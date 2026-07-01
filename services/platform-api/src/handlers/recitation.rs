use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use sha2::Digest;
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

pub async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RecitationSessionRequest>,
) -> Result<Json<RecitationSession>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_self_or_any(&req.learner_id, &[ActorRole::Admin, ActorRole::Ops])?;

    let external_processing_allowed =
        req.consent.external_asr_processing && req.consent.guardian_approved;

    let session_id = next_id("session");
    let audit_id = next_id("audit");
    let trace_id = crate::auth::extract_trace_id(&headers);

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'recitation.session.started', 'recitation_session', $4, $5)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&session_id)
    .bind(serde_json::json!({"trace_id": trace_id, "model_version": req.model_version}))
    .execute(&mut *tx)
    .await?;

    let mode_str = match req.mode {
        PracticeMode::Listen => "listen",
        PracticeMode::GuidedRecite => "guided-recite",
        PracticeMode::MemoryRecite => "memory-recite",
        PracticeMode::Correction => "correction",
        PracticeMode::Drill => "drill",
        PracticeMode::Complete => "complete",
    };

    let quran_ref_json = serde_json::to_value(&req.quran_ref).unwrap_or_default();
    let consent_json = serde_json::to_value(&req.consent).unwrap_or_default();

    // Create consent record
    let consent_record_id = next_id("consent");
    let audio_retention_str = match req.consent.audio_retention {
        AudioRetention::Discard => "discard",
        AudioRetention::TrainingOptIn => "training-opt-in",
        AudioRetention::TeacherReview => "teacher-review",
    };

    sqlx::query(
        "INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
            external_asr_processing, guardian_approved, consent_version, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&consent_record_id)
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .bind(audio_retention_str)
    .bind(req.consent.anonymized_learning)
    .bind(req.consent.external_asr_processing)
    .bind(req.consent.guardian_approved)
    .bind(&req.consent.consent_version)
    .bind(&audit_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO recitation_sessions
            (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id,
             mode, practice_plan_id, external_processing_allowed, confidence, review_status,
             started_at, latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0.0, 'draft', now(), 0, $10, $11, $12, $13)",
    )
    .bind(&session_id)
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .bind(&quran_ref_json)
    .bind(&req.source_checksum)
    .bind(&req.model_version)
    .bind(mode_str)
    .bind(&req.practice_plan_id)
    .bind(external_processing_allowed)
    .bind(&consent_record_id)
    .bind(&consent_json)
    .bind(&audit_id)
    .bind(&req.language)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(RecitationSession {
        id: session_id,
        tenant_id: actor.tenant_id,
        learner_id: req.learner_id,
        quran_ref: req.quran_ref,
        source_checksum: req.source_checksum,
        model_version: req.model_version,
        language: req.language,
        mode: req.mode,
        practice_plan_id: req.practice_plan_id,
        external_processing_allowed,
        confidence: 0.0,
        review_status: ReviewStatus::Draft,
        consent: req.consent,
        audit_event_id: audit_id,
    }))
}

pub async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<RecitationSession>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[
        ActorRole::Learner,
        ActorRole::Teacher,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let row = sqlx::query(
        "SELECT id, tenant_id, learner_id, quran_ref, source_checksum,
                model_version_id, mode, practice_plan_id,
                external_processing_allowed, confidence::float8 as confidence, review_status,
                consent_snapshot, audit_event_id, language
         FROM recitation_sessions
         WHERE id = $1 AND tenant_id = $2",
    )
    .bind(&id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;

    let learner_id: String = row.try_get("learner_id")?;
    actor.require_self_or_any(
        &learner_id,
        &[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops],
    )?;

    let quran_ref: QuranReference =
        serde_json::from_value(row.try_get("quran_ref")?).unwrap_or(QuranReference {
            surah_number: 1,
            ayah_start: 1,
            ayah_end: 7,
            display: "Unknown".to_owned(),
        });

    let mode_str: String = row.try_get("mode")?;
    let mode = match mode_str.as_str() {
        "listen" => PracticeMode::Listen,
        "guided-recite" => PracticeMode::GuidedRecite,
        "memory-recite" => PracticeMode::MemoryRecite,
        "correction" => PracticeMode::Correction,
        "drill" => PracticeMode::Drill,
        "complete" => PracticeMode::Complete,
        _ => PracticeMode::GuidedRecite,
    };

    let rs_str: String = row.try_get("review_status")?;
    let review_status = match rs_str.as_str() {
        "draft" => ReviewStatus::Draft,
        "ai-suggested" => ReviewStatus::AiSuggested,
        "teacher-reviewed" => ReviewStatus::TeacherReviewed,
        "scholar-approved" => ReviewStatus::ScholarApproved,
        "blocked" => ReviewStatus::Blocked,
        _ => ReviewStatus::Draft,
    };

    tx.commit().await?;

    Ok(Json(RecitationSession {
        id: row.try_get("id")?,
        tenant_id: row.try_get("tenant_id")?,
        learner_id,
        quran_ref,
        source_checksum: row.try_get("source_checksum")?,
        model_version: row.try_get("model_version_id")?,
        language: row.try_get("language").unwrap_or_else(|_| "ar".to_owned()),
        mode,
        practice_plan_id: row.try_get("practice_plan_id")?,
        external_processing_allowed: row.try_get("external_processing_allowed")?,
        confidence: row.try_get("confidence").unwrap_or(0.0),
        review_status,
        // If a session predates consent_snapshot, fall back to the MOST RESTRICTIVE consent
        // — never fabricate consent (e.g. anonymized-learning) the learner may not have given.
        consent: serde_json::from_value(row.try_get("consent_snapshot")?).unwrap_or(Consent {
            audio_retention: AudioRetention::Discard,
            anonymized_learning: false,
            external_asr_processing: false,
            guardian_approved: false,
            consent_version: "unknown".to_owned(),
        }),
        audit_event_id: row.try_get("audit_event_id").unwrap_or_default(),
    }))
}

pub async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        "SELECT id, learner_id, quran_ref, mode, confidence, review_status, started_at, latency_ms
         FROM recitation_sessions WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 50",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| {
            let quran_ref: serde_json::Value =
                r.try_get("quran_ref").unwrap_or(serde_json::json!({}));
            let started: chrono::DateTime<chrono::Utc> = r
                .try_get("started_at")
                .unwrap_or_else(|_| chrono::Utc::now());
            serde_json::json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "learnerId": r.try_get::<String, _>("learner_id").unwrap_or_default(),
                "quranRef": quran_ref,
                "mode": r.try_get::<String, _>("mode").unwrap_or_default(),
                "confidence": r.try_get::<f64, _>("confidence").unwrap_or(0.0),
                "reviewStatus": r.try_get::<String, _>("review_status").unwrap_or_default(),
                "startedAt": started.to_rfc3339(),
                "latencyMs": r.try_get::<i32, _>("latency_ms").unwrap_or(0),
            })
        })
        .collect();

    tx.commit().await?;

    Ok(Json(out))
}

