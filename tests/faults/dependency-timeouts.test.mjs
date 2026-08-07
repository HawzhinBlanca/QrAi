import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApplication } from "../../server/src/app.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import {
  createDeadline,
  fetchWithDeadline,
  isDeadlineError,
  parseTimeoutSeconds,
} from "../../server/src/lib/deadline.mjs";
import {
  TENANT,
  insertDeclaredTestAcousticFinding,
  queryJson,
  withDb,
} from "../api-parity/lib/harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const ML_KEY = "deadline-ml-key";
const AGENTS_KEY = "deadline-agents-key";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function startPartialHangServer() {
  let closeCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"partial":');
    response.on("close", () => {
      closeCount += 1;
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    async waitForClose(target = 1) {
      const expiresAt = Date.now() + 2_000;
      while (closeCount < target && Date.now() < expiresAt) {
        await delay(20);
      }
      assert.ok(closeCount >= target, "the timed-out dependency socket was not cancelled");
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

async function waitForHttp(url, child, stderr) {
  const expiresAt = Date.now() + 12_000;
  while (Date.now() < expiresAt) {
    if (child.exitCode !== null) {
      throw new Error(`dependency test process exited before readiness: ${stderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The process is still booting.
    }
    await delay(50);
  }
  throw new Error(`dependency test process did not become ready: ${stderr()}`);
}

async function startNodeService(entry, env, healthUrl) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrText = "";
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });
  child.stdout.resume();
  try {
    await waitForHttp(healthUrl, child, () => stderrText);
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    throw error;
  }
  return {
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      await Promise.race([exited, delay(2_000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

async function dbAvailable(t) {
  if (DATABASE_URL === "") {
    t.skip("DATABASE_URL is unavailable; live Postgres deadline proof is explicit");
    return false;
  }
  try {
    await queryJson("SELECT 1 AS ok");
    return true;
  } catch {
    t.skip("Postgres is unreachable; live deadline proof is explicit");
    return false;
  }
}

const actorHeaders = (userId, role = "learner") => ({
  "content-type": "application/json",
  "x-tenant-id": TENANT,
  "x-user-id": userId,
  "x-user-role": role,
});

async function seedReviewFinding() {
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  const ids = {
    audit: `audit-deadline-${suffix}`,
    consent: `consent-deadline-${suffix}`,
    session: `session-deadline-${suffix}`,
    alignment: `alignment-deadline-${suffix}`,
    finding: `finding-deadline-${suffix}`,
    chunk: `chunk-deadline-${suffix}`,
  };
  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [reviewer] = await queryJson(
    "SELECT id, role FROM users WHERE tenant_id = $1 AND role IN ('teacher','admin','ops') ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  const [word] = await queryJson("SELECT id FROM canonical_words WHERE ayah_id = '1:1' LIMIT 1");
  if (!learner || !reviewer || !model || !word) return null;

  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     VALUES ($1, $2, $3, 'test.seed', 'test', $1, '{}'::jsonb)`,
    [ids.audit, TENANT, learner.id],
  );
  await queryJson(
    `INSERT INTO consent_records
       (id, tenant_id, user_id, audio_retention, anonymized_learning,
        external_asr_processing, guardian_approved, consent_version, audit_event_id)
     VALUES ($1, $2, $3, 'teacher-review', true, false, true, 'pilot-v1', $4)`,
    [ids.consent, TENANT, learner.id, ids.audit],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{}'::jsonb, 'fnv1a32:deadline', $4, 'guided-recite', 'p', false,
             0.0, 'draft', now(), 0, $5, '{}'::jsonb, $6, 'ar')`,
    [ids.session, TENANT, learner.id, model.id, ids.consent, ids.audit],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'x', 100, 300, 0.9, 'matched', $5, $6, 'client-reported')`,
    [ids.alignment, TENANT, ids.session, word.id, model.id, ids.audit],
  );
  await insertDeclaredTestAcousticFinding({
    id: ids.finding,
    alignmentId: ids.alignment,
    auditEventId: ids.audit,
  });
  await queryJson(
    `INSERT INTO audio_chunks
       (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status,
        object_key, audit_event_id)
     VALUES ($1, $2, $3, 'deadline-evidence', 50, 350, 16000, 'aligned', $4, $5)`,
    [ids.chunk, TENANT, ids.session, `${TENANT}/${learner.id}/${ids.chunk}.bin`, ids.audit],
  );
  return { ...ids, learnerId: learner.id, reviewer };
}

async function cleanupReviewFinding(fixture) {
  if (!fixture) return;
  await queryJson(
    "DELETE FROM audit_events WHERE tenant_id = $1 AND subject_id = $2 AND action = 'recitation.audio.read'",
    [TENANT, fixture.finding],
  );
  await queryJson("DELETE FROM audio_chunks WHERE tenant_id = $1 AND id = $2", [TENANT, fixture.chunk]);
  await queryJson("DELETE FROM tajweed_findings WHERE tenant_id = $1 AND id = $2", [TENANT, fixture.finding]);
  await queryJson("DELETE FROM word_alignments WHERE tenant_id = $1 AND id = $2", [TENANT, fixture.alignment]);
  await queryJson("DELETE FROM recitation_sessions WHERE tenant_id = $1 AND id = $2", [TENANT, fixture.session]);
  await queryJson("DELETE FROM consent_records WHERE tenant_id = $1 AND id = $2", [TENANT, fixture.consent]);
  await queryJson("DELETE FROM audit_events WHERE tenant_id = $1 AND id = $2", [TENANT, fixture.audit]);
}

test("a shared deadline aborts a response body that hangs after headers", async () => {
  const hung = await startPartialHangServer();
  const startedAt = performance.now();
  try {
    const response = await fetchWithDeadline(hung.url, { deadline: createDeadline(100) });
    await assert.rejects(() => response.json(), (error) => isDeadlineError(error));
    assert.ok(performance.now() - startedAt < 1_000, "the body exceeded its bounded deadline");
    await hung.waitForClose();
  } finally {
    await hung.stop();
  }
});

test("service timeout configuration is strict and cannot silently disable cancellation", () => {
  assert.equal(parseTimeoutSeconds("1"), 1_000);
  for (const value of ["", "0", "1.5", "6O", "-1", "2147484"]) {
    assert.throws(() => parseTimeoutSeconds(value), /UPSTREAM_TIMEOUT_SECS/);
  }
});

test("a hanging Rust compatibility response is cancelled and returns fixed 502", async () => {
  const hung = await startPartialHangServer();
  const app = createApplication({
    upstream: hung.url,
    compatibilityRouteKeys: new Set(),
    rateLimitEnabled: false,
    upstreamTimeoutMs: 100,
  });
  try {
    await app.ready();
    const startedAt = performance.now();
    const response = await app.inject({ method: "GET", url: "/compatibility-hang" });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: "compatibility service unavailable" });
    assert.ok(performance.now() - startedAt < 1_000, "compatibility proxy was not bounded");
    await hung.waitForClose();
  } finally {
    await app.close();
    await hung.stop();
  }
});

test("ML cancels a hung ASR body and never records alignment completion", async () => {
  const hung = await startPartialHangServer();
  const work = await mkdtemp(join(tmpdir(), "qrai-ml-deadline-"));
  const port = await freePort();
  const service = await startNodeService(
    join(root, "tests/inference/lib/worker-compatibility-harness.mjs"),
    {
      ML_INFERENCE_PORT: String(port),
      ML_API_KEY: ML_KEY,
      ASR_API_KEY: "deadline-asr-key",
      ASR_SERVICE_URL: hung.url,
      UPSTREAM_TIMEOUT_SECS: "1",
      AUDIO_STORAGE_DIR: join(work, "audio"),
    },
    `http://127.0.0.1:${port}/health`,
  );
  try {
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/alignments:predict`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ml-api-key": ML_KEY },
      body: JSON.stringify({
        audioBase64: "AAAA",
        audioFormat: "wav",
        consent: { externalAsrProcessing: true, guardianApproved: true },
        externalAsrRequested: true,
        quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
        sessionId: "deadline-session",
        tenantId: "deadline-tenant",
      }),
      signal: AbortSignal.timeout(4_000),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "dependency operation timed out" });
    assert.ok(performance.now() - startedAt < 3_000, "ML exceeded its ASR deadline");
    await hung.waitForClose();

    const auditDir = join(work, "audio", "audit-log");
    const files = await readdir(auditDir).catch(() => []);
    const auditText = (await Promise.all(files.map((name) => readFile(join(auditDir, name), "utf8"))))
      .join("\n");
    assert.ok(files.length > 0, "the audit assertion did not inspect a real ML audit file");
    assert.match(auditText, /privacy\.external-asr\.called/, "the dependency attempt was not audited");
    assert.doesNotMatch(auditText, /ml\.alignment\.predicted/, "timed-out alignment was claimed complete");
  } finally {
    await service.stop();
    await hung.stop();
    await rm(work, { recursive: true, force: true });
  }
});

test("the agents worker cancels a hung platform response and returns generic 503", async () => {
  const hung = await startPartialHangServer();
  const port = await freePort();
  const service = await startNodeService(
    join(root, "services/agents/server.mjs"),
    {
      AGENTS_PORT: String(port),
      AGENTS_SERVICE_API_KEY: AGENTS_KEY,
      PLATFORM_API_URL: hung.url,
      UPSTREAM_TIMEOUT_SECS: "1",
    },
    `http://127.0.0.1:${port}/health`,
  );
  try {
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/run/tajweed`, {
      method: "POST",
      headers: { "x-agents-api-key": AGENTS_KEY },
      signal: AbortSignal.timeout(4_000),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "dependency operation timed out" });
    assert.ok(performance.now() - startedAt < 3_000, "worker exceeded its platform deadline");
    await hung.waitForClose();
  } finally {
    await service.stop();
    await hung.stop();
  }
});

test("Postgres timeout is server-side, retryable, and rolls back partial durable state", async (t) => {
  if (!(await dbAvailable(t))) return;
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  const userId = `learner-db-deadline-${suffix}`;
  const auditId = `audit-db-deadline-${suffix}`;
  const db = createDb(DATABASE_URL, { statementTimeoutMs: 120 });
  let app;
  try {
    await queryJson(
      "INSERT INTO users (id, tenant_id, display_name, role, language) VALUES ($1, $2, 'Deadline learner', 'learner', 'ar')",
      [userId, TENANT],
    );

    await assert.rejects(
      db.forDeadline(createDeadline(300)).withTenant(TENANT, async (tx) => {
        await tx`
          INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
          VALUES (${auditId}, ${TENANT}, ${userId}, 'test.deadline', 'test', ${auditId})`;
        await tx`SELECT pg_sleep(1)`;
      }),
      (error) => error?.code === "57014",
    );
    assert.deepEqual(
      await queryJson("SELECT id FROM audit_events WHERE tenant_id = $1 AND id = $2", [TENANT, auditId]),
      [],
      "the statement timeout returned before its transaction rolled back",
    );

    app = createApplication({
      databaseUrl: DATABASE_URL,
      allowHeaderAuth: true,
      enforceRestrictedDbRole: false,
      rateLimitEnabled: false,
      upstreamTimeoutMs: 120,
    });
    await app.ready();
    const lockKey = `progress:${TENANT}:${userId}:1:1`;
    await withDb(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [lockKey]);
        const response = await app.inject({
          method: "POST",
          url: "/v1/learner/progress",
          headers: actorHeaders(userId),
          payload: { ayahRef: "1:1", quality: 5 },
        });
        assert.equal(response.statusCode, 503);
        assert.equal(response.headers["retry-after"], "1");
        assert.deepEqual(response.json(), { error: "database operation timed out" });
      } finally {
        await client.query("ROLLBACK");
      }
    });
    assert.deepEqual(
      await queryJson(
        "SELECT ayah_ref FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2",
        [TENANT, userId],
      ),
      [],
      "the timed-out write produced partial progress",
    );
  } finally {
    await app?.close();
    await db.end();
    await queryJson("DELETE FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2", [TENANT, userId]).catch(() => {});
    await queryJson("DELETE FROM audit_events WHERE tenant_id = $1 AND id = $2", [TENANT, auditId]).catch(() => {});
    await queryJson("DELETE FROM users WHERE tenant_id = $1 AND id = $2", [TENANT, userId]).catch(() => {});
  }
});

test("storage timeout preserves privacy data and never marks review audio served", async (t) => {
  if (!(await dbAvailable(t))) return;
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  const privacyLearnerId = `learner-storage-deadline-${suffix}`;
  const storageCalls = { get: 0, listLearner: 0 };
  const waitForAbort = (signal) => new Promise((resolve, reject) => {
    if (!signal) {
      reject(new Error("storage call did not receive a deadline signal"));
      return;
    }
    if (signal.aborted) {
      reject(new Error("planned storage timeout"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("planned storage timeout")),
      { once: true },
    );
  });
  const audioObjectStore = {
    assertReady: async () => {},
    close: async () => {},
    deleteLearner: async () => assert.fail("manifest timeout must precede deletion"),
    get: async (_key, { signal } = {}) => {
      storageCalls.get += 1;
      return waitForAbort(signal);
    },
    listLearner: async (_owner, { signal } = {}) => {
      storageCalls.listLearner += 1;
      return waitForAbort(signal);
    },
  };
  let fixture;
  let app;
  try {
    await queryJson(
      "INSERT INTO users (id, tenant_id, display_name, role, language) VALUES ($1, $2, 'Storage learner', 'learner', 'ar')",
      [privacyLearnerId, TENANT],
    );
    fixture = await seedReviewFinding();
    if (!fixture) {
      t.skip("the live database has no learner/reviewer/model/canonical-word seed");
      return;
    }

    app = createApplication({
      databaseUrl: DATABASE_URL,
      allowHeaderAuth: true,
      enforceRestrictedDbRole: false,
      rateLimitEnabled: false,
      upstreamTimeoutMs: 150,
      audioObjectStore,
    });
    await app.ready();

    const privacy = await app.inject({
      method: "POST",
      url: "/v1/privacy/delete",
      headers: actorHeaders(privacyLearnerId),
      payload: { learnerId: privacyLearnerId },
    });
    assert.equal(privacy.statusCode, 502);
    assert.deepEqual(privacy.json(), { error: "audio erasure service unavailable" });
    assert.equal(storageCalls.listLearner, 1, "privacy did not attempt its direct storage inventory");
    assert.equal(
      (await queryJson("SELECT count(*)::int AS count FROM users WHERE tenant_id = $1 AND id = $2", [TENANT, privacyLearnerId]))[0].count,
      1,
      "privacy timeout deleted the learner's database state",
    );
    assert.equal(
      (await queryJson("SELECT count(*)::int AS count FROM privacy_jobs WHERE tenant_id = $1 AND learner_id = $2", [TENANT, privacyLearnerId]))[0].count,
      0,
      "privacy timeout claimed a durable delete job",
    );

    const audio = await app.inject({
      method: "GET",
      url: `/v1/tajweed-findings/${fixture.finding}/audio`,
      headers: actorHeaders(fixture.reviewer.id, fixture.reviewer.role),
    });
    assert.equal(audio.statusCode, 502);
    assert.deepEqual(audio.json(), { error: "audio storage unavailable" });
    assert.equal(storageCalls.get, 1, "playback did not attempt its direct storage read");
    const [audit] = await queryJson(
      `SELECT metadata FROM audit_events
       WHERE tenant_id = $1 AND subject_id = $2 AND action = 'recitation.audio.read'
       ORDER BY created_at DESC LIMIT 1`,
      [TENANT, fixture.finding],
    );
    assert.equal(audit.metadata.outcome, "available", "eligibility changed during the storage fault");
    assert.equal(audit.metadata.delivery, "attempted");
    assert.notEqual(audit.metadata.delivery, "served", "partial audio was claimed served");
  } finally {
    await app?.close();
    await cleanupReviewFinding(fixture).catch(() => {});
    await queryJson("DELETE FROM privacy_jobs WHERE tenant_id = $1 AND learner_id = $2", [TENANT, privacyLearnerId]).catch(() => {});
    await queryJson("DELETE FROM users WHERE tenant_id = $1 AND id = $2", [TENANT, privacyLearnerId]).catch(() => {});
  }
});
