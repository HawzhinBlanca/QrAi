use axum::Router;
use axum::response::IntoResponse;
use sqlx::PgPool;
use std::sync::Arc;
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

pub mod auth;
pub mod handlers;
pub mod types;

use auth::JwtConfig;

pub const REALTIME_TICKET_TTL_SECONDS: u64 = 300;
use hmac::Mac;
type HmacSha256 = hmac::Hmac<sha2::Sha256>;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub jwt_config: Arc<JwtConfig>,
}

impl AppState {
    pub fn new(pool: PgPool, jwt_secret: &str) -> Self {
        Self {
            pool,
            jwt_config: Arc::new(JwtConfig::new(jwt_secret)),
        }
    }

    /// Construct with an explicit header-auth toggle (tests/embedders that must not
    /// depend on the process-wide ALLOW_HEADER_AUTH env var).
    pub fn with_header_auth(pool: PgPool, jwt_secret: &str, allow_header_auth: bool) -> Self {
        Self {
            pool,
            jwt_config: Arc::new(JwtConfig::with_header_auth(jwt_secret, allow_header_auth)),
        }
    }
}

pub fn platform_router(state: AppState) -> Router {
    platform_router_with_rate_limit(state, true)
}

pub fn platform_router_with_rate_limit(state: AppState, rate_limit: bool) -> Router {
    // Restrict CORS origins in production via CORS_ALLOWED_ORIGINS (comma-separated).
    // Unset = permissive (dev/pilot, no-login preview).
    let allow_origin = match std::env::var("CORS_ALLOWED_ORIGINS") {
        Ok(v) if !v.trim().is_empty() => {
            let origins: Vec<axum::http::HeaderValue> =
                v.split(',').filter_map(|o| o.trim().parse().ok()).collect();
            tower_http::cors::AllowOrigin::list(origins)
        }
        _ => tower_http::cors::AllowOrigin::any(),
    };
    let cors = CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods(Any)
        .allow_headers(Any);

    let base_router = Router::new()
        .route("/health", axum::routing::get(health))
        .route(
            "/v1/auth/token",
            axum::routing::post(handlers::auth::issue_token),
        )
        .route(
            "/v1/auth/register",
            axum::routing::post(handlers::user::register),
        )
        .route("/v1/auth/login", axum::routing::post(handlers::user::login))
        .route(
            "/v1/recitation-sessions",
            axum::routing::get(handlers::recitation::list_sessions)
                .post(handlers::recitation::create_session),
        )
        .route(
            "/v1/recitation-sessions/{id}",
            axum::routing::get(handlers::recitation::get_session),
        )
        .route(
            "/v1/recitation-sessions/{id}/alignments",
            axum::routing::get(handlers::recitation::list_session_alignments),
        )
        .route(
            "/v1/tajweed-findings",
            axum::routing::get(handlers::review::list_tajweed_findings),
        )
        .route(
            "/v1/realtime-session-tickets",
            axum::routing::post(handlers::recitation::create_realtime_ticket),
        )
        .route(
            "/v1/teacher-reviews",
            axum::routing::post(handlers::review::create_teacher_review),
        )
        .route(
            "/v1/teacher-review-queue",
            axum::routing::get(handlers::review::list_teacher_review_queue),
        )
        .route(
            "/v1/scholar-approvals",
            axum::routing::get(handlers::review::list_scholar_approvals)
                .post(handlers::review::create_scholar_approval),
        )
        .route(
            "/v1/agent-runs",
            axum::routing::get(handlers::agent::list_agent_runs)
                .post(handlers::agent::create_agent_run),
        )
        .route(
            "/v1/eval-runs/{model_version}",
            axum::routing::get(handlers::eval::get_eval_run),
        )
        .route(
            "/v1/quran/surahs",
            axum::routing::get(handlers::quran::list_surahs),
        )
        .route(
            "/v1/quran/surahs/{surah_number}",
            axum::routing::get(handlers::quran::get_surah),
        )
        .route(
            "/v1/quran/ayahs/{surah_number}/{ayah_number}",
            axum::routing::get(handlers::quran::get_ayah),
        )
        .route(
            "/v1/privacy/export",
            axum::routing::post(handlers::privacy::create_privacy_export),
        )
        .route(
            "/v1/privacy/delete",
            axum::routing::post(handlers::privacy::create_privacy_delete),
        )
        .route(
            "/v1/audit-events",
            axum::routing::get(handlers::audit::list_audit_events),
        )
        .route(
            "/v1/learner/progress",
            axum::routing::get(handlers::progress::get_progress),
        )
        .route(
            "/v1/learner/progress",
            axum::routing::post(handlers::progress::update_progress),
        )
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    if rate_limit {
        let governor_conf = GovernorConfigBuilder::default()
            .per_second(60)
            .burst_size(100)
            .finish()
            .unwrap();
        base_router.layer(GovernorLayer {
            config: governor_conf.into(),
        })
    } else {
        base_router
    }
}

async fn health() -> impl IntoResponse {
    (axum::http::StatusCode::OK, "ok")
}

/// Begin a transaction scoped to a tenant so Postgres Row-Level-Security enforces tenant
/// isolation at the DATABASE layer (defense in depth on top of the app-level WHERE tenant_id
/// filters). Uses `set_config(..., is_local => true)` (SET LOCAL) so the context resets when
/// the transaction ends and the pooled connection is safely reused.
///
/// In dev the connection role is a superuser (RLS bypassed), so this is a no-op there and
/// behavior is unchanged; in production (a restricted, non-superuser role) it activates the
/// policies defined in infra/sql/0003 + 0009.
pub async fn begin_tenant_tx<'a>(
    pool: &'a PgPool,
    tenant_id: &str,
) -> Result<sqlx::Transaction<'a, sqlx::Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.tenant_id', $1, true)")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

pub fn realtime_ticket_secret() -> String {
    std::env::var("REALTIME_GATEWAY_TICKET_SECRET").unwrap_or_else(|_| "smoke-secret".to_owned())
}

pub fn issue_realtime_ticket(
    session_id: &str,
    tenant_id: &str,
    learner_id: &str,
    external_asr_processing: bool,
    expires_at_unix_seconds: u64,
    nonce: &str,
    secret: &str,
) -> String {
    let payload = format!(
        "{session_id}.{tenant_id}.{learner_id}.{external_asr_processing}.{expires_at_unix_seconds}.{nonce}"
    );
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    let signature = to_hex(&mac.finalize().into_bytes());
    format!(
        "rt_v1.{session_id}.{tenant_id}.{learner_id}.{external_asr_processing}.{expires_at_unix_seconds}.{nonce}.{signature}"
    )
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub fn unix_now_seconds() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}
