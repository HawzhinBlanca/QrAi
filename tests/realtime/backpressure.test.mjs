import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { issueRealtimeTicket } from "../../server/src/lib/ticket.mjs";
import {
  AUDIO_LIMITS,
  AUDIO_MAX_SEQUENCE,
  audioTimeline,
  createRealtimeAudioRuntime as createRuntime,
} from "../../server/src/realtime/audio.mjs";
import { createRealtimeApplication } from "../../server/src/realtime/main.mjs";

const MiB = 1024 * 1024;
const LIVE_ORIGIN = "https://audio.example.org";
const LIVE_SECRET = "w3.5-bounded-audio-ticket-secret-over-32-bytes";
const LIVE_TENANT = "tenant-audio-live";
const LIVE_NOW_SECONDS = 2_100_000_000;
const socketInboxes = new WeakMap();

function testOutcomeAuthority() {
  return {
    async stored({ identity }) {
      return identity.audioRetention === "discard" ? "discarded" : "indexed";
    },
    async lost() {
      return "accepted_lost";
    },
    async lostMany() {
      return "accepted_lost";
    },
  };
}

function createRealtimeAudioRuntime(options) {
  return createRuntime({
    ...options,
    audioOutcomeAuthority: options.audioOutcomeAuthority ?? testOutcomeAuthority(),
  });
}

function admitted(sessionId, traceId = null) {
  return Object.freeze({
    accepted: true,
    claims: Object.freeze({
      tenantId: "tenant-audio",
      learnerId: "learner-audio",
      sessionId,
      externalAsrProcessing: false,
      audioRetention: "discard",
      expiresAtUnixSeconds: 9_999_999_999n,
    }),
    traceId,
  });
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = [];
  }

  send(value, callback) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(String(value));
    callback?.();
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed.push({ code, reason: String(reason ?? "") });
    queueMicrotask(() => this.emit("close", code, Buffer.from(String(reason ?? ""))));
  }

  terminate() {
    this.close(1006, "");
  }

  binary(bytes) {
    this.emit("message", bytes, true);
  }

  text(value) {
    this.emit("message", Buffer.from(value), false);
  }

  peerClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  acks() {
    return this.sent.map((value) => JSON.parse(value));
  }
}

function pausedStore() {
  const calls = [];
  const pending = [];
  return {
    calls,
    pending,
    put(value, { signal } = {}) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry = { value, signal, resolve, reject, settled: false };
      calls.push(entry);
      pending.push(entry);
      return promise;
    },
    resolve(index) {
      const entry = calls[index];
      assert.ok(entry, `store call ${index} must exist`);
      if (entry.settled) return;
      entry.settled = true;
      entry.resolve({ created: true, objectKey: `object-${index}`, size: entry.value.audioBytes.length });
    },
    reject(index, error = new Error("store failed")) {
      const entry = calls[index];
      assert.ok(entry, `store call ${index} must exist`);
      if (entry.settled) return;
      entry.settled = true;
      entry.reject(error);
    },
  };
}

