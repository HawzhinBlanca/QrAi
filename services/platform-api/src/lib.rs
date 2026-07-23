use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::response::IntoResponse;
use sqlx::PgPool;
use std::sync::Arc;
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

pub mod auth;
pub mod handlers;
pub mod metrics;
pub mod types;

use auth::JwtConfig;
use metrics::Metrics;

pub const REALTIME_TICKET_TTL_SECONDS: u64 = 300;

pub use quran_ai_shared_ticket::issue_realtime_ticket;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub jwt_config: Arc<JwtConfig>,
    /// Shared HTTP client for outbound requests (ML proxy, ASR proxy, audio erasure).
    /// Reuses connection pools and TLS sessions.
    pub http_client: reqwest::Client,
    /// Internal ML/ASR inference endpoints + keys — read from env at construction, kept off the
    /// browser. Held on state (not scattered env reads) so tests can point them at a mock server.
    pub ml_inference_url: String,
    pub ml_api_key: String,
    pub asr_inference_url: String,
    pub asr_api_key: String,
    /// Request metrics (counts + latency histogram), rendered as Prometheus text at `/metrics`.
    pub metrics: Arc<Metrics>,
    /// When set, `/metrics` requires `x-metrics-token` to match this value. Read once at startup.
    pub metrics_token: Option<String>,
    /// When true (dev only), `/metrics` is served without a token. Read once at startup.
    pub metrics_dev_open: bool,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

impl AppState {
    pub fn new(pool: PgPool, jwt_secret: &str) -> Self {
        Self::build(pool, JwtConfig::new(jwt_secret))
    }

    /// Construct with an explicit header-auth toggle (tests/embedders that must not
    /// depend on the process-wide ALLOW_HEADER_AUTH env var).
    pub fn with_header_auth(pool: PgPool, jwt_secret: &str, allow_header_auth: bool) -> Self {
        Self::build(
            pool,
            JwtConfig::with_header_auth(jwt_secret, allow_header_auth),
        )
    }

    fn build(pool: PgPool, jwt_config: JwtConfig) -> Self {
        Self {
            pool,
            jwt_config: Arc::new(jwt_config),
            // A bare `Client::new()` has no request timeout, so a stuck/hung ML or ASR upstream
            // (e.g. a GPU/MPS fault mid-inference) would block the calling request indefinitely
            // instead of failing over with a 502 in bounded time. 60s comfortably covers Whisper
            // transcription on CPU, which can legitimately take tens of seconds.
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("reqwest client with a fixed timeout is always constructible"),
            ml_inference_url: env_or("ML_INFERENCE_URL", "http://127.0.0.1:8090"),
            ml_api_key: env_or("ML_API_KEY", "smoke-ml-api-key"),
            asr_inference_url: env_or("ASR_INFERENCE_URL", "http://127.0.0.1:8091"),
            asr_api_key: env_or("ASR_API_KEY", "smoke-asr-api-key"),
            metrics: Arc::new(Metrics::new()),
            metrics_token: std::env::var("METRICS_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            metrics_dev_open: std::env::var("ALLOW_INSECURE_DEFAULTS")
                .map(|v| v == "1")
                .unwrap_or(false),
        }
    }

    /// Override `/metrics` access for tests (avoids process-env races in the parallel test suite).
    pub fn with_metrics_access(mut self, token: Option<&str>, dev_open: bool) -> Self {
        self.metrics_token = token.map(str::to_owned);
        self.metrics_dev_open = dev_open;
        self
    }

    /// Point the ML inference endpoint at a specific URL (tests use a mock server so the audio
    /// erasure / proxy paths run without a live ML service).
    pub fn with_ml_inference_url(mut self, url: impl Into<String>) -> Self {
        self.ml_inference_url = url.into();
        self
    }

    /// Point the ASR inference endpoint at a specific URL (tests use a mock server so the
    /// transcribe proxy path runs without a live ASR service).
    pub fn with_asr_inference_url(mut self, url: impl Into<String>) -> Self {
        self.asr_inference_url = url.into();
        self
    }
}

pub fn platform_router(state: AppState) -> Router {
    // Rate limiting is on by default; set DISABLE_RATE_LIMIT=1 to turn it off (local dev /
    // preview, where a browser fires bursts of requests from a single IP).
    let rate_limit = std::env::var("DISABLE_RATE_LIMIT")
        .map(|v| v != "1")
        .unwrap_or(true);
    platform_router_with_rate_limit(state, rate_limit)
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
        .route("/ready", axum::routing::get(ready))
        .route("/metrics", axum::routing::get(metrics_endpoint))
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
            "/v1/learners/active",
            axum::routing::get(handlers::recitation::list_active_learners),
        )
        .route(
            "/v1/recitation-sessions/{id}",
            axum::routing::get(handlers::recitation::get_session),
        )
        .route(
            "/v1/recitation-sessions/{id}/alignments",
            axum::routing::get(handlers::recitation::list_session_alignments)
                .post(handlers::recitation::persist_session_alignments),
        )
        .route(
            "/v1/recitation-sessions/{id}/request-teacher-review",
            axum::routing::post(handlers::recitation::request_teacher_review),
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
            "/v1/pilot/session/bootstrap",
            axum::routing::post(handlers::pilot::bootstrap),
        )
        .route(
            "/v1/pilot/session/logout",
            axum::routing::post(handlers::pilot::logout),
        )
        .route(
            "/v1/learner/progress",
            axum::routing::get(handlers::progress::get_progress),
        )
        .route(
            "/v1/learner/progress",
            axum::routing::post(handlers::progress::update_progress),
        )
        .route(
            "/v1/learner/progress/weekly",
            axum::routing::get(handlers::progress::get_weekly_progress),
        )
        .route(
            "/v1/ml/alignments:predict",
            axum::routing::post(handlers::ml_proxy::proxy_predict_alignment),
        )
        .route(
            "/v1/ml/tajweed-findings:predict",
            axum::routing::post(handlers::ml_proxy::proxy_predict_tajweed),
        )
        // ASR transcription proxy: the browser posts recorded audio here (never to the ASR service
        // directly), and the platform API forwards it with the server-side ASR_API_KEY. Audio is far
        // larger than a JSON prediction, so this route raises the 2 MB Axum default to 16 MB (a few
        // minutes of 16 kHz mono base64 WAV); other routes keep the small default.
        .route(
            "/v1/asr/transcribe",
            axum::routing::post(handlers::ml_proxy::proxy_asr_transcribe)
                .layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        // Forced alignment (T3): audio + canonical transcript → per-word timestamps. Same auth +
        // server-side ASR key + 16 MB audio limit as transcribe; the browser never reaches the ASR
        // service directly.
        .route(
            "/v1/asr/force-align",
            axum::routing::post(handlers::ml_proxy::proxy_asr_force_align)
                .layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        // Record request counts + latency for every route (matched-path labels keep cardinality
        // bounded). Applied inside TraceLayer so it wraps the actual handlers.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            track_metrics,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let rate_limited = if rate_limit {
        // per_millisecond/per_second set the REPLENISH PERIOD (time to regain ONE request),
        // not a rate. The old `per_second(60)` therefore meant "1 request per 60s" after the
        // burst — a single browser page load (~15 requests) would exhaust a 100 burst in a
        // few interactions and then get throttled to ~1 req/min. Replenish one request every
        // 50ms (~20 req/s sustained) with a 200 burst: generous for a real client, still a
        // backstop against abuse.
        //
        // Keying: default is the PEER IP. Behind a reverse proxy every request shares the
        // proxy's IP, collapsing this to a single global bucket — set TRUST_PROXY_HEADERS=1
        // to key off X-Forwarded-For/X-Real-IP instead. That is spoofable if the service is
        // exposed directly (a client sets the header to dodge the limit), so it is opt-in and
        // must only be enabled behind a proxy that OVERWRITES those headers.
        let trust_proxy = std::env::var("TRUST_PROXY_HEADERS")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false);
        if trust_proxy {
            let conf = GovernorConfigBuilder::default()
                .per_millisecond(50)
                .burst_size(200)
                .key_extractor(tower_governor::key_extractor::SmartIpKeyExtractor)
                .finish()
                .unwrap();
            base_router.layer(GovernorLayer {
                config: conf.into(),
            })
        } else {
            let conf = GovernorConfigBuilder::default()
                .per_millisecond(50)
                .burst_size(200)
                .finish()
                .unwrap();
            base_router.layer(GovernorLayer {
                config: conf.into(),
            })
        }
    } else {
        base_router
    };

