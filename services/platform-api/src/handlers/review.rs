use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::types::*;

/// Minimum confidence for anything a learner is shown. The same number as
/// `canShowLearnerFacingAiOutput` (packages/contracts/src/index.ts), `learnerMinConfidence`
/// (apps/flutter/lib/src/api/models.dart), the agent-run gate in `handlers/agent.rs`, and
/// `services/node-api`. tests/contract/tajweed-gate-parity.test.mjs pins all of them against each
/// other, so this cannot be lowered in one language alone.
pub const LEARNER_MIN_CONFIDENCE: f64 = 0.82;

/// The learner-facing gate, in Rust: an approved review status, enough confidence, and at least one
/// source. An ALLOWLIST of statuses, for the reason the TypeScript original spells out — a denylist
/// fails OPEN on any status this code has not heard of, and failing open here means handing a
/// learner an unreviewed judgement about their recitation.
pub(crate) fn clears_learner_gate(
    review_status: &str,
    confidence: f64,
    sources: &serde_json::Value,
) -> bool {
    let approved = review_status == "teacher-reviewed" || review_status == "scholar-approved";
    let has_source = sources.as_array().is_some_and(|s| !s.is_empty());
    approved && confidence >= LEARNER_MIN_CONFIDENCE && has_source
}

/// What a reviewer can do with this finding's audio.
///
///   available     a stored chunk covers the finding's span, and consent permits keeping it
///   discarded     consent said `discard`; the recording was destroyed on purpose
///   not-captured  retention was permitted, but no audio was stored for this span
///   unknown       retention could not be established — never offered for playback
///
/// Consent is checked FIRST and is authoritative. A chunk existing under `discard` consent is a
/// retention BUG, and answering `available` would invite a teacher to listen to a recording that
/// should not exist. `discard` means `discarded`, whatever happens to be on disk.
///
/// A missing consent record is `unknown`, not `not-captured`: those are different claims, and only
/// one of them is true when the row a session's retention policy lives in has gone.
pub(crate) fn audio_status(audio_retention: Option<String>, has_audio: bool) -> &'static str {
    match audio_retention.as_deref() {
        Some("discard") => "discarded",
        None => "unknown",
        Some(_) if has_audio => "available",
        Some(_) => "not-captured",
    }
}

