use std::collections::{HashMap, HashSet};
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
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;
use thiserror::Error;
use tokio::sync::{RwLock, mpsc};

type HmacSha256 = Hmac<Sha256>;

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
}

#[derive(Debug, Default)]
struct GatewayCounters {
    sessions_started: AtomicU64,
    sessions_ended: AtomicU64,
    chunks_accepted: AtomicU64,
    chunks_rejected_backpressure: AtomicU64,
    chunks_rejected_missing_session: AtomicU64,
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
            let key = format!("quran-ai:gateway:session:{session_id}");
            let _: Result<(), _> = match action {
                "start" => redis::cmd("SETEX")
                    .arg(&key)
                    .arg(300)
                    .arg("active")
                    .query(&mut conn),
                "end" => redis::cmd("DEL").arg(&key).query(&mut conn),
                _ => Ok(()),
            };
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
            && let Ok(keys) = redis::cmd("KEYS")
                .arg("quran-ai:gateway:session:*")
                .query::<Vec<String>>(&mut conn)
        {
            return keys.len();
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
        }
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
        }
    }
}

#[derive(Clone)]
struct GatewayServerState {
    gateway: RealtimeGateway,
    config: GatewayServerConfig,
    consumed_tickets: Arc<RwLock<HashSet<String>>>,
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
    let consumed_tickets: Arc<RwLock<HashSet<String>>> = Arc::new(RwLock::new(HashSet::new()));

    // Spawn periodic cleanup of expired consumed tickets (every 5 minutes)
    // Only spawn if we're inside a Tokio runtime (not in tests)
    let cleanup_tickets = consumed_tickets.clone();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(300)).await;
                let mut tickets = cleanup_tickets.write().await;
                let before = tickets.len();
                tickets.clear();
                tracing::debug!("consumed_tickets cleanup: removed {before} entries");
            }
        });
    }

    Router::new()
        .route("/health", get(health))
        .route("/v1/recitation-sessions/{session_id}/audio", get(audio_ws))
        .route("/metrics", get(metrics))
        .with_state(GatewayServerState {
            gateway,
            config,
            consumed_tickets,
        })
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
            "consumed_tickets_count": ticket_count,
        })),
    )
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
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

    {
        let mut consumed_tickets = state.consumed_tickets.write().await;
        if !consumed_tickets.insert(ticket.to_owned()) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
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

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TicketError {
    #[error("missing realtime ticket")]
    Missing,
    #[error("malformed realtime ticket")]
    Malformed,
    #[error("realtime ticket is bound to another session")]
    SessionMismatch,
    #[error("realtime ticket expired")]
    Expired,
    #[error("realtime ticket signature is invalid")]
    InvalidSignature,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeTicketClaims {
    pub session_id: String,
    pub tenant_id: String,
    pub learner_id: String,
    pub external_asr_processing: bool,
    pub expires_at_unix_seconds: u64,
    pub nonce: String,
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
    let payload = ticket_payload(
        session_id,
        tenant_id,
        learner_id,
        external_asr_processing,
        expires_at_unix_seconds,
        nonce,
    );
    let signature = sign_ticket_payload(&payload, secret);
    format!(
        "rt_v1.{session_id}.{tenant_id}.{learner_id}.{external_asr_processing}.{expires_at_unix_seconds}.{nonce}.{signature}"
    )
}

pub fn validate_realtime_ticket(
    expected_session_id: &str,
    ticket: &str,
    secret: &str,
    now_unix_seconds: u64,
) -> Result<RealtimeTicketClaims, TicketError> {
    let trimmed = ticket.trim();
    if trimmed.is_empty() {
        return Err(TicketError::Missing);
    }

    let mut parts = trimmed.split('.');
    let version = parts.next().ok_or(TicketError::Malformed)?;
    let session_id = parts.next().ok_or(TicketError::Malformed)?;
    let tenant_id = parts.next().ok_or(TicketError::Malformed)?;
    let learner_id = parts.next().ok_or(TicketError::Malformed)?;
    let external_asr_processing = parts.next().ok_or(TicketError::Malformed)?;
    let expires_at = parts.next().ok_or(TicketError::Malformed)?;
    let nonce = parts.next().ok_or(TicketError::Malformed)?;
    let signature = parts.next().ok_or(TicketError::Malformed)?;
    if parts.next().is_some()
        || version != "rt_v1"
        || tenant_id.trim().is_empty()
        || learner_id.trim().is_empty()
        || nonce.trim().is_empty()
    {
        return Err(TicketError::Malformed);
    }

    if session_id != expected_session_id {
        return Err(TicketError::SessionMismatch);
    }

    let expires_at = expires_at
        .parse::<u64>()
        .map_err(|_| TicketError::Malformed)?;
    if expires_at <= now_unix_seconds {
        return Err(TicketError::Expired);
    }
    let external_asr_processing = external_asr_processing
        .parse::<bool>()
        .map_err(|_| TicketError::Malformed)?;

    let payload = ticket_payload(
        session_id,
        tenant_id,
        learner_id,
        external_asr_processing,
        expires_at,
        nonce,
    );
    let expected_signature = sign_ticket_payload(&payload, secret);
    if !constant_time_eq(signature.as_bytes(), expected_signature.as_bytes()) {
        return Err(TicketError::InvalidSignature);
    }

    Ok(RealtimeTicketClaims {
        session_id: session_id.to_owned(),
        tenant_id: tenant_id.to_owned(),
        learner_id: learner_id.to_owned(),
        external_asr_processing,
        expires_at_unix_seconds: expires_at,
        nonce: nonce.to_owned(),
    })
}

fn ticket_payload(
    session_id: &str,
    tenant_id: &str,
    learner_id: &str,
    external_asr_processing: bool,
    expires_at_unix_seconds: u64,
    nonce: &str,
) -> String {
    format!(
        "{session_id}.{tenant_id}.{learner_id}.{external_asr_processing}.{expires_at_unix_seconds}.{nonce}"
    )
}

fn sign_ticket_payload(payload: &str, secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length for realtime ticket signing");
    mac.update(payload.as_bytes());
    to_hex(&mac.finalize().into_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.iter()
        .zip(right)
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right))
        == 0
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
    let mut reader = reader;
    tokio::spawn(async move {
        let client = reqwest::Client::new();
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
            match client.post(&url).json(&body).send().await {
                Ok(resp) if resp.status().is_success() => {
                    tracing::debug!("forwarded chunk {chunk_id} to ML service");
                }
                Ok(resp) => {
                    tracing::warn!("ML service returned {} for chunk {chunk_id}", resp.status());
                }
                Err(e) => {
                    tracing::warn!("failed to forward chunk {chunk_id} to ML: {e}");
                }
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

    use super::{
        AudioChunk, GatewayError, GatewayServerConfig, RealtimeGateway, TicketError,
        gateway_router, issue_realtime_ticket, validate_realtime_ticket,
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
}