pub async fn create_realtime_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RealtimeSessionTicketRequest>,
) -> Result<Json<RealtimeSessionTicket>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[ActorRole::Learner, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let row = sqlx::query(
        "SELECT id, tenant_id, learner_id, external_processing_allowed
         FROM recitation_sessions
         WHERE id = $1 AND tenant_id = $2",
    )
    .bind(&req.session_id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;

    let session_id: String = row.try_get("id")?;
    let learner_id: String = row.try_get("learner_id")?;
    let external_asr: bool = row.try_get("external_processing_allowed")?;

    actor.require_self_or_any(&learner_id, &[ActorRole::Admin, ActorRole::Ops])?;

    let allowed_sample_rates = if req.requested_sample_rates.is_empty() {
        vec![16_000u32]
    } else {
        req.requested_sample_rates
            .into_iter()
            .filter(|sr| matches!(sr, 16_000 | 24_000 | 48_000))
            .collect::<Vec<_>>()
    };
    let allowed_sample_rates = if allowed_sample_rates.is_empty() {
        vec![16_000u32]
    } else {
        allowed_sample_rates
    };

    let audit_id = next_id("audit");
    let ticket_id = next_id("rt-ticket");
    let expires_at = crate::unix_now_seconds() + crate::REALTIME_TICKET_TTL_SECONDS;
    let nonce = uuid::Uuid::new_v4().to_string();
    let token = crate::issue_realtime_ticket(
        &session_id,
        &actor.tenant_id,
        &learner_id,
        external_asr,
        expires_at,
        &nonce,
        &crate::realtime_ticket_secret(),
    );

    let trace_id = crate::auth::extract_trace_id(&headers);
    let token_hash = format!("{:x}", sha2::Sha256::digest(token.as_bytes()));
    let expires_at_ts =
        chrono::DateTime::from_timestamp(expires_at as i64, 0).unwrap_or_else(chrono::Utc::now);
    let sample_rates_i32: Vec<i32> = allowed_sample_rates.iter().map(|&v| v as i32).collect();

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'recitation.realtime-ticket.issued', 'realtime_session_ticket', $4, $5)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&ticket_id)
    .bind(serde_json::json!({"trace_id": trace_id}))
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO realtime_session_tickets
            (id, tenant_id, session_id, learner_id, token_hash, expires_at,
             allowed_sample_rates, external_asr_processing, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&ticket_id)
    .bind(&actor.tenant_id)
    .bind(&session_id)
    .bind(&learner_id)
    .bind(&token_hash)
    .bind(expires_at_ts)
    .bind(&sample_rates_i32)
    .bind(external_asr)
    .bind(&audit_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(RealtimeSessionTicket {
        session_id,
        tenant_id: actor.tenant_id,
        learner_id,
        expires_at: expires_at.to_string(),
        allowed_sample_rates,
        external_asr_processing: external_asr,
        token,
        audit_event_id: audit_id,
    }))
}

/// Read-only: word-level alignments for a session (internal Command console).
/// Joins canonical_words for the Uthmani text. Teacher/Admin/Ops only.
pub async fn list_session_alignments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        "SELECT wa.word_id, cw.text_uthmani, wa.heard_text, wa.start_ms, wa.end_ms,
                wa.confidence::float8 AS confidence, wa.status
         FROM word_alignments wa
         JOIN canonical_words cw ON cw.id = wa.word_id
         WHERE wa.session_id = $1 AND wa.tenant_id = $2
         ORDER BY wa.start_ms ASC",
    )
    .bind(&id)
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "wordId": r.try_get::<String, _>("word_id").unwrap_or_default(),
                "canonicalText": r.try_get::<String, _>("text_uthmani").unwrap_or_default(),
                "heardText": r.try_get::<String, _>("heard_text").unwrap_or_default(),
                "startMs": r.try_get::<i32, _>("start_ms").unwrap_or(0),
                "endMs": r.try_get::<i32, _>("end_ms").unwrap_or(0),
                "confidence": r.try_get::<f64, _>("confidence").unwrap_or(0.0),
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
            })
        })
        .collect();

    tx.commit().await?;

    Ok(Json(out))
}
