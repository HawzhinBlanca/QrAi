use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, header};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::AppState;
use crate::types::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapRequest {
    pub token: String,
}

pub async fn bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BootstrapRequest>,
) -> Result<(HeaderMap, Json<Value>), ApiError> {
    // 1. Origin verification for pilot session bootstrap (exact allowlist when
    // CORS_ALLOWED_ORIGINS is configured; presence-only in dev)
    crate::auth::require_allowed_origin(&headers, &state.jwt_config.pilot_allowed_origins)?;

    // 2. Hash the bootstrap invitation token
    let mut invite_hasher = Sha256::new();
    invite_hasher.update(req.token.as_bytes());
    let invite_hash = format!("{:x}", invite_hasher.finalize());

    // 3. Atomically verify and consume the invitation
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| ApiError::Database(e.to_string()))?;

    let row =
        sqlx::query("SELECT tenant_id, learner_id FROM app.consume_pilot_invitation_by_hash($1)")
            .bind(&invite_hash)
            .fetch_optional(&mut *tx)
            .await?;

    let Some(row) = row else {
        return Err(ApiError::Unauthorized);
    };

    let tenant_id: String = row.try_get("tenant_id")?;
    let learner_id: String = row.try_get("learner_id")?;

    // Set local tenant_id for RLS and query user profile (bound set_config, matching
    // begin_tenant_tx — never string-interpolate into SQL)
    sqlx::query("SELECT set_config('app.tenant_id', $1, true)")
        .bind(&tenant_id)
        .execute(&mut *tx)
        .await?;

    let user_row =
        sqlx::query("SELECT display_name, role FROM users WHERE id = $1 AND tenant_id = $2")
            .bind(&learner_id)
            .bind(&tenant_id)
            .fetch_one(&mut *tx)
            .await?;

    let display_name: String = user_row.try_get("display_name")?;
    let role: String = user_row.try_get("role")?;

    if role != "learner" {
        return Err(ApiError::Forbidden);
    }

    // 4. Generate new session token, session ID, and CSRF token
    let session_token = uuid::Uuid::new_v4().to_string();
    let session_id = next_id("pilot-session");
    let csrf_token = uuid::Uuid::new_v4().to_string();

    let mut session_hasher = Sha256::new();
    session_hasher.update(session_token.as_bytes());
    let session_hash = format!("{:x}", session_hasher.finalize());

    let now = Utc::now();
    let idle_expires_at = now + Duration::hours(8);
    let absolute_expires_at = now + Duration::hours(24);

    sqlx::query(
        "INSERT INTO pilot_sessions (id, tenant_id, learner_id, token_hash, csrf_token, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)"
    )
    .bind(&session_id)
    .bind(&tenant_id)
    .bind(&learner_id)
    .bind(&session_hash)
    .bind(&csrf_token)
    .bind(idle_expires_at)
    .bind(absolute_expires_at)
    .execute(&mut *tx)
    .await?;

    // Create bootstrap audit event
    let audit_id = next_id("audit");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, $2, $3, 'pilot.session.bootstrap', 'user', $3)",
    )
    .bind(&audit_id)
    .bind(&tenant_id)
    .bind(&learner_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Set cookie headers
    let mut resp_headers = HeaderMap::new();
    let cookie_val = format!(
        "__Host-qrai-pilot={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800",
        session_token
    );
    resp_headers.insert(
        header::SET_COOKIE,
        cookie_val
            .parse()
            .map_err(|e: axum::http::header::InvalidHeaderValue| {
                ApiError::BadRequest(format!("Failed to parse cookie: {e}"))
            })?,
    );

    Ok((
        resp_headers,
        Json(json!({
            "userId": learner_id,
            "tenantId": tenant_id,
            "displayName": display_name,
            "role": role,
            "csrfToken": csrf_token,
        })),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<Value>), ApiError> {
    // Look up the cookie to find the active session to revoke
    if let Some(cookie_header) = headers.get("cookie")
        && let Ok(cookie_str) = cookie_header.to_str()
    {
        for cookie in cookie_str.split(';') {
            let cookie = cookie.trim();
            if let Some(val) = cookie.strip_prefix("__Host-qrai-pilot=") {
                let mut hasher = Sha256::new();
                hasher.update(val.as_bytes());
                let session_hash = format!("{:x}", hasher.finalize());

                // Find session using SECURITY DEFINER function to bypass initial RLS
                let row = sqlx::query(
                    "SELECT id, tenant_id, learner_id FROM app.get_pilot_session_by_hash($1)",
                )
                .bind(&session_hash)
                .fetch_optional(&state.pool)
                .await?;

                if let Some(row) = row {
                    let session_id: String = row.try_get("id")?;
                    let tenant_id: String = row.try_get("tenant_id")?;
                    let learner_id: String = row.try_get("learner_id")?;

                    // Revoke session under a tenant transaction
                    let mut tx = crate::begin_tenant_tx(&state.pool, &tenant_id).await?;
                    sqlx::query("UPDATE pilot_sessions SET revoked_at = now() WHERE id = $1")
                        .bind(&session_id)
                        .execute(&mut *tx)
                        .await?;

                    // Audit logout
                    let audit_id = next_id("audit");
                    sqlx::query(
                        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
                         VALUES ($1, $2, $3, 'pilot.session.logout', 'user', $3)"
                    )
                    .bind(&audit_id)
                    .bind(&tenant_id)
                    .bind(&learner_id)
                    .execute(&mut *tx)
                    .await?;

                    tx.commit().await?;
                }
            }
        }
    }

    // Set cookie clearing headers
    let mut resp_headers = HeaderMap::new();
    let cookie_val = "__Host-qrai-pilot=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    resp_headers.insert(
        header::SET_COOKIE,
        cookie_val
            .parse()
            .map_err(|e: axum::http::header::InvalidHeaderValue| {
                ApiError::BadRequest(format!("Failed to parse cookie: {e}"))
            })?,
    );

    Ok((resp_headers, Json(json!({ "status": "logged_out" }))))
}
