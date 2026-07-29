use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::types::*;

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
    let finding_exists =
        sqlx::query("SELECT 1 FROM tajweed_findings WHERE id = $1 AND tenant_id = $2")
            .bind(&req.finding_id)
            .bind(&actor.tenant_id)
            .fetch_optional(&mut *tx)
            .await?;
    if finding_exists.is_none() {
        return Err(ApiError::NotFound);
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
        "SELECT tf.id, tf.alignment_id, wa.word_id, tf.rule, tf.severity,
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
