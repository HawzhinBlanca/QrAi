use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::types::*;

pub async fn list_audit_events(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Result<Json<Vec<AuditEvent>>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let rows = sqlx::query(
        "SELECT id, tenant_id, actor_id, action, subject_type, subject_id, metadata
         FROM audit_events
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 200",
    )
    .bind(&actor.tenant_id)
    .fetch_all(&mut *tx)
    .await?;

    let events = rows
        .into_iter()
        .map(|r| {
            let metadata: serde_json::Value = r.try_get("metadata").unwrap_or_default();
            let trace_id = metadata
                .get("trace_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_owned());
            AuditEvent {
                id: r.try_get("id").unwrap_or_default(),
                tenant_id: r.try_get("tenant_id").unwrap_or_default(),
                actor_id: r.try_get("actor_id").unwrap_or_default(),
                trace_id,
                action: r.try_get("action").unwrap_or_default(),
                subject_type: r.try_get("subject_type").unwrap_or_default(),
                subject_id: r.try_get("subject_id").unwrap_or_default(),
            }
        })
        .collect();

    tx.commit().await?;

    Ok(Json(events))
}
