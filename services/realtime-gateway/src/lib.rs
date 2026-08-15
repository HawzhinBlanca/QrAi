use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

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

pub mod insecure;

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

// A real chunk is `chunk_duration_ms` (480ms) of audio at up to 48kHz stereo 16-bit PCM —
// 48_000 * 2 bytes/sample * 2 channels * 0.48s ≈ 92 KB, the largest realistic case. Cap at 2 MB
// (20x+ headroom) so no legitimate chunk is ever rejected, while closing an unbounded-size DoS:
// verified empirically that a 10 MB binary WebSocket frame was accepted with no size check at
// all — `bytes.to_vec()` materializes the whole frame in memory before this point, and a handful
// of malicious/buggy connections sending nearly-max-size frames could exhaust gateway memory.
const MAX_CHUNK_BYTES: usize = 2 * 1024 * 1024;

/// Transport-level frame cap, DERIVED from `MAX_CHUNK_BYTES` rather than chosen separately.
///
/// The comment above closed the *unbounded* case, but not the materialization it describes: without
/// this, axum/tungstenite's default `max_frame_size` applies and the transport accepts **16 MiB** —
/// 8x what the application will ever keep. Measured (specs/gateway-ws-sweep/research.md §4): frames
/// of 4/8/12/15/16 MiB were received IN FULL and `to_vec()`-copied before `AudioChunk::new` refused
/// them; only 17 MiB was stopped by the transport. The 10 MB frame that motivated `MAX_CHUNK_BYTES`
/// was therefore still being assembled in memory, just refused a step later.
///
/// The +64 KiB slack is deliberate. An exact cap would turn every 2 MiB + 1 frame from a clean
/// `audio chunk too large` ack into an abrupt transport close — replacing a precise application
/// error with a worse one. Near-miss frames keep reaching the application; only absurd ones are
/// stopped at the transport.
///
/// Honest sizing: the measured memory impact of the old gap was ~1 MiB of RSS across twelve rejected
/// 8 MiB frames. This is hardening, not a fix for an observed leak.
const MAX_WS_FRAME_BYTES: usize = MAX_CHUNK_BYTES + 64 * 1024;

/// Largest number of chunks ONE recitation session may ever store.
///
/// `MAX_CHUNK_BYTES` bounds a single frame and nothing bounded the total. Measured against a real
/// gateway and ml-inference: 40 x 512 KiB down one socket on one ticket was 20 MiB accepted, zero
/// refusals, 16 MiB on disk. Nothing refuses because nothing counts.
///
/// That matters more than a transient disk spike. `audioRetention: "training-opt-in"` is never
/// evicted — ml-inference's retention sweep `continue`s past it — so the growth is permanent, on the
/// same volume that holds the audit log, whose write failure is swallowed by design while `/health`
/// still reports ok. A full disk therefore takes the compliance trail with it, silently.
///
/// Counted on `sequence`, NOT on a socket-local byte total, and that choice is the whole point:
/// `resume_sequence` persists a session's position across reconnects (a session outlives the socket
/// that carries it). A per-socket counter would reset every time the client reconnected, which is
/// exactly the bypass a learner hits by accident on a flaky connection.
///
/// Derivation, so this is a number with a reason: a chunk is `chunk_duration_ms` (480ms), so 15_000
/// chunks is two hours of continuous audio in ONE session. The longest surah recited slowly is well
/// under that, and a real chunk is ~90 KiB (480ms of 48kHz stereo 16-bit PCM), so the honest ceiling
/// this sets is ~1.3 GiB per session rather than the unbounded figure it replaces.
const MAX_SESSION_CHUNKS: u64 = 15_000;

/// Largest ticket lifetime this gateway will honour, as `expires_at - now`.
///
/// `platform-api` mints with `REALTIME_TICKET_TTL_SECONDS = 300`, so an hour is ~12x any legitimate
/// ticket — generous enough that clock skew or a slow handshake can never refuse a real learner.
///
/// This is NOT an auth control: a ticket carrying a far-future expiry is validly signed, so producing
/// one already requires the signing secret. It is a bound on the damage such a ticket does, and the
/// damage is concrete rather than theoretical: `consumed_tickets` maps a ticket to its expiry and
/// `evict_expired` retains anything with `expires_at > now`, so a `u64::MAX` entry is **never
/// evicted** — each one is a permanent map entry. That defeats the per-entry eviction introduced in
/// `55c872e` precisely to stop this map growing without bound.
///
/// The same clamp already exists one file over, for the sibling credential: `MintInvitationRequest`
/// clamps invitation TTL to [1, 720] hours "so an admin cannot mint an effectively immortal invite".
const MAX_TICKET_LIFETIME_SECONDS: u64 = 3600;

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

        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(GatewayError::ChunkTooLarge {
                size: bytes.len(),
                max: MAX_CHUNK_BYTES,
            });
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
    #[error("audio chunk too large: {size} bytes exceeds the {max} byte limit")]
    ChunkTooLarge { size: usize, max: usize },
    #[error("recitation session {session_id} reached its {max} chunk limit")]
    SessionChunkLimitReached { session_id: String, max: u64 },
}

#[derive(Clone)]
pub struct RealtimeGateway {
    sessions: Arc<RwLock<HashMap<String, mpsc::Sender<AudioChunk>>>>,
    counters: Arc<GatewayCounters>,
    chunk_capacity: usize,
    redis_url: Option<String>,
    // Lazily-initialized, shared, auto-reconnecting async connection — NOT a fresh sync
    // `redis::Client::open(..).get_connection()` per call. That prior pattern opened a brand-new
    // blocking TCP connection (handshake included) on every session start/end, every ticket
    // check, and every metrics poll, executed directly inside async handlers with no
    // `spawn_blocking` — real risk of stalling a Tokio worker thread under Redis latency, on top
    // of the connection-churn overhead. `ConnectionManager` is `Clone` (multiplexes over one
    // connection) and reconnects on its own, so one instance is created once and reused.
    redis_conn: Arc<tokio::sync::OnceCell<redis::aio::ConnectionManager>>,
    /// How far each SESSION has counted, kept across the connections that make it up.
    ///
    /// A session survives reconnects on purpose — the same `session_id` is resumed after a dropped
    /// socket. The per-connection counter did not, and both things derived from it restarted at
    /// zero: the chunk id (`{session}-ws-{sequence:04}`, which is the storage filename) and the
    /// chunk's `start_ms`. So connection 2's audio was written over connection 1's under the same
    /// key, claiming to have been spoken at the same instants. Measured: a learner who reconnects
    /// twice keeps 6 of 12 chunks, and the survivors are not even a coherent prefix.
    ///
    /// IN-PROCESS, deliberately, and not in Redis. Redis here is best-effort — `redis_connection`
    /// returns an `Option` and the comments above forbid letting it block the session map — so
    /// making "a learner does not overwrite their own recitation" depend on it would put a
    /// correctness property behind an optional service.
    ///
    /// The residual, stated rather than hidden: a gateway RESTART loses these, so a session resumed
    /// across a restart can still collide. That window is much narrower than the one this closes
    /// (every reconnect), and closing it needs durable session state, which is a bigger change.
    session_next_sequence: Arc<RwLock<HashMap<String, SessionCursor>>>,
}

/// Where a session's chunk numbering has reached, and when that was last touched.
#[derive(Debug, Clone, Copy)]
struct SessionCursor {
    next_sequence: u64,
    touched_unix: u64,
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
    /// Chunks whose AUDIO was stored but whose index row could not be written, after retries.
    ///
    /// Deliberately separate from `chunks_forward_failed`: that one means the analysis never ran;
    /// this one means the recording exists and cannot be FOUND. A teacher's review queue will report
    /// `not-captured` for a finding whose audio is sitting on disk. Different repair, different
    /// urgency, so a single counter would have hidden one behind the other.
    pub chunks_index_failed: u64,
    /// Chunks stored while `PLATFORM_API_URL` was absent. These are just as undiscoverable as a
    /// failed index request, but the repair is configuration first and reconciliation second.
    pub chunks_index_disabled: u64,
}

#[derive(Debug, Default)]
struct GatewayCounters {
    sessions_started: AtomicU64,
    sessions_ended: AtomicU64,
    chunks_accepted: AtomicU64,
    chunks_rejected_backpressure: AtomicU64,
    chunks_rejected_missing_session: AtomicU64,
    chunks_forward_failed: AtomicU64,
    chunks_index_failed: AtomicU64,
    chunks_index_disabled: AtomicU64,
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
            redis_conn: Arc::new(tokio::sync::OnceCell::new()),
            session_next_sequence: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// The chunk sequence a NEW connection for this session must start counting from.
    ///
    /// Zero for a session nobody has streamed yet; otherwise wherever the previous connection got
    /// to. This is what stops a reconnect from re-minting chunk ids that already name stored audio.
    pub async fn resume_sequence(&self, session_id: &str) -> u64 {
        self.session_next_sequence
            .read()
            .await
            .get(session_id)
            .map(|c| c.next_sequence)
            .unwrap_or(0)
    }

    /// Record how far a connection counted, so the next one continues instead of repeating.
    ///
    /// MONOTONIC: never moves a session's cursor backwards. Two connections for one session can
    /// overlap (the old socket's handler finishing after the new one has started), and a late,
    /// smaller value from the dying connection would hand the live one ids it has already used —
    /// re-opening exactly the bug this closes.
    pub async fn record_sequence(&self, session_id: &str, next_sequence: u64) {
        let now = unix_now_seconds();
        let mut cursors = self.session_next_sequence.write().await;
        let entry = cursors
            .entry(session_id.to_owned())
            .or_insert(SessionCursor {
                next_sequence: 0,
                touched_unix: now,
            });
        entry.next_sequence = entry.next_sequence.max(next_sequence);
        entry.touched_unix = now;

        // Bounded, or this map is a leak in a process that runs for months. Sessions have no
        // "finished" signal — a learner simply stops reconnecting — so the only available rule is
        // age. Swept only when the map is large, so the common path stays O(1).
        const SWEEP_ABOVE: usize = 1024;
        const STALE_AFTER_SECONDS: u64 = 6 * 60 * 60;
        if cursors.len() > SWEEP_ABOVE {
            let cutoff = now.saturating_sub(STALE_AFTER_SECONDS);
            cursors.retain(|_, c| c.touched_unix >= cutoff);
        }
    }

