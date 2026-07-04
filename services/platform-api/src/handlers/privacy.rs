use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

/// Erase the learner's recorded audio from the ML inference service (right-to-erasure). The DB
/// cascade below only removes derived records; the raw audio blobs live in the ML service's storage,
/// so without this call a "delete" leaves the recordings on disk. The erase is scoped to the actor's
/// server-validated tenant, uses the server-side ML key, and is idempotent (re-deleting is a no-op),
/// so the whole delete is safe to retry. Returns the object keys the ML service reports erased.
async fn erase_ml_audio(
    state: &AppState,
    tenant_id: &str,
    learner_id: &str,
    trace_id: Option<&str>,
) -> Result<Vec<String>, ApiError> {
    let response = state
        .http_client
        .post(format!("{}/v1/privacy/delete", state.ml_inference_url))
        .header("content-type", "application/json")
        .header("x-ml-api-key", &state.ml_api_key)
        .json(&serde_json::json!({
            "tenantId": tenant_id,
            "learnerId": learner_id,
            "traceId": trace_id,
        }))
        .send()
        .await
        .map_err(|e| {
            tracing::error!("privacy delete: ML audio erase send error: {e}");
            ApiError::Upstream("audio erasure service unavailable".to_owned())
        })?;

    if !response.status().is_success() {
        tracing::warn!(
            "privacy delete: ML audio erase upstream status {}",
            response.status()
        );
        return Err(ApiError::Upstream("audio erasure failed".to_owned()));
    }

    let result: serde_json::Value = response.json().await.map_err(|e| {
        tracing::error!("privacy delete: ML audio erase parse error: {e}");
        ApiError::Upstream("audio erasure returned an invalid response".to_owned())
    })?;

    let mut keys = Vec::new();
    for field in ["deletedAudioObjectKeys", "deletedMetadataObjectKeys"] {
        if let Some(arr) = result.get(field).and_then(|v| v.as_array()) {
            keys.extend(arr.iter().filter_map(|v| v.as_str().map(String::from)));
        }
    }
    // Durable success-path record of the erasure, emitted BEFORE the DB cascade runs. If a transient
    // DB failure then rolls back the privacy_jobs row, this log line is the authoritative audit trail
    // that the audio was in fact deleted — without it a retry (which the ML service answers with an
    // empty list, the directory now gone) would leave no record that erasure ever happened.
    tracing::info!(
        "privacy delete: erased {} ML audio object(s) for tenant={tenant_id} learner={learner_id} trace={trace_id:?}",
        keys.len(),
    );
    Ok(keys)
}

pub async fn create_privacy_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PrivacyJobRequest>,
) -> Result<Json<PrivacyJob>, ApiError> {
    create_privacy_job(state, headers, req, PrivacyJobKind::Export).await
}

pub async fn create_privacy_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PrivacyJobRequest>,
) -> Result<Json<PrivacyJob>, ApiError> {
    create_privacy_job(state, headers, req, PrivacyJobKind::Delete).await
}

