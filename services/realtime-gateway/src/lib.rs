use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::{RwLock, mpsc};

pub use quran_ai_shared_ticket::{
    RealtimeTicketClaims, TicketError, issue_realtime_ticket, validate_realtime_ticket,
};

/// How long a session stays counted as "active" in the shared Redis set before it self-expires by
/// score (bounds counter drift from unclean terminations). Matches the realtime ticket TTL window.
const ACTIVE_SESSION_TTL_SECONDS: u64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioChunk {
    pub session_id: String,
    pub chunk_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub sample_rate: u32,
    pub bytes: Vec<u8>,
}

impl AudioChunk {
    pub fn new(
        session_id: impl Into<String>,
        chunk_id: impl Into<String>,
        start_ms: u64,
        end_ms: u64,
        sample_rate: u32,
        bytes: Vec<u8>,
    ) -> Result<Self, GatewayError> {
        if end_ms <= start_ms {
            return Err(GatewayError::InvalidChunkTiming { start_ms, end_ms });
        }

        if !matches!(sample_rate, 16_000 | 24_000 | 48_000) {
            return Err(GatewayError::UnsupportedSampleRate(sample_rate));
        }

        if bytes.is_empty() {
            return Err(GatewayError::EmptyAudioChunk);
        }

        Ok(Self {
            session_id: session_id.into(),
            chunk_id: chunk_id.into(),
            start_ms,
            end_ms,
            sample_rate,
            bytes,
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GatewayError {
    #[error("recitation session already exists: {0}")]
    SessionAlreadyExists(String),
    #[error("recitation session not found: {0}")]
    SessionNotFound(String),
    #[error("audio channel is applying backpressure for session: {0}")]
    Backpressure(String),
    #[error("audio channel closed for session: {0}")]
    ChannelClosed(String),
    #[error(
        "invalid audio chunk timing: end_ms ({end_ms}) must be greater than start_ms ({start_ms})"
    )]
    InvalidChunkTiming { start_ms: u64, end_ms: u64 },
    #[error("unsupported sample rate: {0}")]
    UnsupportedSampleRate(u32),
    #[error("audio chunk must contain bytes")]
    EmptyAudioChunk,
}

#[derive(Clone)]
pub struct RealtimeGateway {
    sessions: Arc<RwLock<HashMap<String, mpsc::Sender<AudioChunk>>>>,
    counters: Arc<GatewayCounters>,
    chunk_capacity: usize,
    redis_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GatewayMetrics {
    pub active_sessions: usize,
    pub sessions_started: u64,
    pub sessions_ended: u64,
    pub chunks_accepted: u64,
    pub chunks_rejected_backpressure: u64,
    pub chunks_rejected_missing_session: u64,
    /// Chunks that were acked to the client but could NOT be delivered to ML after retries — the
    /// only signal that a session's analysis has gaps (see the forwarding task in handle_audio_socket).
    pub chunks_forward_failed: u64,
}

#[derive(Debug, Default)]
struct GatewayCounters {
    sessions_started: AtomicU64,
    sessions_ended: AtomicU64,
    chunks_accepted: AtomicU64,
    chunks_rejected_backpressure: AtomicU64,
    chunks_rejected_missing_session: AtomicU64,
    chunks_forward_failed: AtomicU64,
}

impl RealtimeGateway {
    pub fn new(chunk_capacity: usize) -> Self {
        Self::with_redis(chunk_capacity, None)
    }

    pub fn with_redis(chunk_capacity: usize, redis_url: Option<String>) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            counters: Arc::new(GatewayCounters::default()),
            chunk_capacity: chunk_capacity.max(1),
            redis_url,
        }
    }

    async fn redis_track_session(&self, session_id: &str, action: &str) {
        if let Some(ref _url) = self.redis_url
            && let Ok(mut conn) = redis::Client::open(_url.as_str())
                .and_then(|c| c.get_connection())
                .map_err(|e| {
                    tracing::warn!("Redis connect failed: {e}");
                    e
                })
        {
            // Active sessions live in a SORTED SET scored by expiry (unix seconds). This SELF-HEALS: a
            // session whose "end" is never recorded (dropped socket, panicking task, gateway crash or
            // restart) simply expires by score and is evicted on the next count. The previous bare
            // INCR/DECR counter had no TTL and no reconciliation, so any unclean termination or restart
            // drifted `active-session-count` upward forever with no recovery short of a manual reset.
            let zkey = "quran-ai:gateway:active-sessions";
            let _: Result<(), _> = match action {
                "start" => {
                    // Bound a session's tracked lifetime to the ticket TTL window.
                    let expiry = unix_now_seconds().saturating_add(ACTIVE_SESSION_TTL_SECONDS);
                    redis::cmd("ZADD")
                        .arg(zkey)
                        .arg(expiry)
                        .arg(session_id)
                        .query(&mut conn)
                }
                "end" => redis::cmd("ZREM")
                    .arg(zkey)
                    .arg(session_id)
                    .query(&mut conn),
                _ => Ok(()),
            };
        }
    }

    /// Cross-restart / cross-instance single-use enforcement for realtime tickets.
    ///
    /// Uses Redis `SET key 1 NX EX <ttl>` so a consumed ticket stays consumed even if
    /// this gateway process restarts or a *different* gateway instance handled the first
    /// use — the in-memory set alone loses that history on restart and is per-process.
    /// The Redis key expires with the ticket, so it never grows unbounded.
    ///
    /// Fails DEGRADED: if Redis is unconfigured or unreachable, returns `Unavailable`
    /// and the caller falls back to the in-memory consumed set (single-process
    /// protection) rather than rejecting every connection during a Redis outage.
    /// Whether a shared (Redis) replay store is configured. When false, single-use is
    /// per-process by design and fail-closed does not apply.
    fn redis_configured(&self) -> bool {
        self.redis_url.is_some()
    }

    async fn redis_mark_ticket(&self, ticket_hash: &str, ttl_seconds: u64) -> TicketDedup {
        let Some(ref url) = self.redis_url else {
            return TicketDedup::Unavailable;
        };
        let ttl = ttl_seconds.max(1);
        let key = format!("quran-ai:gateway:ticket:{ticket_hash}");
        let mut conn = match redis::Client::open(url.as_str()).and_then(|c| c.get_connection()) {
            Ok(conn) => conn,
            Err(e) => {
                tracing::warn!("Redis connect failed (ticket dedup degraded to in-memory): {e}");
                return TicketDedup::Unavailable;
            }
        };
        // `SET .. NX` returns the value ("OK") when the key was newly set, and Nil
        // (deserialized to None) when the key already existed — i.e. a replay.
        let set: redis::RedisResult<Option<String>> = redis::cmd("SET")
            .arg(&key)
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(ttl)
            .query(&mut conn);
        match set {
            Ok(Some(_)) => TicketDedup::Fresh,
            Ok(None) => TicketDedup::Replay,
            Err(e) => {
                tracing::warn!("Redis ticket dedup failed (degraded to in-memory): {e}");
                TicketDedup::Unavailable
            }
        }
    }

    pub async fn start_session(
        &self,
        session_id: impl Into<String>,
    ) -> Result<SessionReader, GatewayError> {
        let session_id = session_id.into();
        let (sender, receiver) = mpsc::channel(self.chunk_capacity);
        let mut sessions = self.sessions.write().await;

        if sessions.contains_key(&session_id) {
            return Err(GatewayError::SessionAlreadyExists(session_id));
        }

        sessions.insert(session_id.clone(), sender);
        self.counters
            .sessions_started
            .fetch_add(1, Ordering::Relaxed);
        self.redis_track_session(&session_id, "start").await;
        Ok(SessionReader {
            session_id,
            receiver,
        })
    }

    pub async fn send_chunk(&self, chunk: AudioChunk) -> Result<(), GatewayError> {
        let sender = {
            let sessions = self.sessions.read().await;
            match sessions.get(&chunk.session_id).cloned() {
                Some(sender) => sender,
                None => {
                    self.counters
                        .chunks_rejected_missing_session
                        .fetch_add(1, Ordering::Relaxed);
                    return Err(GatewayError::SessionNotFound(chunk.session_id.clone()));
                }
            }
        };

        match sender.try_send(chunk) {
            Ok(()) => {
                self.counters
                    .chunks_accepted
                    .fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(chunk)) => {
                self.counters
                    .chunks_rejected_backpressure
                    .fetch_add(1, Ordering::Relaxed);
                Err(GatewayError::Backpressure(chunk.session_id))
            }
            Err(mpsc::error::TrySendError::Closed(chunk)) => {
                Err(GatewayError::ChannelClosed(chunk.session_id))
            }
        }
    }

    pub async fn end_session(&self, session_id: &str) -> Result<(), GatewayError> {
        let mut sessions = self.sessions.write().await;
        if sessions.remove(session_id).is_some() {
            self.counters.sessions_ended.fetch_add(1, Ordering::Relaxed);
            self.redis_track_session(session_id, "end").await;
            Ok(())
        } else {
            Err(GatewayError::SessionNotFound(session_id.to_owned()))
        }
    }

    pub async fn active_session_count(&self) -> usize {
        if let Some(ref _url) = self.redis_url
            && let Ok(mut conn) = redis::Client::open(_url.as_str())
                .and_then(|c| c.get_connection())
                .map_err(|e| {
                    tracing::warn!("Redis connect failed: {e}");
                    e
                })
        {
            let zkey = "quran-ai:gateway:active-sessions";
            let now = unix_now_seconds();
            // Evict entries whose expiry has passed (stale sessions left by crashes/restarts), then
            // count the live ones. `(now` makes the bound exclusive so a session expiring exactly now
            // is still counted until the next tick.
            let _: Result<(), _> = redis::cmd("ZREMRANGEBYSCORE")
                .arg(zkey)
                .arg("-inf")
                .arg(format!("({now}"))
                .query(&mut conn);
            let count: Result<i64, _> = redis::cmd("ZCARD").arg(zkey).query(&mut conn);
            match count {
                Ok(c) => return c.max(0) as usize,
                Err(e) => {
                    tracing::warn!("Redis ZCARD active-sessions failed: {e}");
                }
            }
        }
        self.sessions.read().await.len()
    }

    pub async fn metrics(&self) -> GatewayMetrics {
        GatewayMetrics {
            active_sessions: self.active_session_count().await,
            sessions_started: self.counters.sessions_started.load(Ordering::Relaxed),
            sessions_ended: self.counters.sessions_ended.load(Ordering::Relaxed),
            chunks_accepted: self.counters.chunks_accepted.load(Ordering::Relaxed),
            chunks_rejected_backpressure: self
                .counters
                .chunks_rejected_backpressure
                .load(Ordering::Relaxed),
            chunks_rejected_missing_session: self
                .counters
                .chunks_rejected_missing_session
                .load(Ordering::Relaxed),
            chunks_forward_failed: self.counters.chunks_forward_failed.load(Ordering::Relaxed),
        }
    }

    /// Record that a chunk could not be delivered to the ML service after retries (analysis gap).
    pub fn record_forward_failure(&self) {
        self.counters
            .chunks_forward_failed
            .fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Debug)]
pub struct SessionReader {
    session_id: String,
    receiver: mpsc::Receiver<AudioChunk>,
}

impl SessionReader {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub async fn recv(&mut self) -> Option<AudioChunk> {
        self.receiver.recv().await
    }
}

#[derive(Debug, Clone)]
pub struct GatewayServerConfig {
    pub chunk_capacity: usize,
    pub sample_rate: u32,
    pub chunk_duration_ms: u64,
    pub ticket_secret: String,
    pub ml_inference_url: String,
    pub tenant_id: String,
    /// When true AND Redis is configured, reject a connection if the shared replay store is
    /// unreachable (fail CLOSED) instead of degrading to per-process single-use. Trades
    /// availability for a guarantee that a ticket used during a Redis outage can't be
    /// replayed on another instance. Default false (fail open). Env: REALTIME_TICKET_FAIL_CLOSED.
    pub ticket_fail_closed: bool,
}

impl Default for GatewayServerConfig {
    fn default() -> Self {
        Self {
            chunk_capacity: 8,
            sample_rate: 16_000,
            chunk_duration_ms: 480,
            ticket_secret: std::env::var("REALTIME_GATEWAY_TICKET_SECRET")
                .unwrap_or_else(|_| "smoke-secret".to_owned()),
            ml_inference_url: std::env::var("ML_INFERENCE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8090".to_owned()),
            tenant_id: std::env::var("GATEWAY_TENANT_ID")
                .unwrap_or_else(|_| "hikmah-pilot-erbil".to_owned()),
            ticket_fail_closed: std::env::var("REALTIME_TICKET_FAIL_CLOSED")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false),
        }
    }
}