/// `GET /v1/tajweed-findings/{id}/audio` — the recitation a finding is about, for the person judging it.
///
/// ADR-0037. The bytes travel THROUGH here rather than via a signed URL handed to the client: a URL
/// that grants access is a credential outliving the check that produced it, unrevocable when consent
/// is withdrawn mid-window, and its audit record would say a link was issued rather than that a
/// recording was heard.
///
/// ── Who ──────────────────────────────────────────────────────────────────────────────────────────
/// Exactly the roles that can RECORD A DECISION about the finding — `create_teacher_review`'s list.
/// Scholar is deliberately absent even though a scholar can READ the finding queue: reviewing
/// content for religious accuracy does not require listening to a particular child's voice, and this
/// is a child's voice. Whoever can decide needs to hear; nobody else does.
///
/// ── Order ────────────────────────────────────────────────────────────────────────────────────────
/// authenticate -> authorize -> find in tenant -> consent -> AUDIT -> fetch.
///
/// The audit row is written BEFORE the bytes are requested, so a transfer that dies halfway is still
/// recorded as an attempt. It is written AFTER authorization, so an unauthenticated caller cannot
/// write rows into the audit log by asking.
pub async fn get_finding_audio(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    axum::extract::Path(finding_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // One query for the finding, its span, its learner, its consent and its chunk. Tenant-scoped on
    // the finding AND on the chunk: `ac.tenant_id = tf.tenant_id` is not decoration, it is what stops
    // a chunk id from another tenant being reachable through a finding in this one.
    let row = sqlx::query(
        "SELECT rs.learner_id, cr.audio_retention,
                ac.id AS chunk_id, ac.start_ms AS chunk_start_ms, ac.end_ms AS chunk_end_ms,
                wa.start_ms AS finding_start_ms, wa.end_ms AS finding_end_ms,
                (SELECT count(*) FROM audio_chunks c2
                  WHERE c2.session_id = wa.session_id AND c2.tenant_id = tf.tenant_id
                    AND c2.start_ms < wa.end_ms AND c2.end_ms > wa.start_ms) AS overlapping
         FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
         LEFT JOIN recitation_sessions rs ON rs.id = wa.session_id
         LEFT JOIN consent_records cr ON cr.id = rs.consent_record_id
         LEFT JOIN audio_chunks ac ON ac.session_id = wa.session_id
              AND ac.tenant_id = tf.tenant_id
              AND ac.start_ms < wa.end_ms AND ac.end_ms > wa.start_ms
         WHERE tf.id = $1 AND tf.tenant_id = $2
         -- Earliest overlapping chunk. A word can straddle a chunk boundary; `overlapping` tells the
         -- caller when there is more rather than pretending this one is the whole word.
         ORDER BY ac.start_ms ASC NULLS LAST
         LIMIT 1",
    )
    .bind(&finding_id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;

    // 404 whether the finding does not exist or belongs to another tenant. Distinguishing them would
    // let a teacher in one tenant confirm a finding id in another.
    let row = row.ok_or(ApiError::NotFound)?;

    let retention: Option<String> = row.try_get("audio_retention").unwrap_or(None);
    let chunk_id: Option<String> = row.try_get("chunk_id").unwrap_or(None);
    let learner_id: Option<String> = row.try_get("learner_id").unwrap_or(None);

    let status = audio_status(retention.clone(), chunk_id.is_some());

    // ── The audit row, before anything else is decided ──────────────────────────────────────────
    // EVERY authorized attempt, not only the ones that return bytes. "Who tried to listen to this
    // child's recording, and what happened" is the question a pilot has to answer, and an attempt on
    // a discarded recording is at least as interesting as a successful one. The outcome is recorded
    // WITH the attempt, so the row never claims audio was heard when it was not.
    //
    // After authorization, so an unauthenticated caller cannot write rows into the audit log by
    // asking. Before the bytes, so a transfer that dies halfway still leaves the record.
    let audit_id = next_id("audit");
    let trace_id = crate::auth::extract_trace_id(&headers);
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'recitation.audio.read', 'tajweed_finding', $4, $5)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&finding_id)
    .bind(serde_json::json!({
        "trace_id": trace_id,
        "outcome": status,
        "chunk_id": chunk_id,
        "learner_id": learner_id,
    }))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    match status {
        // 410 Gone, not 404: the finding exists and the recording DID exist. The learner asked for it
        // to be destroyed and it was. A 404 would read as "we lost it" or "not yet", and a teacher
        // would keep coming back.
        "discarded" => {
            return Err(ApiError::Gone(
                "this recording was discarded at the learner's request".to_owned(),
            ));
        }
        "unknown" => {
            return Err(ApiError::Gone(
                "retention for this recording cannot be established".to_owned(),
            ));
        }
        "not-captured" => return Err(ApiError::NotFound),
        _ => {}
    }
    let chunk_id = chunk_id.ok_or(ApiError::NotFound)?;
    let learner_id = learner_id.ok_or(ApiError::NotFound)?;

    // The object key's PARTS, never the key — and `tenant_id` is the ACTOR's, never a value read
    // from the row. A tenant id taken from data is a tenant id an attacker can influence.
    let upstream = state
        .http_client
        .post(format!("{}/v1/audio-objects:read", state.ml_inference_url))
        .header("content-type", "application/json")
        .header("x-ml-api-key", &state.ml_api_key)
        .json(&serde_json::json!({
            "tenantId": actor.tenant_id,
            "learnerId": learner_id,
            "chunkId": chunk_id,
        }))
        .send()
        .await
        .map_err(|e| {
            tracing::error!("audio read send error: {e}");
            ApiError::Upstream("audio storage unavailable".to_owned())
        })?;

    if upstream.status() == reqwest::StatusCode::GONE {
        // ml-inference checks the retention stored ALONGSIDE the bytes. Reaching this means the two
        // records disagree — the consent row said retain, the object said otherwise. Refuse, and say
        // so loudly server-side: a disagreement about whether a child's recording may be played is
        // not a routine 4xx.
        tracing::error!(
            "retention disagreement for finding {finding_id}: consent said {retention:?}, storage refused"
        );
        return Err(ApiError::Gone(
            "this recording was not retained for review".to_owned(),
        ));
    }
    if upstream.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(ApiError::NotFound);
    }
    if !upstream.status().is_success() {
        tracing::warn!("audio read upstream status {}", upstream.status());
        return Err(ApiError::Upstream("audio storage error".to_owned()));
    }

    let object: serde_json::Value = upstream.json().await.map_err(|e| {
        tracing::error!("audio read parse error: {e}");
        ApiError::Upstream("audio storage returned an invalid response".to_owned())
    })?;

    let overlapping: i64 = row.try_get("overlapping").unwrap_or(0);
    Ok(Json(serde_json::json!({
        "audioBase64": object.get("audioBase64").cloned().unwrap_or(serde_json::Value::Null),
        "auditEventId": audit_id,
        "chunkId": chunk_id,
        // How much of the word this chunk actually covers, so a client can say "part of this word is
        // in the next chunk" instead of playing a fragment as though it were the whole thing.
        "chunksOverlappingFinding": overlapping,
        "endMs": object.get("endMs").cloned().unwrap_or(serde_json::Value::Null),
        "findingEndMs": row.try_get::<i32, _>("finding_end_ms").unwrap_or(0),
        "findingStartMs": row.try_get::<i32, _>("finding_start_ms").unwrap_or(0),
        "sampleRate": object.get("sampleRate").cloned().unwrap_or(serde_json::Value::Null),
        "startMs": object.get("startMs").cloned().unwrap_or(serde_json::Value::Null),
    })))
}

