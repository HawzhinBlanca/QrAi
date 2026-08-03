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

pub async fn create_teacher_review(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Json(req): Json<TeacherReviewRequest>,
) -> Result<Json<TeacherReview>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // The finding must exist in this tenant. Without this check a dangling finding_id
    // fails the FK constraint and surfaces as a 500; a missing referenced entity is a
    // 404. RLS scopes the lookup to the caller's tenant.
    let finding = sqlx::query(
        "SELECT jsonb_array_length(source_refs) AS source_count
         FROM tajweed_findings WHERE id = $1 AND tenant_id = $2",
    )
    .bind(&req.finding_id)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    let finding = finding.ok_or(ApiError::NotFound)?;

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
        "INSERT INTO teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&review_id)
    .bind(&actor.tenant_id)
    .bind(&req.finding_id)
    .bind(author_id)
    .bind(decision_str)
    .bind(&req.note)
    .bind(&audit_id)
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
        finding_id: req.finding_id,
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
        "SELECT id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id
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
                finding_id: r.try_get("finding_id").unwrap_or_default(),
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
    Json(req): Json<ScholarApprovalRequest>,
) -> Result<Json<ScholarApproval>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Scholar, ActorRole::Admin, ActorRole::Ops])?;

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
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[
        ActorRole::Teacher,
        ActorRole::Scholar,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        // `wa.transcript_source` travels with the finding because this queue is where a teacher
        // DECIDES. A finding anchored to a `client-reported` alignment rests on words the learner's
        // browser supplied — possibly its own Web Speech recognition, possibly nothing recited at
        // all — while a `server-derived` one rests on audio this platform transcribed itself.
        // Promoting the first to `teacher-reviewed` makes it learner-visible feedback (ADR-0028)
        // about a recitation nobody can show happened, and until now the queue gave a teacher no way
        // to tell the two apart.
        "SELECT tf.id, tf.alignment_id, wa.word_id, wa.transcript_source, tf.rule, tf.severity,
                tf.confidence::float8 AS confidence, tf.explanation, tf.review_status, tf.source_refs
         FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
         WHERE tf.tenant_id = $1
         -- tf.id breaks ties: confidence is NOT unique (findings routinely share 0.9), so with the
         -- LIMIT below Postgres would drop an ARBITRARY subset of the tied rows at the cutoff and
         -- return a different set run to run. Verified: with 205 findings and LIMIT 200, a seeded
         -- finding appeared or vanished depending on tie ordering. Any ORDER BY feeding a LIMIT
         -- needs a unique tiebreaker to be reproducible (and to paginate correctly later).
         ORDER BY tf.confidence DESC, tf.id LIMIT 200",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| {
            let sources: serde_json::Value =
                r.try_get("source_refs").unwrap_or(serde_json::json!([]));
            serde_json::json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "wordId": r.try_get::<String, _>("word_id").unwrap_or_default(),
                // `server-derived` | `client-reported` — what this finding's evidence rests on.
                "transcriptSource": r
                    .try_get::<String, _>("transcript_source")
                    .unwrap_or_else(|_| "client-reported".to_owned()),
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

    Ok(Json(out))
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
