import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { createApplication } from "../../server/src/app.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import { createRealtimeApplication } from "../../server/src/realtime/main.mjs";
import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import {
  createTestDatabase,
  migrationTestAdminUrl,
} from "../migrations/lib/postgres.mjs";

const { Client } = pg;
const SESSION_ID = "session-recovery-1";
const LIVE_TENANT = "hikmah-pilot-erbil";
const LIVE_LEARNER = "learner-1";
const LIVE_SECRET = "w3.7-real-node-recovery-secret-over-32-bytes";
const fixture = JSON.parse(
  await readFile(
    new URL("../../packages/contracts/fixtures/realtime/recovery-policy.json", import.meta.url),
    "utf8",
  ),
);

const {
  RECOVERY_POLICY,
  createRealtimeRecoveryController,
  planRecoveryRetry,
} = await import("../../scripts/lib/realtime-recovery-client.mjs");
const {
  recoveryResponseFields,
  validateRecoveryReportBody,
} = await import("../../server/src/realtime/recovery-report.mjs");

function ack(sequence, accepted = true, overrides = {}) {
  return JSON.stringify({
    kind: "audio.ack",
    session_id: SESSION_ID,
    chunk_id: `${SESSION_ID}-ws-${String(sequence).padStart(4, "0")}`,
    sequence,
    accepted,
    trace_id: null,
    message: accepted ? "accepted" : "audio backpressure",
    ...overrides,
  });
}

function makeHarness({ random = () => 0 } = {}) {
  const sockets = [];
  const timers = [];
  const reports = [];
  const errors = [];
  const states = [];
  let tickets = 0;
  let captureStops = 0;

  const dependencies = {
    getUrl: async () => `ws://realtime.test/audio?ticket=fresh-${++tickets}`,
    openSocket: (url, handlers) => {
      const socket = {
        url,
        handlers,
        sent: [],
        closeCalls: 0,
        send(bytes) {
          this.sent.push(Buffer.from(bytes));
        },
        close() {
          this.closeCalls += 1;
        },
      };
      sockets.push(socket);
      return socket;
    },
    schedule: (fn, delayMs) => {
      const timer = { active: true, delayMs, fn };
      timers.push(timer);
      return timer;
    },
    cancelSchedule: (timer) => {
      if (timer) timer.active = false;
    },
    random,
    stopCapture: async () => {
      captureStops += 1;
    },
    finalize: async (report) => {
      reports.push(structuredClone(report));
    },
    onError: (reason) => errors.push(reason),
    onStateChange: (state) => states.push(state),
  };

  return {
    dependencies,
    errors,
    reports,
    sockets,
    states,
    get captureStops() {
      return captureStops;
    },
    get tickets() {
      return tickets;
    },
    open(index = sockets.length - 1) {
      sockets[index].handlers.onOpen();
    },
    message(payload, index = sockets.length - 1) {
      sockets[index].handlers.onMessage(payload);
    },
    drop(index = sockets.length - 1) {
      sockets[index].handlers.onClose();
    },
    fireNextTimer() {
      const timer = timers.find((candidate) => candidate.active);
      assert.ok(timer, "no active recovery timer");
      timer.active = false;
      timer.fn();
      return timer.delayMs;
    },
    activeTimers() {
      return timers.filter((timer) => timer.active);
    },
  };
}

