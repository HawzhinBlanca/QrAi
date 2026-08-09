import { createAudioAck, serializeAudioAck } from "./protocol.mjs";
import { AUDIO_DELIVERY_OUTCOMES } from "./outcomes.mjs";

const MiB = 1024 * 1024;
const SOCKET_OPEN = 1;

export const AUDIO_LIMITS = Object.freeze({
  maxPayloadBytes: 2 * MiB,
  maxTransportBytes: 2 * MiB + 64 * 1024,
  maxRetainedChunksPerSession: 8,
  maxRetainedBytesPerSession: 4 * MiB,
  maxRetainedBytesGlobal: 64 * MiB,
  maxActiveSessions: 100,
  maxAckBufferedBytes: 64 * 1024,
  maxCursorEntries: 1_024,
  cursorTtlMs: 6 * 60 * 60 * 1_000,
  storeAttemptTimeoutMs: 2_000,
  maxDrainMs: 4_000,
  sampleRate: 16_000,
  chunkDurationMs: 480,
});

export const AUDIO_SESSION_OUTCOMES = Object.freeze([
  "started",
  "ended",
  "capacity",
  "duplicate",
]);

export const AUDIO_INGRESS_OUTCOMES = Object.freeze([
  "enqueued",
  "backpressure",
  "empty",
  "oversized",
  "sequence_exhausted",
  "slow_consumer",
]);

export const AUDIO_STORE_OUTCOMES = Object.freeze([
  "stored",
  "failed",
  "aborted",
]);

export const AUDIO_MAX_SEQUENCE = Math.floor(
  (Number.MAX_SAFE_INTEGER - AUDIO_LIMITS.chunkDurationMs) / AUDIO_LIMITS.chunkDurationMs,
);

export function audioTimeline(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > AUDIO_MAX_SEQUENCE) return null;
  return Object.freeze({
    startMs: sequence * AUDIO_LIMITS.chunkDurationMs,
    endMs: (sequence + 1) * AUDIO_LIMITS.chunkDurationMs,
  });
}

function counters(outcomes) {
  return Object.fromEntries(outcomes.map((outcome) => [outcome, 0]));
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`realtime audio ${name} must be a non-empty string`);
  }
  return value;
}

function validateContext(context) {
  if (!context || context.accepted !== true || !context.claims || !Object.isFrozen(context.claims)) {
    throw new TypeError("realtime audio requires frozen admitted claims");
  }
  const traceId = context.traceId;
  if (traceId !== null && (typeof traceId !== "string" || traceId.trim() === "")) {
    throw new TypeError("realtime audio trace id must be null or a non-empty string");
  }
  const claims = context.claims;
  const audioRetention = requiredString(claims.audioRetention, "retention");
  if (!["discard", "teacher-review", "training-opt-in"].includes(audioRetention)) {
    throw new TypeError("realtime audio retention is invalid");
  }
  return Object.freeze({
    tenantId: requiredString(claims.tenantId, "tenant id"),
    learnerId: requiredString(claims.learnerId, "learner id"),
    sessionId: requiredString(claims.sessionId, "session id"),
    audioRetention,
    traceId,
  });
}

function validateSocket(socket) {
  if (
    !socket ||
    typeof socket.on !== "function" ||
    typeof socket.send !== "function" ||
    typeof socket.close !== "function"
  ) {
    throw new TypeError("realtime audio requires a WebSocket-like boundary");
  }
}

function rawAudioBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(value);
  }
  return null;
}

function metric(type, name, help, value) {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}

function labelledCounter(name, help, values, orderedOutcomes) {
  let output = `# HELP ${name} ${help}\n# TYPE ${name} counter\n`;
  for (const outcome of orderedOutcomes) {
    output += `${name}{outcome="${outcome}"} ${values[outcome]}\n`;
  }
  return output;
}

/**
 * One bounded audio-ingress authority for the isolated Node realtime process.
 *
 * `accepted=true` means the chunk received a slot and byte reservation. Storage is deliberately a
 * separate outcome: changing that meaning would silently fork the Rust-generated wire contract.
 */
