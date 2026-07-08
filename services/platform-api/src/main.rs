use std::net::SocketAddr;

use quran_ai_platform_api::{AppState, platform_router};
use sqlx::postgres::PgPoolOptions;

/// Parse DATABASE_MAX_CONNECTIONS, falling back to 10 for anything absent, unparseable, or zero
/// (a zero-size pool would deadlock on the first query). Pure so it can be unit-tested.
fn max_connections_from_env(raw: Option<String>) -> u32 {
    raw.and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(10)
}

/// Parse DATABASE_ACQUIRE_TIMEOUT_SECS, defaulting to 10s for anything absent, unparseable, or
/// zero (a zero timeout would fail acquires instantly). Pure so it can be unit-tested.
fn acquire_timeout_secs_from_env(raw: Option<String>) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(10)
}

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
    // ASR_API_KEY gates the ASR inference service, which the browser reaches only via the
    // platform-api /v1/asr/* proxy (the key stays server-side). A publicly-known default would let
    // anyone hit the ASR service directly on a deploy that forgets to set it.
    let asr_key = std::env::var("ASR_API_KEY").unwrap_or_default();
    if asr_key.trim().is_empty() || asr_key == "smoke-asr-api-key" {
        panic!(
            "ASR_API_KEY must be set to a non-default value in production (it gates the ASR \
             inference service, fronted by the /v1/asr proxy). Set ALLOW_INSECURE_DEFAULTS=1 for local dev only."
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

    // LOG_FORMAT=json emits one structured JSON object per line — the shape a log aggregator
    // (Loki/CloudWatch/ELK) ingests for querying and alerting (E13/P3.7). Default stays the
    // human-readable formatter for local dev; only production sets LOG_FORMAT=json.
    let log_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "quran_ai_platform_api=info,tower_http=info".into());
    if std::env::var("LOG_FORMAT").as_deref() == Ok("json") {
        tracing_subscriber::fmt()
            .with_env_filter(log_filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(log_filter).init();
    }

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://hawzhin@localhost:5432/quran_ai".to_owned());

    // Pool size is tunable per deployment: a single classroom of ~20-30 learners reciting near
    // simultaneously can saturate a fixed small pool, after which requests queue on acquire and
    // surface as errors indistinguishable from an outage. Raise DATABASE_MAX_CONNECTIONS for the
    // real pilot host; default 10 for local/dev (P3.8).
    let max_connections = max_connections_from_env(std::env::var("DATABASE_MAX_CONNECTIONS").ok());

    // Fail fast when the pool is saturated instead of hanging on sqlx's 30s default acquire timeout:
    // a shorter wait surfaces a retryable 503 (PoolTimedOut → ApiError::Unavailable) in bounded time,
    // rather than the request appearing to hang then erroring. Tunable via DATABASE_ACQUIRE_TIMEOUT_SECS.
    let acquire_timeout_secs =
        acquire_timeout_secs_from_env(std::env::var("DATABASE_ACQUIRE_TIMEOUT_SECS").ok());

    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(std::time::Duration::from_secs(acquire_timeout_secs))
        .connect(&database_url)
        .await
        .map_err(|e| {
            eprintln!(
                "Failed to connect to Postgres at {}: {e}",
                redact_database_url(&database_url)
            );
            e
        })?;

    // Defense-in-depth: if the API connects as a superuser / BYPASSRLS role, EVERY RLS policy is a
    // no-op and tenant isolation rests solely on per-handler filters. Refuse to boot in production in
    // that case (dev/CI opt out with ALLOW_INSECURE_DEFAULTS=1), mirroring infra/sql/rls-app-role.sql.
    if !std::env::var("ALLOW_INSECURE_DEFAULTS")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false)
    {
        let (rolname, rolsuper, rolbypassrls): (String, bool, bool) = sqlx::query_as(
            "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        )
        .fetch_one(&pool)
        .await?;
        if rolsuper || rolbypassrls {
            panic!(
                "DB role '{rolname}' is superuser/bypassrls — RLS tenant isolation is INERT. Connect \
                 as a restricted role (see infra/sql/rls-app-role.sql), or set ALLOW_INSECURE_DEFAULTS=1 \
                 for local dev only."
            );
        }
    }

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
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    tracing::info!("quran-ai platform api shut down cleanly");
    Ok(())
}

/// Resolves on SIGTERM (container stop / redeploy) or Ctrl-C. axum's graceful shutdown then stops
/// accepting new connections and lets in-flight requests drain, so a routine deploy no longer
/// aborts requests mid-flight (P3.10).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::{acquire_timeout_secs_from_env, max_connections_from_env, redact_database_url};

    #[test]
    fn max_connections_defaults_to_10_and_rejects_invalid_or_zero() {
        assert_eq!(max_connections_from_env(None), 10);
        assert_eq!(max_connections_from_env(Some("".to_owned())), 10);
        assert_eq!(
            max_connections_from_env(Some("not-a-number".to_owned())),
            10
        );
        assert_eq!(max_connections_from_env(Some("0".to_owned())), 10); // zero would deadlock
        assert_eq!(max_connections_from_env(Some("25".to_owned())), 25);
        assert_eq!(max_connections_from_env(Some("  40  ".to_owned())), 40);
    }

    #[test]
    fn acquire_timeout_defaults_to_10s_and_rejects_invalid_or_zero() {
        assert_eq!(acquire_timeout_secs_from_env(None), 10);
        assert_eq!(acquire_timeout_secs_from_env(Some("".to_owned())), 10);
        assert_eq!(acquire_timeout_secs_from_env(Some("nope".to_owned())), 10);
        assert_eq!(acquire_timeout_secs_from_env(Some("0".to_owned())), 10); // instant-fail guard
        assert_eq!(acquire_timeout_secs_from_env(Some("5".to_owned())), 5);
        assert_eq!(acquire_timeout_secs_from_env(Some("30".to_owned())), 30);
    }

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
