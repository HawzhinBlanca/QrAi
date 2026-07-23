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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintInvitationRequest {
    pub learner_id: String,
    /// Validity window in hours; defaults to 168 (7 days), clamped to [1, 720] so an admin
    /// cannot mint an effectively immortal invite.
    pub ttl_hours: Option<i64>,
}

/// Admin/Ops mint a SINGLE-USE pilot invitation for a learner IN THEIR OWN TENANT (P1.6).
///
/// The raw token is returned exactly once — only its SHA-256 hash is stored, so a leaked DB row
/// cannot be replayed into a session. The learner opens `?invite=<token>`; the web app exchanges
/// it for a `__Host-qrai-pilot` cookie via `bootstrap`. This is the only way pilot invitations are
/// issued, closing the "invitation-issuance mechanism not present anywhere" gap from research.md.
pub async fn mint_invitation(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Json(req): Json<MintInvitationRequest>,
) -> Result<Json<Value>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Admin, ActorRole::Ops])?;

    let ttl_hours = req.ttl_hours.unwrap_or(168).clamp(1, 720);

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // The invited user must exist in the caller's tenant (RLS scopes the lookup) and be a learner —
    // the pilot cookie pins role=learner, so inviting a teacher/admin would silently under-privilege
    // them and is almost certainly a mistake; reject it explicitly rather than mint a dead invite.
    let target = sqlx::query("SELECT role FROM users WHERE id = $1 AND tenant_id = $2")
        .bind(&req.learner_id)
        .bind(&actor.tenant_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(target) = target else {
        return Err(ApiError::NotFound);
    };
    let target_role: String = target.try_get("role")?;
    if target_role != "learner" {
        return Err(ApiError::BadRequest(
            "pilot invitations may only target learner accounts".to_string(),
        ));
    }

    // Raw token shown once; store only its hash (mirrors bootstrap's session-token handling).
    let token = uuid::Uuid::new_v4().to_string();
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let token_hash = format!("{:x}", hasher.finalize());

    let invitation_id = next_id("pilot-invitation");
    let expires_at = Utc::now() + Duration::hours(ttl_hours);

    sqlx::query(
        "INSERT INTO pilot_invitations (id, tenant_id, learner_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&invitation_id)
    .bind(&actor.tenant_id)
    .bind(&req.learner_id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;

    let audit_id = next_id("audit");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, $2, $3, 'pilot.invitation.minted', 'user', $4)",
    )
    .bind(&audit_id)
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&req.learner_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // ponytail: per-request env read on a rare admin endpoint (not an auth decision, just a URL
    // prefix); move to AppState if invitation minting ever becomes hot. Absent base => caller builds
    // the URL from the raw token itself, which is the source of truth.
    let invite_url = std::env::var("PILOT_INVITE_BASE_URL")
        .ok()
        .filter(|b| !b.is_empty())
        .map(|base| format!("{}/?invite={}", base.trim_end_matches('/'), token));

    Ok(Json(json!({
        "invitationId": invitation_id,
        "learnerId": req.learner_id,
        "token": token,
        "inviteUrl": invite_url,
        "expiresAt": expires_at.to_rfc3339(),
    })))
}
