use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

pub async fn create_teacher_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TeacherReviewRequest>,
) -> Result<Json<TeacherReview>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

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
    .execute(&state.pool)
    .await?;

    sqlx::query(
        "INSERT INTO teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&review_id)
    .bind(&actor.tenant_id)
    .bind(&req.finding_id)
    .bind(&req.teacher_id)
    .bind(decision_str)
    .bind(&req.note)
    .bind(&audit_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(TeacherReview {
        id: review_id,
        tenant_id: actor.tenant_id,
        finding_id: req.finding_id,
        teacher_id: req.teacher_id,
        decision: req.decision,
        note: req.note,
        audit_event_id: audit_id,
    }))
}

pub async fn list_teacher_review_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TeacherReview>>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops])?;

    let rows = sqlx::query(
        "SELECT id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id
         FROM teacher_reviews WHERE tenant_id = $1 ORDER BY created_at DESC",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&state.pool)
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

    Ok(Json(reviews))
}

pub async fn create_scholar_approval(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ScholarApprovalRequest>,
) -> Result<Json<ScholarApproval>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[ActorRole::Scholar, ActorRole::Admin, ActorRole::Ops])?;

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
    .execute(&state.pool)
    .await?;

    sqlx::query(
        "INSERT INTO scholar_approvals (id, tenant_id, topic, reviewer_id, status, risk, source_refs, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&approval_id)
    .bind(&actor.tenant_id)
    .bind(&req.topic)
    .bind(&req.reviewer_id)
    .bind(status_str)
    .bind(risk_str)
    .bind(&sources_json)
    .bind(&audit_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(ScholarApproval {
        id: approval_id,
        tenant_id: actor.tenant_id,
        topic: req.topic,
        reviewer_id: req.reviewer_id,
        status: req.status,
        risk: req.risk,
        sources: req.sources,
        audit_event_id: audit_id,
    }))
}

pub async fn list_scholar_approvals(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[
        ActorRole::Scholar,
        ActorRole::Teacher,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    let rows = sqlx::query(
        "SELECT id, topic, reviewer_id, status, risk, source_refs
         FROM scholar_approvals WHERE tenant_id = $1 ORDER BY created_at DESC",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&state.pool)
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

    Ok(Json(out))
}
