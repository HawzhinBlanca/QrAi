use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use sha2::Digest;
use sqlx::Row;

use crate::AppState;
use crate::types::*;

fn parse_review_status(value: &str) -> Result<ReviewStatus, ApiError> {
    match value {
        "draft" => Ok(ReviewStatus::Draft),
        "ai-suggested" => Ok(ReviewStatus::AiSuggested),
        "teacher-review-required" => Ok(ReviewStatus::TeacherReviewRequired),
        "teacher-reviewed" => Ok(ReviewStatus::TeacherReviewed),
        "scholar-approved" => Ok(ReviewStatus::ScholarApproved),
        "blocked" => Ok(ReviewStatus::Blocked),
        _ => Err(ApiError::Database(format!(
            "invalid review_status in database: {value}"
        ))),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexAudioChunkRequest {
    pub session_id: String,
    pub chunk_id: String,
    pub object_key: String,
    #[serde(default)]
    pub start_ms: serde_json::Value,
    #[serde(default)]
    pub end_ms: serde_json::Value,
    #[serde(default)]
    pub sample_rate: Option<i32>,
    // `tenantId` / `learnerId` are DELIBERATELY absent. A caller that can name the tenant can write
    // a row deciding whose recording a teacher is later played; both come from the signed ticket.
    // serde drops unknown fields, so sending them is not an error — it simply has no effect, which
    // `tests/api-parity/audio-index-parity.test.mjs` asserts rather than assumes.
}

/// `POST /v1/audio-chunks` — the gateway records that a chunk of audio exists (ADR-0037).
///
/// The missing half of playback. Audio was stored by ml-inference and NOTHING wrote the row saying
/// where it is: `audio_chunks` was populated by a test fixture and a smoke script and by nothing
/// else. Measured before this existed — of 2752 tajweed findings, zero had a session with any audio
/// row, so no finding could ever resolve to a recording.
///
/// ── The credential is the session's own realtime ticket ─────────────────────────────────────────
/// Not a new shared secret. The gateway already holds a ticket THIS SERVICE minted for the session,
/// signed with `REALTIME_GATEWAY_TICKET_SECRET`, expiring in `REALTIME_TICKET_TTL_SECONDS`, carrying
/// tenant, learner and session. Reusing it means the gateway can only index chunks for a session it
/// was actually admitted to, the scope is one session rather than the whole service, and there is no
/// third credential to rotate. A shared service key would have granted every session at once, and
/// forever.
///
/// 401 for a missing, malformed, expired, wrongly-signed or wrong-session ticket — one answer, so a
/// caller cannot tell "this ticket is for another session" from "this signature is wrong".
pub async fn index_audio_chunk(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: JsonBody<IndexAudioChunkRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // The ticket is checked BEFORE the body is read, for the reason every other handler now does it:
    // an unidentified caller learns nothing about the request shape.
    let ticket = headers
        .get("x-realtime-ticket")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?
        .to_owned();

    let Json(req) = body?;

    let claims = quran_ai_shared_ticket::validate_realtime_ticket(
        &req.session_id,
        &ticket,
        &crate::realtime_ticket_secret(),
        crate::unix_now_seconds(),
    )
    .map_err(|_| ApiError::Unauthorized)?;

    // Same rule as `usable_span`: a chunk whose span identifies no audio is unlocatable, and this
    // index exists so a finding can be located. Refusing here keeps the DB CHECK constraint
    // (0026_alignment_span_check) from being the only thing holding the line.
    let Some((start_ms, end_ms)) = usable_span(&req.start_ms, &req.end_ms) else {
        return Err(ApiError::BadRequest(
            "startMs/endMs must be integers with 0 <= startMs < endMs".to_owned(),
        ));
    };

    let mut tx = crate::begin_tenant_tx(&state.pool, &claims.tenant_id).await?;

    // The session must exist in the ticket's tenant. The ticket alone proves the gateway was
    // admitted; this proves the row it is about is still there (erasure may have removed it
    // mid-session, and a chunk indexed against a deleted session is a dangling pointer at best).
    let session = sqlx::query(
        "SELECT audit_event_id FROM recitation_sessions WHERE id = $1 AND tenant_id = $2",
    )
    .bind(&claims.session_id)
    .bind(&claims.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;
    // Reusing the session's audit event rather than minting one per chunk: a chunk arrives every few
    // seconds per learner, and an audit row each would bury the events a human actually reads.
    let audit_event_id: String = session.try_get("audit_event_id").unwrap_or_default();

    // ON CONFLICT DO NOTHING, because the gateway RETRIES a chunk whose response was lost. Failing a
    // retry would make a delivered chunk look undelivered and the gateway would count a loss that did
    // not happen — the opposite of what its lossy-session accounting is for.
    sqlx::query(
        "INSERT INTO audio_chunks
            (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status,
             object_key, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'aligned', $8, $9)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(&req.chunk_id)
    .bind(&claims.tenant_id)
    .bind(&claims.session_id)
    .bind(&req.chunk_id)
    .bind(start_ms)
    .bind(end_ms)
    .bind(req.sample_rate.unwrap_or(16_000))
    .bind(&req.object_key)
    .bind(&audit_event_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(serde_json::json!({
        "chunkId": req.chunk_id,
        "indexed": true,
        "sessionId": claims.session_id,
    })))
}

pub async fn create_session(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: JsonBody<RecitationSessionRequest>,
) -> Result<Json<RecitationSession>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    // Authentication first, then the body, then authorization — the middle step cannot move ahead of
    // the last one here, because the authorization decision READS `req.learner_id`. An anonymous
    // caller is still refused before their body is parsed, which is the disclosure that mattered.
    let Json(req) = body?;
    actor.require_self_or_any(&req.learner_id, &[ActorRole::Admin, ActorRole::Ops])?;

    if !is_supported_language(&req.language) {
        return Err(ApiError::BadRequest(format!(
            "unsupported language {:?}; allowed: {SUPPORTED_LANGUAGE_CODES:?}",
            req.language
        )));
    }

    let external_processing_allowed =
        req.consent.external_asr_processing && req.consent.guardian_approved;

    let session_id = next_id("session");
    let audit_id = next_id("audit");
    let trace_id = crate::auth::extract_trace_id(&headers);

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // FK2 — `recitation_sessions.learner_id` REFERENCES users(id). Without this the INSERT violates
    // the FK and surfaces as an opaque 500 on the product's most-called write.
    //
    // AFTER require_self_or_any above, and it must stay there. This is the second endpoint where
    // that ordering decides between a fix and a vulnerability: put the existence check first and a
    // learner can enumerate learner ids by reading 404-vs-403. Tenant-scoped for the same reason.
    let learner_exists = sqlx::query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2")
        .bind(&req.learner_id)
        .bind(&actor.tenant_id)
        .fetch_optional(&mut *tx)
        .await?;
    if learner_exists.is_none() {
        return Err(ApiError::NotFound);
    }

    // FK3 — `recitation_sessions.model_version_id` REFERENCES model_versions(id).
    //
    // 400 NAMING the value, not 404. model_version is chosen from a fixed server-side vocabulary,
    // like the agent-run status enum that already 400s this way — and this endpoint can fail on
    // learnerId OR modelVersion, so a shared "record not found" would leave a caller guessing
    // between two very different fixes. model_versions is global, so no tenant predicate.
    let model_exists = sqlx::query("SELECT 1 FROM model_versions WHERE id = $1")
        .bind(&req.model_version)
        .fetch_optional(&mut *tx)
        .await?;
    if model_exists.is_none() {
        return Err(ApiError::BadRequest(format!(
            "unknown model version: {}",
            req.model_version
        )));
    }

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
    method: axum::http::Method,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<RecitationSession>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
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
            word_start: None,
            word_end: None,
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
    let review_status = parse_review_status(&rs_str)?;

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
            recording_consent: false,
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
    method: axum::http::Method,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        "SELECT id, learner_id, quran_ref, mode, confidence::float8 AS confidence, review_status, started_at, latency_ms
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

/// The COMPLETE set of distinct learner ids that have at least one recitation session in this tenant
/// (no LIMIT), for internal batch consumers like the agents practice recommender. `list_sessions` is
/// capped at 50 recent rows for UI use, so deriving "active learners" from it silently drops learners
/// once tenant session volume exceeds the cap — this endpoint is the un-truncated source. Staff only.
pub async fn list_active_learners(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Result<Json<Vec<String>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;
    let ids = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT learner_id FROM recitation_sessions WHERE tenant_id = $1 ORDER BY learner_id",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(ids))
}

pub async fn create_realtime_ticket(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: JsonBody<RealtimeSessionTicketRequest>,
) -> Result<Json<RealtimeSessionTicket>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Learner, ActorRole::Admin, ActorRole::Ops])?;
    let Json(req) = body?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // `audio_retention` is joined from the session's OWN consent record, exactly like
    // `external_processing_allowed` above it and for the same reason: it is the learner's stored
    // answer, and the request body has no say in it. The gateway is the only thing that can tell
    // ml-inference how long this recording may be kept, and the ticket is the only channel it has.
    let row = sqlx::query(
        "SELECT s.id, s.tenant_id, s.learner_id, s.external_processing_allowed, c.audio_retention
         FROM recitation_sessions s
         JOIN consent_records c ON c.id = s.consent_record_id
         WHERE s.id = $1 AND s.tenant_id = $2",
    )
    .bind(&req.session_id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;

    let session_id: String = row.try_get("id")?;
    let learner_id: String = row.try_get("learner_id")?;
    let external_asr: bool = row.try_get("external_processing_allowed")?;
    let audio_retention: String = row.try_get("audio_retention")?;

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
        &audio_retention,
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
    method: axum::http::Method,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistAlignmentInput {
    pub word_id: String,
    #[serde(default)]
    pub heard_text: String,
    // Taken as raw JSON rather than `i32`, so an absent, null, string or fractional timing lands in
    // the same place as a zero-length or inverted one: `usable_span` below. Typed as `i32` with
    // `#[serde(default)]`, an ABSENT timing silently became 0 and a wrong-typed one was a 422 — two
    // different answers to one question, and the port's answer was a third (it accepted everything).
    #[serde(default)]
    pub start_ms: serde_json::Value,
    #[serde(default)]
    pub end_ms: serde_json::Value,
    pub confidence: f64,
    pub status: String,
}

/// The time span an alignment claims, or `None` if it does not identify any audio.
///
/// `start_ms`/`end_ms` are the ONLY record of where in a recitation a word was heard, and a tajweed
/// finding is anchored to the alignment row. So a finding whose span is 0ms-to-0ms points at nothing:
/// a reviewer asked to adjudicate it — the whole purpose of the review queue, and the precondition
/// for ever assembling an adjudicated corpus — has nothing to listen to, and the row is
/// indistinguishable in the table from one pointing at real audio.
///
/// Measured in staging before this existed: 2686 tajweed findings, of which 507 (19%) resolved to a
/// zero-length span. Nothing reported it, because 0 is a perfectly valid integer and every layer
/// accepted it.
///
/// The web client already refuses to PRODUCE one — `liveRecitation.ts` computes
/// `endMs = Math.max(startMs + 1, ...)` deliberately. That guard lived in a client, which is a
/// display choice rather than an authority; this is the same argument as ADR-0028.
///
/// Requires `0 <= start < end`. Zero-length is refused because a word takes time to say; negative is
/// refused because it is a position in a recording.
pub(crate) fn usable_span(
    start: &serde_json::Value,
    end: &serde_json::Value,
) -> Option<(i32, i32)> {
    // `as_i64` returns None for a string, a bool, null, and for a float like 1.5 — serde_json only
    // reports an integer when the JSON number genuinely had no fractional part.
    let start = start.as_i64()?;
    let end = end.as_i64()?;
    if start < 0 || end <= start {
        return None;
    }
    // A span past i32 is not a recitation timestamp; the column is int4 and would error anyway.
    Some((i32::try_from(start).ok()?, i32::try_from(end).ok()?))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistAlignmentsRequest {
    pub alignments: Vec<PersistAlignmentInput>,
    #[serde(default)]
    pub model_version: Option<String>,
}

/// Persist a session's word-level alignment (learner-owner or staff). This is the link that
/// makes a learner's REAL recitation visible in the Command console (which reads
/// `word_alignments`). Replaces any prior alignment for the session (idempotent re-record),
/// skips words whose id is not a real canonical word (e.g. the synthetic "extra-N" ids that
/// would violate the FK), and clamps confidence to [0,1]. The canonical-word check is BATCHED
/// (one query, not one per alignment). Rows skipped for an unrecognised status vs. a non-canonical
/// word are counted separately and returned (`skippedInvalidStatus`, `skippedUnknownWord`), and an
/// unrecognised status is logged, so incomplete feedback is visible instead of a silent gap.
/// The write half of `persist_session_alignments`, without the HTTP shell.
///
/// Extracted so `finalize_session` can persist a server-derived alignment through EXACTLY this
/// code. Duplicating it would have meant two copies of the FK-safe cascade below, and the one that
/// drifted would silently stop deleting a teacher's review before re-aligning under it.
///
/// Does not commit — the caller owns the transaction, because `finalize_session` has more to do in
/// the same one.
/// Where the words being persisted came from. Not a request field — a property of the CODE PATH,
/// which is why it is an enum passed by the caller rather than anything a client can influence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranscriptSource {
    /// `finalize_session`: the transcript was fetched server-to-server from the service holding the
    /// audio. The caller named a session and supplied no words.
    ServerDerived,
    /// The client-facing persist route: the words originate from something the caller sent, and a
    /// caller can send anything. Practice, not evidence.
    ClientReported,
}

impl TranscriptSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::ServerDerived => "server-derived",
            Self::ClientReported => "client-reported",
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn persist_alignments_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: &str,
    actor_user_id: &str,
    session_id: &str,
    req: PersistAlignmentsRequest,
    transcript_source: TranscriptSource,
    trace_id: Option<String>,
) -> Result<serde_json::Value, ApiError> {
    // FK3 — model_version must satisfy the FK against model_versions(id).
    //
    // This used to fall back to "model-v0.3" when the requested model was unknown, and return 200.
    // That is worse than the 500s it was avoiding: a caller says "this alignment came from model X",
    // the row is stored as model-v0.3, and the caller is never told the label changed. Every
    // downstream "which model produced this?" — tajweed_findings, the Command console — then has a
    // confidently wrong answer, and unlike a 500 nothing surfaces it.
    //
    // ABSENT still defaults. That is a default, not a substitution: the caller asserted nothing, so
    // nothing is being overridden. Only a PRESENT-and-unknown value is now refused.
    let model_version = match req.model_version {
        None => "model-v0.3".to_owned(),
        Some(requested) => {
            let known: Option<String> =
                sqlx::query_scalar("SELECT id FROM model_versions WHERE id = $1")
                    .bind(&requested)
                    .fetch_optional(&mut **tx)
                    .await?;
            known.ok_or(ApiError::BadRequest(format!(
                "unknown model version: {requested}"
            )))?
        }
    };

    // Replace-on-write: clear the session's prior alignment first, in FK-safe order.
    // tajweed_findings.alignment_id and teacher_reviews.finding_id both RESTRICT, so a naked
    // DELETE of word_alignments would raise a foreign_key_violation (→ 500) for any session
    // that already has findings/reviews. Re-recording the alignment invalidates those old
    // findings anyway (they point at words being re-aligned), so cascade them explicitly:
    // teacher_reviews → tajweed_findings → word_alignments, all scoped to this session.
    // DETACHED, not deleted (0024_teacher_review_survives_realignment.sql).
    //
    // This used to be a DELETE, and it is reached by the session OWNER — so a learner re-recording
    // their own session erased any review a teacher had already submitted on it. A finding about
    // words that no longer exist should certainly go. A named teacher's judgement about a named
    // learner, made at a known time, is a different kind of record, and a learner action must not be
    // able to remove it.
    //
    // `finding_id = NULL` releases the RESTRICT so the finding below can be deleted; the review row,
    // its author, its note, its decision and its snapshot of what was being judged all survive, now
    // marked as being about something the learner has since replaced.
    //
    // Still counted and still audited under the same name: the count is what a reader of the audit
    // event uses to know review history was affected.
    let deleted_teacher_reviews = sqlx::query(
        "UPDATE teacher_reviews SET finding_id = NULL, superseded_at = now()
         WHERE tenant_id = $1 AND superseded_at IS NULL AND finding_id IN (
             SELECT tf.id FROM tajweed_findings tf
             JOIN word_alignments wa ON wa.id = tf.alignment_id
             WHERE wa.session_id = $2 AND wa.tenant_id = $1)",
    )
    .bind(tenant_id)
    .bind(session_id)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    let deleted_tajweed_findings = sqlx::query(
        "DELETE FROM tajweed_findings WHERE tenant_id = $1 AND alignment_id IN (
             SELECT id FROM word_alignments WHERE session_id = $2 AND tenant_id = $1)",
    )
    .bind(tenant_id)
    .bind(session_id)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    sqlx::query("DELETE FROM word_alignments WHERE session_id = $1 AND tenant_id = $2")
        .bind(session_id)
        .bind(tenant_id)
        .execute(&mut **tx)
        .await?;

    // Audit AFTER the cascade, recording what this request ACTUALLY did. The cascade above is
    // authorized for the session OWNER (require_self_or_any), so a learner re-recording their own
    // session used to silently erase any teacher_reviews a teacher had already submitted on it — with
    // the audit event giving no hint that review history was destroyed. Recording the real counts
    // made it visible; 0024 stopped the reviews being destroyed at all (they are now detached and
    // marked superseded, retaining a snapshot of what was judged).
    //
    // `deletedTeacherReviews` keeps its name. It is read by existing operator queries and the number
    // still answers the question it was added for — how much review history this request affected —
    // even though "deleted" is now the weaker "detached". Renaming a field in an audit log breaks
    // every reader for a wording improvement.
    //
    // Still ordered before the word_alignments INSERTs below, which FK-reference this audit row.
    let audit_id = next_id("audit");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'recitation.alignment.persisted', 'recitation_session', $4, $5)",
    )
    .bind(&audit_id)
    .bind(tenant_id)
    .bind(actor_user_id)
    .bind(session_id)
    .bind(serde_json::json!({
        "trace_id": trace_id,
        "count": req.alignments.len(),
        "deletedTeacherReviews": deleted_teacher_reviews,
        "deletedTajweedFindings": deleted_tajweed_findings,
    }))
    .execute(&mut **tx)
    .await?;

    const VALID_STATUS: [&str; 5] = ["matched", "misread", "missed", "extra", "needs-review"];
    // Partition once. An UNRECOGNISED status is a data-quality signal from the ML service (e.g. a typo
    // like "matche"), not something to drop silently — count it, log it, and report it to the caller
    // so incomplete feedback is visible rather than a silent gap.
    let (valid, invalid_status): (Vec<_>, Vec<_>) = req
        .alignments
        .iter()
        .partition(|a| VALID_STATUS.contains(&a.status.as_str()));

    // Batch the canonical-word existence check into ONE query (was N+1 — one SELECT per alignment,
    // e.g. 29 round-trips for Al-Fatihah). canonical_words is global reference data (not tenant-scoped).
    let candidate_ids: Vec<String> = valid.iter().map(|a| a.word_id.clone()).collect();
    let known_words: std::collections::HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT id FROM canonical_words WHERE id = ANY($1)")
            .bind(&candidate_ids)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .collect();

    let mut persisted = 0i64;
    let mut skipped_unknown_word = 0i64;
    let mut skipped_unusable_span = 0i64;
    for a in valid {
        // Only real canonical words satisfy the word_id FK; synthetic ids ("extra-N") are EXPECTED to
        // be absent (an "extra" word the learner said that isn't in the canonical text) — not an error.
        if !known_words.contains(&a.word_id) {
            skipped_unknown_word += 1;
            continue;
        }
        // Skipped and COUNTED, the same way an unknown word is, rather than failing the whole batch:
        // one bad timing among fifty must not discard forty-nine good ones. The count goes back in
        // the response, so a client sending unusable timings learns it instead of finding out later
        // that its findings point nowhere.
        let Some((start_ms, end_ms)) = usable_span(&a.start_ms, &a.end_ms) else {
            skipped_unusable_span += 1;
            continue;
        };
        let wa_id = next_id("word-alignment");
        sqlx::query(
            "INSERT INTO word_alignments
                (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status, model_version_id, audit_event_id, transcript_source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::float8::numeric, $9, $10, $11, $12)",
        )
        .bind(&wa_id)
        .bind(tenant_id)
        .bind(session_id)
        .bind(&a.word_id)
        .bind(&a.heard_text)
        .bind(start_ms)
        .bind(end_ms)
        .bind(a.confidence.clamp(0.0, 1.0))
        .bind(&a.status)
        .bind(&model_version)
        .bind(&audit_id)
        .bind(transcript_source.as_str())
        .execute(&mut **tx)
        .await?;
        persisted += 1;
    }

    let skipped_invalid_status = invalid_status.len() as i64;
    if skipped_invalid_status > 0 {
        // Log the actual offending status strings (not just a count) so a data-quality problem in the
        // ML output is greppable/actionable without reproducing against the DB.
        let bad_statuses: Vec<&str> = invalid_status.iter().map(|a| a.status.as_str()).collect();
        tracing::warn!(
            "persist_session_alignments session={session_id}: {skipped_invalid_status} alignment(s) had an \
             unrecognised status and were skipped (ML data-quality issue): {bad_statuses:?}"
        );
    }

    Ok(serde_json::json!({
        "sessionId": session_id,
        "persisted": persisted,
        "skippedInvalidStatus": skipped_invalid_status,
        "skippedUnknownWord": skipped_unknown_word,
        "skippedUnusableSpan": skipped_unusable_span,
        // On the wire so a caller is never left assuming its words were recorded as measured
        // evidence. `client-reported` here is not a failure — it is the honest label for practice
        // the server did not witness.
        "transcriptSource": transcript_source.as_str(),
        "auditEventId": audit_id,
    }))
}

