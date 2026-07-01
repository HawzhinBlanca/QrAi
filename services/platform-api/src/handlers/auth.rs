use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::Deserialize;
use serde_json::json;

use crate::types::*;

pub async fn issue_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TokenRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Minting a JWT for an arbitrary user is an admin/ops operation. Without this check
    // anyone who knows a (user_id, tenant_id, role) tuple could forge a session for any
    // user, bypassing login entirely. Require an authenticated admin/ops caller, scoped
    // to their own tenant.
    let caller = crate::auth::actor_from_headers(&headers, &state.jwt_config)?;
    caller.require_any(&[ActorRole::Admin, ActorRole::Ops])?;
    if caller.tenant_id != req.tenant_id {
        return Err(ApiError::Forbidden);
    }

    // Verify the user exists in the database
    let row = sqlx::query("SELECT id, tenant_id, role FROM users WHERE id = $1 AND tenant_id = $2")
        .bind(&req.user_id)
        .bind(&req.tenant_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    let user_row: (String, String, String) = (
        row.try_get("id")
            .map_err(|e| ApiError::Database(e.to_string()))?,
        row.try_get("tenant_id")
            .map_err(|e| ApiError::Database(e.to_string()))?,
        row.try_get("role")
            .map_err(|e| ApiError::Database(e.to_string()))?,
    );

    if user_row.2 != req.role {
        return Err(ApiError::Forbidden);
    }

    let token = state
        .jwt_config
        .issue_token(&req.user_id, &req.tenant_id, &req.role)?;

    // Audit records the REAL caller as actor_id and the target user as subject_id.
    let audit_id = next_id("audit");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, $2, $3, 'auth.token.issued', 'auth_token', $4)",
    )
    .bind(&audit_id)
    .bind(&req.tenant_id)
    .bind(&caller.user_id)
    .bind(&req.user_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "token": token,
        "user_id": req.user_id,
        "tenant_id": req.tenant_id,
        "role": req.role,
        "audit_event_id": audit_id,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRequest {
    pub user_id: String,
    pub tenant_id: String,
    pub role: String,
}

use crate::AppState;
use sqlx::Row;