function immediateStore() {
  const calls = [];
  return {
    calls,
    async put(value, options) {
      calls.push({ value, options });
      return { created: true, objectKey: `object-${calls.length - 1}`, size: value.audioBytes.length };
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function releaseCalls(store, count) {
  for (let index = 0; index < count; index += 1) {
    await waitFor(() => store.calls.length > index, `store call ${index} never started`);
    store.resolve(index);
  }
}

function liveTicket(sessionId, nonce = `nonce-${sessionId}`) {
  return issueRealtimeTicket({
    sessionId,
    tenantId: LIVE_TENANT,
    learnerId: `learner-${sessionId}`,
    externalAsrProcessing: false,
    audioRetention: "discard",
    expiresAtUnixSeconds: LIVE_NOW_SECONDS + 300,
    nonce,
  }, LIVE_SECRET);
}

function liveApplication(store, overrides = {}) {
  store.assertReady ??= async () => {};
  store.close ??= async () => {};
  return createRealtimeApplication({
    db: { assertRestrictedRole: async () => {}, end: async () => {} },
    audioObjectStore: store,
    workerReadyUrl: "http://worker:8098/ready",
    asrReadyUrl: "http://asr:8091/ready",
    readinessTimeoutMs: 100,
    shutdownGraceMs: 1_000,
    metricsToken: null,
    metricsDevOpen: true,
    ticketSecret: LIVE_SECRET,
    tenantId: LIVE_TENANT,
    allowedOrigins: [LIVE_ORIGIN],
    allowMissingOrigin: false,
    rateLimitEnabled: false,
    trustedProxyHops: 0,
    replayAuthority: {
      claim: async () => "fresh",
      renderMetrics: () => "",
      start: () => {},
      stop: async () => {},
    },
    audioOutcomeAuthority: testOutcomeAuthority(),
    admissionNowUnixSeconds: () => LIVE_NOW_SECONDS,
    fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
    logger: false,
    ...overrides,
  });
}

async function openLiveSocket(app, sessionId, nonce) {
  const token = liveTicket(sessionId, nonce);
  const path = `/v1/recitation-sessions/${encodeURIComponent(sessionId)}/audio?ticket=${encodeURIComponent(token)}&trace_id=trace-live`;
  return app.injectWS(path, { headers: { origin: LIVE_ORIGIN } }, {
    onInit(socket) {
      const inbox = {
        close: null,
        closeWaiters: [],
        messages: [],
        messageWaiters: [],
      };
      socketInboxes.set(socket, inbox);
      socket.on("message", (value) => {
        let parsed;
        try {
          parsed = JSON.parse(value.toString());
        } catch (error) {
          const waiter = inbox.messageWaiters.shift();
          if (waiter) waiter.reject(error);
          return;
        }
        const waiter = inbox.messageWaiters.shift();
        if (waiter) waiter.resolve(parsed);
        else inbox.messages.push(parsed);
      });
      socket.on("error", (error) => {
        for (const waiter of inbox.messageWaiters.splice(0)) waiter.reject(error);
      });
      socket.on("close", (code, reason) => {
        inbox.close = { code, reason: reason.toString() };
        for (const waiter of inbox.closeWaiters.splice(0)) waiter.resolve(inbox.close);
        for (const waiter of inbox.messageWaiters.splice(0)) {
          waiter.reject(new Error(`WebSocket closed before acknowledgement (${code})`));
        }
      });
    },
  });
}

function nextSocketMessage(socket, timeoutMs = 2_000) {
  const inbox = socketInboxes.get(socket);
  assert.ok(inbox, "live socket inbox is missing");
  if (inbox.messages.length > 0) return Promise.resolve(inbox.messages.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = inbox.messageWaiters.indexOf(waiter);
      if (index >= 0) inbox.messageWaiters.splice(index, 1);
      reject(new Error("WebSocket acknowledgement timed out"));
    }, timeoutMs);
    const waiter = {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    };
    inbox.messageWaiters.push(waiter);
  });
}

function nextSocketClose(socket, timeoutMs = 2_000) {
  const inbox = socketInboxes.get(socket);
  assert.ok(inbox, "live socket inbox is missing");
  if (inbox.close !== null) return Promise.resolve(inbox.close);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = inbox.closeWaiters.indexOf(waiter);
      if (index >= 0) inbox.closeWaiters.splice(index, 1);
      reject(new Error("WebSocket close timed out"));
    }, timeoutMs);
    const waiter = {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
    };
    inbox.closeWaiters.push(waiter);
  });
}

async function terminateSocket(socket) {
  if (socket.readyState === 3) return;
  const closed = nextSocketClose(socket);
  socket.terminate();
  await closed;
}

async function metricsBody(app) {
  const response = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(response.statusCode, 200);
  return response.body;
}

function metricValue(metrics, series) {
  const match = metrics.match(new RegExp(`^${series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ([0-9]+)$`, "m"));
  assert.ok(match, `missing metric ${series}`);
  return Number(match[1]);
}

