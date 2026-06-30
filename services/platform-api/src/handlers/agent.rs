use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

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

    let rows = sqlx::query(
        "SELECT id, name, goal, status, confidence, review_status, source_refs, trace
         FROM agent_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&state.pool)
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
            serde_json::json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "goal": r.try_get::<String, _>("goal").unwrap_or_default(),
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
                "confidence": r.try_get::<f64, _>("confidence").unwrap_or(0.0),
                "reviewStatus": r.try_get::<String, _>("review_status").unwrap_or_default(),
                "sources": sources,
                "lastEvent": last_event,
            })
        })
        .collect();

    Ok(Json(out))
}
