use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
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
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Scope the whole registration to the target tenant so RLS enforces isolation on the
    // users/audit writes. (institutions is not an RLS table; the tenant-exists check is safe.)
    let mut tx = crate::begin_tenant_tx(&state.pool, &req.tenant_id).await?;

    // Verify tenant exists
    let tenant_exists = sqlx::query("SELECT id FROM institutions WHERE id = $1")
        .bind(&req.tenant_id)
        .fetch_optional(&mut *tx)
        .await?;

    if tenant_exists.is_none() {
        return Err(ApiError::NotFound);
    }

    // Validate role. Self-service registration is learner-only; elevated roles
    // (teacher/scholar/admin/ops) require an already-authenticated admin/ops caller —
    // this prevents anyone from self-registering as admin (privilege escalation).
    let role = ActorRole::parse_role(&req.role).ok_or(ApiError::Forbidden)?;
    if role != ActorRole::Learner {
        let caller = actor_from_headers(&headers, &state.jwt_config)?;
        caller.require_any(&[ActorRole::Admin, ActorRole::Ops])?;
        // An admin/ops may create elevated-role users only WITHIN THEIR OWN TENANT. The tx above is
        // scoped to the client-supplied req.tenant_id, so RLS's `with check (tenant_id =
        // app.current_tenant_id())` is satisfied for ANY tenant the caller names — role alone is not
        // enough. Without this a tenant-A admin could POST {tenantId:"B", role:"admin", password:...}
        // and mint an attacker-controlled admin in tenant B, then log in for full cross-tenant
        // takeover. Mirrors the tenant-match issue_token already enforces (handlers/auth.rs).
        if caller.tenant_id != req.tenant_id {
            return Err(ApiError::Forbidden);
        }
    }

    if !is_supported_language(&req.language) {
        return Err(ApiError::BadRequest(format!(
            "unsupported language {:?}; allowed: {SUPPORTED_LANGUAGE_CODES:?}",
            req.language
        )));
    }

    // Validate password strength
    if req.password.len() < 8 {
        return Err(ApiError::BadRequest(
            "Password must be at least 8 characters".to_string(),
        ));
    }

    // Check email uniqueness if provided. Scope explicitly by tenant_id (matching how login scopes
    // by tenant_id + email) rather than relying on the ambient RLS policy — so the check is correct
    // even if the connecting role ever bypasses RLS, and it cannot become a cross-tenant existence
    // oracle. Email uniqueness is per-tenant by design.
    if let Some(ref email) = req.email {
        let existing = sqlx::query("SELECT id FROM users WHERE email = $1 AND tenant_id = $2")
            .bind(email)
            .bind(&req.tenant_id)
            .fetch_optional(&mut *tx)
            .await?;
        if existing.is_some() {
            return Err(ApiError::BadRequest("Email already registered".to_string()));
        }
    }

    // Hash password with bcrypt (cost=12). bcrypt is CPU-bound (~hundreds of ms);
    // run it on the blocking pool so it never stalls an async worker thread.
    let password_for_hash = req.password.clone();
    let password_hash = tokio::task::spawn_blocking(move || bcrypt::hash(&password_for_hash, 12))
        .await
        .map_err(|_| ApiError::Database("password hashing task panicked".to_string()))?
        .map_err(|_| ApiError::BadRequest("Password hashing failed".to_string()))?;

    tracing::info!(tenant_id = %req.tenant_id, role = %req.role, "user registering");

    let user_id = next_id("user");

    // The SELECT-based email check above is a fast pre-check, not the enforcement: under READ
    // COMMITTED, two concurrent registrations with the same email can both pass that SELECT before
    // either commits (verified empirically — 10 concurrent requests all previously succeeded,
    // creating 10 users sharing one email, after which login-by-email non-deterministically picked
    // one). idx_users_tenant_email_unique (0013) is the real enforcement; the losing side of the
    // race gets a unique_violation here, which must map to the same clean 400 as the pre-check
    // rather than leak a raw "duplicate key value violates constraint ..." Postgres error as a 500.
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
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(ref db_err) = e
            && db_err.constraint() == Some("idx_users_tenant_email_unique")
        {
            return ApiError::BadRequest("Email already registered".to_string());
        }
        ApiError::from(e)
    })?;

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
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

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
    // Scope to the requested tenant so RLS enforces isolation on the users/audit access.
    let mut tx = crate::begin_tenant_tx(&state.pool, &req.tenant_id).await?;

    // Find user by user_id or email
    let row = if let Some(ref email) = req.email {
        sqlx::query(
            "SELECT id, tenant_id, role, display_name, password_hash FROM users WHERE email = $1 AND tenant_id = $2",
        )
        .bind(email)
        .bind(&req.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
    } else if let Some(ref user_id) = req.user_id {
        sqlx::query(
            "SELECT id, tenant_id, role, display_name, password_hash FROM users WHERE id = $1 AND tenant_id = $2",
        )
        .bind(user_id)
        .bind(&req.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        return Err(ApiError::BadRequest(
            "Either userId or email is required".to_string(),
        ));
    };

    // Do NOT early-return when the user is absent or has no password: that makes "no such user"
    // measurably faster than "wrong password" and leaks account existence through response latency.
    // Instead always run exactly one bcrypt verify — against the real hash when present, otherwise a
    // fixed well-formed decoy of the same cost (12) — and only then decide. DUMMY_PASSWORD_HASH is a
    // bcrypt hash of a fixed placeholder string; it is NOT a credential, only a timing-equalising
    // decoy so verify burns the same CPU whether or not the account exists.
    const DUMMY_PASSWORD_HASH: &str =
        "$2b$12$ahpuA0AfJhkR6u02DgpHHu8tZ4hhhIXwUJbG8gUGLOpyWD7XCaBWq";
    let stored_hash: Option<String> = match &row {
        Some(r) => r.try_get("password_hash")?,
        None => None,
    };
    let hash_for_verify = stored_hash
        .clone()
        .unwrap_or_else(|| DUMMY_PASSWORD_HASH.to_string());
    let password_for_verify = req.password.clone();
    // bcrypt::verify is CPU-bound; keep it off the async workers. A malformed hash → treat as invalid
    // (not an error) so it still can't be distinguished by latency.
    let verified =
        tokio::task::spawn_blocking(move || bcrypt::verify(&password_for_verify, &hash_for_verify))
            .await
            .map_err(|_| ApiError::Unauthorized)?
            .unwrap_or(false);
    let row = match row {
        Some(r) if stored_hash.is_some() && verified => r,
        _ => {
            tracing::warn!(user_id = ?req.user_id, "failed login attempt");
            return Err(ApiError::Unauthorized);
        }
    };

    let user_id: String = row.try_get("id")?;
    let tenant_id: String = row.try_get("tenant_id")?;
    let role: String = row.try_get("role")?;
    let display_name: String = row.try_get("display_name")?;

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
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "userId": user_id,
        "tenantId": tenant_id,
        "role": role,
        "displayName": display_name,
        "token": token,
        "auditEventId": audit_id,
    })))
}
