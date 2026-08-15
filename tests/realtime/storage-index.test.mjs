import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import {
  AUDIO_LIMITS,
  createRealtimeAudioRuntime,
} from "../../server/src/realtime/audio.mjs";
import {
  AUDIO_DELIVERY_OUTCOMES,
  createRealtimeAudioOutcomeAuthority,
  markAudioChunkRepairedInTransaction,
} from "../../server/src/realtime/outcomes.mjs";
import { indexAudioChunkInTransaction } from "../../server/src/storage/audio-index.mjs";
import { createFilesystemAudioObjectStore } from "../../server/src/storage/audio-object-store.mjs";
import {
  createTestDatabase,
  migrationTestAdminUrl,
} from "../migrations/lib/postgres.mjs";

const { Client } = pg;
const pcmFrame = (marker = 1) => Buffer.alloc(AUDIO_LIMITS.frameBytes, marker);

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  closed = [];

  send(value, callback) {
    this.sent.push(String(value));
    callback?.();
  }

  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason ?? ""));
  }

  binary(value) {
    this.emit("message", value, true);
  }

  acks() {
    return this.sent.map((value) => JSON.parse(value));
  }
}

function admitted(sessionId, audioRetention = "teacher-review") {
  return Object.freeze({
    accepted: true,
    claims: Object.freeze({
      tenantId: "tenant-storage-index",
      learnerId: "learner-storage-index",
      sessionId,
      audioRetention,
    }),
    traceId: "trace-storage-index",
  });
}

function runtimeUrl(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function seedTenantSession(client, suffix) {
  const identity = {
    tenantId: `tenant-storage-index-${suffix}`,
    learnerId: `learner-storage-index-${suffix}`,
    sessionId: `session-storage-index-${suffix}`,
    audioRetention: "teacher-review",
  };
  const consentId = `consent-storage-index-${suffix}`;
  const auditId = `audit-storage-index-${suffix}`;
  await client.query(
    "insert into institutions (id, name, region) values ($1, 'Storage index tenant', 'test')",
    [identity.tenantId],
  );
  await client.query(
    `insert into users (id, tenant_id, display_name, role, language)
     values ($1, $2, 'Storage index learner', 'learner', 'ckb')`,
    [identity.learnerId, identity.tenantId],
  );
  await client.query(
    `insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     values ($1, $2, $3, 'audio.storage-index.test', 'recitation_session', $4)`,
    [auditId, identity.tenantId, identity.learnerId, identity.sessionId],
  );
  await client.query(
    `insert into consent_records
       (id, tenant_id, user_id, audio_retention, anonymized_learning,
        external_asr_processing, guardian_approved, consent_version, audit_event_id)
     values ($1, $2, $3, $4, false, false, true, 'storage-index-v1', $5)`,
    [consentId, identity.tenantId, identity.learnerId, identity.audioRetention, auditId],
  );
  await client.query(
    `insert into recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        external_processing_allowed, confidence, review_status, started_at, latency_ms,
        consent_record_id, audit_event_id)
     values ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}',
             'storage-index-checksum', 'model-v0.3', 'guided-recite', false, 0, 'draft',
             now(), 0, $4, $5)`,
    [identity.sessionId, identity.tenantId, identity.learnerId, consentId, auditId],
  );
  return identity;
}

function outcomeInput(identity, chunkId, sequence, stored = null) {
  return {
    identity,
    chunk: {
      chunkId,
      sequence,
      startMs: sequence * 480,
      endMs: (sequence + 1) * 480,
      sampleRate: 16_000,
    },
    ...(stored ? { stored } : {}),
  };
}

function immediateStore({ failure = null } = {}) {
  const calls = [];
  return {
    calls,
    async put(value, { signal }) {
      calls.push({ value, signal });
      if (failure) throw failure;
      return {
        objectKey: `audio/v1/${value.tenantId}/${value.learnerId}/${value.sessionId}/${value.chunkId}.pcm`,
        sha256: "a".repeat(64),
        size: value.audioBytes.length,
        storedAt: "2026-08-09T00:00:00.000Z",
        created: true,
      };
    },
  };
}

function fakeOutcomes(overrides = {}) {
  const calls = { stored: [], lost: [], lostMany: [] };
  return {
    calls,
    async stored(input) {
      calls.stored.push(input);
      return input.identity.audioRetention === "discard" ? "discarded" : "indexed";
    },
    async lost(input) {
      calls.lost.push(input);
      return "accepted_lost";
    },
    async lostMany(input) {
      calls.lostMany.push(input);
      return "accepted_lost";
    },
    ...overrides,
  };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("the runtime requires a complete storage/index outcome authority", () => {
  const store = immediateStore();
  for (const audioOutcomeAuthority of [null, {}, { stored() {} }, { lost() {} }]) {
    assert.throws(
      () => createRealtimeAudioRuntime({
        audioObjectStore: store,
        audioOutcomeAuthority,
        shutdownGraceMs: 8_000,
      }),
      /complete realtime audio outcome authority/,
    );
  }
});

test("retained store success is indexed after the enqueue ack with exact immutable metadata", async () => {
  const store = immediateStore();
  const outcomes = fakeOutcomes();
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    audioOutcomeAuthority: outcomes,
    shutdownGraceMs: 8_000,
  });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-indexed"));
  socket.binary(pcmFrame(1));

  assert.equal(socket.acks()[0].accepted, true, "ack must remain enqueue-only and immediate");
  await waitFor(() => outcomes.calls.stored.length === 1, "stored outcome was not consumed");
  assert.deepEqual(outcomes.calls.stored[0], {
    identity: {
      tenantId: "tenant-storage-index",
      learnerId: "learner-storage-index",
      sessionId: "session-indexed",
      audioRetention: "teacher-review",
      traceId: "trace-storage-index",
    },
    chunk: {
      chunkId: "session-indexed-ws-0000",
      sequence: 0,
      startMs: 0,
      endMs: 480,
      sampleRate: 16_000,
    },
    stored: store.calls[0] && {
      objectKey: "audio/v1/tenant-storage-index/learner-storage-index/session-indexed/session-indexed-ws-0000.pcm",
      sha256: "a".repeat(64),
      size: AUDIO_LIMITS.frameBytes,
      storedAt: "2026-08-09T00:00:00.000Z",
      created: true,
    },
  });
  await waitFor(() => runtime.snapshot().retainedChunks === 0, "indexed chunk remained retained");
  assert.match(runtime.renderMetrics(), /realtime_audio_delivery_total\{outcome="indexed"\} 1/);
  assert.deepEqual(socket.closed, []);
  socket.close(1000, "done");
});