pub async fn create_teacher_review(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: JsonBody<TeacherReviewRequest>,
) -> Result<Json<TeacherReview>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;
    let Json(req) = body?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // The finding must exist in this tenant. Without this check a dangling finding_id
    // fails the FK constraint and surfaces as a 500; a missing referenced entity is a
    // 404. RLS scopes the lookup to the caller's tenant.
    // `reviewed_finding` is captured in the SAME read that validates the finding exists, so the
    // snapshot is of the row this decision was actually made against. Re-reading it afterwards would
    // leave a window in which the finding changed between the check and the copy.
    let finding = sqlx::query(
        "SELECT jsonb_array_length(tf.source_refs) AS source_count,
                jsonb_build_object(
                  'findingId',    tf.id,
                  'wordId',       wa.word_id,
                  'sessionId',    wa.session_id,
                  'rule',         tf.rule,
                  'severity',     tf.severity,
                  'confidence',   tf.confidence::float8,
                  'explanation',  tf.explanation,
                  'reviewStatus', tf.review_status,
                  'sources',      tf.source_refs
                ) AS reviewed_finding
         FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
         WHERE tf.id = $1 AND tf.tenant_id = $2",
    )
    .bind(&req.finding_id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    let finding = finding.ok_or(ApiError::NotFound)?;
    let reviewed_finding: serde_json::Value = finding
        .try_get("reviewed_finding")
        .unwrap_or_else(|_| serde_json::json!({}));

    // ── Accepting an UNSOURCED finding is refused ───────────────────────────────────────────────
    // `create_scholar_approval` already refuses the same hazard (`ApiError::MissingSources`) and a
    // teacher acceptance is now the other way content reaches a learner (ADR-0027), so it needed the
    // same server-side answer. Until this, the only thing withholding an unsourced acceptance was
    // `canShowLearnerFacingAiOutput` in the CLIENT — one laxer future client away from showing a
    // learner a judgement about their recitation with nothing standing behind it.
    //
    // Refused BEFORE anything is written, as the scholar path is, so a rejected acceptance leaves no
    // row and no audit trail implying one was considered.
    //
    // Only `accepted`. Rejecting or editing an unsourced finding is exactly what a teacher SHOULD be
    // able to do with one, and refusing those would trap it in the queue forever.
    let source_count: i32 = finding.try_get("source_count").unwrap_or(0);
    if req.decision == TeacherDecision::Accepted && source_count == 0 {
        return Err(ApiError::BadRequest(
            "a finding with no source cannot be released to a learner; reject it, or have a source \
             added first"
                .to_owned(),
        ));
    }

    let review_id = next_id("teacher-review");
    let audit_id = next_id("audit");
    let trace_id = crate::auth::extract_trace_id(&headers);
    let decision_str = match req.decision {
        TeacherDecision::Accepted => "accepted",
        TeacherDecision::Rejected => "rejected",
        TeacherDecision::Edited => "edited",
    };

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'review.teacher.submitted', 'teacher_review', $4, $5)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&review_id)
    .bind(serde_json::json!({"trace_id": trace_id, "decision": decision_str}))
    .execute(&mut *tx)
    .await?;

    // The review author is the AUTHENTICATED actor — never a caller-supplied teacher_id.
    // Trusting req.teacher_id let any teacher attribute a review to another user (even a
    // cross-tenant user, since users(id) is a platform-global FK). req.teacher_id is ignored.
    let author_id = &actor.user_id;
    sqlx::query(
        "INSERT INTO teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id, reviewed_finding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&review_id)
    .bind(&actor.tenant_id)
    .bind(&req.finding_id)
    .bind(author_id)
    .bind(decision_str)
    .bind(&req.note)
    .bind(&audit_id)
    // What the teacher was looking at. A review that outlives its finding (see
    // 0024_teacher_review_survives_realignment.sql) says "a teacher rejected something" without it.
    .bind(&reviewed_finding)
    .execute(&mut *tx)
    .await?;

    // ── The decision reaches the finding ────────────────────────────────────────────────────────
    // Until ADR-0027 this handler recorded a review and stopped. Nothing anywhere updated
    // `tajweed_findings.review_status`, so an ACCEPTED finding stayed `ai-suggested`, stayed below
    // `canShowLearnerFacingAiOutput`, and the learner saw "waiting for a teacher to review"
    // permanently. Teachers could work the queue forever and change nothing.
    //
    // Same transaction as the review row and the audit event, deliberately: a promotion without its
    // audit trail is learner-facing content nobody can account for, and a review row whose
    // promotion was lost is a teacher's decision silently dropped. Either half alone is worse than
    // neither.
    //
    // `edited` promotes NOTHING. It means the teacher rewrote the explanation, and there is nowhere
    // to store the rewrite — `teacher_reviews.note` is free text that no reader ever folds back
    // into the finding. Promoting would publish the ORIGINAL wording as teacher-approved: precisely
    // the text the teacher said was wrong. So the finding stays pending and stays in the queue,
    // which is the truth about its state.
    let promoted = match req.decision {
        TeacherDecision::Accepted => Some("teacher-reviewed"),
        TeacherDecision::Rejected => Some("blocked"),
        TeacherDecision::Edited => None,
    };
    if let Some(status) = promoted {
        // Tenant-scoped like every other write here: RLS already restricts the transaction, and the
        // predicate makes the scope explicit rather than implicit in the session variable.
        sqlx::query(
            "UPDATE tajweed_findings SET review_status = $1 WHERE id = $2 AND tenant_id = $3",
        )
        .bind(status)
        .bind(&req.finding_id)
        .bind(&actor.tenant_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(Json(TeacherReview {
        id: review_id,
        teacher_id: actor.user_id.clone(),
        tenant_id: actor.tenant_id,
        // Freshly written, so it is about a live finding by construction.
        finding_id: Some(req.finding_id),
        superseded_at: None,
        decision: req.decision,
        note: req.note,
        audit_event_id: audit_id,
    }))
}

pub async fn list_teacher_review_queue(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Result<Json<Vec<TeacherReview>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        "SELECT id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id,
                to_char(superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS superseded_at
         FROM teacher_reviews WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 200",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let reviews = rows
        .into_iter()
        .map(|r| {
            let decision_str: String = r.try_get("decision").unwrap_or_default();
            let decision = match decision_str.as_str() {
                "accepted" => TeacherDecision::Accepted,
                "rejected" => TeacherDecision::Rejected,
                "edited" => TeacherDecision::Edited,
                _ => TeacherDecision::Accepted,
            };
            TeacherReview {
                id: r.try_get("id").unwrap_or_default(),
                tenant_id: r.try_get("tenant_id").unwrap_or_default(),
                // NULL is the answer, not a failure to read one: a detached review genuinely has
                // no finding. `unwrap_or_default()` on a String turned that into `""`.
                finding_id: r.try_get("finding_id").ok().flatten(),
                superseded_at: r.try_get("superseded_at").ok().flatten(),
                teacher_id: r.try_get("teacher_id").unwrap_or_default(),
                decision,
                note: r.try_get("note").unwrap_or_default(),
                audit_event_id: r.try_get("audit_event_id").unwrap_or_default(),
            }
        })
        .collect();

    tx.commit().await?;

    Ok(Json(reviews))
}

pub async fn create_scholar_approval(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: JsonBody<ScholarApprovalRequest>,
) -> Result<Json<ScholarApproval>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Scholar, ActorRole::Admin, ActorRole::Ops])?;
    let Json(req) = body?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    if req.status == ScholarDecision::ScholarApproved && req.sources.is_empty() {
        return Err(ApiError::MissingSources);
    }
    if req.status == ScholarDecision::ScholarApproved && req.risk == RiskLevel::High {
        return Err(ApiError::HighRiskApproval);
    }

    let approval_id = next_id("scholar-approval");
    let audit_id = next_id("audit");
    let trace_id = crate::auth::extract_trace_id(&headers);
    let status_str = match req.status {
        ScholarDecision::Draft => "draft",
        ScholarDecision::ScholarApproved => "scholar-approved",
        ScholarDecision::Blocked => "blocked",
    };
    let risk_str = match req.risk {
        RiskLevel::Low => "low",
        RiskLevel::Medium => "medium",
        RiskLevel::High => "high",
    };
    let sources_json = serde_json::to_value(&req.sources).unwrap_or_default();

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'review.scholar.approved', 'scholar_approval', $4, $5)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&approval_id)
    .bind(serde_json::json!({"trace_id": trace_id}))
    .execute(&mut *tx)
    .await?;

    // The reviewer is the AUTHENTICATED actor, never a caller-supplied reviewer_id (which
    // would allow attributing an approval to another user). req.reviewer_id is ignored.
    sqlx::query(
        "INSERT INTO scholar_approvals (id, tenant_id, topic, reviewer_id, status, risk, source_refs, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&approval_id)
    .bind(&actor.tenant_id)
    .bind(&req.topic)
    .bind(&actor.user_id)
    .bind(status_str)
    .bind(risk_str)
    .bind(&sources_json)
    .bind(&audit_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(ScholarApproval {
        id: approval_id,
        reviewer_id: actor.user_id.clone(),
        tenant_id: actor.tenant_id,
        topic: req.topic,
        status: req.status,
        risk: req.risk,
        sources: req.sources,
        audit_event_id: audit_id,
    }))
}