    /// Returns the shared `ConnectionManager`, initializing it on first use. Cheap to call
    /// repeatedly: after the first successful connect, this is just an `Arc`/`Clone` load, no I/O.
    ///
    /// Configured with a SHORT connection timeout and NO retries — the crate's own defaults are 6
    /// retries with exponential backoff, which would turn "Redis is unreachable" into a multi-second
    /// stall on every call site here, including the ticket_fail_closed path, whose entire point is to
    /// reject a connection quickly rather than let a client hang waiting for a security check to time
    /// out. The old per-call sync `get_connection()` made exactly one attempt and failed immediately;
    /// this preserves that fail-fast behavior while still getting a shared, reusable connection.
    async fn redis_connection(&self) -> Option<redis::aio::ConnectionManager> {
        let url = self.redis_url.as_ref()?;
        let result = self
            .redis_conn
            .get_or_try_init(|| async {
                let config = redis::aio::ConnectionManagerConfig::new()
                    .set_number_of_retries(0)
                    .set_connection_timeout(std::time::Duration::from_secs(2))
                    .set_response_timeout(std::time::Duration::from_secs(2));
                redis::Client::open(url.as_str())?
                    .get_connection_manager_with_config(config)
                    .await
            })
            .await;
        match result {
            Ok(conn) => Some(conn.clone()),
            Err(e) => {
                tracing::warn!("Redis connect failed: {e}");
                None
            }
        }
    }