async fn create_privacy_job(
    state: AppState,
    headers: HeaderMap,
    req: PrivacyJobRequest,
    kind: PrivacyJobKind,
) -> Result<Json<PrivacyJob>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_self_or_any(&req.learner_id, &[ActorRole::Admin, ActorRole::Ops])?;
    let trace_id = crate::auth::extract_trace_id(&headers);

    // Right-to-erasure: erase the learner's recorded audio from the ML inference service BEFORE the
    // DB cascade. The DB rows are only derived records; the raw audio is the sensitive PII. Doing it
    // first means an ML outage fails fast (502) with the database untouched, and — because both the
    // audio erase and the DB cascade are idempotent — the caller can safely retry the whole delete.
    let audio_object_keys_deleted = if kind == PrivacyJobKind::Delete {
        erase_ml_audio(
            &state,
            &actor.tenant_id,
            &req.learner_id,
            trace_id.as_deref(),
        )
        .await?
    } else {
        Vec::new()
    };

    // Whole export/delete runs in one tenant-scoped transaction: RLS enforces isolation AND
    // the multi-table delete cascade is atomic.
    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let kind_str = match kind {
        PrivacyJobKind::Export => "export",
        PrivacyJobKind::Delete => "delete",
    };

    let sessions =
        sqlx::query("SELECT id FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .fetch_all(&mut *tx)
            .await?;

    let session_ids: Vec<String> = sessions
        .into_iter()
        .map(|r| r.try_get::<String, _>("id").unwrap_or_default())
        .collect();

    let progress_rows = sqlx::query(
        "SELECT ayah_ref FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .fetch_all(&mut *tx)
    .await?;

    let progress_ids: Vec<String> = progress_rows
        .into_iter()
        .map(|r| {
            format!(
                "learner_progress:{}",
                r.try_get::<String, _>("ayah_ref").unwrap_or_default()
            )
        })
        .collect();

    let mut included_ids = session_ids.clone();
    included_ids.extend(progress_ids);

    let deleted_ids = if kind == PrivacyJobKind::Delete {
        included_ids.clone()
    } else {
        Vec::new()
    };

    let job_id = next_id("privacy-job");
    let audit_id = next_id("audit");
    let action = match kind {
        PrivacyJobKind::Export => "privacy.export.requested",
        PrivacyJobKind::Delete => "privacy.delete.requested",
    };

    let included_json = serde_json::to_value(&included_ids).unwrap_or_default();
    let deleted_json = serde_json::to_value(&deleted_ids).unwrap_or_default();
    let audio_keys_json = serde_json::to_value(&audio_object_keys_deleted).unwrap_or_default();

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, $4, 'privacy_job', $5, $6)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(action)
    .bind(&job_id)
    .bind(serde_json::json!({"trace_id": trace_id, "kind": kind_str}))
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO privacy_jobs (id, tenant_id, learner_id, kind, included_records, deleted_records, audio_object_keys_deleted, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&job_id)
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .bind(kind_str)
    .bind(&included_json)
    .bind(&deleted_json)
    .bind(&audio_keys_json)
    .bind(&audit_id)
    .execute(&mut *tx)
    .await?;

    if kind == PrivacyJobKind::Delete {
        sqlx::query("DELETE FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&mut *tx)
            .await?;

        // Delete in FK-safe order: teacher_reviews -> tajweed_findings -> word_alignments -> audio_chunks.
        // Every derived-record delete is scoped through this learner's tenant-owned sessions;
        // otherwise one learner's erasure can remove another learner's reviewed findings.
        sqlx::query(
            "DELETE FROM teacher_reviews
             WHERE tenant_id = $1
               AND finding_id IN (
                 SELECT tf.id
                 FROM tajweed_findings tf
                 JOIN word_alignments wa
                   ON wa.id = tf.alignment_id
                  AND wa.tenant_id = tf.tenant_id
                 JOIN recitation_sessions rs
                   ON rs.id = wa.session_id
                  AND rs.tenant_id = wa.tenant_id
                 WHERE tf.tenant_id = $1
                   AND rs.learner_id = $2
               )",
        )
        .bind(&actor.tenant_id)
        .bind(&req.learner_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "DELETE FROM tajweed_findings
             WHERE tenant_id = $1
               AND alignment_id IN (
                 SELECT wa.id
                 FROM word_alignments wa
                 JOIN recitation_sessions rs
                   ON rs.id = wa.session_id
                  AND rs.tenant_id = wa.tenant_id
                 WHERE wa.tenant_id = $1
                   AND rs.learner_id = $2
               )",
        )
        .bind(&actor.tenant_id)
        .bind(&req.learner_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "DELETE FROM word_alignments
             WHERE tenant_id = $1
               AND session_id IN (
                 SELECT id FROM recitation_sessions
                 WHERE tenant_id = $1 AND learner_id = $2
               )",
        )
        .bind(&actor.tenant_id)
        .bind(&req.learner_id)
        .execute(&mut *tx)
        .await?;

        // Remaining session-owned rows must be deleted before the sessions themselves, and
        // the sessions + consent records before the delete is truly complete (right-to-erasure).
        for table in ["audio_chunks", "alignment_runs"] {
            sqlx::query(&format!(
                "DELETE FROM {table} WHERE tenant_id = $1 AND session_id IN \
                 (SELECT id FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2)"
            ))
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            "DELETE FROM realtime_session_tickets WHERE tenant_id = $1 AND learner_id = $2",
        )
        .bind(&actor.tenant_id)
        .bind(&req.learner_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM consent_records WHERE tenant_id = $1 AND user_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    Ok(Json(PrivacyJob {
        id: job_id,
        tenant_id: actor.tenant_id,
        learner_id: req.learner_id,
        kind,
        included_records: included_ids,
        deleted_records: deleted_ids,
        audio_object_keys_deleted,
        audit_event_id: audit_id,
    }))
}