pub async fn list_scholar_approvals(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[
        ActorRole::Scholar,
        ActorRole::Teacher,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        "SELECT id, topic, reviewer_id, status, risk, source_refs
         FROM scholar_approvals WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 200",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| {
            let sources: serde_json::Value =
                r.try_get("source_refs").unwrap_or(serde_json::json!([]));
            let source_count = sources.as_array().map(|a| a.len()).unwrap_or(0);
            serde_json::json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "topic": r.try_get::<String, _>("topic").unwrap_or_default(),
                "reviewer": r.try_get::<String, _>("reviewer_id").unwrap_or_default(),
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
                "risk": r.try_get::<String, _>("risk").unwrap_or_default(),
                "sourceCount": source_count,
            })
        })
        .collect();

    tx.commit().await?;

    Ok(Json(out))
}

/// Read-only: tajweed findings for the tenant (internal Command console).
/// Teacher/Scholar/Admin/Ops only.
pub async fn list_tajweed_findings(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<(HeaderMap, Json<Vec<serde_json::Value>>), ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[
        ActorRole::Teacher,
        ActorRole::Scholar,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    // `offset` reaches SQL, so it is parsed STRICTLY rather than coerced. A string, a negative or a
    // float is a clean 400 naming the parameter — not a value the driver decides how to interpret.
    // The page size stays 200; what changes is that the rest of the queue is now reachable at all.
    let offset: i64 = match query.get("offset") {
        None => 0,
        // DIGITS ONLY, checked before `parse`. Rust's integer parser accepts a leading `+`, so
        // `+5` parsed to 5 here while the port's digits-only test refused it — a divergence a
        // strengthened hostile-input case found. `+` is also the query-string encoding for a space,
        // so `?offset=+5` is genuinely ambiguous about whether it ever meant 5; refusing it is the
        // only reading both implementations can share.
        Some(raw) => raw
            .chars()
            .all(|c| c.is_ascii_digit())
            .then(|| raw.parse::<i64>().ok())
            .flatten()
            .filter(|n| *n >= 0 && !raw.is_empty())
            .ok_or_else(|| {
                ApiError::BadRequest("offset must be a non-negative integer".to_owned())
            })?,
    };

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        // `wa.transcript_source` travels with the finding because this queue is where a teacher
        // DECIDES. A finding anchored to a `client-reported` alignment rests on words the learner's
        // browser supplied — possibly its own Web Speech recognition, possibly nothing recited at
        // all — while a `server-derived` one rests on audio this platform transcribed itself.
        // Promoting the first to `teacher-reviewed` makes it learner-visible feedback (ADR-0028)
        // about a recitation nobody can show happened, and until now the queue gave a teacher no way
        // to tell the two apart.
        // wa.session_id is SELECTed and returned as `sessionId`. It was already in this join and
        // simply never surfaced, and its absence was a real defect in the teacher queue: the web
        // client fetches this list TENANT-WIDE and then decided which findings belonged to the open
        // session by matching `wordId`. word_id is the CANONICAL id (e.g. "1:1:2"), identical for
        // every learner reciting that passage, so another learner's findings were attributed to the
        // session on screen — and a teacher's accept/reject was submitted against that finding id.
        "SELECT tf.id, tf.alignment_id, wa.session_id, wa.word_id, wa.transcript_source, tf.analysis_basis,
                tf.rule, tf.severity,
                tf.confidence::float8 AS confidence, tf.explanation, tf.review_status, tf.source_refs,
                cr.audio_retention,
                EXISTS (
                  SELECT 1 FROM audio_chunks ac
                  WHERE ac.session_id = wa.session_id
                    AND ac.tenant_id = tf.tenant_id
                    AND ac.start_ms < wa.end_ms AND ac.end_ms > wa.start_ms
                ) AS has_audio
         FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
         -- LEFT, both of them. An INNER join here would silently DROP any finding whose session or
         -- consent record has gone (erasure, or a session deleted while its finding survived), and a
         -- finding vanishing from a review queue is worse than one that cannot be played.
         LEFT JOIN recitation_sessions rs ON rs.id = wa.session_id
         LEFT JOIN consent_records cr ON cr.id = rs.consent_record_id
         WHERE tf.tenant_id = $1
         -- ── What this queue is FOR ──────────────────────────────────────────────────────────────
         -- A teacher opens this to decide what to work on, so it sorts by whether work is NEEDED and
         -- then by how long it has waited. It used to sort by confidence DESC, which is unrelated to
         -- either -- and measured against a real corpus that page held 115 already-reviewed
         -- findings, 84 ai-suggested, and ZERO of the 1781 whose status literally names the need.
         --
         -- ADR-0036 then made it worse: setting canonical-text confidence to 0 (correctly -- it was
         -- fabricated) put every NEW finding behind all 2892 legacy ones carrying 0.80-0.90, so the
         -- newest evidence became the least visible.
         --
         -- An UNRECOGNISED status sorts with the awaiting group, not the decided one. A status
         -- nobody has heard of should surface for a human rather than vanish -- the same
         -- fail-toward-visible reasoning as the learner gate allowlist, pointed the other way.
         --
         -- Oldest recitation first, because the longest wait is the most urgent and FIFO is the only
         -- order in which nothing starves.
         --
         -- rs.started_at, not tf.created_at: tajweed_findings has NO timestamp column at all. The
         -- first version of this ORDER BY assumed one and both implementations returned a database
         -- error, identically -- which is the useful kind of failure, but worth recording so the
         -- next person does not assume it either.
         --
         -- NULLS FIRST: a finding whose session has been erased still needs a human, and sinking it
         -- to the bottom of a truncated page is how an orphan becomes invisible.
         --
         -- tf.id still breaks ties: started_at is not unique across a session's findings, and any
         -- ORDER BY feeding a LIMIT needs a unique tiebreaker to be reproducible.
         ORDER BY (tf.review_status IN ('teacher-reviewed', 'blocked', 'scholar-approved')),
                  rs.started_at ASC NULLS FIRST, tf.id
         LIMIT 200 OFFSET $2",
    )
    .bind(&actor.tenant_id)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await?;

    // How deep the queue actually is. Returned as a HEADER rather than by wrapping the array in an
    // object: the response has always been a bare array, and every client reads it that way. A
    // teacher seeing 200 rows had no way to tell whether that was the whole queue or the first ten
    // per cent of it — measured at the time of writing, 1986 awaited review.
    let total_awaiting: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM tajweed_findings
         WHERE tenant_id = $1
           AND review_status NOT IN ('teacher-reviewed', 'blocked', 'scholar-approved')",
    )
    .bind(&actor.tenant_id)
    .fetch_one(&mut *tx)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| {
            let sources: serde_json::Value =
                r.try_get("source_refs").unwrap_or(serde_json::json!([]));
            serde_json::json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "sessionId": r.try_get::<String, _>("session_id").unwrap_or_default(),
                "wordId": r.try_get::<String, _>("word_id").unwrap_or_default(),
                // `server-derived` | `client-reported` — what this finding's evidence rests on.
                "transcriptSource": r
                    .try_get::<String, _>("transcript_source")
                    .unwrap_or_else(|_| "client-reported".to_owned()),
                // `canonical-text` | `acoustic` — what the finding is ABOUT (ADR-0033).
                //
                // The two answer different questions and a teacher needs both. `transcriptSource`
                // says whether the platform heard the recitation at all; `analysisBasis` says
                // whether this judgement was derived from it. Today every finding is
                // `canonical-text`: the analyser reads the passage's Uthmani text and detects where
                // a rule applies, which is true of the text and identical for every learner.
                //
                // Accepting one promotes it to learner-visible feedback about that learner's
                // recitation (ADR-0028). Whether that is the right thing to do with a text-derived
                // finding is a scholar's call; this is what makes it a call rather than an
                // assumption.
                "analysisBasis": r
                    .try_get::<String, _>("analysis_basis")
                    .unwrap_or_else(|_| "canonical-text".to_owned()),
                // Whether a reviewer can HEAR the recitation this finding is about, and if not, why.
                //
                // A teacher opening this queue is asked to accept or reject a claim about how a
                // child recited. Nothing told them whether the recording still existed: when this
                // was added, ALL 2772 findings in the corpus belonged to sessions whose consent said
                // `discard`, so the audio was destroyed on purpose — and the queue looked exactly
                // the same as if it were sitting there unplayed.
                "audioStatus": audio_status(
                    r.try_get::<Option<String>, _>("audio_retention").unwrap_or(None),
                    r.try_get::<bool, _>("has_audio").unwrap_or(false),
                ),
                "rule": r.try_get::<String, _>("rule").unwrap_or_default(),
                "severity": r.try_get::<String, _>("severity").unwrap_or_default(),
                "confidence": r.try_get::<f64, _>("confidence").unwrap_or(0.0),
                "explanation": r.try_get::<String, _>("explanation").unwrap_or_default(),
                "reviewStatus": r.try_get::<String, _>("review_status").unwrap_or_default(),
                "sources": sources,
            })
        })
        .collect();

    tx.commit().await?;

    let mut out_headers = HeaderMap::new();
    out_headers.insert(
        "x-total-awaiting",
        total_awaiting
            .to_string()
            .parse()
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("0")),
    );
    Ok((out_headers, Json(out)))
}

