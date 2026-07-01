use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

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

    let kind_str = match kind {
        PrivacyJobKind::Export => "export",
        PrivacyJobKind::Delete => "delete",
    };

    let sessions =
        sqlx::query("SELECT id FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .fetch_all(&state.pool)
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
    .fetch_all(&state.pool)
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
    let trace_id = crate::auth::extract_trace_id(&headers);
    let action = match kind {
        PrivacyJobKind::Export => "privacy.export.requested",
        PrivacyJobKind::Delete => "privacy.delete.requested",
    };

    let included_json = serde_json::to_value(&included_ids).unwrap_or_default();
    let deleted_json = serde_json::to_value(&deleted_ids).unwrap_or_default();

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
    .execute(&state.pool)
    .await?;

    sqlx::query(
        "INSERT INTO privacy_jobs (id, tenant_id, learner_id, kind, included_records, deleted_records, audio_object_keys_deleted, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7)",
    )
    .bind(&job_id)
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .bind(kind_str)
    .bind(&included_json)
    .bind(&deleted_json)
    .bind(&audit_id)
    .execute(&state.pool)
    .await?;

    if kind == PrivacyJobKind::Delete {
        sqlx::query("DELETE FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&state.pool)
            .await?;

        // Delete in FK-safe order: teacher_reviews → tajweed_findings → word_alignments → audio_chunks
        sqlx::query(
            "DELETE FROM teacher_reviews WHERE tenant_id = $1 AND finding_id IN (SELECT id FROM tajweed_findings WHERE tenant_id = $1)",
        )
        .bind(&actor.tenant_id)
        .execute(&state.pool)
        .await?;

        sqlx::query(
            "DELETE FROM tajweed_findings WHERE tenant_id = $1 AND alignment_id IN (SELECT id FROM word_alignments WHERE session_id IN (SELECT id FROM recitation_sessions WHERE learner_id = $2))",
        )
        .bind(&actor.tenant_id)
        .bind(&req.learner_id)
        .execute(&state.pool)
        .await?;

        sqlx::query(
            "DELETE FROM word_alignments WHERE tenant_id = $1 AND session_id IN (SELECT id FROM recitation_sessions WHERE learner_id = $2)",
        )
        .bind(&actor.tenant_id)
        .bind(&req.learner_id)
        .execute(&state.pool)
        .await?;

        // Remaining session-owned rows must be deleted before the sessions themselves, and
        // the sessions + consent records before the delete is truly complete (right-to-erasure).
        for table in ["audio_chunks", "alignment_runs"] {
            sqlx::query(&format!(
                "DELETE FROM {table} WHERE tenant_id = $1 AND session_id IN \
                 (SELECT id FROM recitation_sessions WHERE learner_id = $2)"
            ))
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&state.pool)
            .await?;
        }

        sqlx::query(
            "DELETE FROM realtime_session_tickets WHERE tenant_id = $1 AND learner_id = $2",
        )
        .bind(&actor.tenant_id)
        .bind(&req.learner_id)
        .execute(&state.pool)
        .await?;

        sqlx::query("DELETE FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&state.pool)
            .await?;

        sqlx::query("DELETE FROM consent_records WHERE tenant_id = $1 AND user_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&state.pool)
            .await?;
    }

    Ok(Json(PrivacyJob {
        id: job_id,
        tenant_id: actor.tenant_id,
        learner_id: req.learner_id,
        kind,
        included_records: included_ids,
        deleted_records: deleted_ids,
        audio_object_keys_deleted: Vec::new(),
        audit_event_id: audit_id,
    }))
}