async function waitForMetrics(app, predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metrics = await metricsBody(app);
    if (predicate(metrics)) return metrics;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("the production audio bounds are explicit and leave Rust-compatible rejection slack", () => {
  assert.deepEqual(AUDIO_LIMITS, Object.freeze({
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
  }));
  assert.deepEqual(audioTimeline(AUDIO_MAX_SEQUENCE), {
    startMs: AUDIO_MAX_SEQUENCE * AUDIO_LIMITS.chunkDurationMs,
    endMs: (AUDIO_MAX_SEQUENCE + 1) * AUDIO_LIMITS.chunkDurationMs,
  });
  assert.ok(Number.isSafeInteger(audioTimeline(AUDIO_MAX_SEQUENCE).endMs));
  for (const invalid of [-1, 0.5, AUDIO_MAX_SEQUENCE + 1, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.equal(audioTimeline(invalid), null, `unsafe sequence ${invalid} must fail closed`);
  }
});

test("a paused store applies exact per-session chunk backpressure and reuses the rejected sequence", async () => {
  const store = pausedStore();
  const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-slots", "trace-slots"));

  for (let index = 0; index < AUDIO_LIMITS.maxRetainedChunksPerSession; index += 1) {
    socket.binary(Buffer.from([index]));
  }
  socket.binary(Buffer.from([99]));

  const acks = socket.acks();
  assert.equal(acks.length, 9);
  assert.deepEqual(acks.slice(0, 8).map(({ accepted, sequence }) => ({ accepted, sequence })),
    Array.from({ length: 8 }, (_, sequence) => ({ accepted: true, sequence })));
  assert.equal(acks[8].accepted, false);
  assert.equal(acks[8].sequence, 8);
  assert.equal(acks[8].trace_id, "trace-slots");
  assert.deepEqual(runtime.snapshot(), {
    activeSessions: 1,
    retainedChunks: 8,
    retainedBytes: 8,
  });

  await releaseCalls(store, 8);
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "the session queue did not drain");
  socket.binary(Buffer.from([8]));
  assert.deepEqual(socket.acks().at(-1), {
    kind: "audio.ack",
    session_id: "session-slots",
    chunk_id: "session-slots-ws-0008",
    sequence: 8,
    accepted: true,
    trace_id: "trace-slots",
    message: "accepted",
  });
  await releaseCalls(store, 9);
  socket.peerClose();
  await waitFor(() => runtime.snapshot().activeSessions === 0, "the closed session remained active");
});

test("per-session and process-wide byte budgets include in-flight storage", async () => {
  const perSessionStore = pausedStore();
  const perSession = createRealtimeAudioRuntime({
    audioObjectStore: perSessionStore,
    shutdownGraceMs: 8_000,
  });
  const socket = new FakeSocket();
  perSession.handleSocket(socket, admitted("session-bytes"));
  socket.binary(Buffer.alloc(2 * MiB, 1));
  socket.binary(Buffer.alloc(2 * MiB, 2));
  socket.binary(Buffer.from([3]));
  assert.deepEqual(socket.acks().map(({ accepted, sequence }) => ({ accepted, sequence })), [
    { accepted: true, sequence: 0 },
    { accepted: true, sequence: 1 },
    { accepted: false, sequence: 2 },
  ]);
  assert.equal(perSession.snapshot().retainedBytes, 4 * MiB);
  await releaseCalls(perSessionStore, 2);
  socket.peerClose();
  await waitFor(() => perSession.snapshot().activeSessions === 0, "byte-bound session did not close");

  const globalStore = pausedStore();
  const global = createRealtimeAudioRuntime({ audioObjectStore: globalStore, shutdownGraceMs: 8_000 });
  const sockets = [];
  for (let index = 0; index < 16; index += 1) {
    const peer = new FakeSocket();
    sockets.push(peer);
    global.handleSocket(peer, admitted(`session-global-${index}`));
    peer.binary(Buffer.alloc(2 * MiB, index));
    peer.binary(Buffer.alloc(2 * MiB, index + 1));
  }
  const overflow = new FakeSocket();
  sockets.push(overflow);
  global.handleSocket(overflow, admitted("session-global-overflow"));
  overflow.binary(Buffer.from([1]));
  assert.equal(global.snapshot().retainedBytes, 64 * MiB);
  assert.equal(overflow.acks().at(-1).accepted, false);
  assert.equal(overflow.acks().at(-1).sequence, 0);

  await releaseCalls(globalStore, 32);
  await waitFor(() => global.snapshot().retainedBytes === 0, "global byte budget did not release");
  for (const peer of sockets) peer.peerClose();
  await waitFor(() => global.snapshot().activeSessions === 0, "global sessions did not close");
});

test("the 101st active session is refused without a queue or identity-bearing close reason", async () => {
  const store = pausedStore();
  const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
  const sockets = [];
  for (let index = 0; index < AUDIO_LIMITS.maxActiveSessions; index += 1) {
    const socket = new FakeSocket();
    sockets.push(socket);
    runtime.handleSocket(socket, admitted(`session-cap-${index}`));
  }
  const refused = new FakeSocket();
  runtime.handleSocket(refused, admitted("session-cap-refused", "trace-cap"));

  assert.equal(runtime.snapshot().activeSessions, 100);
  assert.deepEqual(refused.acks(), [{
    kind: "audio.ack",
    session_id: "session-cap-refused",
    chunk_id: "session-start",
    sequence: 0,
    accepted: false,
    trace_id: "trace-cap",
    message: "realtime session capacity reached",
  }]);
  assert.deepEqual(refused.closed, [{ code: 1013, reason: "try again later" }]);
  assert.equal(store.calls.length, 0);

  for (const socket of sockets) socket.peerClose();
  await waitFor(() => runtime.snapshot().activeSessions === 0, "session capacity did not release");
});

test("a slow acknowledgement consumer is closed before audio is retained", async () => {
  for (const [suffix, bufferedAmount] of [
    ["invalid", AUDIO_LIMITS.maxAckBufferedBytes + 1],
    ["projected", AUDIO_LIMITS.maxAckBufferedBytes - 1],
  ]) {
    const store = pausedStore();
    const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
    const socket = new FakeSocket();
    runtime.handleSocket(socket, admitted(`session-slow-${suffix}`));
    socket.bufferedAmount = bufferedAmount;
    socket.binary(Buffer.from([1]));

    assert.deepEqual(socket.sent, []);
    assert.deepEqual(socket.closed, [{ code: 1013, reason: "try again later" }]);
    assert.equal(store.calls.length, 0);
    await waitFor(() => runtime.snapshot().activeSessions === 0, "slow consumer session did not close");
    assert.deepEqual(runtime.snapshot(), { activeSessions: 0, retainedChunks: 0, retainedBytes: 0 });
  }
});

test("accepted frames are acknowledged immediately and stored FIFO with claims-derived metadata", async () => {
  const store = pausedStore();
  const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-fifo", "trace-fifo"));

  const frames = [Buffer.from([1, 2]), Buffer.from([3, 4, 5]), Buffer.from([6])];
  for (const frame of frames) socket.binary(frame);
  assert.deepEqual(socket.acks().map(({ accepted, sequence }) => ({ accepted, sequence })), [
    { accepted: true, sequence: 0 },
    { accepted: true, sequence: 1 },
    { accepted: true, sequence: 2 },
  ]);
  assert.equal(store.calls.length, 1, "one consumer must serialize the object-store writes");
  assert.deepEqual(store.calls[0].value, {
    tenantId: "tenant-audio",
    learnerId: "learner-audio",
    sessionId: "session-fifo",
    chunkId: "session-fifo-ws-0000",
    startMs: 0,
    endMs: 480,
    sampleRate: 16_000,
    audioRetention: "discard",
    audioBytes: frames[0],
  });
  assert.ok(store.calls[0].signal instanceof AbortSignal);

  store.resolve(0);
  await waitFor(() => store.calls.length === 2, "the second FIFO write never started");
  assert.equal(store.calls[1].value.chunkId, "session-fifo-ws-0001");
  assert.equal(store.calls[1].value.startMs, 480);
  assert.equal(store.calls[1].value.endMs, 960);
  assert.deepEqual(store.calls[1].value.audioBytes, frames[1]);
  store.resolve(1);
  await waitFor(() => store.calls.length === 3, "the third FIFO write never started");
  assert.equal(store.calls[2].value.chunkId, "session-fifo-ws-0002");
  assert.deepEqual(store.calls[2].value.audioBytes, frames[2]);
  store.resolve(2);
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "FIFO writes did not drain");
  socket.peerClose();
  await waitFor(() => runtime.snapshot().activeSessions === 0, "FIFO session did not close");
});