/// `GET /v1/recitation-sessions/{id}/tajweed-findings` — a learner's own reviewed feedback.
///
/// ── Why this route exists ───────────────────────────────────────────────────────────────────────
/// `list_tajweed_findings` reads the whole tenant's queue and is staff-only, and
/// `POST /v1/ml/tajweed-findings:predict` RE-ANALYSES rather than reading, returning fresh
/// `ai-suggested` findings every time. So until this route there was no way for a learner to see a
/// finding a teacher had approved: the promotion in `create_teacher_review` moved a row nothing
/// learner-facing ever read.
///
/// ── Ownership, not role ─────────────────────────────────────────────────────────────────────────
/// `require_self_or_any(learner_id, [Teacher, Admin, Ops])` — the same predicate `proxy_ml` uses for
/// analysis. A learner reads their OWN session and nobody else's; staff may read any session in
/// their tenant. A session that does not exist in the caller's tenant is a 404 before the ownership
/// check, so this cannot be used to probe for session ids belonging to another tenant.
///
/// ── Withheld findings are REDACTED for a learner, not removed ───────────────────────────────────
/// This route used to return every finding in full and leave the gating to the client, on the
/// reasoning that "a COUNT of pending notes is not a judgement about the recitation". The reasoning
/// was right and the code did not implement it: both clients use only whether a withheld finding
/// EXISTS (`hasWithheldFindings` in apps/web's TajweedPanel, the `isLearnerVisible` filter in
/// apps/flutter's), while the response carried `rule`, `severity`, `explanation` and `wordId` — the
/// unreviewed judgement itself — to the learner's device. A client filtering that out afterwards is
/// a display choice, not a control: one direct API call, or one client that forgets, and a learner
/// reads an AI opinion about their recitation that no teacher has approved.
///
/// So a finding that does not clear the gate keeps its row and its `reviewStatus` — the panel can
/// still say "notes are waiting for a teacher" — and loses everything that is a judgement.
///
/// Staff (the `STAFF` roles below) receive every finding intact: reviewing the unreviewed ones is
/// the entire job of the teacher queue.
pub async fn list_session_tajweed_findings(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let learner_id: String = sqlx::query_scalar(
        "SELECT learner_id FROM recitation_sessions WHERE id = $1 AND tenant_id = $2",
    )
    .bind(&id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;
    // One list, used for BOTH the authorization and the redaction decision below. Two copies of
    // "who counts as staff here" would eventually disagree, and the direction they would disagree
    // in is a learner being handed an unreviewed finding.
    const STAFF: [ActorRole; 3] = [ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops];
    actor.require_self_or_any(&learner_id, &STAFF)?;
    let is_staff = STAFF.contains(&actor.role);

    // Same columns and the same ordering as the staff queue, so the two cannot describe a finding
    // differently. `tf.id` breaks the confidence tie for a stable order.
    let rows = sqlx::query(
        "SELECT tf.id, wa.word_id, tf.rule, tf.severity, tf.confidence::float8 AS confidence,
                tf.explanation, tf.review_status, tf.source_refs
         FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
         WHERE wa.session_id = $1 AND wa.tenant_id = $2
         ORDER BY tf.confidence DESC, tf.id",
    )
    .bind(&id)
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| {
            let id = r.try_get::<String, _>("id").unwrap_or_default();
            let review_status = r.try_get::<String, _>("review_status").unwrap_or_default();
            let confidence = r.try_get::<f64, _>("confidence").unwrap_or(0.0);
            let sources = r
                .try_get::<serde_json::Value, _>("source_refs")
                .unwrap_or_else(|_| serde_json::json!([]));

            // Reported to BOTH audiences and meaning the same thing to each: staff read it as
            // "still withheld from the learner", the learner as "a note you cannot see yet".
            let withheld = !clears_learner_gate(&review_status, confidence, &sources);

            if withheld && !is_staff {
                // `confidence: 0` and `sources: []` are not filler. They make the redacted row fail
                // `canShowLearnerFacingAiOutput` and `isLearnerVisible` on their own, so a client
                // that never learns what `withheld` means still cannot display one as feedback.
                return serde_json::json!({
                    "id": id,
                    "wordId": "",
                    "rule": "",
                    "severity": "",
                    "confidence": 0.0,
                    "explanation": "",
                    "reviewStatus": review_status,
                    "sources": [],
                    "withheld": true,
                });
            }

            serde_json::json!({
                "id": id,
                "wordId": r.try_get::<String, _>("word_id").unwrap_or_default(),
                "rule": r.try_get::<String, _>("rule").unwrap_or_default(),
                "severity": r.try_get::<String, _>("severity").unwrap_or_default(),
                "confidence": confidence,
                "explanation": r.try_get::<String, _>("explanation").unwrap_or_default(),
                "reviewStatus": review_status,
                "sources": sources,
                "withheld": withheld,
            })
        })
        .collect();

    tx.commit().await?;

    Ok(Json(out))
}