#[derive(Clone)]
struct GatewayServerState {
    gateway: RealtimeGateway,
    config: GatewayServerConfig,
    // ticket string -> its expiry (unix seconds). Per-process fast path for single-use
    // enforcement; the authoritative cross-restart/cross-instance check is Redis when set.
    consumed_tickets: Arc<RwLock<HashMap<String, u64>>>,
    http_client: reqwest::Client,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AudioIngressAck {
    pub kind: &'static str,
    pub session_id: String,
    pub chunk_id: String,
    pub sequence: u64,
    pub accepted: bool,
    pub trace_id: Option<String>,
    pub message: String,
}

pub fn gateway_router(config: GatewayServerConfig) -> Router {
    let redis_url = std::env::var("REDIS_URL").ok();
    let gateway = RealtimeGateway::with_redis(config.chunk_capacity, redis_url);
    let consumed_tickets: Arc<RwLock<HashMap<String, u64>>> = Arc::new(RwLock::new(HashMap::new()));
    let http_client = reqwest::Client::new();

    // Spawn periodic cleanup that evicts ONLY expired consumed tickets (every 60s).
    // Only spawn if we're inside a Tokio runtime (not in tests).
    let cleanup_tickets = consumed_tickets.clone();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
                let removed = {
                    let mut tickets = cleanup_tickets.write().await;
                    evict_expired(&mut tickets, unix_now_seconds())
                };
                if removed > 0 {
                    tracing::debug!("consumed_tickets cleanup: removed {removed} expired entries");
                }
            }
        });
    }

    let rate_limited = std::env::var("ENABLE_RATE_LIMIT")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);

    let base_router = Router::new()
        .route("/health", get(health))
        .route(
            "/v1/recitation-sessions/{session_id}/audio",
            get(audio_ws).route_layer(axum::middleware::from_fn(validate_origin)),
        )
        .route("/metrics", get(metrics))
        .with_state(GatewayServerState {
            gateway,
            config,
            consumed_tickets,
            http_client,
        });

    if rate_limited {
        let conf = tower_governor::governor::GovernorConfigBuilder::default()
            .per_millisecond(50)
            .burst_size(200)
            .finish()
            .unwrap();
        base_router.layer(tower_governor::GovernorLayer {
            config: conf.into(),
        })
    } else {
        base_router
    }
}