export function createRealtimeAudioRuntime({
  audioObjectStore,
  audioOutcomeAuthority,
  shutdownGraceMs,
  nowMs = Date.now,
} = {}) {
  if (!audioObjectStore || typeof audioObjectStore.put !== "function") {
    throw new TypeError("realtime audio requires the object-store put boundary");
  }
  if (
    !audioOutcomeAuthority ||
    typeof audioOutcomeAuthority.stored !== "function" ||
    typeof audioOutcomeAuthority.lost !== "function" ||
    typeof audioOutcomeAuthority.lostMany !== "function"
  ) {
    throw new TypeError("realtime audio requires a complete realtime audio outcome authority");
  }
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs <= 0) {
    throw new TypeError("realtime audio shutdown grace must be a positive safe integer");
  }
  if (typeof nowMs !== "function") throw new TypeError("realtime audio clock must be a function");

  const sessions = new Map();
  const cursors = new Map();
  const sessionCounters = counters(AUDIO_SESSION_OUTCOMES);
  const ingressCounters = counters(AUDIO_INGRESS_OUTCOMES);
  const storeCounters = counters(AUDIO_STORE_OUTCOMES);
  const deliveryCounters = counters(AUDIO_DELIVERY_OUTCOMES);
  let retainedChunks = 0;
  let retainedBytes = 0;
  let stopping = false;
  let stopPromise = null;

  function snapshot() {
    return {
      activeSessions: sessions.size,
      retainedChunks,
      retainedBytes,
    };
  }

  function closeSocket(socket, code = 1013, reason = "try again later") {
    try {
      socket.close(code, reason);
    } catch {
      try {
        socket.terminate?.();
      } catch {
        // The peer is already gone. Session cleanup is owned by the close/error path below.
      }
    }
  }

  function ackFits(socket, serialized) {
    return (
      Number.isSafeInteger(socket.bufferedAmount) &&
      socket.bufferedAmount >= 0 &&
      socket.bufferedAmount + Buffer.byteLength(serialized) <= AUDIO_LIMITS.maxAckBufferedBytes
    );
  }

  function writeAck(socket, serialized) {
    try {
      socket.send(serialized, (error) => {
        if (error) closeSocket(socket);
      });
      return true;
    } catch {
      closeSocket(socket);
      return false;
    }
  }

  function sendAck(socket, input) {
    if (socket.readyState !== SOCKET_OPEN) return false;
    const serialized = serializeAudioAck(createAudioAck(input));
    if (!ackFits(socket, serialized)) {
      ingressCounters.slow_consumer += 1;
      closeSocket(socket);
      return false;
    }
    return writeAck(socket, serialized);
  }

  function rejection(session, message) {
    deliveryCounters.rejected += 1;
    return sendAck(session.socket, {
      sessionId: session.identity.sessionId,
      chunkId: `${session.identity.sessionId}-ws-${String(session.nextSequence).padStart(4, "0")}`,
      sequence: session.nextSequence,
      accepted: false,
      traceId: session.identity.traceId,
      message,
    });
  }

  function sweepCursors(now) {
    for (const [sessionId, cursor] of cursors) {
      if (now - cursor.touchedAtMs >= AUDIO_LIMITS.cursorTtlMs) cursors.delete(sessionId);
    }
    while (cursors.size >= AUDIO_LIMITS.maxCursorEntries) {
      const oldest = cursors.keys().next().value;
      if (oldest === undefined) break;
      cursors.delete(oldest);
    }
  }

  function recordCursor(session) {
    const now = nowMs();
    sweepCursors(now);
    const prior = cursors.get(session.identity.sessionId)?.nextSequence ?? 0;
    cursors.delete(session.identity.sessionId);
    cursors.set(session.identity.sessionId, {
      nextSequence: Math.max(prior, session.nextSequence),
      touchedAtMs: now,
    });
  }

  function finalizeSession(session) {
    if (!session.closed || session.retainedChunks !== 0 || session.finalized) return;
    session.finalized = true;
    recordCursor(session);
    if (sessions.get(session.identity.sessionId) === session) {
      sessions.delete(session.identity.sessionId);
      sessionCounters.ended += 1;
    }
  }

  function releaseChunk(session, chunk) {
    if (chunk.released) return;
    chunk.released = true;
    session.retainedChunks -= 1;
    session.retainedBytes -= chunk.bytes.length;
    retainedChunks -= 1;
    retainedBytes -= chunk.bytes.length;
  }

  function outcomeChunk(chunk) {
    return Object.freeze({
      chunkId: chunk.chunkId,
      sequence: chunk.sequence,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      sampleRate: AUDIO_LIMITS.sampleRate,
    });
  }

  function recordDelivery(outcome, fallback) {
    const selected = AUDIO_DELIVERY_OUTCOMES.includes(outcome) ? outcome : fallback;
    deliveryCounters[selected] += 1;
    return selected;
  }

  function deliveryFailed(outcome) {
    return outcome !== "indexed" && outcome !== "discarded";
  }

  async function storeChunk(session, chunk) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUDIO_LIMITS.storeAttemptTimeoutMs);
    timer.unref?.();
    session.inFlightController = controller;
    let onAbort;
    try {
      let putPromise;
      try {
        putPromise = audioObjectStore.put(
          {
            tenantId: session.identity.tenantId,
            learnerId: session.identity.learnerId,
            sessionId: session.identity.sessionId,
            chunkId: chunk.chunkId,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            sampleRate: AUDIO_LIMITS.sampleRate,
            audioRetention: session.identity.audioRetention,
            audioBytes: chunk.bytes,
          },
          { signal: controller.signal },
        );
      } catch (error) {
        putPromise = Promise.reject(error);
      }
      const putResult = Promise.resolve(putPromise).then(
          (stored) => ({ outcome: "stored", stored }),
          () => ({ outcome: controller.signal.aborted ? "aborted" : "failed", stored: null }),
      );
      const aborted = new Promise((resolve) => {
        onAbort = () => resolve({ outcome: "aborted", stored: null });
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([putResult, aborted]);
      storeCounters[result.outcome] += 1;
      let delivery;
      if (result.outcome === "stored") {
        try {
          delivery = await audioOutcomeAuthority.stored({
            identity: session.identity,
            chunk: outcomeChunk(chunk),
            stored: result.stored,
          });
        } catch {
          delivery = "stored_unindexed_unrecorded";
        }
        delivery = recordDelivery(delivery, "stored_unindexed_unrecorded");
      } else {
        try {
          delivery = await audioOutcomeAuthority.lost({
            identity: session.identity,
            chunk: outcomeChunk(chunk),
            reasonCode: result.outcome === "failed" ? "store-failed" : "store-aborted",
          });
        } catch {
          delivery = "accepted_lost_unrecorded";
        }
        delivery = recordDelivery(delivery, "accepted_lost_unrecorded");
      }
      if (deliveryFailed(delivery)) {
        closeSocket(session.socket, 1013, "audio delivery unavailable");
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      if (session.inFlightController === controller) session.inFlightController = null;
      releaseChunk(session, chunk);
    }
  }

  function startDrain(session) {
    if (session.drainPromise !== null) return;
    session.drainPromise = (async () => {
      while (session.queue.length > 0) {
        const chunk = session.queue.shift();
        await storeChunk(session, chunk);
      }
    })().finally(() => {
      session.drainPromise = null;
      finalizeSession(session);
      if (session.queue.length > 0) startDrain(session);
    });
  }

  function reserve(session, bytes) {
    if (
      session.retainedChunks >= AUDIO_LIMITS.maxRetainedChunksPerSession ||
      session.retainedBytes + bytes.length > AUDIO_LIMITS.maxRetainedBytesPerSession ||
      retainedBytes + bytes.length > AUDIO_LIMITS.maxRetainedBytesGlobal
    ) {
      ingressCounters.backpressure += 1;
      rejection(session, "audio backpressure");
      return;
    }

    const sequence = session.nextSequence;
    const timeline = audioTimeline(sequence);
    if (timeline === null) throw new TypeError("realtime audio sequence must have a safe timeline");
    const chunkId = `${session.identity.sessionId}-ws-${String(sequence).padStart(4, "0")}`;
    const serializedAck = serializeAudioAck(createAudioAck({
      sessionId: session.identity.sessionId,
      chunkId,
      sequence,
      accepted: true,
      traceId: session.identity.traceId,
      message: "accepted",
    }));
    if (session.socket.readyState !== SOCKET_OPEN) return;
    if (!ackFits(session.socket, serializedAck)) {
      ingressCounters.slow_consumer += 1;
      deliveryCounters.rejected += 1;
      closeSocket(session.socket);
      return;
    }
    const chunk = {
      sequence,
      chunkId,
      ...timeline,
      bytes,
      released: false,
    };
    session.nextSequence += 1;
    session.retainedChunks += 1;
    session.retainedBytes += bytes.length;
    retainedChunks += 1;
    retainedBytes += bytes.length;
    session.queue.push(chunk);
    ingressCounters.enqueued += 1;
    writeAck(session.socket, serializedAck);
    startDrain(session);
  }

  function onMessage(session, value, isBinary) {
    if (stopping || session.closed || !isBinary) return;
    const bytes = rawAudioBuffer(value);
    if (bytes === null || bytes.length === 0) {
      ingressCounters.empty += 1;
      rejection(session, "audio frame must contain bytes");
      return;
    }
    if (bytes.length > AUDIO_LIMITS.maxPayloadBytes) {
      ingressCounters.oversized += 1;
      rejection(session, `audio frame exceeds ${AUDIO_LIMITS.maxPayloadBytes} bytes`);
      return;
    }
    if (audioTimeline(session.nextSequence) === null) {
      ingressCounters.sequence_exhausted += 1;
      rejection(session, "audio sequence exhausted");
      closeSocket(session.socket, 1011, "audio sequence exhausted");
      return;
    }
    reserve(session, bytes);
  }

  function handleSocket(socket, context) {
    validateSocket(socket);
    const identity = validateContext(context);
    if (stopping) {
      closeSocket(socket, 1012, "service restart");
      return;
    }
    if (sessions.has(identity.sessionId)) {
      sessionCounters.duplicate += 1;
      sendAck(socket, {
        sessionId: identity.sessionId,
        chunkId: "session-start",
        sequence: 0,
        accepted: false,
        traceId: identity.traceId,
        message: "recitation session already active",
      });
      closeSocket(socket);
      return;
    }
    if (sessions.size >= AUDIO_LIMITS.maxActiveSessions) {
      sessionCounters.capacity += 1;
      sendAck(socket, {
        sessionId: identity.sessionId,
        chunkId: "session-start",
        sequence: 0,
        accepted: false,
        traceId: identity.traceId,
        message: "realtime session capacity reached",
      });
      closeSocket(socket);
      return;
    }

    const now = nowMs();
    sweepCursors(now);
    const session = {
      identity,
      socket,
      queue: [],
      retainedChunks: 0,
      retainedBytes: 0,
      nextSequence: cursors.get(identity.sessionId)?.nextSequence ?? 0,
      drainPromise: null,
      inFlightController: null,
      closed: false,
      finalized: false,
    };
    sessions.set(identity.sessionId, session);
    sessionCounters.started += 1;
    socket.on("message", (value, isBinary) => onMessage(session, value, isBinary));
    const close = () => {
      if (session.closed) return;
      session.closed = true;
      finalizeSession(session);
    };
    socket.once?.("close", close);
    socket.once?.("error", close);
  }

  async function stop() {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const session of sessions.values()) {
        session.closed = true;
        closeSocket(session.socket, 1012, "service restart");
      }
      const drainBudgetMs = Math.max(1, Math.min(
        AUDIO_LIMITS.maxDrainMs,
        Math.floor((shutdownGraceMs * 3) / 5),
      ));
      const deadline = Date.now() + drainBudgetMs;
      while (retainedChunks > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (retainedChunks > 0) {
        const draining = [];
        const queuedLosses = [];
        for (const session of [...sessions.values()]) {
          session.inFlightController?.abort();
          for (const chunk of session.queue.splice(0)) {
            storeCounters.aborted += 1;
            queuedLosses.push({ identity: session.identity, chunk: outcomeChunk(chunk), session, raw: chunk });
          }
          if (session.drainPromise !== null) draining.push(session.drainPromise);
          finalizeSession(session);
        }
        if (queuedLosses.length > 0) {
          let outcome;
          try {
            outcome = await audioOutcomeAuthority.lostMany({
              entries: queuedLosses.map(({ identity, chunk }) => ({ identity, chunk })),
              reasonCode: "store-aborted",
            });
          } catch {
            outcome = "accepted_lost_unrecorded";
          }
          const selected = AUDIO_DELIVERY_OUTCOMES.includes(outcome)
            ? outcome
            : "accepted_lost_unrecorded";
          deliveryCounters[selected] += queuedLosses.length;
          for (const { session, raw } of queuedLosses) releaseChunk(session, raw);
        }
        await Promise.allSettled(draining);
      }
      for (const session of [...sessions.values()]) finalizeSession(session);
    })();
    return stopPromise;
  }

  function renderMetrics() {
    let output = metric(
      "gauge",
      "realtime_audio_active_sessions",
      "Audio sessions currently active or draining.",
      sessions.size,
    );
    output += metric(
      "gauge",
      "realtime_audio_retained_chunks",
      "Audio chunks retained in queues or storage attempts.",
      retainedChunks,
    );
    output += metric(
      "gauge",
      "realtime_audio_retained_bytes",
      "Audio bytes retained in queues or storage attempts.",
      retainedBytes,
    );
    output += labelledCounter(
      "realtime_audio_sessions_total",
      "Audio session lifecycle outcomes.",
      sessionCounters,
      AUDIO_SESSION_OUTCOMES,
    );
    output += labelledCounter(
      "realtime_audio_ingress_total",
      "Audio ingress decisions.",
      ingressCounters,
      AUDIO_INGRESS_OUTCOMES,
    );
    output += labelledCounter(
      "realtime_audio_store_total",
      "Audio object-store outcomes after ingress acceptance.",
      storeCounters,
      AUDIO_STORE_OUTCOMES,
    );
    output += labelledCounter(
      "realtime_audio_delivery_total",
      "Audio outcomes after enqueue across storage and indexing.",
      deliveryCounters,
      AUDIO_DELIVERY_OUTCOMES,
    );
    return output;
  }

  return Object.freeze({ handleSocket, renderMetrics, snapshot, stop });
}