#[cfg(test)]
mod audio_status_tests {
    use super::audio_status;

    /// `audio_status` decides what a reviewer is TOLD about a learner's recording, and until this
    /// module it had no Rust test at all — its only guard was the JS parity layer.
    ///
    /// Measured: replacing the whole function with `"xyzzy"` leaves `cargo test` at 97 passed, 0
    /// failed. Only `review-parity` and `audio-playback-parity` noticed. That is real coverage, one
    /// layer out, and it means a Rust-side refactor can break this while the crate's own suite stays
    /// green — the same reasoning `learner_gate_tests` below gives for pinning the status allowlist
    /// here: this is the authoritative implementation, and Rust cannot be called from Node.
    ///
    /// Found by cargo-mutants: four surviving mutants on this function, including both match-guard
    /// flips, all of which this module kills.
    #[test]
    fn consent_is_authoritative_and_checked_before_the_disk() {
        // The case that matters most. A stored chunk under `discard` consent is a RETENTION BUG;
        // answering "available" would invite a teacher to play a recording that should not exist.
        assert_eq!(audio_status(Some("discard".to_owned()), true), "discarded");
        assert_eq!(audio_status(Some("discard".to_owned()), false), "discarded");
    }

    #[test]
    fn a_missing_consent_record_is_unknown_not_a_guess() {
        // "unknown" and "not-captured" are different CLAIMS, and only one of them is true when the
        // row holding a session's retention policy has gone. Never offered for playback either way.
        assert_eq!(audio_status(None, false), "unknown");
        assert_eq!(audio_status(None, true), "unknown");
    }

