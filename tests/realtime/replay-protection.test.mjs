import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";

import pg from "pg";

import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import { issueRealtimeTicket } from "../../server/src/lib/ticket.mjs";
import {
  createRealtimeAdmission,
  REALTIME_ADMISSION_OUTCOMES,
} from "../../server/src/realtime/admission.mjs";
import { createRealtimeApplication } from "../../server/src/realtime/main.mjs";
import { createRealtimeReplayAuthority } from "../../server/src/realtime/replay.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "../migrations/lib/postgres.mjs";

const { Client } = pg;
const TENANT = "hikmah-pilot-erbil";
const LEARNER = "learner-1";
const SESSION = "session-seed-fatihah-1";
const ORIGIN = "https://replay.example.org";
const SECRET = "w3.4-replay-ticket-secret-more-than-32-bytes";
const replayModuleUrl = new URL("../../server/src/realtime/replay.mjs", import.meta.url).href;
const dbModuleUrl = new URL("../../server/src/lib/db.mjs", import.meta.url).href;

function runtimeUrl(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

function ticket({
  sessionId = SESSION,
  learnerId = LEARNER,
  nonce = randomUUID(),
  expiresAtUnixSeconds = Math.floor(Date.now() / 1_000) + 300,
} = {}) {
  return {
    nonce,
    token: issueRealtimeTicket({
      sessionId,
      tenantId: TENANT,
      learnerId,
      externalAsrProcessing: false,
      audioRetention: "teacher-review",
      expiresAtUnixSeconds,
      nonce,
    }, SECRET),
  };
}

function fakeReplayAuthority(claim) {
  return Object.freeze({
    claim,
    renderMetrics: () => "",
    start: () => {},
    stop: async () => {},
  });
}

function appOptions({ db, replayAuthority, useDefaultReplay = false, handleAdmittedSocket } = {}) {
  const options = {
    db: db ?? { assertRestrictedRole: async () => {}, end: async () => {} },
    audioObjectStore: {
      assertReady: async () => {},
      close: async () => {},
      put: async () => ({ created: true }),
    },
    workerReadyUrl: "http://worker:8098/ready",
    asrReadyUrl: "http://asr:8091/ready",
    readinessTimeoutMs: 250,
    shutdownGraceMs: 8_000,
    metricsToken: null,
    metricsDevOpen: true,
    ticketSecret: SECRET,
    tenantId: TENANT,
    allowedOrigins: [ORIGIN],
    allowMissingOrigin: false,
    rateLimitEnabled: false,
    trustedProxyHops: 0,
    handleAdmittedSocket,
    fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
    logger: false,
  };
  if (!useDefaultReplay) {
    options.replayAuthority = replayAuthority ?? fakeReplayAuthority(async () => "fresh");
  }
  return options;
}

async function listenApp(options) {
  const app = createRealtimeApplication(options);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    return { app, port: app.server.address().port };
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

function upgrade({ port, sessionId = SESSION, token, origin = ORIGIN, timeoutMs = 2_000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const path = `/v1/recitation-sessions/${encodeURIComponent(sessionId)}/audio?ticket=${encodeURIComponent(token)}`;
    const request = httpRequest({
      agent: false,
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: origin,
        "Sec-WebSocket-Key": Buffer.alloc(16, 9).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error("realtime replay upgrade timed out"));
    }, timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    request.once("response", (response) => {
      response.once("error", () => {});
      response.resume();
      finish({
        body: "",
        contentLength: response.headers["content-length"],
        statusCode: response.statusCode,
      });
    });
    request.once("upgrade", (response, socket) => {
      finish({ body: "", contentLength: response.headers["content-length"], statusCode: response.statusCode });
      socket.destroy();
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

async function seedSiblingSession(admin, suffix) {
  const sessionId = `session-replay-sibling-${suffix}`;
  const auditId = `audit-replay-sibling-${suffix}`;
  await admin.query(
    `insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     values ($1, $2, $3, 'replay.test.session', 'recitation_session', $4)`,
    [auditId, TENANT, LEARNER, sessionId],
  );
  await admin.query(
    `insert into recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        external_processing_allowed, confidence, review_status, started_at, latency_ms,
        consent_record_id, audit_event_id)
     values ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}',
             'replay-sibling-checksum', 'model-v0.3', 'guided-recite', false, 0, 'draft',
             now(), 0, 'consent-seed-learner-1', $4)`,
    [sessionId, TENANT, LEARNER, auditId],
  );
  return sessionId;
}

function claims({ sessionId = SESSION, nonce = randomUUID(), expiresAtUnixSeconds } = {}) {
  return Object.freeze({
    sessionId,
    tenantId: TENANT,
    learnerId: LEARNER,
    externalAsrProcessing: false,
    audioRetention: "teacher-review",
    expiresAtUnixSeconds: BigInt(expiresAtUnixSeconds ?? Math.floor(Date.now() / 1_000) + 300),
    nonce,
  });
}

async function claimInFreshProcess(connectionString, input) {
  const script = `
    import { createDb } from ${JSON.stringify(dbModuleUrl)};
    import { createRealtimeReplayAuthority } from ${JSON.stringify(replayModuleUrl)};
    const db = createDb(process.env.REPLAY_DATABASE_URL, { statementTimeoutMs: 2000, connectTimeout: 1 });
    const authority = createRealtimeReplayAuthority({ db, tenantId: process.env.REPLAY_TENANT_ID });
    const claims = JSON.parse(process.env.REPLAY_CLAIMS_JSON);
    claims.expiresAtUnixSeconds = BigInt(claims.expiresAtUnixSeconds);
    try {
      process.stdout.write(await authority.claim(claims));
    } finally {
      await authority.stop();
      await db.end();
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      PATH: process.env.PATH,
      REPLAY_DATABASE_URL: connectionString,
      REPLAY_TENANT_ID: TENANT,
      REPLAY_CLAIMS_JSON: JSON.stringify(input, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("fresh replay process timed out"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  return stdout;
}

test("admission records replay outcomes only after the durable claim and strips nonce", async () => {
  const inputTicket = ticket({ nonce: "admission-nonce" });
  const base = {
    ticketSecret: SECRET,
    tenantId: TENANT,
    allowedOrigins: [ORIGIN],
    allowMissingOrigin: false,
    rateLimitEnabled: false,
    nowUnixSeconds: () => Math.floor(Date.now() / 1_000),
  };
  const input = {
    sessionId: SESSION,
    ticket: inputTicket.token,
    origin: ORIGIN,
    clientIp: "127.0.0.1",
    traceId: "trace-replay",
  };

  let observedClaims;
  const fresh = createRealtimeAdmission({
    ...base,
    replayClaim: async (value) => {
      observedClaims = value;
      return "fresh";
    },
  });
  const admitted = await fresh.admit(input);
  assert.equal(admitted.accepted, true);
  assert.equal(observedClaims.nonce, "admission-nonce");
  assert.equal("nonce" in admitted.claims, false, "the socket seam received the ticket nonce");
  const serialized = JSON.stringify(
    admitted,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  assert.equal(serialized.includes("admission-nonce"), false);
  assert.match(fresh.renderMetrics(), /outcome="accepted"} 1/);

  const replayed = createRealtimeAdmission({ ...base, replayClaim: async () => "replay" });
  assert.deepEqual(await replayed.admit(input), {
    accepted: false,
    outcome: "replay_rejected",
    retryAfterSeconds: null,
    statusCode: 401,
  });
  assert.match(replayed.renderMetrics(), /outcome="accepted"} 0/);
  assert.match(replayed.renderMetrics(), /outcome="replay_rejected"} 1/);

  const unavailable = createRealtimeAdmission({
    ...base,
    replayClaim: async () => { throw new Error("postgresql://secret@db/learner-1"); },
  });
  assert.deepEqual(await unavailable.admit(input), {
    accepted: false,
    outcome: "replay_unavailable",
    retryAfterSeconds: null,
    statusCode: 503,
  });
  assert.deepEqual(REALTIME_ADMISSION_OUTCOMES, Object.freeze([
    "accepted",
    "origin_rejected",
    "ticket_rejected",
    "rate_rejected",
    "replay_rejected",
    "replay_unavailable",
  ]));
  assert.doesNotMatch(
    unavailable.renderMetrics(),
    /postgresql:\/\/|learner-1|admission-nonce|exception|secret detail/i,
  );

  const invalidOutcome = createRealtimeAdmission({
    ...base,
    replayClaim: async () => "unexpected",
  });
  assert.deepEqual(await invalidOutcome.admit(input), {
    accepted: false,
    outcome: "replay_unavailable",
    retryAfterSeconds: null,
    statusCode: 503,
  });
});

test("origin, ticket, and rate refusals happen before the durable claim", async () => {
  let replayCalls = 0;
  const admission = createRealtimeAdmission({
    ticketSecret: SECRET,
    tenantId: TENANT,
    allowedOrigins: [ORIGIN],
    allowMissingOrigin: false,
    rateLimitEnabled: true,
    rateLimitOptions: { capacity: 1, refillIntervalMs: 60_000, now: () => 0 },
    nowUnixSeconds: () => Math.floor(Date.now() / 1_000),
    replayClaim: async () => {
      replayCalls += 1;
      return "fresh";
    },
  });
  const valid = ticket({ nonce: "ordered-boundary" }).token;
  assert.equal((await admission.admit({
    sessionId: SESSION,
    ticket: valid,
    origin: "https://wrong.example.org",
    clientIp: "127.0.0.1",
  })).outcome, "origin_rejected");
  assert.equal((await admission.admit({
    sessionId: SESSION,
    ticket: "not-a-ticket",
    origin: ORIGIN,
    clientIp: "127.0.0.1",
  })).outcome, "ticket_rejected");
  assert.equal(replayCalls, 0);
  assert.equal((await admission.admit({
    sessionId: SESSION,
    ticket: valid,
    origin: ORIGIN,
    clientIp: "127.0.0.1",
  })).accepted, true);
  assert.equal((await admission.admit({
    sessionId: SESSION,
    ticket: valid,
    origin: ORIGIN,
    clientIp: "127.0.0.1",
  })).outcome, "rate_rejected");
  assert.equal(replayCalls, 1, "a pre-replay rate refusal consumed the durable ticket");
});

test("cleanup lifecycle is single-interval, non-overlapping, fail-safe, and drained on stop", async () => {
  const pending = [];
  const timerState = { callback: null, cleared: 0, created: 0, unref: 0 };
  const tx = () => new Promise((resolve, reject) => pending.push({ reject, resolve }));
  const authority = createRealtimeReplayAuthority({
    db: { withTenant: async (_tenantId, body) => body(tx) },
    tenantId: TENANT,
    cleanupIntervalMs: 1_000,
    setIntervalImpl(callback) {
      timerState.callback = callback;
      timerState.created += 1;
      return { unref: () => { timerState.unref += 1; } };
    },
    clearIntervalImpl() {
      timerState.cleared += 1;
    },
  });

  authority.start();
  authority.start();
  assert.deepEqual(timerState, {
    callback: timerState.callback,
    cleared: 0,
    created: 1,
    unref: 1,
  });
  timerState.callback();
  timerState.callback();
  assert.equal(pending.length, 1, "an interval overlapped its own in-flight cleanup");
  let stopSettled = false;
  const stopping = authority.stop().then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false, "stop returned before the in-flight cleanup settled");
  pending.shift().resolve([]);
  await stopping;
  await authority.stop();

  authority.start();
  timerState.callback();
  pending.shift().reject(new Error("secret cleanup failure"));
  await new Promise((resolve) => setImmediate(resolve));
  timerState.callback();
  pending.shift().resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  await authority.stop();
  assert.equal(timerState.created, 2);
  assert.equal(timerState.cleared, 2);
  assert.match(authority.renderMetrics(), /outcome="succeeded"} 2/);
  assert.match(authority.renderMetrics(), /outcome="failed"} 1/);
  assert.doesNotMatch(
    authority.renderMetrics(),
    /tenant|session|learner|hash|nonce|ticket|exception|secret cleanup failure/i,
  );
});

test("W3.4 adds no broker dependency, Compose edge, or public route", async () => {
  const serverPackage = JSON.parse(await readFile(
    new URL("../../server/package.json", import.meta.url),
    "utf8",
  ));
  const dependencyNames = Object.keys(serverPackage.dependencies ?? {});
  assert.deepEqual(dependencyNames.filter((name) => /redis|ioredis|nats|broker/i.test(name)), []);
  const composeSources = await Promise.all([
    "../../docker-compose.yml",
    "../../docker-compose.release.yml",
    "../../docker-compose.canary.yml",
    "../../docker-compose.native.yml",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.doesNotMatch(composeSources.join("\n"), /^\s*(redis|nats|broker):\s*$/im);
  const mainSource = await readFile(new URL("../../server/src/realtime/main.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(mainSource, /redis|ioredis|nats|broker/i);
  assert.equal(mainSource.includes("/v1/recitation-sessions/:sessionId/audio"), true);
  assert.equal(mainSource.includes("/v1/replay"), false);
});

test("a replay authority outage returns a bodyless 503 and never upgrades", async () => {
  const inputTicket = ticket({ nonce: "outage-nonce" });
  const fixture = await listenApp(appOptions({
    replayAuthority: fakeReplayAuthority(async () => {
      throw new Error("database unavailable with secret detail");
    }),
  }));
  try {
    const response = await upgrade({ port: fixture.port, token: inputTicket.token });
    assert.deepEqual(response, { body: "", contentLength: "0", statusCode: 503 });
    const metrics = await fixture.app.inject({ method: "GET", url: "/metrics" });
    assert.match(metrics.body, /realtime_admission_total\{outcome="replay_unavailable"\} 1/);
    assert.doesNotMatch(metrics.body, /database unavailable|secret detail|outage-nonce|rt_v2/);
  } finally {
    await fixture.app.close();
  }
});

test("Postgres is single-use across instances/restarts, fail-closed under lock, and meets the approved load bar", { timeout: 180_000 }, async (t) => {
  const emergencyClosers = [];
  t.after(async () => {
    await Promise.allSettled([...emergencyClosers].reverse().map((close) => close()));
  });
  const database = await createTestDatabase(t, "realtime_replay_runtime");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_replay_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "realtime-replay-runtime-password";
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });
  const adminUrl = migrationTestAdminUrl();
  t.after(async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  const connectionString = runtimeUrl(database.connectionString, roleName, password);
  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  let adminClosed = false;
  emergencyClosers.push(async () => {
    if (!adminClosed) {
      await admin.query("rollback").catch(() => {});
      await admin.end().catch(() => {});
    }
  });
  const suffix = randomUUID();
  const siblingSession = await seedSiblingSession(admin, suffix);

  const admittedContexts = [];
  const makeLive = async ({ statementTimeoutMs = 500, admissionNowUnixSeconds } = {}) => {
    const db = createDb(connectionString, { statementTimeoutMs, connectTimeout: 1 });
    try {
      const fixture = await listenApp({
        ...appOptions({
          db,
          useDefaultReplay: true,
          handleAdmittedSocket(socket, context) {
            admittedContexts.push(context);
            socket.close(1013, "temporarily unavailable");
          },
        }),
        admissionNowUnixSeconds,
      });
      emergencyClosers.push(() => fixture.app.close().catch(() => {}));
      return fixture;
    } catch (error) {
      await db.end().catch(() => {});
      throw error;
    }
  };

  const nonce = `cross-instance-${suffix}`;
  const shared = ticket({ nonce });
  const first = await makeLive();
  const second = await makeLive();
  try {
    const raced = await Promise.all([
      upgrade({ port: first.port, token: shared.token }),
      upgrade({ port: second.port, token: shared.token }),
    ]);
    assert.deepEqual(raced.map(({ statusCode }) => statusCode).sort(), [101, 401]);
    assert.equal(admittedContexts.length, 1);
    assert.equal("nonce" in admittedContexts[0].claims, false);

    const replay = await upgrade({ port: first.port, token: shared.token });
    assert.deepEqual(replay, { body: "", contentLength: "0", statusCode: 401 });

    const sameNonceNewSession = ticket({ sessionId: siblingSession, nonce });
    assert.equal((await upgrade({
      port: second.port,
      sessionId: siblingSession,
      token: sameNonceNewSession.token,
    })).statusCode, 101);

    const wrongLearner = ticket({ learnerId: "another-learner", nonce: `wrong-${suffix}` });
    assert.equal((await upgrade({ port: first.port, token: wrongLearner.token })).statusCode, 401);

    const unknownSession = `unknown-${suffix}`;
    const unknown = ticket({ sessionId: unknownSession, nonce: `unknown-${suffix}` });
    assert.deepEqual(await upgrade({
      port: first.port,
      sessionId: unknownSession,
      token: unknown.token,
    }), { body: "", contentLength: "0", statusCode: 401 });

    const databaseNow = Number((await admin.query(
      "select floor(extract(epoch from clock_timestamp()))::bigint as now",
    )).rows[0].now);
    const dbExpired = ticket({
      expiresAtUnixSeconds: databaseNow - 1,
      nonce: `db-expired-${suffix}`,
    });
    const laggingNode = await makeLive({ admissionNowUnixSeconds: () => databaseNow - 2 });
    try {
      assert.deepEqual(await upgrade({ port: laggingNode.port, token: dbExpired.token }), {
        body: "",
        contentLength: "0",
        statusCode: 401,
      });
    } finally {
      await laggingNode.app.close();
    }

    const stored = await admin.query(
      `select tenant_id, session_id, nonce_hash, expires_at_unix_seconds::text, claimed_at
         from realtime_ticket_replay_claims
        where nonce_hash = $1 order by session_id`,
      [createHash("sha256").update(nonce, "utf8").digest("hex")],
    );
    assert.equal(stored.rows.length, 2, "same nonce in two signed sessions false-collided");
    assert.ok(stored.rows.every(({ nonce_hash: hash }) => /^[0-9a-f]{64}$/.test(hash)));
    const serializedRows = JSON.stringify(stored.rows);
    assert.equal(serializedRows.includes(nonce), false);
    assert.equal(serializedRows.includes(shared.token), false);
  } finally {
    await Promise.all([first.app.close(), second.app.close()]);
  }

  const restarted = await makeLive();
  try {
    assert.equal((await upgrade({ port: restarted.port, token: shared.token })).statusCode, 401);
  } finally {
    await restarted.app.close();
  }

  const processClaim = claims({ nonce: `process-restart-${suffix}` });
  assert.equal(await claimInFreshProcess(connectionString, processClaim), "fresh");
  assert.equal(await claimInFreshProcess(connectionString, processClaim), "replay");

  const locked = await makeLive({ statementTimeoutMs: 100 });
  await admin.query("begin");
  await admin.query("lock table realtime_ticket_replay_claims in access exclusive mode");
  const lockNonce = `locked-${suffix}`;
  const lockHash = createHash("sha256").update(lockNonce, "utf8").digest("hex");
  const lockTicket = ticket({ nonce: lockNonce });
  try {
    const startedAt = performance.now();
    const response = await upgrade({ port: locked.port, token: lockTicket.token });
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(response, { body: "", contentLength: "0", statusCode: 503 });
    assert.ok(elapsed < 1_000, `locked replay claim took ${elapsed.toFixed(1)} ms`);
  } finally {
    await admin.query("rollback");
  }
  const delayed = await admin.query(
    "select count(*)::int as count from realtime_ticket_replay_claims where nonce_hash = $1",
    [lockHash],
  );
  assert.equal(delayed.rows[0].count, 0, "a timed-out replay claim committed after its 503");
  assert.equal((await upgrade({ port: locked.port, token: lockTicket.token })).statusCode, 101);
  assert.equal((await upgrade({ port: locked.port, token: lockTicket.token })).statusCode, 401);
  await locked.app.close();

  const cleanupDbs = [
    createDb(connectionString, { statementTimeoutMs: 1_000, connectTimeout: 1 }),
    createDb(connectionString, { statementTimeoutMs: 1_000, connectTimeout: 1 }),
  ];
  const cleanupAuthorities = cleanupDbs.map((db) => createRealtimeReplayAuthority({
    db,
    tenantId: TENANT,
    cleanupBatchSize: 2,
  }));
  emergencyClosers.push(async () => {
    await Promise.all(cleanupAuthorities.map((authority) => authority.stop().catch(() => {})));
    await Promise.all(cleanupDbs.map((db) => db.end().catch(() => {})));
  });

  const liveClaim = claims({ nonce: `live-cleanup-${suffix}` });
  const liveHash = createHash("sha256").update(liveClaim.nonce, "utf8").digest("hex");
  assert.equal(await cleanupAuthorities[0].claim(liveClaim), "fresh");

  const composedNonce = `nonce-\u00fcn\u00efcode-${suffix}`;
  const decomposedNonce = `nonce-u\u0308ni\u0308code-${suffix}`;
  const unicodeHashes = [composedNonce, decomposedNonce].map((value) =>
    createHash("sha256").update(value, "utf8").digest("hex"));
  assert.notEqual(unicodeHashes[0], unicodeHashes[1]);
  assert.equal(await cleanupAuthorities[0].claim(claims({ nonce: composedNonce })), "fresh");
  assert.equal(await cleanupAuthorities[0].claim(claims({ nonce: decomposedNonce })), "fresh");
  const exactUnicodeRows = await admin.query(
    "select nonce_hash from realtime_ticket_replay_claims where nonce_hash = any($1::text[]) order by nonce_hash",
    [unicodeHashes],
  );
  assert.deepEqual(exactUnicodeRows.rows.map(({ nonce_hash: hash }) => hash), [...unicodeHashes].sort());

  const expiredHashes = Array.from({ length: 4 }, (_, index) =>
    createHash("sha256").update(`expired-${suffix}-${index}`, "utf8").digest("hex"));
  for (const [index, hash] of expiredHashes.entries()) {
    await admin.query(
      `insert into realtime_ticket_replay_claims
         (tenant_id, session_id, nonce_hash, expires_at_unix_seconds)
       values ($1, $2, $3, floor(extract(epoch from clock_timestamp())) - $4)`,
      [TENANT, SESSION, hash, 10 - index],
    );
  }

  const cleanupLock = new Client({ connectionString: database.connectionString });
  await cleanupLock.connect();
  emergencyClosers.push(async () => {
    await cleanupLock.query("rollback").catch(() => {});
    await cleanupLock.end().catch(() => {});
  });
  await cleanupLock.query("begin");
  await cleanupLock.query(
    "select nonce_hash from realtime_ticket_replay_claims where nonce_hash = $1 for update",
    [expiredHashes[0]],
  );
  const cleanupStarted = performance.now();
  const cleanupResults = await Promise.all(cleanupAuthorities.map((authority) =>
    authority.cleanupExpired()));
  assert.ok(performance.now() - cleanupStarted < 1_000, "cleanup waited for a locked expired row");
  assert.ok(cleanupResults.every((deleted) => deleted <= 2), "cleanup exceeded its batch ceiling");
  assert.equal(cleanupResults.reduce((sum, deleted) => sum + deleted, 0), 3);
  let remainingCleanupRows = await admin.query(
    "select nonce_hash from realtime_ticket_replay_claims where nonce_hash = any($1::text[]) order by nonce_hash",
    [[...expiredHashes, liveHash]],
  );
  assert.deepEqual(remainingCleanupRows.rows, [
    { nonce_hash: expiredHashes[0] },
    { nonce_hash: liveHash },
  ].sort((a, b) => a.nonce_hash.localeCompare(b.nonce_hash)));
  await cleanupLock.query("rollback");
  assert.equal(await cleanupAuthorities[0].cleanupExpired(), 1);
  remainingCleanupRows = await admin.query(
    "select nonce_hash from realtime_ticket_replay_claims where nonce_hash = any($1::text[]) order by nonce_hash",
    [[...expiredHashes, liveHash]],
  );
  assert.deepEqual(remainingCleanupRows.rows, [{ nonce_hash: liveHash }]);

  await cleanupLock.query("begin");
  await cleanupLock.query("lock table realtime_ticket_replay_claims in access exclusive mode");
  const failureDb = createDb(connectionString, { statementTimeoutMs: 100, connectTimeout: 1 });
  const failureAuthority = createRealtimeReplayAuthority({ db: failureDb, tenantId: TENANT });
  emergencyClosers.push(async () => {
    await failureAuthority.stop().catch(() => {});
    await failureDb.end().catch(() => {});
  });
  await assert.rejects(failureAuthority.cleanupExpired(), /timeout|canceling statement/i);
  await cleanupLock.query("rollback");
  assert.match(failureAuthority.renderMetrics(), /outcome="failed"} 1/);
  assert.match(cleanupAuthorities[0].renderMetrics(), /outcome="succeeded"} [1-9][0-9]*/);
  for (const metrics of [failureAuthority.renderMetrics(), cleanupAuthorities[0].renderMetrics()]) {
    assert.doesNotMatch(metrics, /tenant|session|learner|hash|nonce|ticket|exception|secret/i);
  }
  const retainedLive = await admin.query(
    "select count(*)::int as count from realtime_ticket_replay_claims where nonce_hash = $1",
    [liveHash],
  );
  assert.equal(retainedLive.rows[0].count, 1);

  const benchmarkDbs = [
    createDb(connectionString, { statementTimeoutMs: 2_000, connectTimeout: 1 }),
    createDb(connectionString, { statementTimeoutMs: 2_000, connectTimeout: 1 }),
  ];
  const authorities = benchmarkDbs.map((db) => createRealtimeReplayAuthority({ db, tenantId: TENANT }));
  try {
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      authorities[index % authorities.length].claim(claims({ nonce: `warm-${suffix}-${index}` }))));

    const latencies = [];
    const benchmarkHashes = [];
    const benchmarkStarted = performance.now();
    for (let offset = 0; offset < 512; offset += 32) {
      const results = await Promise.all(Array.from({ length: 32 }, async (_, batchIndex) => {
        const index = offset + batchIndex;
        const authority = authorities[index % authorities.length];
        const started = performance.now();
        const benchmarkNonce = `bench-${suffix}-${index}`;
        benchmarkHashes.push(createHash("sha256").update(benchmarkNonce, "utf8").digest("hex"));
        const outcome = await authority.claim(claims({ nonce: benchmarkNonce }));
        latencies.push(performance.now() - started);
        return outcome;
      }));
      assert.ok(results.every((outcome) => outcome === "fresh"));
    }
    const elapsedMs = performance.now() - benchmarkStarted;
    const ordered = [...latencies].sort((a, b) => a - b);
    const p95Ms = ordered[Math.ceil(ordered.length * 0.95) - 1];
    const throughput = 512 / (elapsedMs / 1_000);
    assert.equal(latencies.length, 512);
    const persisted = await admin.query(
      "select count(*)::int as count from realtime_ticket_replay_claims where nonce_hash = any($1::text[])",
      [benchmarkHashes],
    );
    assert.equal(persisted.rows[0].count, 512, "the measured claims did not durably persist");
    assert.ok(p95Ms < 100, `replay claim p95 ${p95Ms.toFixed(1)} ms exceeded 100 ms`);
    assert.ok(throughput >= 100, `replay throughput ${throughput.toFixed(1)}/s fell below 100/s`);
    t.diagnostic(
      `W3.4 restricted Postgres replay benchmark: p95=${p95Ms.toFixed(2)}ms ` +
        `throughput=${throughput.toFixed(2)}/s claims=512 concurrency=32 warmup=32`,
    );
  } finally {
    await Promise.all(authorities.map((authority) => authority.stop()));
    await Promise.all(benchmarkDbs.map((db) => db.end()));
  }

  await admin.query("delete from recitation_sessions where id = $1", [siblingSession]);
  const cascaded = await admin.query(
    "select count(*)::int as count from realtime_ticket_replay_claims where session_id = $1",
    [siblingSession],
  );
  assert.equal(cascaded.rows[0].count, 0);
  await admin.end();
  adminClosed = true;
});