test("text is ignored while empty and oversized binary messages refuse without consuming sequence", async () => {
  const store = pausedStore();
  const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-input"));

  socket.text("not audio");
  socket.binary(Buffer.alloc(0));
  socket.binary(Buffer.alloc(AUDIO_LIMITS.maxPayloadBytes + 1));
  socket.binary(Buffer.alloc(AUDIO_LIMITS.maxPayloadBytes, 7));

  assert.deepEqual(socket.acks().map(({ accepted, sequence, message }) => ({
    accepted,
    sequence,
    message,
  })), [
    { accepted: false, sequence: 0, message: "audio frame must contain bytes" },
    {
      accepted: false,
      sequence: 0,
      message: `audio frame exceeds ${AUDIO_LIMITS.maxPayloadBytes} bytes`,
    },
    { accepted: true, sequence: 0, message: "accepted" },
  ]);
  assert.equal(store.calls.length, 1);
  store.resolve(0);
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "exact-limit frame did not release");
  socket.peerClose();
});

test("duplicate sessions are refused, and reconnect cursors advance monotonically in one process", async () => {
  const store = immediateStore();
  const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
  const first = new FakeSocket();
  runtime.handleSocket(first, admitted("session-reconnect"));
  const duplicate = new FakeSocket();
  runtime.handleSocket(duplicate, admitted("session-reconnect", "trace-duplicate"));
  assert.deepEqual(duplicate.acks(), [{
    kind: "audio.ack",
    session_id: "session-reconnect",
    chunk_id: "session-start",
    sequence: 0,
    accepted: false,
    trace_id: "trace-duplicate",
    message: "recitation session already active",
  }]);
  assert.deepEqual(duplicate.closed, [{ code: 1013, reason: "try again later" }]);

  first.binary(Buffer.from([1]));
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "first reconnect frame did not store");
  first.peerClose();
  await waitFor(() => runtime.snapshot().activeSessions === 0, "first socket did not finalize");

  const second = new FakeSocket();
  runtime.handleSocket(second, admitted("session-reconnect"));
  second.binary(Buffer.from([2]));
  assert.equal(second.acks().at(-1).sequence, 1);
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "second reconnect frame did not store");
  second.peerClose();
  await waitFor(() => runtime.snapshot().activeSessions === 0, "second socket did not finalize");
  first.emit("close", 1000, Buffer.alloc(0));

  const third = new FakeSocket();
  runtime.handleSocket(third, admitted("session-reconnect"));
  third.binary(Buffer.from([3]));
  assert.equal(third.acks().at(-1).sequence, 2, "a late old close must never rewind the cursor");
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "third reconnect frame did not store");
  third.peerClose();
});

