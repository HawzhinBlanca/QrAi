use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::Deserialize;
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

fn empty_sources() -> serde_json::Value {
    serde_json::json!([])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub name: String,
    pub goal: String,
    pub status: String,
    pub confidence: f64,
    pub review_status: String,
    #[serde(default = "empty_sources")]
    pub sources: serde_json::Value,
    #[serde(default)]
    pub last_event: String,
    #[serde(default)]
    pub finding_id: Option<String>,
}

/// Record an agent run (written by the supervised agents service). Ops/Admin/Scholar
/// only. Enforces the source/review gate: an `approved` (learner-facing) run must cite
/// at least one source, mirroring `canShowLearnerFacingAiOutput` in packages/contracts.
pub async fn create_agent_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AgentRunRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[ActorRole::Scholar, ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    const ALLOWED: [&str; 5] = [
        "queued",
        "running",
        "needs-human-review",
        "approved",
        "blocked",
    ];
    if !ALLOWED.contains(&req.status.as_str()) {
        return Err(ApiError::BadRequest(format!(
            "invalid agent run status: {}",
            req.status
        )));
    }
    // review_status drives the learner-facing gate (canShowLearnerFacingAiOutput), so validate it
    // against the contract's allowed set here — otherwise a garbage/typo value only trips the DB CHECK
    // and surfaces as an opaque 500 instead of a clean 400.
    const ALLOWED_REVIEW: [&str; 6] = [
        "draft",
        "ai-suggested",
        "teacher-review-required",
        "teacher-reviewed",
        "scholar-approved",
        "blocked",
    ];
    if !ALLOWED_REVIEW.contains(&req.review_status.as_str()) {
        return Err(ApiError::BadRequest(format!(
            "invalid agent run review_status: {}",
            req.review_status
        )));
    }
    if !(0.0..=1.0).contains(&req.confidence) {
        return Err(ApiError::BadRequest(
            "confidence must be within [0, 1]".to_owned(),
        ));
    }
    // Full server-side mirror of canShowLearnerFacingAiOutput (packages/contracts/src/index.ts)
    // / statusForRun (services/agents/lib/gate.mjs): a status of "approved" is a claim that this
    // run's output may reach a learner directly, so it must independently satisfy every gate
    // condition here, not just the source-count check this endpoint used to enforce alone. There
    // is no separate human-approval endpoint for agent runs (unlike teacher_reviews/
    // scholar_approvals) — this POST is the ONLY place status is ever set, so trusting a
    // client-computed "approved" without re-deriving it here would let one new or misbehaving
    // agent module ship unreviewed, low-confidence content as approved.
    let source_count = req.sources.as_array().map(|a| a.len()).unwrap_or(0);
    let is_approved_review_status = matches!(
        req.review_status.as_str(),
        "teacher-reviewed" | "scholar-approved"
    );
    if req.status == "approved"
        && !(is_approved_review_status && req.confidence >= 0.82 && source_count > 0)
    {
        return Err(ApiError::BadRequest(
            "an approved agent run must have reviewStatus teacher-reviewed or scholar-approved, \
             confidence >= 0.82, and at least one source"
                .to_owned(),
        ));
    }

    let run_id = next_id("agent-run");
    let audit_id = next_id("audit");
    let trace_id = crate::auth::extract_trace_id(&headers);
    let trace = serde_json::json!({
        "last_event": req.last_event,
        "finding_id": req.finding_id,
        "trace_id": trace_id,
    });

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'agent.run.recorded', 'agent_run', $4, $5)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&run_id)
    .bind(serde_json::json!({ "trace_id": trace_id }))
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO agent_runs
            (id, tenant_id, name, goal, status, confidence, review_status, source_refs, trace, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6::float8::numeric, $7, $8, $9, $10)",
    )
    .bind(&run_id)
    .bind(&actor.tenant_id)
    .bind(&req.name)
    .bind(&req.goal)
    .bind(&req.status)
    .bind(req.confidence)
    .bind(&req.review_status)
    .bind(&req.sources)
    .bind(&trace)
    .bind(&audit_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(serde_json::json!({
        "id": run_id,
        "name": req.name,
        "goal": req.goal,
        "status": req.status,
        "confidence": req.confidence,
        "reviewStatus": req.review_status,
        "sources": req.sources,
        "lastEvent": req.last_event,
    })))
}

pub async fn list_agent_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[
        ActorRole::Teacher,
        ActorRole::Scholar,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        "SELECT id, name, goal, status, confidence::float8 AS confidence, review_status, source_refs, trace
         FROM agent_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| {
            let sources: serde_json::Value =
                r.try_get("source_refs").unwrap_or(serde_json::json!([]));
            let trace: serde_json::Value = r.try_get("trace").unwrap_or(serde_json::json!({}));
            let last_event = trace
                .get("last_event")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            // finding_id lives in the trace JSONB (create_agent_run stores it there). Surface it so
            // the agents service can dedup — skip findings that already have a run — instead of
            // re-recording every finding on every batch tick. null for cohort-level runs.
            let finding_id = trace.get("finding_id").and_then(|v| v.as_str());
            serde_json::json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "goal": r.try_get::<String, _>("goal").unwrap_or_default(),
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
                "confidence": r.try_get::<f64, _>("confidence").unwrap_or(0.0),
                "reviewStatus": r.try_get::<String, _>("review_status").unwrap_or_default(),
                "sources": sources,
                "lastEvent": last_event,
                "findingId": finding_id,
            })
        })
        .collect();

    tx.commit().await?;

    Ok(Json(out))
}