    async fn redis_track_session(&self, session_id: &str, action: &str) {
        if let Some(mut conn) = self.redis_connection().await {
            // Active sessions live in a SORTED SET scored by expiry (unix seconds). This SELF-HEALS: a
            // session whose "end" is never recorded (dropped socket, panicking task, gateway crash or
            // restart) simply expires by score and is evicted on the next count. The previous bare
            // INCR/DECR counter had no TTL and no reconciliation, so any unclean termination or restart
            // drifted `active-session-count` upward forever with no recovery short of a manual reset.
            let zkey = "quran-ai:gateway:active-sessions";
            let result: redis::RedisResult<()> = match action {
                "start" => {
                    // Bound a session's tracked lifetime to the ticket TTL window.
                    let expiry = unix_now_seconds().saturating_add(ACTIVE_SESSION_TTL_SECONDS);
                    redis::cmd("ZADD")
                        .arg(zkey)
                        .arg(expiry)
                        .arg(session_id)
                        .query_async(&mut conn)
                        .await
                }
                "end" => {
                    redis::cmd("ZREM")
                        .arg(zkey)
                        .arg(session_id)
                        .query_async(&mut conn)
                        .await
                }
                _ => Ok(()),
            };
            if let Err(e) = result {
                tracing::warn!("Redis session tracking ({action}) failed: {e}");
            }
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
        let Some(mut conn) = self.redis_connection().await else {
            return TicketDedup::Unavailable;
        };
        let ttl = ttl_seconds.max(1);
        let key = format!("quran-ai:gateway:ticket:{ticket_hash}");
        // `SET .. NX` returns the value ("OK") when the key was newly set, and Nil
        // (deserialized to None) when the key already existed — i.e. a replay.
        let set: redis::RedisResult<Option<String>> = redis::cmd("SET")
            .arg(&key)
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(ttl)
            .query_async(&mut conn)
            .await;
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
        {
            let mut sessions = self.sessions.write().await;
            if sessions.contains_key(&session_id) {
                return Err(GatewayError::SessionAlreadyExists(session_id));
            }
            sessions.insert(session_id.clone(), sender);
        }

        self.counters
            .sessions_started
            .fetch_add(1, Ordering::Relaxed);
        // Redis is observability/state reconciliation only. Never hold the in-process session
        // lock while a network handshake or timeout is pending: that would make an unavailable
        // Redis instance stall all chunk sends for an otherwise valid active session.
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
        let removed = {
            let mut sessions = self.sessions.write().await;
            sessions.remove(session_id).is_some()
        };
        if removed {
            self.counters.sessions_ended.fetch_add(1, Ordering::Relaxed);
            // As above, no network await may monopolize the in-process session map.
            self.redis_track_session(session_id, "end").await;
            Ok(())
        } else {
            Err(GatewayError::SessionNotFound(session_id.to_owned()))
        }
    }

    pub async fn active_session_count(&self) -> usize {
        if let Some(mut conn) = self.redis_connection().await {
            let zkey = "quran-ai:gateway:active-sessions";
            let now = unix_now_seconds();
            // Evict entries whose expiry has passed (stale sessions left by crashes/restarts), then
            // count the live ones. `(now` makes the bound exclusive so a session expiring exactly now
            // is still counted until the next tick.
            let evict: redis::RedisResult<()> = redis::cmd("ZREMRANGEBYSCORE")
                .arg(zkey)
                .arg("-inf")
                .arg(format!("({now}"))
                .query_async(&mut conn)
                .await;
            if let Err(e) = evict {
                tracing::warn!("Redis ZREMRANGEBYSCORE active-sessions failed: {e}");
            }
            let count: Result<i64, _> = redis::cmd("ZCARD").arg(zkey).query_async(&mut conn).await;
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
            chunks_index_failed: self.counters.chunks_index_failed.load(Ordering::Relaxed),
            chunks_index_disabled: self.counters.chunks_index_disabled.load(Ordering::Relaxed),
        }
    }

    /// Record that a chunk could not be delivered to the ML service after retries (analysis gap).
    pub fn record_forward_failure(&self) {
        self.counters
            .chunks_forward_failed
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Record that a chunk's audio was stored but its index row was not written (findability gap).
    ///
    /// The audio is NOT deleted and is never deleted on this path. "Fail the chunk, never lose the
    /// audio": a recording a learner consented to keep is not thrown away because a database write
    /// failed. What is lost is the ability to FIND it, and that is counted here rather than hidden —
    /// an operator seeing this above zero has orphaned recordings to re-index, not to mourn.
    pub fn record_index_failure(&self) {
        self.counters
            .chunks_index_failed
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Record a stored chunk that could not even attempt indexing because the API URL is disabled.
    pub fn record_index_disabled(&self) {
        self.counters
            .chunks_index_disabled
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
    /// Where to record that a stored chunk exists (ADR-0037). Env: `PLATFORM_API_URL`.
    ///
    /// `None` disables indexing, and that is a real degradation rather than a neutral default: audio
    /// still reaches storage, but no finding can ever resolve to it and a teacher's review queue
    /// reports `not-captured` for recordings sitting on disk. Announced once at startup rather than
    /// discovered months later, and every un-indexed chunk is still counted.
    pub platform_api_url: Option<String>,
    pub ml_inference_url: String,
    pub tenant_id: String,
    /// When true AND Redis is configured, reject a connection if the shared replay store is
    /// unreachable (fail CLOSED) instead of degrading to per-process single-use. Trades
    /// availability for a guarantee that a ticket used during a Redis outage can't be
    /// replayed on another instance. Default false (fail open). Env: REALTIME_TICKET_FAIL_CLOSED.
    pub ticket_fail_closed: bool,
    /// Shared secret required in `x-metrics-token` to scrape /metrics. Unlike postgres/ml/asr, this
    /// gateway is meant to be reachable OFF-HOST (docker-compose publishes 8081 on all interfaces),
    /// so an unauthenticated /metrics publishes operational telemetry to the internet. Env: METRICS_TOKEN.
    pub metrics_token: Option<String>,
    /// Allow scraping /metrics with no token — dev/CI only. Env: METRICS_DEV_OPEN=1.
    pub metrics_dev_open: bool,
    /// DEV-ONLY fault injection (T13): drop the audio socket after this many accepted chunks, so a
    /// client's reconnect/backoff/re-ticket path can be exercised deterministically instead of
    /// hoping for a real Wi-Fi blip. Read from REALTIME_CHAOS_DROP_AFTER_CHUNKS, but IGNORED unless
    /// ALLOW_CHAOS_INJECTION=1 — a production gateway cannot be told to sabotage itself even if
    /// the env var leaks into its config.
    pub chaos_drop_after_chunks: Option<u64>,
    /// How many connections chaos may drop IN TOTAL before letting one through
    /// (REALTIME_CHAOS_MAX_DROPS, default unlimited). Set to 2 to reproduce "a session survives two
    /// drops and still completes".
    pub chaos_max_drops: u64,
}

impl Default for GatewayServerConfig {
    fn default() -> Self {
        Self {
            chunk_capacity: 8,
            sample_rate: 16_000,
            chunk_duration_ms: 480,
            ticket_secret: std::env::var("REALTIME_GATEWAY_TICKET_SECRET")
                .unwrap_or_else(|_| "smoke-secret".to_owned()),
            // No default. A guessed platform-api URL would index into the wrong place, or silently
            // into nothing; absent means indexing is off and says so.
            platform_api_url: std::env::var("PLATFORM_API_URL")
                .ok()
                .filter(|u| !u.trim().is_empty()),
            ml_inference_url: std::env::var("ML_INFERENCE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8090".to_owned()),
            tenant_id: std::env::var("GATEWAY_TENANT_ID")
                .unwrap_or_else(|_| "hikmah-pilot-erbil".to_owned()),
            ticket_fail_closed: std::env::var("REALTIME_TICKET_FAIL_CLOSED")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false),
            metrics_token: std::env::var("METRICS_TOKEN")
                .ok()
                .filter(|t| !t.trim().is_empty()),
            metrics_dev_open: insecure::relaxed(insecure::METRICS_DEV_OPEN),
            // Chaos is only readable in explicit dev mode — production ignores the env var outright.
            chaos_drop_after_chunks: if insecure::relaxed(insecure::ALLOW_CHAOS_INJECTION) {
                std::env::var("REALTIME_CHAOS_DROP_AFTER_CHUNKS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|n| *n > 0)
            } else {
                None
            },
            chaos_max_drops: std::env::var("REALTIME_CHAOS_MAX_DROPS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(u64::MAX),
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
    /// How many connections chaos has dropped so far (shared across sockets, so
    /// REALTIME_CHAOS_MAX_DROPS bounds TOTAL drops and a later attempt is allowed to succeed).
    chaos_drops: Arc<AtomicU64>,
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
    // Secure by default, matching platform-api's identical DISABLE_RATE_LIMIT pattern (and every
    // other security control in this codebase — ALLOW_INSECURE_DEFAULTS, ALLOW_HEADER_AUTH,
    // TRUST_PROXY_HEADERS are all opt-in for LESS security). This was previously ENABLE_RATE_LIMIT
    // (opt-IN), the one place that inverted the convention: rate limiting was OFF unless an
    // operator explicitly turned it on, and docker-compose.yml never did — verified empirically
    // that a live gateway with no env var set took 350/350 rapid requests with zero throttling.
    let rate_limited = !std::env::var("DISABLE_RATE_LIMIT")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    gateway_router_with_rate_limit(config, rate_limited)
}

/// Like [`gateway_router`], but with explicit control over rate limiting instead of reading it from
/// `DISABLE_RATE_LIMIT`. Tests that exercise the router via `tower::ServiceExt::oneshot` (no real TCP
/// connection, so `tower_governor`'s peer-IP key extractor has nothing to read) must pass `false` —
/// mirrors platform-api's `platform_router_with_rate_limit` split for the identical reason.
pub fn gateway_router_with_rate_limit(config: GatewayServerConfig, rate_limited: bool) -> Router {
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
            chaos_drops: Arc::new(AtomicU64::new(0)),
        });

    if rate_limited {
        // Keying: default is the PEER IP. Behind a reverse proxy (e.g. nginx terminating TLS in
        // front of this gateway) every connection shares the proxy's IP, collapsing per-client
        // rate limiting into one shared bucket — set TRUST_PROXY_HEADERS=1 to key off
        // X-Forwarded-For/X-Real-IP instead, mirroring platform-api's identical
        // GovernorConfigBuilder split. That is spoofable if the gateway is ever exposed directly
        // (a client sets the header to dodge the limit), so it stays opt-in and must only be
        // enabled behind a proxy that overwrites those headers rather than passing them through.
        let trust_proxy = std::env::var("TRUST_PROXY_HEADERS")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false);
        if trust_proxy {
            let conf = tower_governor::governor::GovernorConfigBuilder::default()
                .per_millisecond(50)
                .burst_size(200)
                .key_extractor(tower_governor::key_extractor::SmartIpKeyExtractor)
                .finish()
                .unwrap();
            base_router.layer(tower_governor::GovernorLayer {
                config: conf.into(),
            })
        } else {
            let conf = tower_governor::governor::GovernorConfigBuilder::default()
                .per_millisecond(50)
                .burst_size(200)
                .finish()
                .unwrap();
            base_router.layer(tower_governor::GovernorLayer {
                config: conf.into(),
            })
        }
    } else {
        base_router
    }
}

/// Prometheus scrape endpoint. Access is FAIL-CLOSED: it serves metrics only when the request
/// presents `x-metrics-token` matching `METRICS_TOKEN`; in dev (`ALLOW_INSECURE_DEFAULTS=1`) with no
/// token configured it is open; otherwise it 404s, hiding the endpoint's existence.
///
/// This endpoint used to be unauthenticated JSON. An earlier audit flagged exactly that (see the
/// note on platform-api's metrics_endpoint, which was built fail-closed so as "not to repeat" it) —
/// but the gateway itself was never fixed. It matters MORE here than on platform-api: compose
/// publishes 8081 on all interfaces, so session/chunk/ticket telemetry was world-readable.
/// Output is Prometheus text exposition (was JSON, which no scraper can read).
async fn metrics(
    State(state): State<GatewayServerState>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    if !metrics_access_allowed(&state.config, &headers) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let m = state.gateway.metrics().await;
    let ticket_count = state.consumed_tickets.read().await.len();
    let body = render_prometheus(&m, ticket_count, state.config.platform_api_url.is_some());
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

fn metrics_access_allowed(config: &GatewayServerConfig, headers: &axum::http::HeaderMap) -> bool {
    match &config.metrics_token {
        Some(token) => headers
            .get("x-metrics-token")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == token)
            .unwrap_or(false),
        // No token configured: allow only in explicit dev mode, otherwise fail closed.
        None => config.metrics_dev_open,
    }
}

/// Render the gateway counters as Prometheus text exposition. Cardinality is fixed (no labels), so
/// this cannot blow up a scraper.
fn render_prometheus(
    m: &GatewayMetrics,
    consumed_tickets: usize,
    audio_index_enabled: bool,
) -> String {
    let mut out = String::new();
    let gauge = |out: &mut String, name: &str, help: &str, value: u64| {
        out.push_str(&format!(
            "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {value}\n"
        ));
    };
    let counter = |out: &mut String, name: &str, help: &str, value: u64| {
        out.push_str(&format!(
            "# HELP {name} {help}\n# TYPE {name} counter\n{name} {value}\n"
        ));
    };
    gauge(
        &mut out,
        "realtime_gateway_active_sessions",
        "Sessions currently connected.",
        m.active_sessions as u64,
    );
    counter(
        &mut out,
        "realtime_gateway_sessions_started_total",
        "Audio sessions started.",
        m.sessions_started,
    );
    counter(
        &mut out,
        "realtime_gateway_sessions_ended_total",
        "Audio sessions ended.",
        m.sessions_ended,
    );
    counter(
        &mut out,
        "realtime_gateway_chunks_accepted_total",
        "Audio chunks accepted.",
        m.chunks_accepted,
    );
    counter(
        &mut out,
        "realtime_gateway_chunks_rejected_backpressure_total",
        "Audio chunks rejected because the session buffer was full.",
        m.chunks_rejected_backpressure,
    );
    counter(
        &mut out,
        "realtime_gateway_chunks_rejected_missing_session_total",
        "Audio chunks rejected for an unknown session.",
        m.chunks_rejected_missing_session,
    );
    counter(
        &mut out,
        "realtime_gateway_chunks_forward_failed_total",
        "Audio chunks that failed to forward to ML inference.",
        m.chunks_forward_failed,
    );
    counter(
        &mut out,
        "realtime_gateway_chunks_index_failed_total",
        "Audio chunks stored but not indexed after API attempts; run pnpm db:repair-audio-index.",
        m.chunks_index_failed,
    );
    counter(
        &mut out,
        "realtime_gateway_chunks_index_disabled_total",
        "Audio chunks stored while PLATFORM_API_URL was absent; fix configuration, then run pnpm db:repair-audio-index.",
        m.chunks_index_disabled,
    );
    counter(
        &mut out,
        "realtime_gateway_chunks_stored_unindexed_total",
        "All known stored-but-unindexed chunks; run pnpm db:repair-audio-index and investigate if this increases.",
        m.chunks_index_failed
            .saturating_add(m.chunks_index_disabled),
    );
    gauge(
        &mut out,
        "realtime_gateway_audio_index_enabled",
        "Whether PLATFORM_API_URL is configured for durable audio indexing.",
        u64::from(audio_index_enabled),
    );
    gauge(
        &mut out,
        "realtime_gateway_consumed_tickets",
        "Consumed single-use tickets retained in memory for replay defence.",
        consumed_tickets as u64,
    );
    out
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn validate_origin(
    headers: axum::http::HeaderMap,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> impl IntoResponse {
    // TWO different relaxations, and keeping them apart is the point of the split
    // (specs/insecure-defaults-split/plan.md §3.2).
    //
    //   - Disabling the allowlist ENTIRELY has no legitimate deployment, so it stays reachable only
    //     through the deprecated blunt instrument.
    //   - Accepting a MISSING Origin is what a native/Flutter client actually needs, and it now has
    //     its own name. With it set, a request that DOES carry an Origin is still checked — so
    //     browsers keep their CSWSH protection instead of losing it as collateral damage.
    let skip_origin_check_entirely = insecure::legacy_alias_active();
    let allow_missing_origin =
        skip_origin_check_entirely || insecure::relaxed(insecure::GATEWAY_ALLOW_MISSING_ORIGIN);

    if !skip_origin_check_entirely {
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
        } else if !allow_missing_origin {
            // No Origin header at all. Browsers ALWAYS send Origin on a cross-origin WebSocket
            // upgrade, so in strict (production) mode we fail CLOSED here rather than let the origin
            // allowlist be silently bypassed by simply omitting the header. Native clients — which
            // send no Origin — opt out with GATEWAY_ALLOW_MISSING_ORIGIN=1, which relaxes ONLY this
            // branch: the allowlist above still rejects a disallowed Origin.
            tracing::warn!("CSWSH check failed: missing Origin header");
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    next.run(request).await
}

/// Outcome of validating a realtime ticket for a WebSocket upgrade attempt, decided BEFORE any
/// actual upgrade is attempted.
#[derive(Debug)]
enum TicketCheckOutcome {
    Accepted {
        learner_id: String,
        /// The learner's stored retention choice, signed into the ticket by platform-api. The
        /// gateway never interprets it — it forwards it to ml-inference, which owns the TTL. This
        /// service has no database, so the ticket is the ONLY path this answer can travel.
        audio_retention: String,
        trace_id: Option<String>,
        ticket: String,
    },
    Rejected(StatusCode),
}

/// All of `audio_ws`'s ticket validation, tenant binding, and single-use/replay enforcement,
/// split into its own function so this security-critical logic is unit-testable directly.
/// axum's `WebSocketUpgrade` extractor cannot complete an upgrade inside an in-process
/// `oneshot()` test (it requires a real HTTP/1.1 upgrade) — confirmed empirically: a test that
/// asserts `StatusCode::UPGRADE_REQUIRED` from a `oneshot()` call never actually enters the
/// handler body at all, regardless of ticket validity, tenant match, or replay state. That means
/// any logic left inside `audio_ws` itself is unreachable by `cargo test` and was, before this
/// split, exercised ONLY by `scripts/smoke-gateway.mjs` against a live process — a script that is
/// not part of `scripts/verify.sh`'s CI gate. `check_ticket` has no such dependency, so it can be
/// tested directly (see `mod tests`).
async fn check_ticket(
    state: &GatewayServerState,
    session_id: &str,
    query: &HashMap<String, String>,
) -> TicketCheckOutcome {
    let Some(ticket) = query.get("ticket").map(String::as_str) else {
        return TicketCheckOutcome::Rejected(StatusCode::UNAUTHORIZED);
    };

    let claims = match validate_realtime_ticket(
        session_id,
        ticket,
        &state.config.ticket_secret,
        unix_now_seconds(),
    ) {
        Ok(claims) => claims,
        Err(_) => return TicketCheckOutcome::Rejected(StatusCode::UNAUTHORIZED),
    };

    // G2 — refuse an implausible lifetime, AFTER signature verification so this answers identically
    // for signed and unsigned tickets and distinguishes nothing to a caller.
    //
    // `validate_realtime_ticket` already rejects an EXPIRED ticket; nothing bounded how far in the
    // future the expiry could be. A `u64::MAX` expiry is permanently unexpired, so its entry in
    // `consumed_tickets` is never evicted (`evict_expired` retains `expires_at > now`) — one
    // permanent map entry per ticket, defeating the per-entry eviction added in `55c872e` to keep
    // that map bounded. The lifetime is also handed to Redis as the dedup key's TTL below.
    let lifetime = claims
        .expires_at_unix_seconds
        .saturating_sub(unix_now_seconds());
    if lifetime > MAX_TICKET_LIFETIME_SECONDS {
        tracing::warn!(
            "realtime ticket lifetime {lifetime}s exceeds the maximum {MAX_TICKET_LIFETIME_SECONDS}s; \
             platform-api mints 300s tickets, so this ticket was not minted by a healthy issuer"
        );
        return TicketCheckOutcome::Rejected(StatusCode::UNAUTHORIZED);
    }

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
        return TicketCheckOutcome::Rejected(StatusCode::UNAUTHORIZED);
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
        return TicketCheckOutcome::Rejected(StatusCode::SERVICE_UNAVAILABLE);
    }
    let mem_replay = {
        let mut consumed_tickets = state.consumed_tickets.write().await;
        consumed_tickets
            .insert(ticket.to_owned(), claims.expires_at_unix_seconds)
            .is_some()
    };
    if mem_replay || redis_dedup == TicketDedup::Replay {
        return TicketCheckOutcome::Rejected(StatusCode::UNAUTHORIZED);
    }

    let trace_id = query
        .get("trace_id")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    TicketCheckOutcome::Accepted {
        learner_id: claims.learner_id,
        audio_retention: claims.audio_retention,
        trace_id,
        // The ticket ITSELF, kept so the chunk indexer can present it to platform-api. Not a new
        // credential: it is the one this session was already admitted with, it expires with the
        // session, and it authorises exactly this session's chunks and nothing else.
        ticket: ticket.to_owned(),
    }
}

async fn audio_ws(
    State(state): State<GatewayServerState>,
    Path(session_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    match check_ticket(&state, &session_id, &query).await {
        TicketCheckOutcome::Rejected(status) => status.into_response(),
        TicketCheckOutcome::Accepted {
            learner_id,
            audio_retention,
            trace_id,
            ticket,
        } => upgrade
            // G1 — stop absurd frames at the TRANSPORT rather than assembling them first. Without
            // these the tungstenite defaults apply (16 MiB frame / 64 MiB message), 8x what
            // MAX_CHUNK_BYTES will ever keep. See MAX_WS_FRAME_BYTES for the measurement.
            .max_frame_size(MAX_WS_FRAME_BYTES)
            .max_message_size(MAX_WS_FRAME_BYTES)
            .on_upgrade(move |socket| {
                handle_audio_socket(
                    socket,
                    session_id,
                    learner_id,
                    audio_retention,
                    trace_id,
                    ticket,
                    state,
                )
            })
            .into_response(),
    }
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

/// The `POST /v1/audio-chunks` body the gateway sends ml-inference for one chunk.
///
/// A free function rather than an inline `json!` inside the forwarding task so it can be asserted
/// directly. That matters most for `audioRetention`: this service holds no database, so what it puts
/// here is the ONLY thing telling ml-inference how long a learner agreed their recorded voice may be
/// kept. A missing field is not a missing field — ml-inference reads `?? "discard"` and deletes the
/// recording an hour later, which is indistinguishable from working.
fn chunk_forward_body(
    chunk: &AudioChunk,
    tenant_id: &str,
    learner_id: &str,
    audio_retention: &str,
    trace_id: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "tenantId": tenant_id,
        "learnerId": learner_id,
        "sessionId": chunk.session_id,
        "chunkId": chunk.chunk_id,
        "sampleRate": chunk.sample_rate,
        "startMs": chunk.start_ms,
        "endMs": chunk.end_ms,
        "audioBase64": base64_encode(&chunk.bytes),
        "audioSize": chunk.bytes.len(),
        "audioRetention": audio_retention,
        "traceId": trace_id,
    })
}

async fn handle_audio_socket(
    mut socket: WebSocket,
    session_id: String,
    learner_id: String,
    audio_retention: String,
    trace_id: Option<String>,
    ticket: String,
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
    let platform_api_url = state.config.platform_api_url.clone();
    let mut reader = reader;
    // Clone the gateway (Arc-based) into the forwarding task so it can record forward failures
    // without moving state.gateway away from the socket loop below.
    let forward_gateway = state.gateway.clone();
    tokio::spawn(async move {
        let client = state.http_client.clone();
        while let Some(chunk) = reader.recv().await {
            let chunk_id = chunk.chunk_id.clone();
            // Captured before `chunk` is consumed by `chunk_forward_body` below.
            let chunk_session_id = chunk.session_id.clone();
            let chunk_start_ms = chunk.start_ms;
            let chunk_end_ms = chunk.end_ms;
            let chunk_sample_rate = chunk.sample_rate;
            let url = format!("{}/v1/audio-chunks", ml_url);
            let body = chunk_forward_body(
                &chunk,
                &tenant_id,
                &learner_id,
                &audio_retention,
                ml_trace.as_deref(),
            );
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

            // ── Record that the audio EXISTS, so a finding can later be resolved to it ──────────
            //
            // ADR-0037. Only after the bytes actually reached storage: an index row for audio that
            // was never stored is a pointer to nothing, which is the failure `usable_span` and the
            // 0026 CHECK constraint exist to prevent one level down.
            //
            // "Fail the chunk, never lose the audio." If this write cannot be made, the recording
            // stays exactly where it is and is NEVER deleted — what is lost is only the ability to
            // find it, and that is counted rather than hidden. Deleting stored audio because a
            // database write failed would destroy a recording the learner consented to keep, in
            // order to tidy up a bookkeeping gap.
            if delivered {
                let Some(platform_url) = platform_api_url.as_deref() else {
                    forward_gateway.record_index_disabled();
                    tracing::error!(
                        "stored chunk {chunk_id} is unindexed because PLATFORM_API_URL is absent; \
                         configure it and run `pnpm db:repair-audio-index -- --apply`"
                    );
                    continue;
                };
                let index_url = format!("{platform_url}/v1/audio-chunks");
                let index_body = serde_json::json!({
                    "sessionId": chunk_session_id,
                    "chunkId": chunk_id,
                    "startMs": chunk_start_ms,
                    "endMs": chunk_end_ms,
                    "sampleRate": chunk_sample_rate,
                });
                let mut indexed = false;
                for attempt in 1..=MAX_ATTEMPTS {
                    match client
                        .post(&index_url)
                        // The session's own ticket. platform-api reads tenant and learner from its
                        // signed claims and ignores anything the body might have said about them.
                        .header("x-realtime-ticket", &ticket)
                        .timeout(std::time::Duration::from_secs(5))
                        .json(&index_body)
                        .send()
                        .await
                    {
                        Ok(resp) if resp.status().is_success() => {
                            indexed = true;
                            break;
                        }
                        // A 4xx is permanent — an expired ticket, a span this service should not
                        // have produced, a deleted session. Retrying cannot fix any of them, and
                        // hammering an expired ticket looks exactly like an attack.
                        Ok(resp) if resp.status().is_client_error() => {
                            tracing::warn!(
                                "platform-api rejected the index for chunk {chunk_id}: {} (not retrying)",
                                resp.status()
                            );
                            break;
                        }
                        Ok(resp) => tracing::warn!(
                            "platform-api returned {} indexing chunk {chunk_id} (attempt {attempt}/{MAX_ATTEMPTS})",
                            resp.status()
                        ),
                        Err(e) => tracing::warn!(
                            "failed to index chunk {chunk_id} (attempt {attempt}/{MAX_ATTEMPTS}): {e}"
                        ),
                    }
                    if attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(std::time::Duration::from_millis(100 * attempt as u64))
                            .await;
                    }
                }
                if !indexed {
                    // The audio is still on disk. This says it cannot be found.
                    forward_gateway.record_index_failure();
                }
            }
        }
    });

    // NOT zero. A session outlives the socket that carries it — that is what reconnect means — and
    // this counter names the chunk (`{session}-ws-{sequence:04}`, the storage filename) and dates it
    // (`sequence * chunk_duration_ms`). Restarting it made connection 2 overwrite connection 1's
    // audio under the same key, timestamped as if spoken at the same moment.
    let mut sequence = state.gateway.resume_sequence(&session_id).await;

    while let Some(message) = socket.recv().await {
        match message {
            Ok(Message::Binary(bytes)) => {
                // Checked against `sequence`, which `resume_sequence` carried over from any earlier
                // socket on this session — so reconnecting does not hand the client a fresh budget.
                if sequence >= MAX_SESSION_CHUNKS {
                    let err = GatewayError::SessionChunkLimitReached {
                        session_id: session_id.clone(),
                        max: MAX_SESSION_CHUNKS,
                    };
                    tracing::warn!("{err}");
                    let ack = AudioIngressAck {
                        kind: "audio.ack",
                        session_id: session_id.clone(),
                        chunk_id: format!("{session_id}-ws-{sequence:04}"),
                        sequence,
                        accepted: false,
                        trace_id: None,
                        message: err.to_string(),
                    };
                    if let Ok(text) = serde_json::to_string(&ack)
                        && socket.send(Message::Text(text.into())).await.is_err()
                    {
                        break;
                    }
                    continue;
                }
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

                // T13 fault injection (dev-only; see GatewayServerConfig::chaos_drop_after_chunks).
                // Drop the socket mid-session so the client's buffer/backoff/re-ticket path is
                // exercised deterministically. The drop budget is shared across connections, so
                // REALTIME_CHAOS_MAX_DROPS=2 drops twice and then lets the session finish.
                if let Some(drop_after) = state.config.chaos_drop_after_chunks
                    && sequence >= drop_after
                {
                    let dropped_so_far = state.chaos_drops.load(Ordering::Relaxed);
                    if dropped_so_far < state.config.chaos_max_drops {
                        state.chaos_drops.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(
                            session_id = %session_id,
                            chunks = sequence,
                            drop_number = dropped_so_far + 1,
                            "CHAOS: dropping audio socket (REALTIME_CHAOS_DROP_AFTER_CHUNKS)"
                        );
                        break;
                    }
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

    // BEFORE end_session, and unconditionally — a chaos drop, a network failure and a clean close
    // all reach here, and all of them must hand the next connection a cursor it can trust. Recording
    // it only on the tidy path would leave the reconnect case, which is the whole reason a session
    // spans sockets, still minting duplicate ids.
    state.gateway.record_sequence(&session_id, sequence).await;

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
        AudioChunk, AudioIngressAck, GatewayError, GatewayMetrics, GatewayServerConfig,
        GatewayServerState, MAX_CHUNK_BYTES, MAX_TICKET_LIFETIME_SECONDS, RealtimeGateway,
        TicketCheckOutcome, TicketDedup, TicketError, check_ticket, chunk_forward_body,
        evict_expired, gateway_router, gateway_router_with_rate_limit, issue_realtime_ticket,
        metrics_access_allowed, render_prometheus, serialize_ack, ticket_hash, unix_now_seconds,
        validate_realtime_ticket,
    };

    #[test]
    fn rust_audio_ack_serialization_matches_every_committed_vector() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/contracts/fixtures/realtime/audio-ack-vectors.json"
        );
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("cannot read audio ack vectors at {path}: {error}"));
        let fixture: serde_json::Value =
            serde_json::from_str(&raw).expect("audio ack vectors must be valid JSON");
        let vectors = fixture["vectors"]
            .as_array()
            .expect("audio ack vectors must be an array");
        assert_eq!(fixture["vectorCount"].as_u64(), Some(vectors.len() as u64));
        assert_eq!(vectors.len(), 3, "the Rust oracle commits three ack paths");

        for vector in vectors {
            let expected = &vector["ack"];
            assert_eq!(expected["kind"].as_str(), Some("audio.ack"));
            let ack = AudioIngressAck {
                kind: "audio.ack",
                session_id: expected["session_id"]
                    .as_str()
                    .expect("session_id")
                    .to_owned(),
                chunk_id: expected["chunk_id"].as_str().expect("chunk_id").to_owned(),
                sequence: expected["sequence"].as_u64().expect("sequence"),
                accepted: expected["accepted"].as_bool().expect("accepted"),
                trace_id: expected["trace_id"].as_str().map(ToOwned::to_owned),
                message: expected["message"].as_str().expect("message").to_owned(),
            };
            let actual: serde_json::Value = serde_json::from_str(&serialize_ack(ack))
                .expect("serialized audio ack must be valid JSON");
            assert_eq!(actual, *expected, "ack vector '{}' drifted", vector["name"]);
        }
    }

    fn metrics_headers(token: Option<&str>) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        if let Some(t) = token {
            h.insert("x-metrics-token", t.parse().unwrap());
        }
        h
    }

    /// Security: /metrics publishes operational telemetry and this gateway is published off-host
    /// (compose maps 8081 on all interfaces), so it must NEVER be readable without a token unless
    /// dev mode is explicitly enabled. It used to be wholly unauthenticated.
    #[test]
    fn metrics_access_is_fail_closed_without_a_token_or_dev_mode() {
        let config = GatewayServerConfig {
            metrics_token: None,
            metrics_dev_open: false,
            ..GatewayServerConfig::default()
        };
        assert!(
            !metrics_access_allowed(&config, &metrics_headers(None)),
            "no token configured and not dev-open must FAIL CLOSED"
        );
        assert!(
            !metrics_access_allowed(&config, &metrics_headers(Some("guess"))),
            "a guessed token must not open it either when none is configured"
        );
    }

    #[test]
    fn metrics_access_requires_the_matching_token_when_configured() {
        let config = GatewayServerConfig {
            metrics_token: Some("s3cret".to_owned()),
            metrics_dev_open: true, // must NOT override a configured token
            ..GatewayServerConfig::default()
        };
        assert!(metrics_access_allowed(
            &config,
            &metrics_headers(Some("s3cret"))
        ));
        assert!(!metrics_access_allowed(
            &config,
            &metrics_headers(Some("wrong"))
        ));
        assert!(!metrics_access_allowed(&config, &metrics_headers(None)));
    }

    #[test]
    fn metrics_access_is_open_in_explicit_dev_mode_with_no_token() {
        let config = GatewayServerConfig {
            metrics_token: None,
            metrics_dev_open: true,
            ..GatewayServerConfig::default()
        };
        assert!(metrics_access_allowed(&config, &metrics_headers(None)));
    }

    /// Safety: the chaos hook deliberately sabotages live sessions, so it must be impossible to arm
    /// in production. GatewayServerConfig::default() reads it ONLY when ALLOW_INSECURE_DEFAULTS=1;
    /// with dev mode off the env var is ignored outright rather than merely discouraged.
    #[test]
    fn chaos_fault_injection_cannot_be_armed_without_explicit_dev_mode() {
        // Simulate the config the env-reader produces in each mode (the reader itself is exercised
        // by the service's own startup; this pins the INVARIANT the reader must uphold).
        let production = GatewayServerConfig {
            chaos_drop_after_chunks: None, // what default() yields when ALLOW_INSECURE_DEFAULTS is unset
            ..GatewayServerConfig::default()
        };
        assert!(
            production.chaos_drop_after_chunks.is_none(),
            "chaos must never be armed in production"
        );

        let dev = GatewayServerConfig {
            chaos_drop_after_chunks: Some(3),
            chaos_max_drops: 2,
            ..GatewayServerConfig::default()
        };
        assert_eq!(dev.chaos_drop_after_chunks, Some(3));
        assert_eq!(
            dev.chaos_max_drops, 2,
            "a bounded drop budget lets the session finish"
        );
    }

    /// "Fail the chunk, never lose the audio" — what that means in counters.
    ///
    /// A chunk whose audio reached storage but whose index row did not is NOT a forward failure. The
    /// analysis ran; the recording exists; only its findability is gone. Sharing one counter would
    /// have let a storage outage and a database outage look identical on a dashboard, and they need
    /// different repairs: one loses analysis, the other leaves orphaned recordings to re-index.
    #[tokio::test]
    async fn an_index_failure_is_counted_separately_from_a_forward_failure() {
        let gateway = RealtimeGateway::new(4);
        gateway.record_index_failure();
        gateway.record_index_failure();
        gateway.record_forward_failure();

        let m = gateway.metrics().await;
        assert_eq!(m.chunks_index_failed, 2, "index failures were not counted");
        assert_eq!(
            m.chunks_forward_failed, 1,
            "an index failure was counted as a forward failure; a database outage would read as an \
             ML outage"
        );
    }

    #[tokio::test]
    async fn the_index_failure_counter_is_exposed_to_prometheus() {
        // A counter nothing scrapes is a counter nobody sees. The whole point of not deleting the
        // audio is that an operator can go and re-index it, which requires knowing it happened.
        let gateway = RealtimeGateway::new(4);
        gateway.record_index_failure();
        let out = render_prometheus(&gateway.metrics().await, 0, true);
        assert!(
            out.contains("realtime_gateway_chunks_index_failed_total 1"),
            "the index-failure counter is not exposed: {out}"
        );
        assert!(
            out.contains("realtime_gateway_chunks_stored_unindexed_total 1"),
            "the actionable aggregate is not exposed: {out}"
        );
        assert!(out.contains("realtime_gateway_audio_index_enabled 1"));
    }

    #[test]
    fn renders_prometheus_text_exposition_not_json() {
        let m = GatewayMetrics {
            active_sessions: 2,
            sessions_started: 5,
            sessions_ended: 3,
            chunks_accepted: 40,
            chunks_index_failed: 1,
            chunks_index_disabled: 2,
            chunks_rejected_backpressure: 1,
            chunks_rejected_missing_session: 2,
            chunks_forward_failed: 4,
        };
        let out = render_prometheus(&m, 7, false);
        assert!(out.contains("# TYPE realtime_gateway_active_sessions gauge"));
        assert!(out.contains("realtime_gateway_active_sessions 2"));
        assert!(out.contains("# TYPE realtime_gateway_chunks_forward_failed_total counter"));
        assert!(out.contains("realtime_gateway_chunks_forward_failed_total 4"));
        assert!(out.contains("realtime_gateway_chunks_stored_unindexed_total 3"));
        assert!(out.contains("realtime_gateway_audio_index_enabled 0"));
        assert!(out.contains("realtime_gateway_consumed_tickets 7"));
        assert!(!out.contains('{'), "must be Prometheus text, not JSON");
    }

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
            "discard",
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
    async fn redis_tracking_never_holds_the_session_lock_across_network_io() {
        // Accept the TCP connection but never answer Redis' handshake. This keeps the tracking
        // future pending long enough to prove a chunk send is not blocked behind it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let stalled_redis = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            let _ = accepted_tx.send(());
            tokio::time::sleep(Duration::from_secs(5)).await;
        });

        let gateway = RealtimeGateway::with_redis(2, Some(format!("redis://{address}")));
        let start_gateway = gateway.clone();
        let starting = tokio::spawn(async move { start_gateway.start_session("session-1").await });

        timeout(Duration::from_secs(1), accepted_rx)
            .await
            .expect("gateway should connect to the stalled Redis endpoint")
            .expect("listener should acknowledge the accepted connection");

        let sent = timeout(
            Duration::from_millis(100),
            gateway.send_chunk(chunk("session-1", "chunk-1")),
        )
        .await;
        assert!(
            matches!(sent, Ok(Ok(()))),
            "session lock must not wait for Redis tracking"
        );

        starting.abort();
        stalled_redis.abort();
    }

    #[tokio::test]
    async fn redis_end_tracking_never_blocks_session_lookup() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let stalled_redis = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            let _ = accepted_tx.send(());
            tokio::time::sleep(Duration::from_secs(5)).await;
        });