test("cursor retention is bounded by TTL and entry count", async () => {
  let clockMs = 1_000;
  const store = immediateStore();
  const ttlRuntime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    shutdownGraceMs: 8_000,
    nowMs: () => clockMs,
  });
  const first = new FakeSocket();
  ttlRuntime.handleSocket(first, admitted("session-ttl"));
  first.binary(Buffer.from([1]));
  await waitFor(() => ttlRuntime.snapshot().retainedChunks === 0, "TTL seed did not store");
  first.peerClose();
  await waitFor(() => ttlRuntime.snapshot().activeSessions === 0, "TTL seed did not close");
  clockMs += AUDIO_LIMITS.cursorTtlMs;
  const expired = new FakeSocket();
  ttlRuntime.handleSocket(expired, admitted("session-ttl"));
  expired.binary(Buffer.from([2]));
  assert.equal(expired.acks().at(-1).sequence, 0);
  await waitFor(() => ttlRuntime.snapshot().retainedChunks === 0, "TTL restart did not store");
  expired.peerClose();

  const capRuntime = createRealtimeAudioRuntime({
    audioObjectStore: immediateStore(),
    shutdownGraceMs: 8_000,
    nowMs: () => 5_000,
  });
  const oldest = new FakeSocket();
  capRuntime.handleSocket(oldest, admitted("session-oldest"));
  oldest.binary(Buffer.from([1]));
  await waitFor(() => capRuntime.snapshot().retainedChunks === 0, "cursor-cap seed did not store");
  oldest.peerClose();
  for (let index = 0; index < AUDIO_LIMITS.maxCursorEntries - 1; index += 1) {
    const filler = new FakeSocket();
    capRuntime.handleSocket(filler, admitted(`session-cursor-${index}`));
    filler.peerClose();
  }
  const evicted = new FakeSocket();
  capRuntime.handleSocket(evicted, admitted("session-oldest"));
  evicted.binary(Buffer.from([2]));
  assert.equal(evicted.acks().at(-1).sequence, 0, "the oldest cursor must be evicted at capacity");
  await waitFor(() => capRuntime.snapshot().retainedChunks === 0, "evicted cursor frame did not store");
  evicted.peerClose();
});