test("stored-unindexed is separate from storage success and closes the socket without playback claims", async () => {
  const store = immediateStore();
  const outcomes = fakeOutcomes({
    async stored(input) {
      outcomes.calls.stored.push(input);
      return "stored_unindexed";
    },
  });
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    audioOutcomeAuthority: outcomes,
    shutdownGraceMs: 8_000,
  });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-orphan"));
  socket.binary(pcmFrame(9));
  assert.equal(socket.acks()[0].accepted, true);

  await waitFor(() => socket.closed.length === 1, "stored-unindexed socket remained open");
  assert.deepEqual(socket.closed, [{ code: 1013, reason: "audio delivery unavailable" }]);
  const metrics = runtime.renderMetrics();
  assert.match(metrics, /realtime_audio_store_total\{outcome="stored"\} 1/);
  assert.match(metrics, /realtime_audio_delivery_total\{outcome="stored_unindexed"\} 1/);
  assert.doesNotMatch(metrics, /session-orphan|tenant-storage-index|trace-storage-index/);
});

test("an accepted store failure records accepted-lost and closes instead of silently continuing", async () => {
  const store = immediateStore({ failure: new Error("private failure tenant-storage-index") });
  const outcomes = fakeOutcomes();
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    audioOutcomeAuthority: outcomes,
    shutdownGraceMs: 8_000,
  });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-lost"));
  socket.binary(pcmFrame(17));
  assert.equal(socket.acks()[0].accepted, true);

  await waitFor(() => outcomes.calls.lost.length === 1, "accepted loss was not recorded");
  assert.equal(outcomes.calls.lost[0].reasonCode, "store-failed");
  assert.equal(outcomes.calls.lost[0].chunk.chunkId, "session-lost-ws-0000");
  await waitFor(() => socket.closed.length === 1, "accepted-lost socket remained open");
  const metrics = runtime.renderMetrics();
  assert.match(metrics, /realtime_audio_delivery_total\{outcome="accepted_lost"\} 1/);
  assert.doesNotMatch(metrics, /private-audio|private failure|session-lost/);
});

