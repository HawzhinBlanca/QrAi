const KiB = 1024;
const MiB = KiB * KiB;

export const RECOVERY_POLICY = Object.freeze({
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  maxRetries: 6,
  maxBufferedChunks: 125,
  maxBufferedBytes: 2 * MiB,
  maxInFlight: 1,
  drainTimeoutMs: 5_000,
  maxReportCount: 2_147_483_647,
});

const ACK_FIELDS = new Set([
  "kind",
  "session_id",
  "chunk_id",
  "sequence",
  "accepted",
  "trace_id",
  "message",
]);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validatePolicy(policy) {
  const selected = {
    baseDelayMs: positiveInteger(policy?.baseDelayMs, "recovery base delay"),
    maxDelayMs: positiveInteger(policy?.maxDelayMs, "recovery maximum delay"),
    maxRetries: positiveInteger(policy?.maxRetries, "recovery retry count"),
    maxBufferedChunks: positiveInteger(policy?.maxBufferedChunks, "recovery chunk ceiling"),
    maxBufferedBytes: positiveInteger(policy?.maxBufferedBytes, "recovery byte ceiling"),
    maxInFlight: positiveInteger(policy?.maxInFlight, "recovery in-flight ceiling"),
    drainTimeoutMs: positiveInteger(policy?.drainTimeoutMs, "recovery drain timeout"),
    maxReportCount: positiveInteger(policy?.maxReportCount, "recovery report ceiling"),
  };
  if (selected.maxInFlight !== 1) {
    throw new TypeError("v1 recovery requires exactly one in-flight frame");
  }
  if (selected.baseDelayMs > selected.maxDelayMs) {
    throw new TypeError("recovery base delay cannot exceed its maximum");
  }
  return Object.freeze(selected);
}

export function planRecoveryRetry(
  attempt,
  policy = RECOVERY_POLICY,
  random = Math.random,
) {
  const selected = validatePolicy(policy);
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new TypeError("recovery attempt must be a positive safe integer");
  }
  if (attempt > selected.maxRetries) {
    return Object.freeze({ action: "give-up", reason: "retry-exhausted" });
  }
  const sample = random();
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new TypeError("recovery jitter source must return a number from zero through one");
  }
  const exponential = Math.min(
    selected.baseDelayMs * 2 ** (attempt - 1),
    selected.maxDelayMs,
  );
  const half = exponential / 2;
  return Object.freeze({ action: "retry", delayMs: Math.round(half + half * sample) });
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`recovery ${name} must be a function`);
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`recovery ${name} must be a non-empty string`);
  }
  return value;
}