test("store failures are separate from ingress acceptance and metrics never expose identities or errors", async () => {
  const store = pausedStore();
  const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-secret", "trace-secret"));
  socket.binary(Buffer.from("private-audio"));
  assert.equal(socket.acks().at(-1).accepted, true);
  store.reject(0, new Error("tenant-audio learner-audio private-audio sensitive failure"));
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "failed store retained the frame");
  socket.peerClose();
  await waitFor(() => runtime.snapshot().activeSessions === 0, "failed-store session did not close");

  const metrics = runtime.renderMetrics();
  assert.match(metrics, /realtime_audio_store_total\{outcome="failed"\} 1/);
  assert.match(metrics, /realtime_audio_ingress_total\{outcome="enqueued"\} 1/);
  for (const secret of [
    "tenant-audio",
    "learner-audio",
    "session-secret",
    "trace-secret",
    "private-audio",
    "sensitive failure",
  ]) {
    assert.equal(metrics.includes(secret), false, `metrics leaked ${secret}`);
  }
  const labels = [...metrics.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(labels.length > 0);
  assert.ok(labels.every((label) => /^outcome="[a-z_]+"$/.test(label)));
});

test("shutdown aborts an uncooperative store, releases all accounting, and ignores late settlement", async () => {
  let settle;
  const calls = [];
  const store = {
    put(value, { signal }) {
      calls.push({ value, signal });
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  };
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    shutdownGraceMs: 30,
    nowMs: () => 123,
  });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-abort"));
  socket.binary(Buffer.from([1]));
  socket.binary(Buffer.from([2]));
  await waitFor(() => calls.length === 1, "uncooperative store did not start");

  const startedAt = Date.now();
  await runtime.stop();
  assert.ok(Date.now() - startedAt < 500, "shutdown exceeded its bounded grace");
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(runtime.snapshot(), { activeSessions: 0, retainedChunks: 0, retainedBytes: 0 });
  assert.strictEqual(await runtime.stop(), undefined, "stop must be idempotent");
  settle({ created: true, objectKey: "late", size: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.snapshot(), { activeSessions: 0, retainedChunks: 0, retainedBytes: 0 });
  assert.match(runtime.renderMetrics(), /realtime_audio_store_total\{outcome="aborted"\} 2/);
  assert.doesNotMatch(runtime.renderMetrics(), /realtime_audio_store_total\{outcome="stored"\} 1/);
});

