use axum::http::{HeaderMap, Method};
use chrono::{Duration, Utc};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::AppState;
use crate::types::{Actor, ActorRole, ApiError};

const JWT_ALGORITHM: jsonwebtoken::Algorithm = jsonwebtoken::Algorithm::HS256;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub tenant_id: String,
    pub role: String,
    pub exp: usize,
}

#[derive(Clone)]
pub struct JwtConfig {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
    pub token_ttl_hours: i64,
    /// When true, spoofable x-tenant-id/x-user-id/x-user-role headers are accepted as a
    /// fallback identity (dev/CI only). Read once at startup from ALLOW_HEADER_AUTH.
    pub allow_header_auth: bool,
    /// Exact-match Origin allowlist for pilot-session mutating requests, read once at
    /// startup from CORS_ALLOWED_ORIGINS (same source as the CORS layer). None = unset
    /// (dev): any non-empty Origin passes, mirroring the permissive dev CORS behavior.
    pub pilot_allowed_origins: Option<Vec<String>>,
}

impl JwtConfig {
    pub fn new(secret: &str) -> Self {
        let allow_header_auth = std::env::var("ALLOW_HEADER_AUTH")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false);
        let pilot_allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS")
            .ok()
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().trim_end_matches('/').to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty());
        Self::with_header_auth(secret, allow_header_auth).with_pilot_origins(pilot_allowed_origins)
    }

    /// Explicit-toggle constructor (used by tests / embedders that must not depend on
    /// process-wide env). Production goes through `new`, which reads ALLOW_HEADER_AUTH.
    pub fn with_header_auth(secret: &str, allow_header_auth: bool) -> Self {
        Self {
            encoding_key: EncodingKey::from_secret(secret.as_bytes()),
            decoding_key: DecodingKey::from_secret(secret.as_bytes()),
            token_ttl_hours: 24,
            allow_header_auth,
            pilot_allowed_origins: None,
        }
    }

    /// Explicit origin-allowlist constructor (tests / embedders). Production goes
    /// through `new`, which reads CORS_ALLOWED_ORIGINS.
    pub fn with_pilot_origins(mut self, origins: Option<Vec<String>>) -> Self {
        self.pilot_allowed_origins = origins;
        self
    }

    pub fn issue_token(
        &self,
        user_id: &str,
        tenant_id: &str,
        role: &str,
    ) -> Result<String, ApiError> {
        let exp = (Utc::now() + Duration::hours(self.token_ttl_hours)).timestamp() as usize;
        let claims = Claims {
            sub: user_id.to_owned(),
            tenant_id: tenant_id.to_owned(),
            role: role.to_owned(),
            exp,
        };
        encode(&Header::new(JWT_ALGORITHM), &claims, &self.encoding_key)
            .map_err(|_| ApiError::Unauthorized)
    }

    pub fn validate_token(&self, token: &str) -> Result<Claims, ApiError> {
        let mut validation = Validation::new(JWT_ALGORITHM);
        validation.validate_exp = true;
        decode::<Claims>(token, &self.decoding_key, &validation)
            .map(|data| data.claims)
            .map_err(|_| ApiError::Unauthorized)
    }
}

/// Extracts an Actor from either a Bearer JWT token or fallback headers (for dev/testing).
pub fn actor_from_headers(headers: &HeaderMap, jwt: &JwtConfig) -> Result<Actor, ApiError> {
    // Try Bearer token first
    if let Some(auth_header) = headers.get("authorization")
        && let Ok(auth_str) = auth_header.to_str()
        && let Some(token) = auth_str.strip_prefix("Bearer ")
    {
        let claims = jwt.validate_token(token)?;
        let role = ActorRole::parse_role(&claims.role).ok_or(ApiError::Unauthorized)?;
        return Ok(Actor {
            tenant_id: claims.tenant_id,
            user_id: claims.sub,
            role,
        });
    }

    // Fallback: header-based identity (x-tenant-id/x-user-id/x-user-role). These are
    // spoofable, so they are honored ONLY when ALLOW_HEADER_AUTH is explicitly enabled
    // (dev/CI). In production (flag unset) we reject — a valid Bearer JWT is required.
    if !jwt.allow_header_auth {
        return Err(ApiError::Unauthorized);
    }

    let tenant_id = extract_header(headers, "x-tenant-id")?;
    let user_id = extract_header(headers, "x-user-id")?;
    let role_str = extract_header(headers, "x-user-role")?;
    let role = ActorRole::parse_role(&role_str).ok_or(ApiError::Unauthorized)?;

    Ok(Actor {
        tenant_id,
        user_id,
        role,
    })
}