test("a durable-outcome outage is distinct and still forces the recovery boundary", async () => {
  const store = immediateStore({ failure: new Error("store unavailable") });
  const outcomes = fakeOutcomes({
    async lost(input) {
      outcomes.calls.lost.push(input);
      throw new Error("postgres unavailable with sensitive details");
    },
  });
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    audioOutcomeAuthority: outcomes,
    shutdownGraceMs: 8_000,
  });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-dual-outage"));
  socket.binary(pcmFrame(1));

  await waitFor(() => socket.closed.length === 1, "dual-outage socket remained open");
  const metrics = runtime.renderMetrics();
  assert.match(metrics, /realtime_audio_delivery_total\{outcome="accepted_lost_unrecorded"\} 1/);
  assert.doesNotMatch(metrics, /sensitive|postgres unavailable|session-dual-outage/);
});

test("bounded shutdown durably classifies both in-flight and queued accepted chunks as aborted", async () => {
  const store = {
    put() {
      return new Promise(() => {});
    },
  };
  const outcomes = fakeOutcomes();
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    audioOutcomeAuthority: outcomes,
    shutdownGraceMs: 10,
  });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-shutdown-loss"));
  socket.binary(pcmFrame(1));
  socket.binary(pcmFrame(2));
  assert.deepEqual(socket.acks().map(({ accepted }) => accepted), [true, true]);

  await runtime.stop();
  assert.equal(outcomes.calls.lost.length, 1);
  assert.equal(outcomes.calls.lost[0].reasonCode, "store-aborted");
  assert.equal(outcomes.calls.lostMany.length, 1);
  assert.equal(outcomes.calls.lostMany[0].reasonCode, "store-aborted");
  assert.deepEqual(
    outcomes.calls.lostMany[0].entries.map(({ chunk }) => chunk.chunkId),
    ["session-shutdown-loss-ws-0001"],
  );
  assert.deepEqual(runtime.snapshot(), { activeSessions: 0, retainedChunks: 0, retainedBytes: 0 });
  assert.match(runtime.renderMetrics(), /realtime_audio_delivery_total\{outcome="accepted_lost"\} 2/);
});

test("pre-enqueue rejections report separately and never call durable accepted-chunk outcomes", async () => {
  const store = immediateStore();
  const outcomes = fakeOutcomes();
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: store,
    audioOutcomeAuthority: outcomes,
    shutdownGraceMs: 8_000,
  });
  const socket = new FakeSocket();
  runtime.handleSocket(socket, admitted("session-rejected"));
  socket.binary(Buffer.alloc(0));
  socket.binary(Buffer.alloc(AUDIO_LIMITS.maxPayloadBytes + 1));
  socket.binary(pcmFrame(1));

  assert.deepEqual(socket.acks().map(({ accepted, sequence }) => ({ accepted, sequence })), [
    { accepted: false, sequence: 0 },
    { accepted: false, sequence: 0 },
    { accepted: true, sequence: 0 },
  ]);
  await waitFor(() => outcomes.calls.stored.length === 1, "accepted retry was not indexed");
  assert.equal(outcomes.calls.lost.length, 0);
  assert.equal(outcomes.calls.lostMany.length, 0);
  assert.match(runtime.renderMetrics(), /realtime_audio_delivery_total\{outcome="rejected"\} 2/);
  socket.close(1000, "done");
});

