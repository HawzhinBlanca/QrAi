use std::net::SocketAddr;

use quran_ai_platform_api::{AppState, platform_router};
use sqlx::postgres::PgPoolOptions;

/// Refuse to boot in production with missing or known-weak secrets (JWT signing key and
/// the realtime ticket HMAC secret). Weak defaults let anyone forge auth tokens/tickets.
/// Local dev opts out with ALLOW_INSECURE_DEFAULTS=1.
fn ensure_secure_config() {
    let dev = std::env::var("ALLOW_INSECURE_DEFAULTS")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    if dev {
        return;
    }
    let jwt = std::env::var("JWT_SECRET").unwrap_or_default();
    if jwt.trim().is_empty()
        || jwt == "quran-ai-dev-secret"
        || jwt == "production-secret-change-me"
        || jwt.len() < 32
    {
        panic!(
            "JWT_SECRET must be set to a strong, non-default value in production (at least 32 characters). \
             Set ALLOW_INSECURE_DEFAULTS=1 for local dev only."
        );
    }
    let ticket = std::env::var("REALTIME_GATEWAY_TICKET_SECRET").unwrap_or_default();
    if ticket.trim().is_empty()
        || ticket == "smoke-secret"
        || ticket == "production-secret-change-me"
        || ticket.len() < 32
    {
        panic!(
            "REALTIME_GATEWAY_TICKET_SECRET must be set to a strong, non-default value in \
             production (shared with the realtime gateway, at least 32 characters). Set ALLOW_INSECURE_DEFAULTS=1 for local dev only."
        );
    }
    // ML_API_KEY is the only credential gating the ML inference service; a hardcoded default would
    // leave it reachable with a publicly-known key on any non-compose deploy that forgets to set it.
    let ml_key = std::env::var("ML_API_KEY").unwrap_or_default();
    if ml_key.trim().is_empty() || ml_key == "smoke-ml-api-key" {
        panic!(
            "ML_API_KEY must be set to a non-default value in production (it is the only credential \
             gating the ML inference service). Set ALLOW_INSECURE_DEFAULTS=1 for local dev only."
        );
    }
}

fn redact_database_url(database_url: &str) -> String {
    redact_query_password(&redact_authority_password(database_url))
}

fn redact_authority_password(database_url: &str) -> String {
    let Some(scheme_end) = database_url.find("://") else {
        return database_url.to_owned();
    };
    let authority_start = scheme_end + "://".len();
    let after_scheme = &database_url[authority_start..];
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    let Some(at_index) = authority.rfind('@') else {
        return database_url.to_owned();
    };
    let userinfo = &authority[..at_index];
    let Some(password_separator) = userinfo.rfind(':') else {
        return database_url.to_owned();
    };

    format!(
        "{}{}:***@{}{}",
        &database_url[..authority_start],
        &userinfo[..password_separator],
        &authority[at_index + 1..],
        &after_scheme[authority_end..]
    )
}

fn redact_query_password(database_url: &str) -> String {
    let Some(query_start) = database_url.find('?') else {
        return database_url.to_owned();
    };
    let (prefix, query_and_fragment) = database_url.split_at(query_start + 1);
    let (query, fragment) = query_and_fragment
        .split_once('#')
        .map(|(query, fragment)| (query, format!("#{fragment}")))
        .unwrap_or((query_and_fragment, String::new()));
    let redacted_query = query
        .split('&')
        .map(|part| {
            let Some((key, _value)) = part.split_once('=') else {
                return part.to_owned();
            };
            if key.eq_ignore_ascii_case("password") {
                format!("{key}=***")
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("&");

    format!("{prefix}{redacted_query}{fragment}")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ensure_secure_config();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "quran_ai_platform_api=info,tower_http=info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://hawzhin@localhost:5432/quran_ai".to_owned());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .map_err(|e| {
            eprintln!(
                "Failed to connect to Postgres at {}: {e}",
                redact_database_url(&database_url)
            );
            e
        })?;

    let jwt_secret =
        std::env::var("JWT_SECRET").unwrap_or_else(|_| "quran-ai-dev-secret".to_owned());

    let state = AppState::new(pool, &jwt_secret);

    let addr: SocketAddr = std::env::var("PLATFORM_API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
        .parse()?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("quran-ai platform api listening on http://{addr}");

    axum::serve(
        listener,
        platform_router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::redact_database_url;

    #[test]
    fn redacts_password_in_database_url_authority() {
        assert_eq!(
            redact_database_url("postgresql://api_user:secret-password@db.internal:5432/quran_ai"),
            "postgresql://api_user:***@db.internal:5432/quran_ai"
        );
    }

    #[test]
    fn redacts_password_query_parameter() {
        assert_eq!(
            redact_database_url(
                "postgresql://db.internal/quran_ai?sslmode=require&password=secret-password"
            ),
            "postgresql://db.internal/quran_ai?sslmode=require&password=***"
        );
    }

    #[test]
    fn leaves_passwordless_database_url_readable() {
        assert_eq!(
            redact_database_url("postgresql://db.internal:5432/quran_ai"),
            "postgresql://db.internal:5432/quran_ai"
        );
    }
}