function parseAck(payload) {
  if (typeof payload !== "string") return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== ACK_FIELDS.size || keys.some((key) => !ACK_FIELDS.has(key))) return null;
    if (
      parsed.kind !== "audio.ack" ||
      typeof parsed.session_id !== "string" || parsed.session_id.trim() === "" ||
      typeof parsed.chunk_id !== "string" || parsed.chunk_id.trim() === "" ||
      !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 0 ||
      typeof parsed.accepted !== "boolean" ||
      (parsed.trace_id !== null &&
        (typeof parsed.trace_id !== "string" || parsed.trace_id.trim() === "")) ||
      typeof parsed.message !== "string" || parsed.message.trim() === ""
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function rawFrame(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Reference v1 recovery controller used by chaos/proof tooling and later Dart conformance.
 *
 * It deliberately never logs or snapshots a URL, ticket, frame, tenant, learner, or server error.
 * The wire cannot identify a client frame, so any sent frame without a strict ack is terminally
 * uncertain and is never replayed.
 */
export function createRealtimeRecoveryController({
  sessionId,
  getUrl,
  openSocket,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  random = Math.random,
  stopCapture,
  finalize,
  onError = () => undefined,
  onStateChange = () => undefined,
  policy = RECOVERY_POLICY,
} = {}) {
  nonEmptyString(sessionId, "session id");
  requiredFunction(getUrl, "ticket factory");
  requiredFunction(openSocket, "socket factory");
  requiredFunction(schedule, "scheduler");
  requiredFunction(cancelSchedule, "scheduler cancellation");
  requiredFunction(random, "jitter source");
  requiredFunction(stopCapture, "capture stop");
  requiredFunction(finalize, "finalizer");
  requiredFunction(onError, "error observer");
  requiredFunction(onStateChange, "state observer");
  const limits = validatePolicy(policy);

  let state = "idle";
  let started = false;
  let stopRequested = false;
  let captureStopped = false;
  let finalized = false;
  let connectAttempt = 0;
  let rejectionAttempt = 0;
  let expectedSequence = 0;
  let connectionToken = null;
  let connectionTimer = null;
  let rejectionTimer = null;
  let drainTimer = null;
  let socketOpen = false;
  let socket = null;
  let retainedBytes = 0;
  let maxObservedRetainedBytes = 0;
  let maxObservedRetainedChunks = 0;
  let capturedChunks = 0;
  let acknowledgedChunks = 0;
  let droppedChunks = 0;
  let uncertainChunks = 0;
  let inFlight = null;
  const buffered = [];
  const completion = deferred();

  const transition = (next) => {
    if (state === next) return;
    state = next;
    onStateChange(next);
  };

  const retainedChunks = () => buffered.length + (inFlight === null ? 0 : 1);

  const observeRetention = () => {
    maxObservedRetainedBytes = Math.max(maxObservedRetainedBytes, retainedBytes);
    maxObservedRetainedChunks = Math.max(maxObservedRetainedChunks, retainedChunks());
  };

  const release = (entry) => {
    if (!entry || entry.released) return;
    entry.released = true;
    retainedBytes -= entry.bytes.length;
  };

  const cancelTimers = () => {
    for (const [handle, clear] of [
      [connectionTimer, () => { connectionTimer = null; }],
      [rejectionTimer, () => { rejectionTimer = null; }],
      [drainTimer, () => { drainTimer = null; }],
    ]) {
      if (handle !== null) cancelSchedule(handle);
      clear();
    }
  };

  const stopCaptureOnce = async () => {
    if (captureStopped) return;
    captureStopped = true;
    await stopCapture();
  };

  const classifyRemaining = () => {
    if (inFlight !== null) {
      if (inFlight.awaitingAck) uncertainChunks += 1;
      else droppedChunks += 1;
      release(inFlight);
      inFlight = null;
    }
    droppedChunks += buffered.length;
    for (const entry of buffered.splice(0)) release(entry);
  };

  const finish = (terminalState, stopReason) => {
    if (finalized) return completion.promise;
    finalized = true;
    stopRequested = true;
    cancelTimers();
    connectionToken = null;
    socketOpen = false;
    try {
      socket?.close();
    } catch {
      // Resource release continues; a close error cannot suppress capture stop or finalization.
    }
    socket = null;
    transition(terminalState);
    const report = Object.freeze({
      version: 1,
      state: terminalState === "complete" ? "complete" : "degraded",
      capturedChunks,
      acknowledgedChunks,
      droppedChunks,
      uncertainChunks,
      stopReason,
    });
    void (async () => {
      try {
        await stopCaptureOnce();
      } catch {
        onError("capture-stop-failed");
      }
      try {
        await finalize(report);
      } catch {
        onError("finalization-failed");
      } finally {
        completion.resolve(report);
      }
    })();
    return completion.promise;
  };

  const degrade = (reason) => {
    if (finalized) return completion.promise;
    classifyRemaining();
    return finish("degraded", reason);
  };

  const expectedChunkId = () =>
    `${sessionId}-ws-${String(expectedSequence).padStart(4, "0")}`;

  const sendInFlight = () => {
    if (finalized || !socketOpen || inFlight === null || inFlight.awaitingAck) return;
    inFlight.awaitingAck = true;
    try {
      socket.send(inFlight.bytes);
    } catch {
      void degrade("ack-ambiguous");
    }
  };

  const pump = () => {
    if (finalized || !socketOpen || inFlight !== null) return;
    const next = buffered.shift();
    if (!next) {
      if (stopRequested) void finish("complete", "completed");
      return;
    }
    inFlight = next;
    inFlight.awaitingAck = false;
    sendInFlight();
  };

  const scheduleRejectedRetry = () => {
    rejectionAttempt += 1;
    const decision = planRecoveryRetry(rejectionAttempt, limits, random);
    if (decision.action === "give-up") {
      void degrade("rejected-exhausted");
      return;
    }
    rejectionTimer = schedule(() => {
      rejectionTimer = null;
      sendInFlight();
    }, decision.delayMs);
  };

  const handleMessage = (token, payload) => {
    if (finalized || token !== connectionToken) return;
    const parsed = parseAck(payload);
    if (
      parsed === null ||
      inFlight === null ||
      !inFlight.awaitingAck ||
      parsed.session_id !== sessionId ||
      parsed.sequence !== expectedSequence ||
      parsed.chunk_id !== expectedChunkId()
    ) {
      void degrade("ack-invalid");
      return;
    }
    inFlight.awaitingAck = false;
    if (!parsed.accepted) {
      scheduleRejectedRetry();
      return;
    }
    if (rejectionTimer !== null) {
      cancelSchedule(rejectionTimer);
      rejectionTimer = null;
    }
    release(inFlight);
    inFlight = null;
    acknowledgedChunks += 1;
    expectedSequence += 1;
    connectAttempt = 0;
    rejectionAttempt = 0;
    pump();
  };

  let beginConnect;

  const scheduleReconnect = () => {
    if (finalized || stopRequested || connectionTimer !== null) return;
    connectAttempt += 1;
    const decision = planRecoveryRetry(connectAttempt, limits, random);
    if (decision.action === "give-up") {
      void degrade("retry-exhausted");
      return;
    }
    transition("reconnecting");
    connectionTimer = schedule(() => {
      connectionTimer = null;
      void beginConnect();
    }, decision.delayMs);
  };

  const handleClose = (token) => {
    if (finalized || token !== connectionToken) return;
    connectionToken = null;
    socketOpen = false;
    socket = null;
    if (rejectionTimer !== null) {
      cancelSchedule(rejectionTimer);
      rejectionTimer = null;
    }
    if (inFlight?.awaitingAck) {
      void degrade("ack-ambiguous");
      return;
    }
    if (inFlight !== null) {
      buffered.unshift(inFlight);
      inFlight = null;
    }
    if (stopRequested) {
      void degrade("drain-timeout");
      return;
    }
    scheduleReconnect();
  };

  beginConnect = async () => {
    if (finalized || stopRequested || connectionToken !== null) return;
    transition(connectAttempt === 0 ? "connecting" : "reconnecting");
    const token = {};
    connectionToken = token;
    try {
      const url = nonEmptyString(await getUrl(), "ticketed URL");
      if (finalized || stopRequested || token !== connectionToken) return;
      const opened = openSocket(url, {
        onOpen: () => {
          if (finalized || token !== connectionToken) return;
          socketOpen = true;
          transition(stopRequested ? "draining" : "connected");
          pump();
        },
        onMessage: (payload) => handleMessage(token, payload),
        onClose: () => handleClose(token),
        onError: () => handleClose(token),
      });
      if (
        !opened ||
        typeof opened.send !== "function" ||
        typeof opened.close !== "function"
      ) {
        throw new TypeError("recovery socket factory returned an invalid socket");
      }
      if (token === connectionToken) socket = opened;
    } catch {
      if (token !== connectionToken || finalized) return;
      connectionToken = null;
      socketOpen = false;
      socket = null;
      onError("connection-failed");
      scheduleReconnect();
    }
  };

  const start = async () => {
    if (started || finalized) return;
    started = true;
    await beginConnect();
  };

  const capture = (value) => {
    if (!started || finalized || stopRequested) return false;
    const bytes = rawFrame(value);
    if (bytes === null || bytes.length === 0) {
      throw new TypeError("recovery capture requires a non-empty byte frame");
    }
    if (capturedChunks >= limits.maxReportCount) {
      void degrade("buffer-overflow");
      return false;
    }
    capturedChunks += 1;
    if (
      retainedChunks() + 1 > limits.maxBufferedChunks ||
      retainedBytes + bytes.length > limits.maxBufferedBytes
    ) {
      droppedChunks += 1;
      classifyRemaining();
      void finish("degraded", "buffer-overflow");
      return false;
    }
    const entry = { bytes: Buffer.from(bytes), awaitingAck: false, released: false };
    buffered.push(entry);
    retainedBytes += entry.bytes.length;
    observeRetention();
    pump();
    return true;
  };

  const stop = () => {
    if (finalized) return completion.promise;
    stopRequested = true;
    void stopCaptureOnce().catch(() => onError("capture-stop-failed"));
    transition("draining");
    if (retainedChunks() === 0) return finish("complete", "completed");
    if (drainTimer === null) {
      drainTimer = schedule(() => {
        drainTimer = null;
        void degrade("drain-timeout");
      }, limits.drainTimeoutMs);
    }
    pump();
    return completion.promise;
  };

  const failCapture = () => degrade("device-failure");

  const snapshot = () => Object.freeze({
    state,
    capturedChunks,
    acknowledgedChunks,
    droppedChunks,
    uncertainChunks,
    bufferedChunks: buffered.length,
    retainedBytes,
    maxObservedRetainedChunks,
    maxObservedRetainedBytes,
    inFlight: inFlight !== null,
    connectAttempt,
  });

  return Object.freeze({
    capture,
    done: completion.promise,
    failCapture,
    snapshot,
    start,
    stop,
  });
}