test("delivery outcome vocabulary is closed and metrics expose every fixed label exactly once", () => {
  assert.deepEqual(AUDIO_DELIVERY_OUTCOMES, [
    "indexed",
    "discarded",
    "stored_unindexed",
    "stored_unindexed_unrecorded",
    "accepted_lost",
    "accepted_lost_unrecorded",
    "rejected",
  ]);
  const runtime = createRealtimeAudioRuntime({
    audioObjectStore: immediateStore(),
    audioOutcomeAuthority: fakeOutcomes(),
    shutdownGraceMs: 8_000,
  });
  const metrics = runtime.renderMetrics();
  for (const outcome of AUDIO_DELIVERY_OUTCOMES) {
    assert.equal(
      metrics.match(new RegExp(`realtime_audio_delivery_total\\{outcome="${outcome}"\\}`, "g"))?.length,
      1,
      outcome,
    );
  }
});

test("the real outcome authority refuses an incomplete database boundary", () => {
  for (const db of [null, {}, { withTenant() {} }]) {
    assert.throws(
      () => createRealtimeAudioOutcomeAuthority({ db }),
      /complete tenant database boundary/,
    );
  }
});

test("the restricted database authority indexes, deduplicates loss, and repairs late storage atomically", {
  timeout: 30_000,
}, async (t) => {
  const database = await createTestDatabase(t, "realtime_storage_index");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const suffix = randomUUID();
  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  const identity = await seedTenantSession(admin, suffix);
  await admin.end();

  const roleName = `qrai_storage_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "storage-index-runtime-password";
  await provisionApplicationRole({
    connectionString: database.connectionString,
    roleName,
    password,
  });
  t.after(async () => {
    const cleanup = new Client({ connectionString: migrationTestAdminUrl() });
    await cleanup.connect();
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  const db = createDb(runtimeUrl(database.connectionString, roleName, password), {
    statementTimeoutMs: 2_000,
  });
  t.after(() => db.end());
  await db.assertRestrictedRole();
  const authority = createRealtimeAudioOutcomeAuthority({ db });

  const indexed = outcomeInput(identity, `${identity.sessionId}-direct-0000`, 0, {
    objectKey: `audio/v1/${identity.tenantId}/${identity.learnerId}/${identity.sessionId}/${identity.sessionId}-direct-0000.pcm`,
    sha256: "a".repeat(64),
    size: 3,
    storedAt: "2026-08-09T00:00:00.000Z",
    created: true,
  });
  assert.equal(await authority.stored(indexed), "indexed");
  assert.equal(await authority.stored(indexed), "indexed", "exact index retry must be idempotent");

  const lost = outcomeInput(identity, `${identity.sessionId}-direct-0001`, 1);
  assert.equal(await authority.lost({ ...lost, reasonCode: "store-failed" }), "accepted_lost");
  assert.equal(
    await authority.lost({ ...lost, reasonCode: "store-failed" }),
    "accepted_lost",
    "loss retry must not create a second diagnostic",
  );
  await assert.rejects(
    authority.lost({ ...lost, reasonCode: "store-aborted" }),
    (error) => error?.code === "immutable-conflict",
    "a retry must not rewrite the accepted-loss reason",
  );

  let snapshot = await db.withTenant(identity.tenantId, async (tx) => {
    const [session] = await tx`
      SELECT lost_chunk_count FROM recitation_sessions WHERE id = ${identity.sessionId}`;
    const rows = await tx`
      SELECT chunk_id, initial_outcome, repaired_at
      FROM realtime_audio_chunk_outcomes
      WHERE session_id = ${identity.sessionId}
      ORDER BY chunk_id`;
    return { session, rows };
  });
  assert.equal(Number(snapshot.session.lost_chunk_count), 1);
  assert.deepEqual([...snapshot.rows], [{
    chunk_id: lost.chunk.chunkId,
    initial_outcome: "accepted-lost",
    repaired_at: null,
  }]);

  await assert.rejects(
    db.withTenant(identity.tenantId, (tx) =>
      markAudioChunkRepairedInTransaction(tx, { ...identity, ...lost.chunk })),
    (error) => error?.code === "repair-index-missing",
    "diagnostic repair succeeded without an exact playback index",
  );

  await db.withTenant(identity.tenantId, (tx) => tx`
    UPDATE recitation_sessions
    SET lost_chunk_count = 3
    WHERE tenant_id = ${identity.tenantId} AND id = ${identity.sessionId}`);
  await db.withTenant(identity.tenantId, async (tx) => {
    const repair = {
      ...identity,
      ...lost.chunk,
    };
    await indexAudioChunkInTransaction(tx, repair);
    await markAudioChunkRepairedInTransaction(tx, repair);
    await markAudioChunkRepairedInTransaction(tx, repair);
  });
  snapshot = await db.withTenant(identity.tenantId, async (tx) => {
    const [session] = await tx`
      SELECT lost_chunk_count FROM recitation_sessions WHERE id = ${identity.sessionId}`;
    const [outcome] = await tx`
      SELECT repaired_at FROM realtime_audio_chunk_outcomes
      WHERE session_id = ${identity.sessionId} AND chunk_id = ${lost.chunk.chunkId}`;
    return { session, outcome };
  });
  assert.equal(
    Number(snapshot.session.lost_chunk_count),
    2,
    "repair must decrement only its own loss and preserve unrelated inference gaps",
  );
  assert.ok(snapshot.outcome.repaired_at instanceof Date);

  const conflictId = `${identity.sessionId}-direct-0002`;
  await db.withTenant(identity.tenantId, async (tx) => {
    const [session] = await tx`
      SELECT audit_event_id FROM recitation_sessions WHERE id = ${identity.sessionId}`;
    await tx`
      INSERT INTO audio_chunks
        (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status,
         object_key, audit_event_id)
      VALUES (${conflictId}, ${identity.tenantId}, ${identity.sessionId}, ${conflictId},
              999, 1000, 16000, 'aligned',
              ${`audio/v1/${identity.tenantId}/${identity.learnerId}/${identity.sessionId}/${conflictId}.pcm`},
              ${session.audit_event_id})`;
  });
  const conflict = outcomeInput(identity, conflictId, 2, {
    objectKey: `audio/v1/${identity.tenantId}/${identity.learnerId}/${identity.sessionId}/${conflictId}.pcm`,
    sha256: "b".repeat(64),
    size: 1,
    storedAt: "2026-08-09T00:00:01.000Z",
    created: true,
  });
  assert.equal(await authority.stored(conflict), "stored_unindexed");
  const [diagnostic] = await db.withTenant(identity.tenantId, (tx) => tx`
    SELECT initial_outcome, reason_code
    FROM realtime_audio_chunk_outcomes
    WHERE session_id = ${identity.sessionId} AND chunk_id = ${conflictId}`);
  assert.deepEqual(diagnostic, {
    initial_outcome: "stored-unindexed",
    reason_code: "index-conflict",
  });

  const storageDir = await mkdtemp(join(tmpdir(), "qrai-node-realtime-storage-"));
  const objectStore = createFilesystemAudioObjectStore({ rootDir: storageDir });
  try {
    const runtime = createRealtimeAudioRuntime({
      audioObjectStore: objectStore,
      audioOutcomeAuthority: authority,
      shutdownGraceMs: 8_000,
    });
    const socket = new FakeSocket();
    runtime.handleSocket(socket, Object.freeze({
      accepted: true,
      claims: Object.freeze(identity),
      traceId: "trace-node-live-storage",
    }));
    const audioBytes = pcmFrame(7);
    socket.binary(audioBytes);
    assert.equal(socket.acks()[0]?.accepted, true);
    const chunkId = `${identity.sessionId}-ws-0000`;
    await waitFor(async () => {
      const [row] = await db.withTenant(identity.tenantId, (tx) => tx`
        SELECT object_key FROM audio_chunks WHERE id = ${chunkId}`);
      return Boolean(row);
    }, "real Node runtime never created its playback index");
    const stored = await objectStore.get({ ...identity, chunkId });
    assert.deepEqual(stored.audioBytes, audioBytes);
    assert.equal(
      stored.objectKey,
      `audio/v1/${identity.tenantId}/${identity.learnerId}/${identity.sessionId}/${chunkId}.pcm`,
    );
    assert.match(runtime.renderMetrics(), /realtime_audio_delivery_total\{outcome="indexed"\} 1/);
    socket.close(1000, "done");
    await runtime.stop();
  } finally {
    await objectStore.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});