    // CORS MUST be the outermost layer. Otherwise the rate limiter (GovernorLayer) sees
    // requests first: it rate-limits CORS preflight OPTIONS and returns 429s that never pass
    // back through CorsLayer, so they carry no Access-Control-Allow-Origin header and the
    // browser rejects them — breaking the whole app during any burst of requests. With CORS
    // outermost, it short-circuits preflight OPTIONS (never rate-limited) and every response,
    // including a genuine 429, gets CORS headers the browser can read.
    rate_limited.layer(cors)
}

async fn health() -> impl IntoResponse {
    (axum::http::StatusCode::OK, "ok")
}

/// Readiness (distinct from `/health` liveness): the process can actually SERVE, i.e. its DB pool
/// answers. Returns 503 when Postgres is unreachable so orchestrators / compose healthchecks can
/// tell "process up" from "up but every request will fail" — during a DB outage `/health` stays
/// 200 while `/ready` correctly goes 503 (P3.6).
async fn ready(axum::extract::State(state): axum::extract::State<AppState>) -> impl IntoResponse {
    match sqlx::query("SELECT 1").execute(&state.pool).await {
        Ok(_) => (axum::http::StatusCode::OK, "ready"),
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "not ready"),
    }
}

/// Records request count + latency for every routed request (matched-path label keeps cardinality
/// bounded — `/v1/…/{id}/…` collapses to one series regardless of the id).
async fn track_metrics(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let method = request.method().as_str().to_owned();
    let path = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|m| m.as_str().to_owned())
        .unwrap_or_else(|| "<unmatched>".to_owned());
    let start = std::time::Instant::now();
    let response = next.run(request).await;
    let latency_ms = start.elapsed().as_millis() as u64;
    state
        .metrics
        .record(&method, &path, response.status().as_u16(), latency_ms);
    response
}

/// Prometheus scrape endpoint. Access is fail-closed in production: it serves metrics only when the
/// request presents `x-metrics-token` matching the `METRICS_TOKEN` env var. In dev
/// (`ALLOW_INSECURE_DEFAULTS=1`) with no token configured it is open. Otherwise it 404s — hiding the
/// endpoint's existence — so metrics are never public by default (the audit flagged the gateway's
/// /metrics as publicly exposed; this API must not repeat that).
async fn metrics_endpoint(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    if !metrics_access_allowed(&state, &headers) {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        state.metrics.render(),
    )
        .into_response()
}

fn metrics_access_allowed(state: &AppState, headers: &axum::http::HeaderMap) -> bool {
    match &state.metrics_token {
        Some(token) => headers
            .get("x-metrics-token")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == token)
            .unwrap_or(false),
        // No token configured: allow only in explicit dev mode, otherwise fail closed.
        None => state.metrics_dev_open,
    }
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

// issue_realtime_ticket is now re-exported from quran_ai_shared_ticket.

pub fn unix_now_seconds() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}