        // Create the session before enabling the deliberately stalled Redis endpoint, then prove
        // end-session's best-effort reconciliation does not block a concurrent map lookup.
        let mut gateway = RealtimeGateway::new(2);
        let _reader = gateway.start_session("session-1").await.unwrap();
        gateway.redis_url = Some(format!("redis://{address}"));
        let end_gateway = gateway.clone();
        let ending = tokio::spawn(async move { end_gateway.end_session("session-1").await });

        timeout(Duration::from_secs(1), accepted_rx)
            .await
            .expect("gateway should connect to the stalled Redis endpoint")
            .expect("listener should acknowledge the accepted connection");

        let lookup = timeout(
            Duration::from_millis(100),
            gateway.send_chunk(chunk("session-1", "chunk-1")),
        )
        .await;
        assert_eq!(
            lookup,
            Ok(Err(GatewayError::SessionNotFound("session-1".to_owned()))),
            "session lookup must not wait for Redis end tracking"
        );

        ending.abort();
        stalled_redis.abort();
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

    /// Regression: verified empirically that a 10 MB binary WebSocket frame was accepted with NO
    /// size check at all before this limit existed (a real chunk is ~92 KB at most: 480ms of 48kHz
    /// stereo 16-bit PCM). A handful of malicious/buggy connections sending near-max-size frames
    /// could otherwise exhaust gateway memory.
    #[test]
    fn rejects_oversized_audio_chunk() {
        assert!(
            AudioChunk::new(
                "session-1",
                "at-cap",
                0,
                20,
                16_000,
                vec![0u8; MAX_CHUNK_BYTES]
            )
            .is_ok()
        );
        assert_eq!(
            AudioChunk::new(
                "session-1",
                "over-cap",
                0,
                20,
                16_000,
                vec![0u8; MAX_CHUNK_BYTES + 1]
            )
            .unwrap_err(),
            GatewayError::ChunkTooLarge {
                size: MAX_CHUNK_BYTES + 1,
                max: MAX_CHUNK_BYTES,
            }
        );
    }