/// Resolves an Actor from Bearer token, Pilot cookie, or development headers.
pub async fn resolve_actor(
    method: &Method,
    headers: &HeaderMap,
    state: &AppState,
) -> Result<Actor, ApiError> {
    // 1. Try Bearer Token first
    if let Some(auth_header) = headers.get("authorization")
        && let Ok(auth_str) = auth_header.to_str()
        && let Some(token) = auth_str.strip_prefix("Bearer ")
    {
        let claims = state.jwt_config.validate_token(token)?;
        let role = ActorRole::parse_role(&claims.role).ok_or(ApiError::Unauthorized)?;
        return Ok(Actor {
            tenant_id: claims.tenant_id,
            user_id: claims.sub,
            role,
        });
    }

    // 2. Try Pilot Session Cookie
    if let Some(cookie_header) = headers.get("cookie")
        && let Ok(cookie_str) = cookie_header.to_str()
    {
        let mut session_token = None;
        for cookie in cookie_str.split(';') {
            let cookie = cookie.trim();
            if let Some(val) = cookie.strip_prefix("__Host-qrai-pilot=") {
                session_token = Some(val.to_string());
                break;
            }
        }

        if let Some(token) = session_token {
            let mut hasher = Sha256::new();
            hasher.update(token.as_bytes());
            let token_hash = format!("{:x}", hasher.finalize());

            // Look up session from DB using SECURITY DEFINER function to bypass initial RLS
            let row = sqlx::query("SELECT id, tenant_id, learner_id, csrf_token, idle_expires_at, absolute_expires_at FROM app.get_pilot_session_by_hash($1)")
                .bind(&token_hash)
                .fetch_optional(&state.pool)
                .await?;

            if let Some(row) = row {
                let session_id: String = row.try_get("id")?;
                let tenant_id: String = row.try_get("tenant_id")?;
                let learner_id: String = row.try_get("learner_id")?;
                let csrf_token: String = row.try_get("csrf_token")?;
                let idle_expires_at: chrono::DateTime<Utc> = row.try_get("idle_expires_at")?;
                let absolute_expires_at: chrono::DateTime<Utc> =
                    row.try_get("absolute_expires_at")?;

                let now = Utc::now();
                if now > idle_expires_at || now > absolute_expires_at {
                    return Err(ApiError::Unauthorized);
                }

                // If state-changing, enforce Origin and CSRF checks
                if method == Method::POST
                    || method == Method::PUT
                    || method == Method::DELETE
                    || method == Method::PATCH
                {
                    require_allowed_origin(headers, &state.jwt_config.pilot_allowed_origins)?;

                    // CSRF check. Compare SHA-256 digests, not raw strings: digest
                    // comparison timing reveals nothing about the token itself.
                    if let Some(csrf_header) = headers.get("x-csrf-token") {
                        let csrf_val = csrf_header
                            .to_str()
                            .map_err(|_| ApiError::BadRequest("Invalid CSRF header".to_string()))?;
                        if Sha256::digest(csrf_val.as_bytes())
                            != Sha256::digest(csrf_token.as_bytes())
                        {
                            return Err(ApiError::Unauthorized);
                        }
                    } else {
                        return Err(ApiError::Unauthorized);
                    }
                }

                // Roll the idle expiry
                let new_idle = now + Duration::hours(8);
                sqlx::query("UPDATE pilot_sessions SET last_seen_at = now(), idle_expires_at = $1 WHERE id = $2")
                    .bind(new_idle)
                    .bind(&session_id)
                    .execute(&state.pool)
                    .await?;

                return Ok(Actor {
                    tenant_id,
                    user_id: learner_id,
                    role: ActorRole::Learner,
                });
            }
        }
    }

    // 3. Fallback: Header-based identity (only if allowed in dev/CI)
    if state.jwt_config.allow_header_auth
        && let Ok(tenant_id) = extract_header(headers, "x-tenant-id")
        && let Ok(user_id) = extract_header(headers, "x-user-id")
        && let Ok(role_str) = extract_header(headers, "x-user-role")
        && let Some(role) = ActorRole::parse_role(&role_str)
    {
        return Ok(Actor {
            tenant_id,
            user_id,
            role,
        });
    }

    Err(ApiError::Unauthorized)
}

/// Enforces the pilot Origin policy: the header must be present and non-empty; when an
/// allowlist is configured (CORS_ALLOWED_ORIGINS in production) it must be an exact
/// member. Shared by the auth middleware path and the bootstrap handler.
pub fn require_allowed_origin(
    headers: &HeaderMap,
    allowed: &Option<Vec<String>>,
) -> Result<(), ApiError> {
    let Some(origin_header) = headers.get("origin") else {
        return Err(ApiError::Forbidden);
    };
    let origin = origin_header
        .to_str()
        .map_err(|_| ApiError::BadRequest("Invalid origin header".to_string()))?;
    if origin.is_empty() {
        return Err(ApiError::Forbidden);
    }
    if let Some(allowed) = allowed
        && !allowed.iter().any(|a| a == origin)
    {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn extract_header(headers: &HeaderMap, name: &str) -> Result<String, ApiError> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_owned())
        .ok_or(ApiError::Unauthorized)
}