    #[test]
    fn permitted_retention_reports_what_is_actually_on_disk() {
        for retention in ["teacher-review", "training-opt-in"] {
            assert_eq!(audio_status(Some(retention.to_owned()), true), "available");
            assert_eq!(
                audio_status(Some(retention.to_owned()), false),
                "not-captured"
            );
        }
    }

    #[test]
    fn every_branch_returns_a_distinct_answer() {
        // Four states that mean four different things to the person deciding whether to wait for a
        // recording. Two of them collapsing into one is how a teacher ends up waiting for audio that
        // was destroyed on purpose — and a constant-returning implementation passes every assertion
        // above that happens to expect that constant.
        let all = [
            audio_status(Some("discard".to_owned()), true),
            audio_status(None, false),
            audio_status(Some("teacher-review".to_owned()), true),
            audio_status(Some("teacher-review".to_owned()), false),
        ];
        let distinct: std::collections::BTreeSet<&str> = all.iter().copied().collect();
        assert_eq!(
            distinct.len(),
            4,
            "two audio states report the same string: {all:?}"
        );
    }
}

#[cfg(test)]
mod learner_gate_tests {
    use super::{LEARNER_MIN_CONFIDENCE, clears_learner_gate};
    use serde_json::json;

    /// `tests/contract/tajweed-gate-parity.test.mjs` proves the TypeScript and Dart gates agree, and
    /// pins this file's confidence FLOOR by reading the constant out of the source. What it cannot
    /// do is execute this function: Rust cannot be called from Node.
    ///
    /// So the term it never checked here is the STATUS ALLOWLIST — and this is the authoritative
    /// implementation. ADR-0028 moved enforcement server-side precisely because a client-side gate
    /// is a display choice, not an authorization boundary. A learner with `curl` and their own token
    /// gets whatever this function returns.
    fn sources() -> serde_json::Value {
        json!([{ "id": "s1", "title": "Tajweed reference", "citation": "Rule 1" }])
    }

    #[test]
    fn an_unrecognised_status_is_refused_because_this_is_an_allowlist() {
        // The failure a denylist produces: any status nobody thought of — a typo, one added upstream
        // without updating this gate — reaches a learner. Mirrors the "invented status" case the
        // TypeScript and Dart gates are already held to.
        assert!(
            !clears_learner_gate("definitely-fine-honest", 1.0, &sources()),
            "an unknown review status cleared the server-side learner gate"
        );
    }

    #[test]
    fn exactly_two_statuses_clear_the_gate() {
        // The control, and it is not optional: every negative assertion in this module is satisfied
        // by a function hardcoded to `false`, which would withhold ALL feedback — a different bug,
        // and one no other test here would catch.
        for status in ["teacher-reviewed", "scholar-approved"] {
            assert!(
                clears_learner_gate(status, 0.9, &sources()),
                "{status} should clear the gate"
            );
        }
        for status in [
            "draft",
            "ai-suggested",
            "teacher-review-required",
            "blocked",
        ] {
            assert!(
                !clears_learner_gate(status, 0.9, &sources()),
                "{status} must never clear the gate"
            );
        }
    }

    #[test]
    fn the_confidence_floor_is_inclusive() {
        // Which side of 0.82 clears is a real decision and the parity test pins only the NUMBER, not
        // the comparison. `>` instead of `>=` withholds every finding that lands exactly on the
        // floor, silently and forever.
        assert!(clears_learner_gate(
            "teacher-reviewed",
            LEARNER_MIN_CONFIDENCE,
            &sources()
        ));
        assert!(!clears_learner_gate(
            "teacher-reviewed",
            LEARNER_MIN_CONFIDENCE - 0.001,
            &sources()
        ));
    }