const frame = (size, marker = 1) => Buffer.alloc(size, marker);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function restrictedUrl(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function liveHeaders() {
  return {
    "content-type": "application/json",
    "x-tenant-id": LIVE_TENANT,
    "x-user-id": LIVE_LEARNER,
    "x-user-role": "learner",
  };
}

function openNodeWebSocket(url, handlers) {
  const peer = new WebSocket(url);
  peer.binaryType = "arraybuffer";
  peer.addEventListener("open", () => handlers.onOpen(), { once: true });
  peer.addEventListener("message", ({ data }) => {
    handlers.onMessage(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  });
  peer.addEventListener("error", () => handlers.onError());
  peer.addEventListener("close", () => handlers.onClose(), { once: true });
  return {
    close() {
      if (peer.readyState < WebSocket.CLOSING) peer.close();
    },
    send(bytes) {
      peer.send(bytes);
    },
  };
}

test("the language-neutral policy pins every retry vector and dual bound", () => {
  assert.deepEqual(RECOVERY_POLICY, {
    baseDelayMs: 500,
    maxDelayMs: 15_000,
    maxRetries: 6,
    maxBufferedChunks: 125,
    maxBufferedBytes: 2_097_152,
    maxInFlight: 1,
    drainTimeoutMs: 5_000,
    maxReportCount: 2_147_483_647,
  });
  assert.deepEqual(fixture.buffer, {
    maxChunks: RECOVERY_POLICY.maxBufferedChunks,
    maxBytes: RECOVERY_POLICY.maxBufferedBytes,
    maxInFlight: RECOVERY_POLICY.maxInFlight,
  });
  for (const vector of fixture.retryVectors) {
    assert.deepEqual(
      planRecoveryRetry(vector.attempt, RECOVERY_POLICY, () => vector.random),
      vector.action === "retry"
        ? { action: "retry", delayMs: vector.delayMs }
        : { action: "give-up", reason: vector.reason },
      `retry vector ${vector.attempt}/${vector.random}`,
    );
  }
});

test("a clean drop re-tickets once, preserves ordering, and completes only after drain", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  assert.equal(harness.tickets, 1);
  harness.open();

  assert.equal(controller.capture(frame(4, 1)), true);
  assert.deepEqual(harness.sockets[0].sent, [frame(4, 1)]);
  harness.message(ack(0));
  harness.drop();
  assert.equal(harness.fireNextTimer(), 250);
  await settle();
  assert.equal(harness.tickets, 2);
  assert.match(harness.sockets[1].url, /fresh-2$/);
  harness.open(1);

  assert.equal(controller.capture(frame(4, 2)), true);
  const stopping = controller.stop();
  assert.equal(harness.reports.length, 0, "manual stop finalized before the accepted ack");
  harness.message(ack(1), 1);
  await stopping;

  assert.equal(harness.captureStops, 1);
  assert.equal(harness.reports.length, 1);
  assert.deepEqual(harness.reports[0], {
    version: 1,
    state: "complete",
    capturedChunks: 2,
    acknowledgedChunks: 2,
    droppedChunks: 0,
    uncertainChunks: 0,
    stopReason: "completed",
  });
  assert.equal(controller.snapshot().retainedBytes, 0);
});

test("transport open never resets refusal churn; the seventh retry decision degrades", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  for (let retry = 0; retry <= RECOVERY_POLICY.maxRetries; retry += 1) {
    harness.open();
    harness.drop();
    if (retry < RECOVERY_POLICY.maxRetries) {
      harness.fireNextTimer();
      await settle();
    }
  }
  await controller.done;
  assert.equal(harness.tickets, 1 + RECOVERY_POLICY.maxRetries);
  assert.equal(new Set(harness.sockets.map(({ url }) => url)).size, harness.tickets);
  assert.equal(harness.reports[0].state, "degraded");
  assert.equal(harness.reports[0].stopReason, "retry-exhausted");
  assert.equal(harness.captureStops, 1);
});

test("an ambiguous in-flight frame is never replayed and is reported exactly once", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  harness.open();
  controller.capture(frame(32, 7));
  harness.drop();
  await controller.done;

  assert.equal(harness.sockets.length, 1, "ambiguous audio was reconnected/replayed");
  assert.equal(harness.activeTimers().length, 0);
  assert.deepEqual(harness.reports[0], {
    version: 1,
    state: "degraded",
    capturedChunks: 1,
    acknowledgedChunks: 0,
    droppedChunks: 0,
    uncertainChunks: 1,
    stopReason: "ack-ambiguous",
  });
  assert.deepEqual(controller.snapshot(), {
    state: "degraded",
    capturedChunks: 1,
    acknowledgedChunks: 0,
    droppedChunks: 0,
    uncertainChunks: 1,
    bufferedChunks: 0,
    retainedBytes: 0,
    maxObservedRetainedChunks: 1,
    maxObservedRetainedBytes: 32,
    inFlight: false,
    connectAttempt: 0,
  });
});

test("count and byte overflow stop before retention exceeds either ceiling", async () => {
  for (const [label, chunks] of [
    ["count", Array.from({ length: 126 }, () => frame(15_360))],
    ["bytes", [frame(1_048_576), frame(1_048_576), frame(1)]],
  ]) {
    const harness = makeHarness();
    const controller = createRealtimeRecoveryController({
      sessionId: SESSION_ID,
      ...harness.dependencies,
    });
    await controller.start();
    for (const bytes of chunks) controller.capture(bytes);
    await controller.done;

    const snapshot = controller.snapshot();
    assert.equal(harness.reports[0].stopReason, "buffer-overflow", label);
    assert.equal(harness.reports[0].capturedChunks, chunks.length, label);
    assert.equal(harness.reports[0].droppedChunks, chunks.length, label);
    assert.ok(snapshot.maxObservedRetainedChunks <= RECOVERY_POLICY.maxBufferedChunks, label);
    assert.ok(snapshot.maxObservedRetainedBytes <= RECOVERY_POLICY.maxBufferedBytes, label);
    assert.equal(snapshot.retainedBytes, 0, label);
    assert.equal(harness.captureStops, 1, label);
  }
});