pub fn extract_trace_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-trace-id")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_token_sets_an_expiry_in_the_future_matching_the_configured_ttl() {
        let jwt = JwtConfig::with_header_auth("test-secret", false);
        let before = Utc::now();
        let token = jwt.issue_token("user-1", "tenant-1", "learner").unwrap();
        let claims = jwt.validate_token(&token).unwrap();

        // A `+` -> `-` regression in issue_token would set exp to ~24h in the PAST, which
        // validate_token (via jsonwebtoken's built-in exp check) would immediately reject —
        // catch it directly on the claim value rather than relying on that indirect failure.
        let expected_exp = (before + Duration::hours(jwt.token_ttl_hours)).timestamp() as usize;
        assert!(
            claims.exp.abs_diff(expected_exp) <= 5,
            "expected exp near {expected_exp}, got {}",
            claims.exp
        );
        assert!(
            claims.exp > before.timestamp() as usize,
            "exp must be in the future, not the past"
        );
    }

    fn header_identity() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-tenant-id", "tenant-1".parse().unwrap());
        headers.insert("x-user-id", "user-1".parse().unwrap());
        headers.insert("x-user-role", "learner".parse().unwrap());
        headers
    }

    #[test]
    fn header_identity_is_rejected_when_header_auth_is_disabled() {
        // Security boundary: in production (ALLOW_HEADER_AUTH unset -> allow_header_auth=false),
        // spoofable x-tenant-id/x-user-id/x-user-role headers must NEVER be honored as identity —
        // a valid Bearer JWT is required. Pins `if !jwt.allow_header_auth { return Unauthorized }`
        // directly and fast: deleting that `!` (or flipping the flag's meaning) would accept the
        // spoofed identity in production, and only the slow full integration suite caught that
        // before — a fast unit test makes the regression unmissable.
        let jwt = JwtConfig::with_header_auth("test-secret", false);
        let result = actor_from_headers(&header_identity(), &jwt);
        assert!(matches!(result, Err(ApiError::Unauthorized)));
    }

    #[test]
    fn header_identity_is_accepted_when_header_auth_is_enabled() {
        // The other side of the same gate: in dev/CI (allow_header_auth=true) the header fallback
        // IS honored, and yields exactly the identity the headers carry. Together with the test
        // above this pins both directions of the flag so no single mutation can pass unnoticed.
        let jwt = JwtConfig::with_header_auth("test-secret", true);
        let actor = actor_from_headers(&header_identity(), &jwt).expect("header identity accepted");
        assert_eq!(actor.tenant_id, "tenant-1");
        assert_eq!(actor.user_id, "user-1");
        assert_eq!(actor.role, ActorRole::Learner);
    }

    #[test]
    fn a_valid_bearer_token_is_accepted_even_when_header_auth_is_disabled() {
        // The Bearer path must work regardless of the header-auth flag — it's the production
        // identity mechanism. A token issued for this config validates back to the same actor.
        let jwt = JwtConfig::with_header_auth("test-secret", false);
        let token = jwt.issue_token("user-7", "tenant-9", "teacher").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        let actor = actor_from_headers(&headers, &jwt).expect("valid bearer accepted");
        assert_eq!(actor.tenant_id, "tenant-9");
        assert_eq!(actor.user_id, "user-7");
        assert_eq!(actor.role, ActorRole::Teacher);
    }

    #[test]
    fn a_bearer_token_signed_with_a_different_secret_is_rejected() {
        // A token from another signing key must not validate — pins the HS256 signature check.
        let issuer = JwtConfig::with_header_auth("issuer-secret", false);
        let verifier = JwtConfig::with_header_auth("different-secret", false);
        let token = issuer.issue_token("user-1", "tenant-1", "learner").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert!(matches!(
            actor_from_headers(&headers, &verifier),
            Err(ApiError::Unauthorized)
        ));
    }

    #[test]
    fn extract_trace_id_returns_the_trimmed_header_when_present() {
        let mut headers = HeaderMap::new();
        headers.insert("x-trace-id", "  trace-abc-123  ".parse().unwrap());
        assert_eq!(extract_trace_id(&headers), Some("trace-abc-123".to_owned()));
    }

    #[test]
    fn extract_trace_id_is_none_when_the_header_is_absent() {
        let headers = HeaderMap::new();
        assert_eq!(extract_trace_id(&headers), None);
    }

    #[test]
    fn extract_trace_id_is_none_when_the_header_is_blank() {
        let mut headers = HeaderMap::new();
        headers.insert("x-trace-id", "   ".parse().unwrap());
        assert_eq!(extract_trace_id(&headers), None);
    }
}
