use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
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
    method: axum::http::Method,
    headers: HeaderMap,
    body: JsonBody<PrivacyJobRequest>,
) -> Result<Json<PrivacyJob>, ApiError> {
    create_privacy_job(state, method, headers, body, PrivacyJobKind::Export).await
}

pub async fn create_privacy_delete(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: JsonBody<PrivacyJobRequest>,
) -> Result<Json<PrivacyJob>, ApiError> {
    create_privacy_job(state, method, headers, body, PrivacyJobKind::Delete).await
}

async fn create_privacy_job(
    state: AppState,
    method: axum::http::Method,
    headers: HeaderMap,
    body: JsonBody<PrivacyJobRequest>,
    kind: PrivacyJobKind,
) -> Result<Json<PrivacyJob>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    // Parsed after authentication and before authorization: `require_self_or_any` below reads
    // `req.learner_id`, so it cannot move any earlier than this.
    let Json(req) = body?;
    // Authorization FIRST, and it must stay first: it is what makes the existence check below safe.
    // A learner may only ever pass their own id, so only admin/ops — already trusted with every row
    // in the tenant — can reach a 404 at all. Inverting these two would turn the 404 into a learner
    // enumeration oracle.
    actor.require_self_or_any(&req.learner_id, &[ActorRole::Admin, ActorRole::Ops])?;
    let trace_id = crate::auth::extract_trace_id(&headers);

    // The learner must exist in this tenant. `privacy_jobs.learner_id` REFERENCES users(id), so
    // without this the INSERT below violates the FK and surfaces as a 500 — indistinguishable from
    // a real database failure on a right-to-erasure endpoint, and it invites a retry that can never
    // succeed. A missing referenced entity is a 404, exactly as create_teacher_review already does
    // for a dangling finding_id.
    //
    // BEFORE the audio erase, not inside the transaction below. The plan put it later, to keep the
    // documented "ML first" ordering untouched; running the test red showed why that is wrong — with
    // the ML service unreachable, an unknown learner returned 502 (transient, retry me) instead of
    // 404 (permanent, do not). Wrong-signal-for-retry is the defect being fixed, so it must not
    // survive in the ML-outage case. A READ touches nothing, so "an ML outage fails fast with the
    // database untouched" still holds.
    let mut check_tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;
    let learner_exists = sqlx::query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2")
        .bind(&req.learner_id)
        .bind(&actor.tenant_id)
        .fetch_optional(&mut *check_tx)
        .await?;
    check_tx.commit().await?;
    if learner_exists.is_none() {
        return Err(ApiError::NotFound);
    }

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

    let agent_runs =
        sqlx::query("SELECT id FROM agent_runs WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .fetch_all(&mut *tx)
            .await?;

    let agent_run_ids: Vec<String> = agent_runs
        .into_iter()
        .map(|r| {
            format!(
                "agent_run:{}",
                r.try_get::<String, _>("id").unwrap_or_default()
            )
        })
        .collect();

    let pilot_session_ids: Vec<String> =
        sqlx::query("SELECT id FROM pilot_sessions WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|r| {
                format!(
                    "pilot_session:{}",
                    r.try_get::<String, _>("id").unwrap_or_default()
                )
            })
            .collect();

    let pilot_invitation_ids: Vec<String> =
        sqlx::query("SELECT id FROM pilot_invitations WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|r| {
                format!(
                    "pilot_invitation:{}",
                    r.try_get::<String, _>("id").unwrap_or_default()
                )
            })
            .collect();

    // ── The session-owned categories, which the receipt used to omit ─────────────────────────────
    //
    // `included_ids` is BOTH the export summary ("we currently hold N records for you") and, on a
    // delete, the receipt of what was destroyed — `deleted_ids` is a clone of it. It was built from
    // five tables while the cascade below deletes from twelve.
    //
    // Measured on a learner seeded with one consent record, one session, one alignment and one
    // finding: all four rows were gone afterwards and the receipt named ONE, the session. A learner
    // or a regulator asking "what did you delete?" was told about the recitation and not about the
    // assessments made of it, the word-level record, or the consent they had given.
    //
    // These are IDENTIFIERS, never content, so nothing here crosses the ADR-0028 learner gate: the
    // count of pending notes is already something both clients render, and an id discloses no
    // judgement. Scoped through `recitation_sessions` by learner, exactly as the deletes are, so the
    // receipt and the cascade cannot describe different sets.
    let session_scoped = |table: &str, prefix: &str| {
        format!(
            "SELECT {t}.id FROM {t} JOIN recitation_sessions rs ON rs.id = {t}.session_id \
             WHERE {t}.tenant_id = $1 AND rs.tenant_id = $1 AND rs.learner_id = $2",
            t = table
        )
        .replace("PREFIX", prefix)
    };

    let mut session_owned_ids: Vec<String> = Vec::new();
    for (table, prefix) in [
        ("word_alignments", "word_alignment"),
        ("audio_chunks", "audio_chunk"),
        ("alignment_runs", "alignment_run"),
    ] {
        let rows = sqlx::query(&session_scoped(table, prefix))
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .fetch_all(&mut *tx)
            .await?;
        session_owned_ids.extend(rows.into_iter().map(|r| {
            format!(
                "{prefix}:{}",
                r.try_get::<String, _>("id").unwrap_or_default()
            )
        }));
    }

    // Findings hang off an alignment rather than a session, so they need the extra hop.
    let finding_rows = sqlx::query(
        "SELECT tf.id FROM tajweed_findings tf \
         JOIN word_alignments wa ON wa.id = tf.alignment_id \
         JOIN recitation_sessions rs ON rs.id = wa.session_id \
         WHERE tf.tenant_id = $1 AND rs.tenant_id = $1 AND rs.learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .fetch_all(&mut *tx)
    .await?;
    session_owned_ids.extend(finding_rows.into_iter().map(|r| {
        format!(
            "tajweed_finding:{}",
            r.try_get::<String, _>("id").unwrap_or_default()
        )
    }));

    let consent_rows =
        sqlx::query("SELECT id FROM consent_records WHERE tenant_id = $1 AND user_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .fetch_all(&mut *tx)
            .await?;
    let consent_ids: Vec<String> = consent_rows
        .into_iter()
        .map(|r| {
            format!(
                "consent_record:{}",
                r.try_get::<String, _>("id").unwrap_or_default()
            )
        })
        .collect();

    let ticket_rows = sqlx::query(
        "SELECT id FROM realtime_session_tickets WHERE tenant_id = $1 AND learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .fetch_all(&mut *tx)
    .await?;
    let ticket_ids: Vec<String> = ticket_rows
        .into_iter()
        .map(|r| {
            format!(
                "realtime_session_ticket:{}",
                r.try_get::<String, _>("id").unwrap_or_default()
            )
        })
        .collect();

    let mut included_ids = session_ids.clone();
    included_ids.extend(progress_ids);
    included_ids.extend(agent_run_ids);
    included_ids.extend(pilot_session_ids);
    included_ids.extend(pilot_invitation_ids);
    included_ids.extend(session_owned_ids);
    included_ids.extend(consent_ids);
    included_ids.extend(ticket_ids);

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

        sqlx::query("DELETE FROM pilot_sessions WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM pilot_invitations WHERE tenant_id = $1 AND learner_id = $2")
            .bind(&actor.tenant_id)
            .bind(&req.learner_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM agent_runs WHERE tenant_id = $1 AND learner_id = $2")
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