    /// Serializes tests that mutate the process-wide env vars `validate_origin` reads per-request
    /// (ALLOW_INSECURE_DEFAULTS / GATEWAY_ALLOW_MISSING_ORIGIN / CORS_ALLOWED_ORIGINS). Any future
    /// test touching those MUST take this lock, or it can race this one (cargo runs unit tests
    /// multi-threaded in one process).
    static ORIGIN_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn test_audio_ws_origin_validation() {
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        let _env = ORIGIN_ENV_LOCK.lock().await;

        // Set up env variables
        unsafe {
            std::env::set_var("ALLOW_INSECURE_DEFAULTS", "false");
            std::env::set_var(
                "CORS_ALLOWED_ORIGINS",
                "http://localhost:5173,https://quran-ai.example.com",
            );
        }

        // Rate limiting off: this test drives the router via `oneshot` (no real TCP connection), so
        // tower_governor's peer-IP key extractor has nothing to read and would 500 every request.
        let router = gateway_router_with_rate_limit(GatewayServerConfig::default(), false);

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

    /// The reason the split exists (specs/insecure-defaults-split/plan.md §3.2).
    ///
    /// A native/Flutter client sends no `Origin` header, so before the split the only way to accept
    /// one was ALLOW_INSECURE_DEFAULTS — which ALSO turned off the allowlist, a public JWT key, a
    /// BYPASSRLS DB role and an open /metrics. GATEWAY_ALLOW_MISSING_ORIGIN relaxes ONLY the
    /// missing-Origin branch.
    ///
    /// Case 2 is the whole point: a disallowed Origin must STILL be 403. If that ever returns 426,
    /// the narrow knob has silently become the blunt one and every browser loses CSWSH protection.
    #[tokio::test]
    async fn missing_origin_knob_does_not_disable_the_allowlist() {
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        let _env = ORIGIN_ENV_LOCK.lock().await;

        unsafe {
            // Explicitly remove rather than assume: another test in this process may have left it.
            std::env::remove_var("ALLOW_INSECURE_DEFAULTS");
            std::env::set_var("GATEWAY_ALLOW_MISSING_ORIGIN", "1");
            std::env::set_var("CORS_ALLOWED_ORIGINS", "https://quran-ai.example.com");
        }

        let router = gateway_router_with_rate_limit(GatewayServerConfig::default(), false);
        let upgrade_request = |origin: Option<&str>| {
            let mut builder = Request::builder()
                .uri("/v1/recitation-sessions/session-1/audio?ticket=invalid")
                .header("upgrade", "websocket")
                .header("connection", "upgrade")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .header("sec-websocket-version", "13");
            if let Some(value) = origin {
                builder = builder.header("origin", value);
            }
            builder.body(axum::body::Body::empty()).unwrap()
        };

        // 1. The native client: NO Origin header now gets past the CSWSH layer (426 = the origin
        //    check passed and the ticket layer took over, which is as far as this test goes).
        let resp = router.clone().oneshot(upgrade_request(None)).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UPGRADE_REQUIRED,
            "a native client sending no Origin must connect"
        );

        // 2. THE ASSERTION. A browser presenting a disallowed Origin is still refused.
        let resp = router
            .clone()
            .oneshot(upgrade_request(Some("https://malicious.example.com")))
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "GATEWAY_ALLOW_MISSING_ORIGIN must NOT disable the allowlist — this is the difference \
             between the split being a fix and being bookkeeping"
        );