test("a rejected frame retains identity, retries under jitter, and does not advance progress", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  harness.open();
  controller.capture(frame(5, 9));
  harness.message(ack(0, false));
  assert.equal(harness.fireNextTimer(), 250);
  assert.deepEqual(harness.sockets[0].sent, [frame(5, 9), frame(5, 9)]);
  harness.message(ack(0, true));
  await controller.stop();
  assert.deepEqual(harness.reports[0], {
    version: 1,
    state: "complete",
    capturedChunks: 1,
    acknowledgedChunks: 1,
    droppedChunks: 0,
    uncertainChunks: 0,
    stopReason: "completed",
  });
});

test("repeated rejected acknowledgements exhaust safely with one known dropped frame", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  harness.open();
  controller.capture(frame(8, 4));
  for (let attempt = 0; attempt <= RECOVERY_POLICY.maxRetries; attempt += 1) {
    harness.message(ack(0, false));
    if (attempt < RECOVERY_POLICY.maxRetries) harness.fireNextTimer();
  }
  await controller.done;
  assert.deepEqual(harness.reports[0], {
    version: 1,
    state: "degraded",
    capturedChunks: 1,
    acknowledgedChunks: 0,
    droppedChunks: 1,
    uncertainChunks: 0,
    stopReason: "rejected-exhausted",
  });
  assert.equal(harness.sockets[0].sent.length, 1 + RECOVERY_POLICY.maxRetries);
});

test("manual stop has a bounded drain and an unacknowledged tail becomes uncertain", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  harness.open();
  controller.capture(frame(12, 6));
  const stopping = controller.stop();
  assert.equal(harness.activeTimers().length, 1);
  assert.equal(harness.fireNextTimer(), RECOVERY_POLICY.drainTimeoutMs);
  await stopping;
  assert.equal(harness.reports[0].stopReason, "drain-timeout");
  assert.equal(harness.reports[0].uncertainChunks, 1);
  assert.equal(harness.captureStops, 1);
});

test("stale socket callbacks and duplicate close/error signals cannot fork recovery", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  harness.open(0);
  harness.drop(0);
  // Real WebSocket stacks commonly report error and then close. The stale duplicate must be inert.
  harness.sockets[0].handlers.onError();
  assert.equal(harness.activeTimers().length, 1);
  harness.fireNextTimer();
  await settle();
  assert.equal(harness.sockets.length, 2);

  harness.sockets[0].handlers.onOpen();
  harness.sockets[0].handlers.onMessage(ack(0));
  harness.sockets[0].handlers.onClose();
  assert.equal(harness.activeTimers().length, 0, "a stale peer scheduled another connection");

  harness.open(1);
  controller.capture(frame(3, 2));
  harness.message(ack(0), 1);
  await controller.stop();
  assert.equal(harness.tickets, 2);
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.reports[0].state, "complete");
});

test("device failure and terminal callback races stop/finalize once", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  harness.open();
  controller.capture(frame(16, 0xcd));
  void controller.failCapture();
  harness.message("not json");
  harness.drop();
  void controller.stop();
  await controller.done;
  assert.equal(harness.captureStops, 1);
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.reports[0].stopReason, "device-failure");
  assert.equal(harness.reports[0].uncertainChunks, 1);
  assert.equal(harness.sockets[0].closeCalls, 1);
});

test("malformed, foreign, and out-of-order acknowledgements fail closed without raw diagnostics", async () => {
  for (const [label, payload] of [
    ["malformed", "not json"],
    ["foreign", ack(0, true, { session_id: "another-session" })],
    ["out-of-order", ack(1)],
    ["extra-key", ack(0, true, { extra: true })],
  ]) {
    const harness = makeHarness();
    const controller = createRealtimeRecoveryController({
      sessionId: SESSION_ID,
      ...harness.dependencies,
    });
    await controller.start();
    harness.open();
    controller.capture(frame(16, 0xab));
    harness.message(payload);
    await controller.done;
    assert.equal(harness.reports[0].stopReason, "ack-invalid", label);
    assert.equal(harness.reports[0].uncertainChunks, 1, label);
    assert.equal(JSON.stringify({ errors: harness.errors, report: harness.reports[0] }).includes("abab"), false);
  }
});