async fn metrics(State(state): State<GatewayServerState>) -> impl IntoResponse {
    let gateway_metrics = state.gateway.metrics().await;
    let ticket_count = state.consumed_tickets.read().await.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "active_sessions": gateway_metrics.active_sessions,
            "sessions_started": gateway_metrics.sessions_started,
            "sessions_ended": gateway_metrics.sessions_ended,
            "chunks_accepted": gateway_metrics.chunks_accepted,
            "chunks_rejected_backpressure": gateway_metrics.chunks_rejected_backpressure,
            "chunks_rejected_missing_session": gateway_metrics.chunks_rejected_missing_session,
            "chunks_forward_failed": gateway_metrics.chunks_forward_failed,
            "consumed_tickets_count": ticket_count,
        })),
    )
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn validate_origin(
    headers: axum::http::HeaderMap,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> impl IntoResponse {
    let allow_insecure = std::env::var("ALLOW_INSECURE_DEFAULTS")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);

    if !allow_insecure {
        if let Some(origin_str) = headers
            .get(axum::http::header::ORIGIN)
            .and_then(|h| h.to_str().ok())
        {
            if let Ok(allowed_origins_env) = std::env::var("CORS_ALLOWED_ORIGINS") {
                let mut allowed = false;
                for allowed_origin in allowed_origins_env.split(',') {
                    if allowed_origin.trim() == origin_str.trim() {
                        allowed = true;
                        break;
                    }
                }
                if !allowed {
                    tracing::warn!(
                        "CSWSH check failed: Origin '{origin_str}' not in CORS_ALLOWED_ORIGINS"
                    );
                    return StatusCode::FORBIDDEN.into_response();
                }
            } else {
                tracing::warn!("CSWSH check failed: CORS_ALLOWED_ORIGINS unset in production");
                return StatusCode::FORBIDDEN.into_response();
            }
        } else if headers.contains_key(axum::http::header::ORIGIN) {
            tracing::warn!("CSWSH check failed: Invalid Origin header");
            return StatusCode::FORBIDDEN.into_response();
        } else {
            // No Origin header at all. Browsers ALWAYS send Origin on a cross-origin WebSocket
            // upgrade, so in strict (production) mode we fail CLOSED here rather than let the origin
            // allowlist be silently bypassed by simply omitting the header. Dev and non-browser
            // clients opt out via ALLOW_INSECURE_DEFAULTS.
            tracing::warn!("CSWSH check failed: missing Origin header");
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    next.run(request).await
}

async fn audio_ws(
    State(state): State<GatewayServerState>,
    Path(session_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    let Some(ticket) = query.get("ticket").map(String::as_str) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let claims = match validate_realtime_ticket(
        &session_id,
        ticket,
        &state.config.ticket_secret,
        unix_now_seconds(),
    ) {
        Ok(claims) => claims,
        Err(_) => return StatusCode::UNAUTHORIZED.into_response(),
    };

    // Tenant binding: a gateway instance serves exactly one tenant (GATEWAY_TENANT_ID). The HMAC
    // ticket secret is shared across services, so a ticket validly signed for ANOTHER tenant must not
    // be accepted here just because the session_id string matches — otherwise embedding tenant_id in
    // the ticket would be pointless. Reject a cross-tenant ticket.
    if claims.tenant_id != state.config.tenant_id {
        tracing::warn!(
            "realtime ticket tenant '{}' does not match gateway tenant '{}'",
            claims.tenant_id,
            state.config.tenant_id
        );
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // Single-use enforcement. Redis (when configured) makes this survive gateway
    // restarts and span multiple instances; the in-memory map is the always-on fast path
    // and the sole guard when Redis is absent. A replay seen by EITHER store is rejected.
    let now = unix_now_seconds();
    let ttl = claims.expires_at_unix_seconds.saturating_sub(now).max(1);
    let redis_dedup = state
        .gateway
        .redis_mark_ticket(&ticket_hash(ticket), ttl)
        .await;
    // Fail CLOSED (opt-in): if a shared store is configured but unreachable, we cannot
    // guarantee this ticket wasn't already used on another instance, so refuse rather than
    // fall back to per-process dedup (which would leave a cross-instance replay window).
    if state.config.ticket_fail_closed
        && state.gateway.redis_configured()
        && redis_dedup == TicketDedup::Unavailable
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let mem_replay = {
        let mut consumed_tickets = state.consumed_tickets.write().await;
        consumed_tickets
            .insert(ticket.to_owned(), claims.expires_at_unix_seconds)
            .is_some()
    };
    if mem_replay || redis_dedup == TicketDedup::Replay {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let trace_id = query
        .get("trace_id")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    upgrade
        .on_upgrade(move |socket| {
            handle_audio_socket(socket, session_id, claims.learner_id, trace_id, state)
        })
        .into_response()
}

// TicketError and RealtimeTicketClaims are re-exported from quran_ai_shared_ticket above.

/// Outcome of the cross-instance replay check (see `RealtimeGateway::redis_mark_ticket`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TicketDedup {
    /// First time this ticket was seen by the shared store.
    Fresh,
    /// The shared store already recorded this ticket — a replay.
    Replay,
    /// No shared store available (Redis unconfigured/unreachable); fall back to in-memory.
    Unavailable,
}

/// Stable, bounded-length key for a ticket in the shared replay store. We store a hash
/// rather than the raw signed ticket so Redis never holds the credential material and
/// keys stay a fixed size. Matches how platform-api derives `token_hash`.
fn ticket_hash(ticket: &str) -> String {
    format!("{:x}", Sha256::digest(ticket.as_bytes()))
}

/// Evict only consumed tickets whose own expiry has passed. The previous cleanup cleared
/// the whole set every interval, which erased the single-use marker of tickets that were
/// still valid — reopening a replay window until the ticket's real expiry. Retaining
/// unexpired entries closes that window while still bounding memory.
fn evict_expired(consumed: &mut HashMap<String, u64>, now_unix_seconds: u64) -> usize {
    let before = consumed.len();
    consumed.retain(|_, &mut expires_at| expires_at > now_unix_seconds);
    before - consumed.len()
}

// issue_realtime_ticket, validate_realtime_ticket, and related helpers are now
// provided by the quran-ai-shared-ticket crate (re-exported at the top of this file).

fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        output.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        output.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            output.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

async fn handle_audio_socket(
    mut socket: WebSocket,
    session_id: String,
    learner_id: String,
    trace_id: Option<String>,
    state: GatewayServerState,
) {
    let reader = match state.gateway.start_session(session_id.clone()).await {
        Ok(reader) => reader,
        Err(error) => {
            let _ = socket
                .send(Message::Text(
                    serialize_ack(AudioIngressAck {
                        kind: "audio.ack",
                        session_id,
                        chunk_id: "session-start".to_owned(),
                        sequence: 0,
                        accepted: false,
                        trace_id,
                        message: error.to_string(),
                    })
                    .into(),
                ))
                .await;
            return;
        }
    };
    // Spawn a task to forward audio chunks to the ML inference service
    let ml_url = state.config.ml_inference_url.clone();
    let tenant_id = state.config.tenant_id.clone();
    let ml_trace = trace_id.clone();
    let ml_api_key = std::env::var("ML_API_KEY").unwrap_or_else(|_| "smoke-ml-api-key".to_owned());
    let mut reader = reader;
    // Clone the gateway (Arc-based) into the forwarding task so it can record forward failures
    // without moving state.gateway away from the socket loop below.
    let forward_gateway = state.gateway.clone();
    tokio::spawn(async move {
        let client = state.http_client.clone();
        while let Some(chunk) = reader.recv().await {
            let chunk_id = chunk.chunk_id.clone();
            let session_id = chunk.session_id.clone();
            let url = format!("{}/v1/audio-chunks", ml_url);
            // Encode actual audio bytes as base64
            let audio_base64 = base64_encode(&chunk.bytes);
            let body = serde_json::json!({
                "tenantId": tenant_id,
                "learnerId": learner_id,
                "sessionId": session_id,
                "chunkId": chunk_id,
                "sampleRate": chunk.sample_rate,
                "startMs": chunk.start_ms,
                "endMs": chunk.end_ms,
                "audioBase64": audio_base64,
                "audioSize": chunk.bytes.len(),
                "traceId": ml_trace,
            });
            // Bounded retry: a transient ML blip (connection error / 5xx) shouldn't silently lose the
            // chunk. A 4xx is a permanent rejection (bad body) — don't hammer it. On final failure,
            // record the gap in metrics so a lossy session is observable, not just a warn line.
            const MAX_ATTEMPTS: u32 = 3;
            let mut delivered = false;
            for attempt in 1..=MAX_ATTEMPTS {
                match client
                    .post(&url)
                    .header("x-ml-api-key", &ml_api_key)
                    // Bound each attempt so a hung ML connection can't block the forwarding task
                    // (and thus back up the whole session's chunk queue) indefinitely.
                    .timeout(std::time::Duration::from_secs(5))
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        delivered = true;
                        break;
                    }
                    Ok(resp) if resp.status().is_client_error() => {
                        tracing::warn!(
                            "ML service rejected chunk {chunk_id}: {} (not retrying)",
                            resp.status()
                        );
                        break;
                    }
                    Ok(resp) => tracing::warn!(
                        "ML service returned {} for chunk {chunk_id} (attempt {attempt}/{MAX_ATTEMPTS})",
                        resp.status()
                    ),
                    Err(e) => tracing::warn!(
                        "failed to forward chunk {chunk_id} to ML (attempt {attempt}/{MAX_ATTEMPTS}): {e}"
                    ),
                }
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(100 * attempt as u64))
                        .await;
                }
            }
            if delivered {
                tracing::debug!("forwarded chunk {chunk_id} to ML service");
            } else {
                forward_gateway.record_forward_failure();
            }
        }
    });

    let mut sequence = 0_u64;

    while let Some(message) = socket.recv().await {
        match message {
            Ok(Message::Binary(bytes)) => {
                let chunk_id = format!("{session_id}-ws-{sequence:04}");
                let chunk = AudioChunk::new(
                    session_id.clone(),
                    chunk_id.clone(),
                    sequence * state.config.chunk_duration_ms,
                    (sequence + 1) * state.config.chunk_duration_ms,
                    state.config.sample_rate,
                    bytes.to_vec(),
                );
                let ack = match chunk {
                    Ok(chunk) => match state.gateway.send_chunk(chunk).await {
                        Ok(()) => AudioIngressAck {
                            kind: "audio.ack",
                            session_id: session_id.clone(),
                            chunk_id,
                            sequence,
                            accepted: true,
                            trace_id: trace_id.clone(),
                            message: "accepted".to_owned(),
                        },
                        Err(error) => AudioIngressAck {
                            kind: "audio.ack",
                            session_id: session_id.clone(),
                            chunk_id,
                            sequence,
                            accepted: false,
                            trace_id: trace_id.clone(),
                            message: error.to_string(),
                        },
                    },
                    Err(error) => AudioIngressAck {
                        kind: "audio.ack",
                        session_id: session_id.clone(),
                        chunk_id,
                        sequence,
                        accepted: false,
                        trace_id: trace_id.clone(),
                        message: error.to_string(),
                    },
                };

                let accepted = ack.accepted;
                if socket
                    .send(Message::Text(serialize_ack(ack).into()))
                    .await
                    .is_err()
                {
                    break;
                }

                if accepted {
                    sequence += 1;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(payload)) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Ok(Message::Text(_)) | Ok(Message::Pong(_)) => {}
            Err(_) => break,
        }
    }

    let _ = state.gateway.end_session(&session_id).await;
}

fn serialize_ack(ack: AudioIngressAck) -> String {
    serde_json::to_string(&ack).expect("audio ingress ack should serialize")
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use tokio::time::{Duration, timeout};

    use std::collections::HashMap;

    use super::{
        AudioChunk, GatewayError, GatewayServerConfig, RealtimeGateway, TicketDedup, TicketError,
        evict_expired, gateway_router, issue_realtime_ticket, ticket_hash,
        validate_realtime_ticket,
    };

    fn chunk(session_id: &str, chunk_id: &str) -> AudioChunk {
        AudioChunk::new(session_id, chunk_id, 0, 20, 16_000, vec![1, 2, 3, 4]).unwrap()
    }

    #[test]
    fn builds_gateway_router_for_health_and_audio_websocket_routes() {
        let _router = gateway_router(GatewayServerConfig::default());
    }

    #[test]
    fn validates_signed_realtime_tickets() {
        let secret = "test-secret";
        let ticket = issue_realtime_ticket(
            "session-1",
            "tenant-1",
            "learner-1",
            true,
            2_000,
            "nonce-1",
            secret,
        );

        let claims = validate_realtime_ticket("session-1", &ticket, secret, 1_000).unwrap();
        assert_eq!(claims.session_id, "session-1");
        assert_eq!(claims.tenant_id, "tenant-1");
        assert_eq!(claims.learner_id, "learner-1");
        assert!(claims.external_asr_processing);
        assert_eq!(
            validate_realtime_ticket("session-2", &ticket, secret, 1_000),
            Err(TicketError::SessionMismatch)
        );
        assert_eq!(
            validate_realtime_ticket("session-1", &ticket, secret, 2_000),
            Err(TicketError::Expired)
        );
        assert_eq!(
            validate_realtime_ticket("session-1", "", secret, 1_000),
            Err(TicketError::Missing)
        );
        assert_eq!(
            validate_realtime_ticket("session-1", "rt_smoke_ticket", secret, 1_000),
            Err(TicketError::Malformed)
        );
        assert_eq!(
            validate_realtime_ticket("session-1", &ticket, "wrong-secret", 1_000),
            Err(TicketError::InvalidSignature)
        );

        let tampered = ticket.replace("nonce-1", "nonce-2");
        assert_eq!(
            validate_realtime_ticket("session-1", &tampered, secret, 1_000),
            Err(TicketError::InvalidSignature)
        );
    }

    #[tokio::test]
    async fn streams_chunks_to_session_reader() {
        let gateway = RealtimeGateway::new(4);
        let mut reader = gateway.start_session("session-1").await.unwrap();

        gateway
            .send_chunk(chunk("session-1", "chunk-1"))
            .await
            .unwrap();

        let received = timeout(Duration::from_millis(50), reader.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received.chunk_id, "chunk-1");
        assert_eq!(reader.session_id(), "session-1");
    }

    #[tokio::test]
    async fn applies_backpressure_to_bounded_audio_channel() {
        let gateway = RealtimeGateway::new(1);
        let _reader = gateway.start_session("session-1").await.unwrap();

        gateway
            .send_chunk(chunk("session-1", "chunk-1"))
            .await
            .unwrap();
        let error = gateway
            .send_chunk(chunk("session-1", "chunk-2"))
            .await
            .unwrap_err();

        assert_eq!(error, GatewayError::Backpressure("session-1".to_owned()));
        assert_eq!(gateway.metrics().await.chunks_rejected_backpressure, 1);
    }

    #[tokio::test]
    async fn rejects_duplicate_and_unknown_sessions() {
        let gateway = RealtimeGateway::new(2);
        let _reader = gateway.start_session("session-1").await.unwrap();

        let duplicate = gateway.start_session("session-1").await.unwrap_err();
        let missing = gateway
            .send_chunk(chunk("missing-session", "chunk-1"))
            .await
            .unwrap_err();

        assert_eq!(
            duplicate,
            GatewayError::SessionAlreadyExists("session-1".to_owned())
        );
        assert_eq!(
            missing,
            GatewayError::SessionNotFound("missing-session".to_owned())
        );
        assert_eq!(gateway.metrics().await.chunks_rejected_missing_session, 1);
    }

    #[tokio::test]
    async fn closes_reader_after_session_end() {
        let gateway = RealtimeGateway::new(2);
        let mut reader = gateway.start_session("session-1").await.unwrap();

        gateway.end_session("session-1").await.unwrap();

        let received = timeout(Duration::from_millis(50), reader.recv())
            .await
            .unwrap();
        assert!(received.is_none());
        assert_eq!(gateway.active_session_count().await, 0);
        assert_eq!(gateway.metrics().await.sessions_ended, 1);
    }

    #[tokio::test]
    async fn forward_failure_is_counted_in_metrics() {
        // Chunks dropped after exhausting ML-forward retries must be observable (not just a warn log),
        // so an operator can see a session had analysis gaps.
        let gateway = RealtimeGateway::new(4);
        assert_eq!(gateway.metrics().await.chunks_forward_failed, 0);
        gateway.record_forward_failure();
        gateway.record_forward_failure();
        assert_eq!(gateway.metrics().await.chunks_forward_failed, 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn handles_100_session_ingestion_with_local_p95_under_150ms() {
        let gateway = RealtimeGateway::new(4);
        let mut readers = Vec::new();

        for index in 0..100 {
            readers.push(
                gateway
                    .start_session(format!("session-{index}"))
                    .await
                    .unwrap(),
            );
        }

        let mut latencies = Vec::new();
        for index in 0..100 {
            let session_id = format!("session-{index}");
            let started = Instant::now();
            gateway
                .send_chunk(chunk(&session_id, &format!("chunk-{index}")))
                .await
                .unwrap();
            latencies.push(started.elapsed());
        }
        latencies.sort();

        let p95 = latencies[94];
        let metrics = gateway.metrics().await;

        assert_eq!(readers.len(), 100);
        assert_eq!(metrics.active_sessions, 100);
        assert_eq!(metrics.sessions_started, 100);
        assert_eq!(metrics.chunks_accepted, 100);
        assert!(p95 < Duration::from_millis(150), "p95 was {p95:?}");
    }

    #[test]
    fn cleanup_evicts_only_expired_consumed_tickets() {
        // Regression: the old cleanup cleared the whole set, erasing the single-use
        // marker of still-valid tickets and reopening a replay window. Eviction must
        // keep unexpired entries so a consumed-but-unexpired ticket stays rejected.
        let mut consumed: HashMap<String, u64> = HashMap::new();
        consumed.insert("expired-ticket".to_owned(), 1_000); // expiry in the past
        consumed.insert("live-ticket".to_owned(), 5_000); // still valid

        let removed = evict_expired(&mut consumed, 2_000);

        assert_eq!(removed, 1, "only the expired ticket should be evicted");
        assert!(
            !consumed.contains_key("expired-ticket"),
            "expired ticket is dropped"
        );
        assert!(
            consumed.contains_key("live-ticket"),
            "unexpired consumed ticket is retained so replay stays blocked"
        );
    }

    #[test]
    fn ticket_hash_is_stable_and_not_the_raw_ticket() {
        let ticket = "rt_v1.session-1.tenant-1.learner-1.true.2000.nonce-1.sig";
        let hash = ticket_hash(ticket);
        assert_eq!(hash, ticket_hash(ticket), "hash is deterministic");
        assert_ne!(hash, ticket, "the raw ticket is never used as the key");
        assert_eq!(hash.len(), 64, "sha256 hex digest");
    }

    #[tokio::test]
    async fn redis_ticket_dedup_is_unavailable_without_redis() {
        // With no Redis configured, the shared check reports Unavailable so the caller
        // degrades to the in-memory set rather than rejecting every connection.
        let gateway = RealtimeGateway::new(4);
        let outcome = gateway
            .redis_mark_ticket(&ticket_hash("some-ticket"), 300)
            .await;
        assert_eq!(outcome, TicketDedup::Unavailable);
    }

    #[test]
    fn validates_audio_chunk_shape() {
        assert_eq!(
            AudioChunk::new("session-1", "bad-time", 20, 20, 16_000, vec![1]).unwrap_err(),
            GatewayError::InvalidChunkTiming {
                start_ms: 20,
                end_ms: 20
            }
        );
        assert_eq!(
            AudioChunk::new("session-1", "bad-rate", 0, 20, 44_100, vec![1]).unwrap_err(),
            GatewayError::UnsupportedSampleRate(44_100)
        );
        assert_eq!(
            AudioChunk::new("session-1", "empty", 0, 20, 16_000, Vec::new()).unwrap_err(),
            GatewayError::EmptyAudioChunk
        );
    }

    /// Serializes tests that mutate the process-wide env vars `validate_origin` reads per-request
    /// (ALLOW_INSECURE_DEFAULTS / CORS_ALLOWED_ORIGINS). Any future test touching those MUST take this
    /// lock, or it can race this one (cargo runs unit tests multi-threaded in one process).
    static ORIGIN_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn test_audio_ws_origin_validation() {
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        let _env = ORIGIN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Set up env variables
        unsafe {
            std::env::set_var("ALLOW_INSECURE_DEFAULTS", "false");
            std::env::set_var(
                "CORS_ALLOWED_ORIGINS",
                "http://localhost:5173,https://quran-ai.example.com",
            );
        }

        let router = gateway_router(GatewayServerConfig::default());

        // 1. Strict mode: a MISSING Origin header fails closed (403). Browsers always send Origin on a
        //    cross-origin WS upgrade, so the allowlist must not be bypassable by omitting the header.
        let req = Request::builder()
            .uri("/v1/recitation-sessions/session-1/audio?ticket=invalid")
            .header("upgrade", "websocket")
            .header("connection", "upgrade")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("sec-websocket-version", "13")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // 2. Disallowed origin should fail with 403 Forbidden
        let req = Request::builder()
            .uri("/v1/recitation-sessions/session-1/audio?ticket=invalid")
            .header("upgrade", "websocket")
            .header("connection", "upgrade")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("sec-websocket-version", "13")
            .header("origin", "https://malicious.example.com")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // 3. Allowed origin should pass origin check and return 426 Upgrade Required
        let req = Request::builder()
            .uri("/v1/recitation-sessions/session-1/audio?ticket=invalid")
            .header("upgrade", "websocket")
            .header("connection", "upgrade")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("sec-websocket-version", "13")
            .header("origin", "http://localhost:5173")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UPGRADE_REQUIRED);

        // 4. Insecure defaults allowed: disallowed origin should pass origin check
        unsafe {
            std::env::set_var("ALLOW_INSECURE_DEFAULTS", "true");
        }
        let req = Request::builder()
            .uri("/v1/recitation-sessions/session-1/audio?ticket=invalid")
            .header("upgrade", "websocket")
            .header("connection", "upgrade")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("sec-websocket-version", "13")
            .header("origin", "https://malicious.example.com")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UPGRADE_REQUIRED);

        // Restore env
        unsafe {
            std::env::remove_var("ALLOW_INSECURE_DEFAULTS");
            std::env::remove_var("CORS_ALLOWED_ORIGINS");
        }
    }
}