    #[test]
    fn a_finding_with_no_source_is_refused_however_confident_it_is() {
        // The whole point of the source term: "never expose learner-facing AI feedback without
        // source". Confidence cannot buy its way past it.
        assert!(!clears_learner_gate("teacher-reviewed", 1.0, &json!([])));
    }

    #[test]
    fn a_sources_field_that_is_not_an_array_is_refused_rather_than_assumed_present() {
        // `sources.as_array()` returns None for a string, an object or null. Treating "not an array"
        // as "has a source" is the fail-OPEN direction, and it is reachable: this value is
        // deserialized from ml-inference's JSON, which enforces no schema.
        for shape in [json!(null), json!("s1"), json!({ "id": "s1" }), json!(1)] {
            assert!(
                !clears_learner_gate("teacher-reviewed", 1.0, &shape),
                "a non-array sources value ({shape}) was treated as having a source"
            );
        }
    }
}

#[cfg(test)]
mod learner_gate_corpus_tests {
    use super::clears_learner_gate;

    /// The shared corpus, executed against THIS implementation.
    ///
    /// `packages/contracts/fixtures/canonical-gates.json` opens by stating its own purpose: the
    /// gates "are currently implemented once, in TypeScript. Any second implementation (a Node
    /// service, a Dart client, a Python check) must agree EXACTLY, and prose in a design doc cannot
    /// enforce that. This corpus can: every runtime loads this same file and asserts the same
    /// expectations."
    ///
    /// That last sentence was not true. `canShowLearnerFacingAiOutput` has five implementations
    /// outside TypeScript — this one, `services/node-api/routes/ml-proxy.mjs`,
    /// `services/node-api/routes/agent-write.mjs`, `services/agents/lib/gate.mjs` and
    /// `apps/flutter/lib/src/api/models.dart` — and not one of them read the file. The corpus was
    /// loaded only by the TypeScript suite, which is the language that already owns the reference
    /// implementation, so it proved that TypeScript agreed with itself.
    ///
    /// This is the authoritative gate: ADR-0028 moved enforcement server-side because a client-side
    /// check is a display choice, not an authorization boundary. A learner with `curl` and their own
    /// token gets whatever this function returns. If any implementation had to read the corpus, it
    /// was this one.
    ///
    /// The hand-written cases in `learner_gate_tests` above stay. They are not redundant: they were
    /// written against this function's own reasoning, and a corpus can only ever check the cases
    /// somebody added to it.
    const CORPUS: &str =
        include_str!("../../../../packages/contracts/fixtures/canonical-gates.json");

    #[test]
    fn rust_agrees_with_the_shared_gate_corpus_on_every_case() {
        let corpus: serde_json::Value =
            serde_json::from_str(CORPUS).expect("canonical-gates.json is not valid JSON");

        let cases = corpus["canShowLearnerFacingAiOutput"]["cases"]
            .as_array()
            .expect("canonical-gates.json has no canShowLearnerFacingAiOutput.cases array");

        // Fail CLOSED on an empty corpus. Without this, deleting every case — or renaming the key,
        // which `as_array()` on a missing value would have turned into an empty iteration had it not
        // panicked — leaves a green test that asserts nothing. Same shape as the licence gate that
        // once reported "0 unapproved" because it had received zero packages.
        assert!(
            cases.len() >= 8,
            "the shared corpus is down to {} cases for the learner gate; it had 11. A corpus that \
             shrinks silently is how this check stops meaning anything.",
            cases.len()
        );

        let mut checked = 0;
        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let input = &case["input"];
            let expected = case["expected"]
                .as_bool()
                .unwrap_or_else(|| panic!("case {name:?} has no boolean `expected`"));

            let review_status = input["reviewStatus"]
                .as_str()
                .unwrap_or_else(|| panic!("case {name:?} has no string `reviewStatus`"));
            let confidence = input["confidence"]
                .as_f64()
                .unwrap_or_else(|| panic!("case {name:?} has no numeric `confidence`"));
            let sources = &input["sources"];

            let actual = clears_learner_gate(review_status, confidence, sources);
            assert_eq!(
                actual, expected,
                "the server-side gate disagrees with the shared corpus.\n  case:     {name}\n  \
                 input:    reviewStatus={review_status:?} confidence={confidence} \
                 sources={sources}\n  corpus:   {expected}\n  this impl: {actual}"
            );
            checked += 1;
        }

        // Belt and braces: the loop above is vacuously satisfied by an empty `cases`, and the length
        // check would have to be wrong for that to happen — but "would have to be wrong" is exactly
        // the assumption that produces a guard passing for the wrong reason.
        assert_eq!(checked, cases.len(), "not every corpus case was executed");
    }

    #[test]
    fn the_corpus_contains_both_answers() {
        // A corpus of only-false cases is satisfied by a gate hardcoded to `false`, which withholds
        // every finding from every learner — silent, and no negative case would notice.
        let corpus: serde_json::Value = serde_json::from_str(CORPUS).unwrap();
        let cases = corpus["canShowLearnerFacingAiOutput"]["cases"]
            .as_array()
            .unwrap();
        let passing = cases.iter().filter(|c| c["expected"] == true).count();
        let failing = cases.iter().filter(|c| c["expected"] == false).count();
        assert!(
            passing > 0 && failing > 0,
            "the corpus has {passing} passing and {failing} failing cases; it must have both, or a \
             constant function satisfies it"
        );
    }
}
