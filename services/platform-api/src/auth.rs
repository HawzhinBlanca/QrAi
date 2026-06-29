use axum::http::HeaderMap;
use chrono::{Duration, Utc};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

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
}

impl JwtConfig {
    pub fn new(secret: &str) -> Self {
        Self {
            encoding_key: EncodingKey::from_secret(secret.as_bytes()),
            decoding_key: DecodingKey::from_secret(secret.as_bytes()),
            token_ttl_hours: 24,
        }
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

    // Fallback: header-based auth for dev/testing (x-tenant-id, x-user-id, x-user-role)
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