pub async fn persist_session_alignments(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: JsonBody<PersistAlignmentsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    let Json(req) = body?;
    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // The session must exist in-tenant; only its learner or staff may write its alignment.
    let learner_id: String = sqlx::query_scalar(
        "SELECT learner_id FROM recitation_sessions WHERE id = $1 AND tenant_id = $2",
    )
    .bind(&id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;
    actor.require_self_or_any(
        &learner_id,
        &[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops],
    )?;

    let out = persist_alignments_in_tx(
        &mut tx,
        &actor.tenant_id,
        &actor.user_id,
        &id,
        req,
        // ALWAYS client-reported on this route, and not negotiable through the request body.
        //
        // The words in `req` came from whatever the caller sent. On the web path that is either a
        // transcript this API produced and then handed to the browser, or the browser's own Web
        // Speech recognition — and in both cases the round trip means the server cannot vouch for
        // what came back. A caller can also skip the audio entirely and post a flawless recitation.
        //
        // None of that makes the route wrong: practice a learner logs is worth recording. It makes
        // it something other than measured evidence, and the difference now survives the write.
        // `finalize_session` is the path that earns `ServerDerived`, by never taking words from a
        // caller at all.
        TranscriptSource::ClientReported,
        crate::auth::extract_trace_id(&headers),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(out))
}

/// Learner-initiated "send to teacher": flips the caller's OWN session from draft to
/// teacher-review-required, so it actually appears in the teacher's review pipeline.
///
/// This endpoint exists because the web's "Send to teacher" button previously only switched a
/// local UI step and then displayed "Sent to teacher." — a functional lie; nothing was ever sent
/// (SHIP_PLAN P1.2). Rules:
///  - owner-only: the session must belong to the authenticated actor (any role may send its own);
///  - idempotent: re-sending an already-sent session is a 200 no-op, so a double-tap never errors;
///  - draft-only otherwise: a session a teacher/scholar has already progressed past
///    teacher-review-required is not silently reset by a learner action.
pub async fn request_teacher_review(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT learner_id, review_status FROM recitation_sessions
         WHERE tenant_id = $1 AND id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((learner_id, review_status)) = row else {
        return Err(ApiError::NotFound);
    };
    if learner_id != actor.user_id {
        return Err(ApiError::Forbidden);
    }
    if review_status == "teacher-review-required" {
        tx.commit().await?;
        return Ok(Json(serde_json::json!({
            "sessionId": id,
            "reviewStatus": "teacher-review-required",
            "alreadyRequested": true,
        })));
    }
    if review_status != "draft" {
        return Err(ApiError::BadRequest(format!(
            "session review_status is '{review_status}'; only a draft session can be sent for \
             teacher review"
        )));
    }

    let audit_id = next_id("audit");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, $2, $3, 'session.teacher_review.requested', 'recitation_session', $4)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE recitation_sessions SET review_status = 'teacher-review-required'
         WHERE tenant_id = $1 AND id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(serde_json::json!({
        "sessionId": id,
        "reviewStatus": "teacher-review-required",
        "auditEventId": audit_id,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_review_status_round_trips_every_known_value() {
        assert_eq!(parse_review_status("draft").unwrap(), ReviewStatus::Draft);
        assert_eq!(
            parse_review_status("ai-suggested").unwrap(),
            ReviewStatus::AiSuggested
        );
        assert_eq!(
            parse_review_status("teacher-review-required").unwrap(),
            ReviewStatus::TeacherReviewRequired
        );
        assert_eq!(
            parse_review_status("teacher-reviewed").unwrap(),
            ReviewStatus::TeacherReviewed
        );
        assert_eq!(
            parse_review_status("scholar-approved").unwrap(),
            ReviewStatus::ScholarApproved
        );
        assert_eq!(
            parse_review_status("blocked").unwrap(),
            ReviewStatus::Blocked
        );
    }

    #[test]
    fn parse_review_status_rejects_an_unknown_value() {
        assert!(parse_review_status("not-a-real-status").is_err());
    }
}

/// `POST /v1/recitation-sessions/{id}/finalize` — turn a streamed recitation into a reviewable one.
///
/// ── The link this closes ────────────────────────────────────────────────────────────────────────
/// A gateway-streamed recitation reached `ml-inference` as audio chunks and stopped there: no
/// transcript, so no alignment, so no finding a teacher could review and nothing the learner could
/// ever be shown. This is what runs the rest of the chain, server-side:
///
///   stored chunks → transcript → alignment → persisted `word_alignments`
///
/// and from there the existing path takes over: the tajweed analysis anchors findings to those
/// alignments (`ml_proxy::persist_tajweed_findings`), a teacher promotes one (ADR-0027), and the
/// learner reads it back.
///
/// ── Why the CLIENT does not supply the transcript ───────────────────────────────────────────────
/// Whoever supplies the recognised words decides what the learner is recorded as having said. The
/// web client passes its own `recognizedText` to `/v1/ml/alignments:predict` today, which means a
/// client can assert a flawless recitation and have it stored. Here the transcript is fetched
/// server-to-server from the service that holds the audio; the caller only names the session.
///
/// ── Consent is read from the database, never from the request ───────────────────────────────────
/// The stored chunk metadata carries none (the gateway sends none), so this reads the session's
/// consent record and passes it to `ml-inference`, which refuses without it. A learner who declined
/// external-ASR processing gets `finalized: false` and NO stored alignment — not a fabricated one.
pub async fn finalize_session(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;

    // ── 1. Who owns this, what they consented to, and what they were reciting ──────────────────
    // Read and COMMIT before the network calls below: holding a transaction (and its pooled
    // connection) across two HTTP round-trips to another service is how a slow ASR run turns into
    // pool exhaustion for every other request.
    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;
    let row = sqlx::query(
        "SELECT s.learner_id, s.quran_ref, c.guardian_approved, c.external_asr_processing
         FROM recitation_sessions s
         JOIN consent_records c ON c.id = s.consent_record_id
         WHERE s.id = $1 AND s.tenant_id = $2",
    )
    .bind(&id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;

    let row = row.ok_or(ApiError::NotFound)?;
    let learner_id: String = row.try_get("learner_id")?;
    actor.require_self_or_any(
        &learner_id,
        &[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops],
    )?;
    let quran_ref: serde_json::Value = row.try_get("quran_ref")?;
    let consent = serde_json::json!({
        "guardianApproved": row.try_get::<bool, _>("guardian_approved")?,
        "externalAsrProcessing": row.try_get::<bool, _>("external_asr_processing")?,
    });

    // ── 2. The transcript, from the service that holds the audio ───────────────────────────────
    let transcript = ml_post(
        &state,
        "/v1/session-transcript",
        serde_json::json!({
            "tenantId": actor.tenant_id,
            "learnerId": learner_id,
            "sessionId": id,
            "consent": consent,
        }),
    )
    .await?;

    if !transcript
        .get("transcribed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        // No transcript, no alignment. Reported rather than swallowed: "we did not analyse this"
        // and "you recited it perfectly" are the two answers this endpoint could give, and only one
        // of them is true.
        return Ok(Json(serde_json::json!({
            "sessionId": id,
            "finalized": false,
            "reason": transcript.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown"),
            "persisted": 0,
        })));
    }

    // ── 3. Align the real words against the canonical text ─────────────────────────────────────
    let recognized = transcript
        .get("recognizedText")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let alignment = ml_post(
        &state,
        "/v1/alignments:predict",
        serde_json::json!({
            "tenantId": actor.tenant_id,
            "sessionId": id,
            "quranRef": quran_ref,
            "recognizedText": recognized,
            "consent": consent,
        }),
    )
    .await?;

    // ── 4. Persist, through the SAME code the client-facing route uses ─────────────────────────
    let inputs: Vec<PersistAlignmentInput> = alignment
        .get("alignments")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|a| {
                    Some(PersistAlignmentInput {
                        word_id: a.get("wordId")?.as_str()?.to_owned(),
                        heard_text: a
                            .get("heardText")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_owned(),
                        // Passed through as raw JSON, absent included, so the ML-derived path is held
                        // to the same `usable_span` rule as the client-reported one. It had the
                        // identical `.unwrap_or(0)`: an aligner that returned no timing produced a
                        // 0ms-to-0ms row indistinguishable from a real one.
                        start_ms: a.get("startMs").cloned().unwrap_or(serde_json::Value::Null),
                        end_ms: a.get("endMs").cloned().unwrap_or(serde_json::Value::Null),
                        confidence: a.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        status: a
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("needs-review")
                            .to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Counted before the move into the request below: the response needs to distinguish "the
    // aligner offered nothing" from "it offered rows and every one was refused".
    let alignments_offered = inputs.len() as u64;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;
    let persisted = persist_alignments_in_tx(
        &mut tx,
        &actor.tenant_id,
        &actor.user_id,
        &id,
        PersistAlignmentsRequest {
            alignments: inputs,
            // Absent, not asserted: this alignment came from the ML service and the caller is not
            // claiming a model id. `persist_alignments_in_tx` defaults; a present-but-unknown value
            // would (correctly) be refused.
            model_version: None,
        },
        // The one path that earns this. `inputs` was built from a transcript fetched
        // server-to-server from the service holding the audio (step 2 above) — the caller named a
        // session id and supplied no words at all.
        TranscriptSource::ServerDerived,
        crate::auth::extract_trace_id(&headers),
    )
    .await?;

    // Record what the session did NOT get, on the session.
    //
    // ml-inference reports chunks that were accepted upstream and never reached storage (an outage,
    // a crashed writer, a bad disk). Without this the only trace was a PROCESS counter on the
    // gateway — an operator could see that some chunks were lost somewhere, for someone, while the
    // learner's own session record claimed to be complete. Transcription then returns a short
    // transcript and the aligner scores it against the FULL passage, so words the learner DID recite
    // are recorded as missed.
    //
    // RECORDED, not acted on. This does not refuse the finalize, change the scoring, or block
    // review — what should happen to a gapped session is a product decision. It makes that decision
    // possible by putting the fact somewhere a person and a query can reach.
    let lost_chunks = transcript
        .get("missingChunkIds")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    if lost_chunks > 0 {
        tracing::warn!(
            session_id = %id,
            lost_chunks,
            "session finalized with chunks that were accepted upstream but never stored — its \
             transcript is short, and anything scored against the full passage will read the gap \
             as the learner's mistakes"
        );
        sqlx::query(
            "UPDATE recitation_sessions SET lost_chunk_count = $1 WHERE id = $2 AND tenant_id = $3",
        )
        .bind(lost_chunks as i32)
        .bind(&id)
        .bind(&actor.tenant_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    // `finalized` must mean the teacher got something, not that the request completed.
    //
    // Measured end to end in the mobile order (stream chunks -> /finalize -> analyse): this endpoint
    // answered `finalized: true` with `persisted: 0`. `word_alignments` stayed empty, so
    // `persist_tajweed_findings` returned early with nothing to anchor to, so 38 computed findings
    // stored as 0, so the session never reached a teacher's queue — while the client was told the
    // recitation was finalised, and nothing downstream could tell that apart from one that was.
    //
    // The DEGRADED_STATES rule applied to a write: "we could not store this" and "there was nothing
    // to store" are different answers, and neither of them is "done".
    //
    // The CAUSE is upstream of this function and is NOT fixed here: `/v1/alignments:predict` emits
    // no `startMs`/`endMs`, because `recognizedWordsFrom` reduces the ASR's timed words to bare
    // strings before the aligner sees them, and `usable_span` then (correctly) refuses an alignment
    // that identifies no audio. Isolated on one session: the ML-derived alignments persisted 0, and
    // a single alignment carrying a span persisted 1. Threading the timings through changes the ML
    // contract; this makes the failure legible meanwhile, and fails loudly if it ever regresses.
    let persisted_count = persisted
        .get("persisted")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let (finalized, reason) = match (alignments_offered, persisted_count) {
        // The aligner produced rows and not one survived persistence. The learner still sees their
        // own notes; what does not exist is the teacher's copy, and saying so is the point.
        (offered, 0) if offered > 0 => (false, "alignments-unusable"),
        // The aligner returned nothing for a transcript it did have. An absent transcript already
        // returned `transcribed: false` further up, so this is a different failure.
        (0, _) => (false, "no-alignments"),
        _ => (true, "consent-granted"),
    };
    if !finalized {
        tracing::warn!(
            session_id = %id,
            alignments_offered,
            persisted_count,
            reason,
            "finalize stored no alignment: this session will not reach a teacher's queue"
        );
    }

    Ok(Json(serde_json::json!({
        "sessionId": id,
        "finalized": finalized,
        "reason": reason,
        "chunkCount": transcript.get("chunkCount").cloned().unwrap_or(serde_json::json!(0)),
        // Surfaced on the response too: a client that finalizes a gapped session should be able to
        // tell the learner their recording was incomplete rather than that they recited badly.
        "lostChunkCount": lost_chunks,
        "persisted": persisted.get("persisted").cloned().unwrap_or(serde_json::json!(0)),
        // What the aligner OFFERED, so `persisted: 0` reads as "all rejected" rather than "nothing
        // was recited" — the two the old response could not distinguish.
        "alignmentsOffered": alignments_offered,
        "auditEventId": persisted.get("auditEventId").cloned(),
    })))
}

/// One server-to-server POST to the ML service. Upstream detail is logged, never returned — the
/// same rule `ml_proxy` follows, for the same reason (the error text carries the internal URL).
async fn ml_post(
    state: &AppState,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
    let response = state
        .http_client
        .post(format!("{}{}", state.ml_inference_url, path))
        .header("content-type", "application/json")
        .header("x-ml-api-key", &state.ml_api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!("finalize: {path} send error: {e}");
            ApiError::Upstream("ML service unavailable".to_owned())
        })?;
    if !response.status().is_success() {
        tracing::warn!("finalize: {path} upstream status {}", response.status());
        return Err(ApiError::Upstream("ML service error".to_owned()));
    }
    response.json().await.map_err(|e| {
        tracing::error!("finalize: {path} parse error: {e}");
        ApiError::Upstream("ML service returned an invalid response".to_owned())
    })
}