        // 3. An allowed Origin is unaffected.
        let resp = router
            .clone()
            .oneshot(upgrade_request(Some("https://quran-ai.example.com")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UPGRADE_REQUIRED);

        unsafe {
            std::env::remove_var("GATEWAY_ALLOW_MISSING_ORIGIN");
            std::env::remove_var("CORS_ALLOWED_ORIGINS");
        }
    }

    // check_ticket tests: this is the logic that used to live directly inside audio_ws, where it
    // was unreachable by cargo test at all (see check_ticket's own doc comment). Extracting it let
    // these tests exercise ticket validity, tenant binding, and replay rejection directly.
    use axum::http::StatusCode;

    fn state_for_ticket_tests(config: GatewayServerConfig) -> GatewayServerState {
        GatewayServerState {
            gateway: RealtimeGateway::new(config.chunk_capacity),
            config,
            consumed_tickets: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            http_client: reqwest::Client::new(),
            chaos_drops: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// G2 — the ticket-lifetime bound, tested ON THE BOUNDARY rather than only end to end.
    /// specs/gateway-ws-sweep/plan.md §4
    ///
    /// A far-future expiry is not an auth bypass — producing one needs the signing secret. What it
    /// does is permanent: `consumed_tickets` maps a ticket to its expiry and `evict_expired` retains
    /// anything with `expires_at > now`, so a `u64::MAX` entry is NEVER evicted. Each such ticket is
    /// a permanent map entry, defeating the per-entry eviction added in `55c872e` specifically to
    /// keep that map bounded.
    #[tokio::test]
    async fn check_ticket_refuses_an_implausible_lifetime() {
        let secret = "lifetime-secret";
        let tenant_id = "tenant-lifetime";
        let state = state_for_ticket_tests(GatewayServerConfig {
            ticket_secret: secret.to_owned(),
            tenant_id: tenant_id.to_owned(),
            ..GatewayServerConfig::default()
        });
        let now = unix_now_seconds();

        let ticket_expiring_at = |expires_at: u64, nonce: &str| {
            let mut query = HashMap::new();
            query.insert(
                "ticket".to_owned(),
                issue_realtime_ticket(
                    "session-1",
                    tenant_id,
                    "learner-1",
                    false,
                    "discard",
                    expires_at,
                    nonce,
                    secret,
                ),
            );
            query
        };

        // Both sides of the boundary, so the constant is pinned rather than the direction.
        for (label, expires_at, should_accept) in [
            ("the 300s platform-api mints", now + 300, true),
            (
                "exactly at the cap",
                now + MAX_TICKET_LIFETIME_SECONDS,
                true,
            ),
            (
                "one second past the cap",
                now + MAX_TICKET_LIFETIME_SECONDS + 1,
                false,
            ),
            ("u64::MAX — permanently unevictable", u64::MAX, false),
        ] {
            let query = ticket_expiring_at(expires_at, label);
            let outcome = check_ticket(&state, "session-1", &query).await;
            let accepted = matches!(outcome, TicketCheckOutcome::Accepted { .. });
            assert_eq!(
                accepted, should_accept,
                "{label}: unexpected outcome {outcome:?}"
            );
            // A refusal must be indistinguishable from any other bad ticket, or the new check
            // becomes an oracle for what a valid signature looks like.
            if let TicketCheckOutcome::Rejected(status) = outcome {
                assert_eq!(status, StatusCode::UNAUTHORIZED, "{label}");
            }
        }
    }

    /// The consequence the bound exists to prevent, asserted directly on the eviction it defeats.
    #[test]
    fn an_unbounded_expiry_would_never_be_evicted() {
        let mut consumed = HashMap::new();
        consumed.insert("normal".to_owned(), 1_000_u64);
        consumed.insert("immortal".to_owned(), u64::MAX);

        // Far past both "now" values a real deployment will ever see.
        let removed = evict_expired(&mut consumed, u64::MAX - 1);
        assert_eq!(removed, 1, "the normal entry must be evicted");
        assert!(
            consumed.contains_key("immortal"),
            "a u64::MAX expiry survives every eviction pass — which is why check_ticket must refuse \
             it at the door rather than relying on the sweep to clean up"
        );
    }

    #[tokio::test]
    async fn check_ticket_accepts_a_valid_ticket_and_extracts_learner_and_trace_id() {
        let secret = "check-ticket-secret";
        let tenant_id = "tenant-check-ticket";
        let state = state_for_ticket_tests(GatewayServerConfig {
            ticket_secret: secret.to_owned(),
            tenant_id: tenant_id.to_owned(),
            ..GatewayServerConfig::default()
        });
        let ticket = issue_realtime_ticket(
            "session-1",
            tenant_id,
            "learner-1",
            false,
            "discard",
            unix_now_seconds() + 300,
            "nonce-1",
            secret,
        );
        let mut query = HashMap::new();
        query.insert("ticket".to_owned(), ticket);
        query.insert("trace_id".to_owned(), "trace-abc".to_owned());

        match check_ticket(&state, "session-1", &query).await {
            TicketCheckOutcome::Accepted {
                learner_id,
                audio_retention,
                trace_id,
                ticket: carried,
            } => {
                // The raw ticket is carried through so the chunk indexer can present it to
                // platform-api. Asserted rather than ignored with `..`: if it stopped being the
                // ticket the session was admitted with, indexing would authenticate as something
                // else, and a `..` here would have said nothing about that.
                assert!(
                    !carried.is_empty(),
                    "the admitted ticket was not carried through"
                );
                assert_eq!(learner_id, "learner-1");
                assert_eq!(audio_retention, "discard");
                assert_eq!(trace_id.as_deref(), Some("trace-abc"));
            }
            TicketCheckOutcome::Rejected(status) => {
                panic!("expected a valid ticket to be accepted, got {status}")
            }
        }
    }

    fn a_chunk() -> AudioChunk {
        AudioChunk {
            session_id: "session-1".to_owned(),
            chunk_id: "session-1-ws-0001".to_owned(),
            start_ms: 0,
            end_ms: 480,
            sample_rate: 16_000,
            bytes: vec![1, 2, 3, 4],
        }
    }

    /// The bug this whole change exists to fix, stated as a test.
    ///
    /// Before it, the forwarded body simply had no `audioRetention` key. ml-inference's
    /// `requestBody.audioRetention ?? "discard"` filled the hole, wrote "discard" into every chunk's
    /// .meta.json, and its eviction sweep deleted a learner's recording an hour later — including a
    /// learner who had chosen "teacher-review" and whose teacher would find nothing. Nothing logged
    /// an error; the pipeline was working exactly as written.
    #[test]
    fn the_forwarded_chunk_body_carries_the_learners_retention_choice() {
        for retention in ["discard", "teacher-review", "training-opt-in"] {
            let body = chunk_forward_body(&a_chunk(), "tenant-1", "learner-1", retention, None);
            assert_eq!(
                body["audioRetention"],
                serde_json::json!(retention),
                "ml-inference decides how long a child's recorded voice is kept from this field"
            );
        }
    }

    /// `?? "discard"` downstream means an ABSENT field and a "discard" field are indistinguishable
    /// once they arrive. The difference has to be caught here, on the sending side, or not at all.
    #[test]
    fn the_forwarded_chunk_body_never_simply_omits_retention() {
        let body = chunk_forward_body(&a_chunk(), "tenant-1", "learner-1", "teacher-review", None);
        let obj = body.as_object().expect("the body is a JSON object");
        assert!(
            obj.contains_key("audioRetention"),
            "the key is missing, which ml-inference silently reads as 'discard' — the exact failure \
             this function was extracted to make visible"
        );
        // The rest of the contract, so a refactor cannot drop a field this test does not name.
        for key in [
            "tenantId",
            "learnerId",
            "sessionId",
            "chunkId",
            "sampleRate",
            "startMs",
            "endMs",
            "audioBase64",
            "audioSize",
            "audioRetention",
            "traceId",
        ] {
            assert!(obj.contains_key(key), "the ML chunk body lost `{key}`");
        }
        assert_eq!(
            obj.len(),
            11,
            "an unexpected field joined the ML chunk body"
        );
    }

    /// P5.3 (observability assertions): the trace id is the ONLY thing joining a learner's
    /// WebSocket session to the ML requests it produced. When a recitation fails in the pilot, it is
    /// what makes the difference between reading one request's logs and reading all of them.
    ///
    /// Every other test of this function passes `None`, so `"traceId"` was asserted PRESENT and only
    /// ever observed as `null`. A refactor that hardcoded `"traceId": null`, dropped the parameter,
    /// or wired the wrong variable in passes all of them — the key-presence check above included.
    /// Presence is not propagation.
    #[test]
    fn the_forwarded_chunk_body_carries_the_trace_id_it_was_given() {
        let traced = chunk_forward_body(
            &a_chunk(),
            "tenant-1",
            "learner-1",
            "teacher-review",
            Some("trace-xyz"),
        );
        assert_eq!(
            traced["traceId"],
            serde_json::json!("trace-xyz"),
            "the trace id did not survive into the ML request body, so nothing downstream can be \
             correlated back to the session that caused it"
        );

        // ...and an untraced request must stay DISTINGUISHABLE from a traced one, or the assertion
        // above could be satisfied by a function that stamped a constant into every request.
        let untraced =
            chunk_forward_body(&a_chunk(), "tenant-1", "learner-1", "teacher-review", None);
        assert_eq!(
            untraced["traceId"],
            serde_json::Value::Null,
            "an untraced chunk reported a trace id it was never given"
        );
    }

    #[tokio::test]
    async fn the_accepted_outcome_carries_the_retention_the_ticket_was_signed_with() {
        // Not the same claim as the test above, which would still pass if `check_ticket` hardcoded
        // "discard" — the value it happens to use. This one signs a DIFFERENT choice and requires it
        // to survive: a learner who agreed to keep their recording for a teacher must not have that
        // silently rewritten into the one-hour default somewhere between the ticket and the chunk.
        let secret = "retention-secret";
        let tenant_id = "tenant-retention";
        for retention in ["discard", "teacher-review", "training-opt-in"] {
            let state = state_for_ticket_tests(GatewayServerConfig {
                ticket_secret: secret.to_owned(),
                tenant_id: tenant_id.to_owned(),
                ..GatewayServerConfig::default()
            });
            let ticket = issue_realtime_ticket(
                "session-1",
                tenant_id,
                "learner-1",
                false,
                retention,
                unix_now_seconds() + 300,
                // A fresh nonce per iteration: the same ticket twice is a replay, and the
                // single-use check would reject the second one for the wrong reason.
                &format!("nonce-{retention}"),
                secret,
            );
            let mut query = HashMap::new();
            query.insert("ticket".to_owned(), ticket);

            match check_ticket(&state, "session-1", &query).await {
                TicketCheckOutcome::Accepted {
                    audio_retention, ..
                } => assert_eq!(audio_retention, retention),
                TicketCheckOutcome::Rejected(status) => {
                    panic!("expected retention '{retention}' to be accepted, got {status}")
                }
            }
        }
    }

    #[tokio::test]
    async fn check_ticket_rejects_missing_ticket() {
        let state = state_for_ticket_tests(GatewayServerConfig::default());
        let query = HashMap::new();
        match check_ticket(&state, "session-1", &query).await {
            TicketCheckOutcome::Rejected(status) => {
                assert_eq!(status, StatusCode::UNAUTHORIZED);
            }
            TicketCheckOutcome::Accepted { .. } => panic!("expected missing ticket to be rejected"),
        }
    }

    /// A ticket validly signed for a DIFFERENT tenant must be rejected even though the shared HMAC
    /// secret verifies its signature — otherwise embedding tenant_id in the ticket is pointless.
    #[tokio::test]
    async fn check_ticket_rejects_cross_tenant_ticket() {
        let secret = "cross-tenant-secret";
        let state = state_for_ticket_tests(GatewayServerConfig {
            ticket_secret: secret.to_owned(),
            tenant_id: "tenant-gateway-serves".to_owned(),
            ..GatewayServerConfig::default()
        });
        let ticket = issue_realtime_ticket(
            "session-1",
            "tenant-someone-else",
            "learner-1",
            false,
            "discard",
            unix_now_seconds() + 300,
            "nonce-1",
            secret,
        );
        let mut query = HashMap::new();
        query.insert("ticket".to_owned(), ticket);

        match check_ticket(&state, "session-1", &query).await {
            TicketCheckOutcome::Rejected(status) => {
                assert_eq!(status, StatusCode::UNAUTHORIZED);
            }
            TicketCheckOutcome::Accepted { .. } => {
                panic!("expected a cross-tenant ticket to be rejected")
            }
        }
    }

    /// A valid, unexpired, correctly-tenant-bound ticket must be usable exactly once — a second
    /// check with the SAME ticket must be rejected as a replay, never silently accepted again.
    /// This exact check (`mem_replay || redis_dedup == TicketDedup::Replay`) was the mutation
    /// cargo-mutants found genuinely uncaught by any Rust test before check_ticket existed.
    #[tokio::test]
    async fn check_ticket_rejects_a_replayed_ticket() {
        let secret = "replay-secret";
        let tenant_id = "tenant-replay-test";
        let state = state_for_ticket_tests(GatewayServerConfig {
            ticket_secret: secret.to_owned(),
            tenant_id: tenant_id.to_owned(),
            ..GatewayServerConfig::default()
        });
        let ticket = issue_realtime_ticket(
            "session-1",
            tenant_id,
            "learner-1",
            false,
            "discard",
            unix_now_seconds() + 300,
            "nonce-1",
            secret,
        );
        let mut query = HashMap::new();
        query.insert("ticket".to_owned(), ticket);

        match check_ticket(&state, "session-1", &query).await {
            TicketCheckOutcome::Accepted { .. } => {}
            TicketCheckOutcome::Rejected(status) => {
                panic!("expected the first use to be accepted, got {status}")
            }
        }

        match check_ticket(&state, "session-1", &query).await {
            TicketCheckOutcome::Rejected(status) => {
                assert_eq!(status, StatusCode::UNAUTHORIZED);
            }
            TicketCheckOutcome::Accepted { .. } => {
                panic!("expected the replayed ticket to be rejected")
            }
        }
    }

    /// ticket_fail_closed (opt-in, REALTIME_TICKET_FAIL_CLOSED=1) must refuse the connection
    /// (503) when Redis is configured but unreachable, rather than silently degrading to
    /// per-process-only replay protection — a cross-instance replay could otherwise slip through
    /// during the outage. An unreachable (not just absent) Redis URL is enough to trigger this:
    /// `redis_mark_ticket` attempts to connect, fails, and returns `TicketDedup::Unavailable`.
    #[tokio::test]
    async fn check_ticket_fails_closed_when_redis_configured_but_unreachable() {
        let secret = "fail-closed-secret";
        let tenant_id = "tenant-fail-closed";
        let config = GatewayServerConfig {
            ticket_secret: secret.to_owned(),
            tenant_id: tenant_id.to_owned(),
            ticket_fail_closed: true,
            ..GatewayServerConfig::default()
        };
        let state = GatewayServerState {
            gateway: RealtimeGateway::with_redis(
                config.chunk_capacity,
                Some("redis://127.0.0.1:1/".to_owned()),
            ),
            config,
            consumed_tickets: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            http_client: reqwest::Client::new(),
            chaos_drops: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        };
        let ticket = issue_realtime_ticket(
            "session-1",
            tenant_id,
            "learner-1",
            false,
            "discard",
            unix_now_seconds() + 300,
            "nonce-1",
            secret,
        );
        let mut query = HashMap::new();
        query.insert("ticket".to_owned(), ticket);

        match check_ticket(&state, "session-1", &query).await {
            TicketCheckOutcome::Rejected(status) => {
                assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            }
            TicketCheckOutcome::Accepted { .. } => {
                panic!("expected fail-closed to refuse the connection when Redis is unreachable")
            }
        }
    }

    /// A session's chunk numbering must SURVIVE the socket that carried it.
    ///
    /// The bug this pins: `sequence` lived in the per-connection handler, so a reconnect restarted
    /// it at zero. Both things derived from it restarted too — the chunk id, which is the filename
    /// audio is stored under, and `start_ms`. Connection 2 therefore wrote over connection 1's
    /// recording under the same key, dated as if spoken at the same instant. Measured end to end
    /// (specs/dr-rehearsal/evidence/P5.4-reconnect-drill.log): 12 chunks sent and acked across two
    /// reconnects, 6 distinct ids, 6 files on disk.
    #[tokio::test]
    async fn a_reconnect_continues_the_session_numbering_instead_of_repeating_it() {
        let gateway = RealtimeGateway::new(8);

        // Connection 1: a session nobody has streamed starts at zero.
        let first_start = gateway.resume_sequence("session-a").await;
        assert_eq!(first_start, 0);
        let conn1: Vec<u64> = (first_start..first_start + 3).collect();
        gateway.record_sequence("session-a", 3).await;

        // Connection 2: same session id — that is what a reconnect IS — must not start over.
        let second_start = gateway.resume_sequence("session-a").await;
        assert_eq!(
            second_start, 3,
            "the reconnect restarted the session's numbering"
        );
        let conn2: Vec<u64> = (second_start..second_start + 3).collect();

        // The property that actually protects the audio: no id is minted twice.
        let ids = |seqs: &[u64]| -> Vec<String> {
            seqs.iter()
                .map(|n| format!("session-a-ws-{n:04}"))
                .collect()
        };
        let all = [ids(&conn1), ids(&conn2)].concat();
        let mut distinct = all.clone();
        distinct.sort();
        distinct.dedup();
        assert_eq!(
            distinct.len(),
            all.len(),
            "two connections minted the same chunk id, so the second overwrites the first: {all:?}"
        );

        // And the session clock only moves forward — start_ms is derived from this same counter, so
        // a repeat would make later audio claim an earlier moment and be reassembled out of order.
        assert!(conn2[0] > *conn1.last().unwrap());
    }

    /// Sessions do not belong to each other.
    #[tokio::test]
    async fn each_session_keeps_its_own_cursor() {
        let gateway = RealtimeGateway::new(8);
        gateway.record_sequence("session-a", 9).await;
        assert_eq!(gateway.resume_sequence("session-b").await, 0);
        assert_eq!(gateway.resume_sequence("session-a").await, 9);
    }

    /// The cursor never moves backwards.
    ///
    /// Two connections for one session can overlap: the dying socket's handler runs its recording
    /// step after the new one has already started streaming. A late, smaller value from the old
    /// connection would hand the live one ids it has already used — re-opening the exact bug.
    #[tokio::test]
    async fn a_late_record_from_a_dying_connection_cannot_rewind_the_cursor() {
        let gateway = RealtimeGateway::new(8);
        gateway.record_sequence("session-a", 6).await;
        gateway.record_sequence("session-a", 2).await; // the straggler
        assert_eq!(
            gateway.resume_sequence("session-a").await,
            6,
            "a late straggler rewound the cursor and will re-issue ids 2..6"
        );
    }

    /// The three tests above pin the CURSOR. This one pins that the socket handler actually uses it.
    ///
    /// Written after those three failed to notice the bug being put back: reverting
    /// `handle_audio_socket` to `let mut sequence = 0_u64;` left all forty tests green, because the
    /// cursor API kept behaving perfectly while nothing called it. A fix whose tests cannot detect
    /// its own removal is not a fix, it is a coincidence.
    ///
    /// Source-level, because the alternative — driving two real websocket connections through the
    /// router and comparing minted ids — is an integration test this module has no harness for. The
    /// end-to-end proof is the reconnect drill (specs/dr-rehearsal/evidence/P5.4-reconnect-drill.log),
    /// which is deterministic in ten seconds; this is the cheap half that runs on every build.
    #[test]
    fn the_socket_handler_seeds_its_counter_from_the_session_cursor() {
        // Only the PRODUCTION half. `include_str!` pulls in this test module too, and the needles
        // below appear here verbatim — the first version of this test failed on its own assertion
        // strings. Splitting at the test attribute keeps the check looking at the code it is about.
        let whole = include_str!("lib.rs");
        let source = whole
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .unwrap_or(whole);

        assert!(
            source.contains("let mut sequence = state.gateway.resume_sequence(&session_id).await;"),
            "handle_audio_socket no longer seeds its chunk counter from the session cursor, so a \
             reconnect will re-mint ids that already name stored audio and overwrite it"
        );
        assert!(
            !source.contains("let mut sequence = 0_u64;"),
            "the per-connection counter is back. That is the original bug: the chunk id is the \
             storage filename and start_ms is derived from the same value, so connection 2 writes \
             over connection 1's recording, timestamped as if spoken at the same moment"
        );
        assert!(
            source.contains(".record_sequence(&session_id, sequence)"),
            "the handler no longer records how far it counted, so the NEXT connection resumes from \
             a stale cursor and repeats ids"
        );
    }

    /// One session cannot store without bound, and reconnecting does not reset the budget.
    ///
    /// `MAX_CHUNK_BYTES` bounds a single frame; nothing bounded the total. Measured against a real
    /// gateway and ml-inference before the cap existed: 40 x 512 KiB down one socket on one ticket
    /// was 20 MiB accepted, ZERO refusals, 16 MiB on disk. With the cap temporarily set to 5 and
    /// twelve chunks sent, it was 5 accepted / 7 refused and the disk stopped growing.
    ///
    /// The reconnect property is the subtle half and the reason this asserts on `sequence`: a
    /// socket-local byte counter would reset on every reconnect, handing a fresh budget to anyone
    /// with a flaky connection. `sequence` is seeded from `resume_sequence`, so the budget is the
    /// session's, not the socket's.
    ///
    /// Source-level for the same reason as the test above: driving 15_000 chunks through a real
    /// socket is not something this module has a harness for, and the empirical proof is recorded
    /// above rather than re-run on every build.
    #[test]
    fn one_session_cannot_grow_without_bound() {
        let whole = include_str!("lib.rs");
        let source = whole
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .unwrap_or(whole);

        assert!(
            source.contains("if sequence >= MAX_SESSION_CHUNKS {"),
            "the per-session chunk cap is gone. A learner can then stream until the volume is full \
             — and because `training-opt-in` audio is never evicted, permanently. The same volume \
             holds the audit log, whose write failure is swallowed by design"
        );
        const _: () = assert!(
            crate::MAX_SESSION_CHUNKS >= 10_000,
            "the cap is under two hours of audio at 480ms each. \
             That risks cutting off a legitimate long recitation; raise it or restate the derivation"
        );
        assert!(
            !source.contains("let mut session_bytes = 0"),
            "a socket-local byte counter is back. It resets on reconnect, so it does not bound a \
             SESSION — which is the thing that outlives the socket"
        );
    }
}
