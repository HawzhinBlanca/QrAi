use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::AppState;
use crate::types::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub tenant_id: String,
    pub display_name: String,
    pub role: String,
    pub language: String,
    pub email: Option<String>,
    pub password: String,
}

pub async fn register(
    State(state): State<AppState>,
    _headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Verify tenant exists
    let tenant_exists = sqlx::query("SELECT id FROM institutions WHERE id = $1")
        .bind(&req.tenant_id)
        .fetch_optional(&state.pool)
        .await?;

    if tenant_exists.is_none() {
        return Err(ApiError::NotFound);
    }

    // Validate role
    let role = ActorRole::parse_role(&req.role).ok_or(ApiError::Forbidden)?;
    let _ = role;

    // Validate password strength
    if req.password.len() < 8 {
        return Err(ApiError::BadRequest(
            "Password must be at least 8 characters".to_string(),
        ));
    }

    // Check email uniqueness if provided
    if let Some(ref email) = req.email {
        let existing = sqlx::query("SELECT id FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(&state.pool)
            .await?;
        if existing.is_some() {
            return Err(ApiError::BadRequest("Email already registered".to_string()));
        }
    }

    // Hash password with bcrypt (cost=12 for production)
    let password_hash = bcrypt::hash(&req.password, 12)
        .map_err(|_| ApiError::BadRequest("Password hashing failed".to_string()))?;

    tracing::info!(tenant_id = %req.tenant_id, role = %req.role, "user registering");

    let user_id = next_id("user");

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language, password_hash, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&user_id)
    .bind(&req.tenant_id)
    .bind(&req.display_name)
    .bind(&req.role)
    .bind(&req.language)
    .bind(&password_hash)
    .bind(&req.email)
    .execute(&state.pool)
    .await?;

    // Issue JWT token
    let token = state
        .jwt_config
        .issue_token(&user_id, &req.tenant_id, &req.role)?;

    // Audit
    let audit_id = next_id("audit");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, $2, $3, 'auth.user.registered', 'user', $3)",
    )
    .bind(&audit_id)
    .bind(&req.tenant_id)
    .bind(&user_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "userId": user_id,
        "tenantId": req.tenant_id,
        "role": req.role,
        "displayName": req.display_name,
        "token": token,
        "auditEventId": audit_id,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub user_id: Option<String>,
    pub tenant_id: String,
    pub email: Option<String>,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    _headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Find user by user_id or email
    let row = if let Some(ref email) = req.email {
        sqlx::query(
            "SELECT id, tenant_id, role, display_name, password_hash FROM users WHERE email = $1 AND tenant_id = $2",
        )
        .bind(email)
        .bind(&req.tenant_id)
        .fetch_optional(&state.pool)
        .await?
    } else if let Some(ref user_id) = req.user_id {
        sqlx::query(
            "SELECT id, tenant_id, role, display_name, password_hash FROM users WHERE id = $1 AND tenant_id = $2",
        )
        .bind(user_id)
        .bind(&req.tenant_id)
        .fetch_optional(&state.pool)
        .await?
    } else {
        return Err(ApiError::BadRequest(
            "Either userId or email is required".to_string(),
        ));
    };

    let row = row.ok_or(ApiError::Unauthorized)?;

    let user_id: String = row.try_get("id")?;
    let tenant_id: String = row.try_get("tenant_id")?;
    let role: String = row.try_get("role")?;
    let display_name: String = row.try_get("display_name")?;
    let password_hash: Option<String> = row.try_get("password_hash")?;

    // Verify password
    let stored_hash = password_hash.ok_or(ApiError::Unauthorized)?;
    let valid = bcrypt::verify(&req.password, &stored_hash).map_err(|_| ApiError::Unauthorized)?;
    if !valid {
        tracing::warn!(user_id = ?req.user_id, "failed login attempt");
        return Err(ApiError::Unauthorized);
    }

    tracing::info!(user_id = %user_id, tenant_id = %tenant_id, "user logged in");

    let token = state.jwt_config.issue_token(&user_id, &tenant_id, &role)?;

    let audit_id = next_id("audit");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, $2, $3, 'auth.user.login', 'user', $3)",
    )
    .bind(&audit_id)
    .bind(&tenant_id)
    .bind(&user_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "userId": user_id,
        "tenantId": tenant_id,
        "role": role,
        "displayName": display_name,
        "token": token,
        "auditEventId": audit_id,
    })))
}