test("a simulated ten-minute acknowledged stream retains one frame and accounts for every byte", async () => {
  const harness = makeHarness();
  const controller = createRealtimeRecoveryController({
    sessionId: SESSION_ID,
    ...harness.dependencies,
  });
  await controller.start();
  harness.open();
  const totalChunks = Math.ceil((10 * 60 * 1000) / 480);
  const pcmBytes = 15_360;
  for (let sequence = 0; sequence < totalChunks; sequence += 1) {
    assert.equal(controller.capture(frame(pcmBytes, sequence % 251)), true);
    harness.message(ack(sequence));
  }
  await controller.stop();
  const snapshot = controller.snapshot();
  assert.equal(harness.reports[0].capturedChunks, totalChunks);
  assert.equal(harness.reports[0].acknowledgedChunks, totalChunks);
  assert.equal(harness.reports[0].droppedChunks, 0);
  assert.equal(harness.reports[0].uncertainChunks, 0);
  assert.equal(snapshot.maxObservedRetainedChunks, 1);
  assert.equal(snapshot.maxObservedRetainedBytes, pcmBytes);
  assert.equal(snapshot.retainedBytes, 0);
});

test("the real Node client re-tickets through the API, reconnects, and finalizes durable recovery truth", {
  timeout: 30_000,
}, async (t) => {
  const database = await createTestDatabase(t, "realtime_recovery_e2e");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_recovery_e2e_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "realtime-recovery-e2e-password";
  await provisionApplicationRole({
    connectionString: database.connectionString,
    roleName,
    password,
  });
  const connectionString = restrictedUrl(database.connectionString, roleName, password);
  assert.ok(migrationTestAdminUrl(), "the live recovery proof requires an administrative URL");

  let api = null;
  let realtime = null;
  let workerDb = null;
  let workerRunning = false;
  let workerLoop = null;
  try {
    api = createApplication({
      databaseUrl: connectionString,
      allowHeaderAuth: true,
      ticketSecret: LIVE_SECRET,
      rateLimitEnabled: false,
      upstreamTimeoutMs: 3_000,
      shutdownGraceMs: 1_000,
      logger: false,
    });
    await api.ready();

    const created = await api.inject({
      method: "POST",
      url: "/v1/recitation-sessions",
      headers: liveHeaders(),
      payload: {
        consent: {
          anonymizedLearning: false,
          audioRetention: "discard",
          consentVersion: "w3.7-recovery-e2e-v1",
          externalAsrProcessing: false,
          guardianApproved: true,
        },
        language: "ckb",
        learnerId: LIVE_LEARNER,
        mode: "guided-recite",
        practicePlanId: "w3.7-recovery-e2e",
        quranRef: {
          ayahEnd: 7,
          ayahStart: 1,
          display: "Al-Fatihah 1:1-7",
          surahNumber: 1,
        },
        sourceChecksum: `fixture:w3.7-recovery-${randomUUID()}`,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const sessionId = created.json().id;

    workerDb = createDb(connectionString);
    const unavailableInference = {
      async transcribeSession() {
        return {
          chunkCount: 0,
          reason: "consent-revoked-or-insufficient",
          recognizedTokens: [],
          transcribed: false,
        };
      },
      async predictAlignment() {
        assert.fail("alignment ran after the transcript refusal");
      },
      async predictTajweed() {
        assert.fail("tajweed ran during session finalization");
      },
    };
    const worker = createJobRuntime({
      store: createJobStore({ db: workerDb }),
      handlers: createWorkflowHandlers({
        db: workerDb,
        inference: unavailableInference,
        upstreamTimeoutMs: 1_000,
      }),
      workerId: "w3.7-recovery-e2e-worker",
      leaseMs: 2_000,
      operationTimeoutMs: 1_000,
    });
    workerRunning = true;
    workerLoop = (async () => {
      while (workerRunning) {
        const jobId = await workerDb.withTenant(LIVE_TENANT, async (tx) => {
          const [row] = await tx`
            SELECT id
            FROM background_jobs
            WHERE tenant_id = ${LIVE_TENANT}
              AND kind = 'session.finalize'
              AND subject_id = ${sessionId}
              AND status IN ('queued', 'retry')
              AND available_at <= now()
            ORDER BY created_at, id
            LIMIT 1`;
          return row?.id ?? null;
        });
        if (jobId === null) await new Promise((resolve) => setTimeout(resolve, 5));
        else await worker.runOne(LIVE_TENANT, { jobId });
      }
    })();

    const realtimeDb = createDb(connectionString);
    const storedFrames = [];
    realtime = createRealtimeApplication({
      db: realtimeDb,
      audioObjectStore: {
        async assertReady() {},
        async close() {},
        async put(value) {
          storedFrames.push(Buffer.from(value.audioBytes));
          return { created: true, objectKey: `discarded/${value.chunkId}`, size: value.audioBytes.length };
        },
      },
      workerReadyUrl: "http://worker.invalid/ready",
      asrReadyUrl: "http://asr.invalid/ready",
      readinessTimeoutMs: 100,
      shutdownGraceMs: 1_000,
      metricsDevOpen: true,
      ticketSecret: LIVE_SECRET,
      tenantId: LIVE_TENANT,
      allowedOrigins: [],
      allowMissingOrigin: true,
      rateLimitEnabled: false,
      trustedProxyHops: 0,
      audioOutcomeAuthority: {
        async stored() { return "discarded"; },
        async lost() { return "accepted_lost"; },
        async lostMany() { return "accepted_lost"; },
      },
      fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
      logger: false,
    });
    const listening = await realtime.listen({ host: "127.0.0.1", port: 0 });
    const websocketBase = listening.replace(/^http:/, "ws:");

    const tokens = [];
    const states = [];
    const errors = [];
    let stopped = 0;
    let finalizationResponse = null;
    const controller = createRealtimeRecoveryController({
      sessionId,
      async getUrl() {
        const response = await api.inject({
          method: "POST",
          url: "/v1/realtime-session-tickets",
          headers: liveHeaders(),
          payload: { sessionId },
        });
        assert.equal(response.statusCode, 200, response.body);
        const token = response.json().token;
        tokens.push(token);
        return `${websocketBase}/v1/recitation-sessions/${encodeURIComponent(sessionId)}/audio?ticket=${encodeURIComponent(token)}`;
      },
      openSocket: openNodeWebSocket,
      async stopCapture() {
        stopped += 1;
      },
      async finalize(report) {
        finalizationResponse = await api.inject({
          method: "POST",
          url: `/v1/recitation-sessions/${encodeURIComponent(sessionId)}/finalize`,
          headers: liveHeaders(),
          payload: { recoveryReport: report },
        });
        if (finalizationResponse.statusCode !== 200) {
          throw new Error(`recovery finalization failed with ${finalizationResponse.statusCode}`);
        }
      },
      onError: (reason) => errors.push(reason),
      onStateChange: (state) => states.push(state),
    });

    await controller.start();
    assert.equal(controller.capture(frame(64, 1)), true);
    await waitFor(
      () => controller.snapshot().acknowledgedChunks === 1,
      "the first real Node acknowledgement never reached the controller",
    );
    assert.equal(tokens.length, 1);
    const [firstServerPeer] = [...realtime.websocketServer.clients];
    assert.ok(firstServerPeer, "the real Node WebSocket peer was not registered");
    firstServerPeer.terminate();
    await waitFor(
      () => tokens.length === 2 && controller.snapshot().state === "connected",
      "the clean drop did not mint and admit one fresh ticket",
    );

    assert.equal(controller.capture(frame(64, 2)), true);
    await waitFor(
      () => controller.snapshot().acknowledgedChunks === 2,
      "the recovered real Node socket did not acknowledge the second frame",
    );
    const report = await controller.stop();
    assert.deepEqual(report, {
      version: 1,
      state: "complete",
      capturedChunks: 2,
      acknowledgedChunks: 2,
      droppedChunks: 0,
      uncertainChunks: 0,
      stopReason: "completed",
    });
    assert.equal(stopped, 1);
    assert.equal(new Set(tokens).size, 2, "a reconnect reused a single-use ticket");
    assert.deepEqual(storedFrames, [frame(64, 1), frame(64, 2)]);
    assert.deepEqual(errors, []);
    assert.ok(states.includes("reconnecting"));
    assert.equal(finalizationResponse.statusCode, 200);
    assert.deepEqual(
      {
        finalized: finalizationResponse.json().finalized,
        recordingStatus: finalizationResponse.json().recordingStatus,
        clientDroppedChunkCount: finalizationResponse.json().clientDroppedChunkCount,
        clientUncertainChunkCount: finalizationResponse.json().clientUncertainChunkCount,
        serverLostChunkCount: finalizationResponse.json().serverLostChunkCount,
      },
      {
        finalized: false,
        recordingStatus: "complete",
        clientDroppedChunkCount: 0,
        clientUncertainChunkCount: 0,
        serverLostChunkCount: 0,
      },
    );

    const admin = new Client({ connectionString: database.connectionString });
    await admin.connect();
    try {
      const persisted = await admin.query(
        `SELECT capture_report_state, capture_total_chunks, capture_acknowledged_chunks,
                capture_dropped_chunks, capture_uncertain_chunks,
                (SELECT count(*)::int FROM realtime_session_tickets WHERE session_id = $1) AS tickets,
                (SELECT count(*)::int FROM realtime_ticket_replay_claims WHERE session_id = $1) AS claims
           FROM recitation_sessions WHERE id = $1`,
        [sessionId],
      );
      assert.deepEqual(persisted.rows, [{
        capture_report_state: "complete",
        capture_total_chunks: 2,
        capture_acknowledged_chunks: 2,
        capture_dropped_chunks: 0,
        capture_uncertain_chunks: 0,
        tickets: 2,
        claims: 2,
      }]);
    } finally {
      await admin.end();
    }
  } finally {
    workerRunning = false;
    await workerLoop;
    await realtime?.close();
    await api?.close();
    await workerDb?.end();
    const cleanup = new Client({ connectionString: database.connectionString });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  }
});

test("the finalization report boundary accepts exact accounting and rejects hostile expansion", () => {
  const complete = {
    version: 1,
    state: "complete",
    capturedChunks: 2,
    acknowledgedChunks: 2,
    droppedChunks: 0,
    uncertainChunks: 0,
    stopReason: "completed",
  };
  assert.deepEqual(validateRecoveryReportBody({ recoveryReport: complete }), complete);
  assert.equal(validateRecoveryReportBody({}), null);

  for (const body of [
    { extra: true },
    { recoveryReport: { ...complete, tenantId: "tenant-attack" } },
    { recoveryReport: { ...complete, transcript: "claimed words" } },
    { recoveryReport: { ...complete, audio: "base64" } },
    { recoveryReport: { ...complete, capturedChunks: -1 } },
    { recoveryReport: { ...complete, capturedChunks: 2.5 } },
    { recoveryReport: { ...complete, capturedChunks: 2_147_483_648 } },
    { recoveryReport: { ...complete, droppedChunks: 1 } },
    { recoveryReport: { ...complete, state: "degraded", stopReason: "arbitrary text" } },
  ]) {
    assert.throws(() => validateRecoveryReportBody(body), /recovery report|request body/i);
  }
});

test("recording integrity remains source-separated and never fabricates a total", () => {
  assert.deepEqual(recoveryResponseFields(null, 0), {
    recordingStatus: "unverified",
    clientDroppedChunkCount: 0,
    clientUncertainChunkCount: 0,
    serverLostChunkCount: 0,
  });
  const report = {
    version: 1,
    state: "degraded",
    capturedChunks: 5,
    acknowledgedChunks: 3,
    droppedChunks: 1,
    uncertainChunks: 1,
    stopReason: "ack-ambiguous",
  };
  const fields = recoveryResponseFields(report, 1);
  assert.deepEqual(fields, {
    recordingStatus: "incomplete",
    clientDroppedChunkCount: 1,
    clientUncertainChunkCount: 1,
    serverLostChunkCount: 1,
  });
  assert.equal(Object.hasOwn(fields, "totalLostChunkCount"), false);
  assert.equal(Object.hasOwn(fields, "lostChunkCount"), false);
});

test("the candidate chaos command uses the proved controller and API-issued tickets, never send counts", async () => {
  const source = await readFile(
    new URL("../../scripts/chaos-realtime-reconnect.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /createRealtimeRecoveryController/);
  assert.match(source, /\/v1\/realtime-session-tickets/);
  assert.match(source, /\/finalize/);
  assert.match(source, /acknowledgedChunks \+ report\.droppedChunks \+ report\.uncertainChunks/);
  assert.doesNotMatch(source, /issueRealtimeTicket|REALTIME_GATEWAY_TICKET_SECRET/);
  assert.doesNotMatch(source, /sent\s*>=?\s*TOTAL|delivered all/);
});