test("an object-store attempt times out at the declared bound without retaining audio", async () => {
  let lateReject;
  const store = {
    put(_value, { signal }) {
      assert.equal(signal.aborted, false);
      return new Promise((_resolve, reject) => {
        lateReject = reject;
      });
    },
  };
  const runtime = createRealtimeAudioRuntime({ audioObjectStore: store, shutdownGraceMs: 8_000 });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-timeout"));
  const startedAt = Date.now();
  socket.binary(Buffer.from([1]));
  await waitFor(
    () => runtime.snapshot().retainedChunks === 0,
    "timed-out object-store frame was retained",
    AUDIO_LIMITS.storeAttemptTimeoutMs + 1_000,
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= AUDIO_LIMITS.storeAttemptTimeoutMs - 100, `store aborted too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < AUDIO_LIMITS.storeAttemptTimeoutMs + 800, `store aborted too late: ${elapsedMs}ms`);
  assert.match(runtime.renderMetrics(), /realtime_audio_store_total\{outcome="aborted"\} 1/);
  lateReject(new Error("late sensitive rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.snapshot(), { activeSessions: 0, retainedChunks: 0, retainedBytes: 0 });
  assert.deepEqual(socket.closed, [{ code: 1013, reason: "audio delivery unavailable" }]);
});

test("the real Fastify boundary preserves app/transport limits, strict acks, and duplicate refusal", async () => {
  const store = immediateStore();
  const app = liveApplication(store);
  const sockets = [];
  try {
    await app.ready();
    const socket = await openLiveSocket(app, "session-live-input");
    sockets.push(socket);

    socket.send("text is ignored");
    await new Promise((resolve) => setImmediate(resolve));

    const emptyAck = nextSocketMessage(socket);
    socket.send(Buffer.alloc(0));
    assert.deepEqual(await emptyAck, {
      kind: "audio.ack",
      session_id: "session-live-input",
      chunk_id: "session-live-input-ws-0000",
      sequence: 0,
      accepted: false,
      trace_id: "trace-live",
      message: "audio frame must contain bytes",
    });

    const appOverAck = nextSocketMessage(socket);
    socket.send(Buffer.alloc(AUDIO_LIMITS.maxPayloadBytes + 1));
    assert.deepEqual(await appOverAck, {
      kind: "audio.ack",
      session_id: "session-live-input",
      chunk_id: "session-live-input-ws-0000",
      sequence: 0,
      accepted: false,
      trace_id: "trace-live",
      message: `audio frame exceeds ${AUDIO_LIMITS.maxPayloadBytes} bytes`,
    });

    const exactAck = nextSocketMessage(socket);
    const exactBytes = Buffer.alloc(AUDIO_LIMITS.maxPayloadBytes, 23);
    socket.send(exactBytes);
    assert.equal((await exactAck).accepted, true);
    await waitFor(() => store.calls.length === 1, "the exact-limit live frame did not store");
    assert.deepEqual(store.calls[0].value.audioBytes, exactBytes);

    const slackAck = nextSocketMessage(socket);
    socket.send(Buffer.alloc(AUDIO_LIMITS.maxTransportBytes, 29));
    const slackRefusal = await slackAck;
    assert.equal(slackRefusal.accepted, false);
    assert.equal(slackRefusal.sequence, 1);
    assert.equal(store.calls.length, 1);

    const duplicate = await openLiveSocket(app, "session-live-input", "nonce-duplicate");
    sockets.push(duplicate);
    const duplicateAck = await nextSocketMessage(duplicate);
    assert.equal(duplicateAck.accepted, false);
    assert.equal(duplicateAck.message, "recitation session already active");
    assert.deepEqual(await nextSocketClose(duplicate), { code: 1013, reason: "try again later" });

    const transportOver = await openLiveSocket(app, "session-transport-over");
    sockets.push(transportOver);
    const transportClose = nextSocketClose(transportOver);
    transportOver.send(Buffer.alloc(AUDIO_LIMITS.maxTransportBytes + 1, 31));
    assert.equal((await transportClose).code, 1009);

    const metrics = await waitForMetrics(
      app,
      (body) => metricValue(body, "realtime_audio_active_sessions") === 1,
      "closed hostile sessions remained active",
    );
    assert.equal(metricValue(metrics, "realtime_audio_ingress_total{outcome=\"enqueued\"}"), 1);
    assert.equal(metricValue(metrics, "realtime_audio_ingress_total{outcome=\"empty\"}"), 1);
    assert.equal(metricValue(metrics, "realtime_audio_ingress_total{outcome=\"oversized\"}"), 2);
    assert.equal(metricValue(metrics, "realtime_audio_sessions_total{outcome=\"duplicate\"}"), 1);
  } finally {
    await Promise.allSettled(sockets.map((socket) => terminateSocket(socket)));
    await app.close();
  }
});

test("100 real Fastify sessions meet the ack bar and every retained gauge returns to zero", async (t) => {
  const store = pausedStore();
  const app = liveApplication(store);
  const sockets = [];
  try {
    await app.ready();
    sockets.push(...await Promise.all(Array.from(
      { length: AUDIO_LIMITS.maxActiveSessions },
      (_, index) => openLiveSocket(app, `session-load-${index}`),
    )));

    const frame = Buffer.alloc(4 * 1024, 37);
    const timings = await Promise.all(sockets.map(async (socket, index) => {
      const ack = nextSocketMessage(socket);
      const startedAt = performance.now();
      socket.send(frame);
      const received = await ack;
      return {
        elapsedMs: performance.now() - startedAt,
        received,
        sessionId: `session-load-${index}`,
      };
    }));
    for (const { received, sessionId } of timings) {
      assert.equal(received.kind, "audio.ack");
      assert.equal(received.session_id, sessionId);
      assert.equal(received.sequence, 0);
      assert.equal(received.accepted, true);
      assert.equal(received.trace_id, "trace-live");
    }
    const sortedLatencies = timings.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
    const p95Ms = sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1];
    assert.ok(p95Ms < 250, `100-session send-to-ack p95 ${p95Ms.toFixed(2)}ms exceeded 250ms`);
    t.diagnostic(`measured 100-session send-to-ack p95: ${p95Ms.toFixed(2)}ms`);

    const refused = await openLiveSocket(app, "session-load-refused");
    sockets.push(refused);
    const refusedAck = await nextSocketMessage(refused);
    assert.equal(refusedAck.accepted, false);
    assert.equal(refusedAck.message, "realtime session capacity reached");
    assert.deepEqual(await nextSocketClose(refused), { code: 1013, reason: "try again later" });

    const loaded = await metricsBody(app);
    assert.equal(metricValue(loaded, "realtime_audio_active_sessions"), 100);
    assert.equal(metricValue(loaded, "realtime_audio_retained_chunks"), 100);
    assert.equal(metricValue(loaded, "realtime_audio_retained_bytes"), 100 * frame.length);
    assert.ok(metricValue(loaded, "realtime_audio_retained_bytes") < AUDIO_LIMITS.maxRetainedBytesGlobal);
    t.diagnostic(`measured retained audio at 100 sessions: ${100 * frame.length} bytes`);
    assert.equal(store.calls.length, 100);

    for (let index = 0; index < store.calls.length; index += 1) store.resolve(index);
    const drained = await waitForMetrics(
      app,
      (body) => metricValue(body, "realtime_audio_retained_chunks") === 0,
      "100-session store drain retained chunks",
    );
    assert.equal(metricValue(drained, "realtime_audio_retained_bytes"), 0);
    await Promise.all(sockets.slice(0, 100).map((socket) => terminateSocket(socket)));
    const closed = await waitForMetrics(
      app,
      (body) => metricValue(body, "realtime_audio_active_sessions") === 0,
      "100-session close retained active sessions",
    );
    assert.equal(metricValue(closed, "realtime_audio_retained_chunks"), 0);
    assert.equal(metricValue(closed, "realtime_audio_retained_bytes"), 0);
  } finally {
    await Promise.allSettled(sockets.map((socket) => terminateSocket(socket)));
    await app.close();
  }
});

test("Fastify pre-close aborts audio before replay, object-store, and database resources close", async () => {
  const order = [];
  let storeSignal;
  const store = {
    async assertReady() {},
    put(_value, { signal }) {
      storeSignal = signal;
      order.push("store-put");
      return new Promise(() => {});
    },
    async close() {
      assert.equal(storeSignal.aborted, true, "object storage closed before audio abort");
      order.push("store-close");
    },
  };
  const app = liveApplication(store, {
    shutdownGraceMs: 30,
    db: {
      assertRestrictedRole: async () => {},
      async end() {
        assert.equal(storeSignal.aborted, true, "database closed before audio abort");
        order.push("db-close");
      },
    },
    replayAuthority: {
      claim: async () => "fresh",
      renderMetrics: () => "",
      start: () => {},
      async stop() {
        assert.equal(storeSignal.aborted, true, "replay stopped before audio abort");
        order.push("replay-stop");
      },
    },
  });
  await app.ready();
  const socket = await openLiveSocket(app, "session-preclose");
  const ack = nextSocketMessage(socket);
  socket.send(Buffer.from([1]));
  assert.equal((await ack).accepted, true);
  await waitFor(() => storeSignal instanceof AbortSignal, "pre-close store attempt did not start");

  const startedAt = Date.now();
  await app.close();
  assert.ok(Date.now() - startedAt < 500, "Fastify pre-close exceeded the derived audio budget");
  assert.deepEqual(order, ["store-put", "replay-stop", "store-close", "db-close"]);
});
