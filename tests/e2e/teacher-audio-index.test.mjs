import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { issueRealtimeTicket, newNonce } from "../../server/src/lib/ticket.mjs";
import { repairAudioIndex } from "../../server/scripts/repair-audio-index.mjs";
import { parseCompleteStoredMetadata } from "./lib/stored-metadata.mjs";
import {
  DATABASE_URL,
  ROLE_USER_IDS,
  TENANT,
  insertDeclaredTestAcousticFinding,
  queryJson,
  request,
  startApi,
} from "../api-parity/lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const GATEWAY_BIN = join(root, "services/realtime-gateway/target/debug/quran-ai-realtime-gateway");
const ML_ENTRY = join(root, "tests/inference/lib/worker-compatibility-harness.mjs");
const SECRET = "teacher-audio-index-e2e-secret-with-production-length";
const ML_KEY = "teacher-audio-index-e2e-ml-key";
const AUDIO_BYTES = new Uint8Array([81, 117, 114, 97, 110, 45, 97, 117, 100, 105, 111]);

let api;
let ml;
let healthyGateway;
let orphanGateway;
let rejectingIndex;
let storageDir;
let mlPort;
let healthyGatewayPort;
let orphanGatewayPort;
let stderr = "";
const seededFixtures = [];

/** @returns {Promise<number>} */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close(() => resolve(address.port));
    });
  });

async function waitForHealth(url, what) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The process has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${what} never became healthy at ${url}${stderr ? `\n${stderr}` : ""}`);
}

function startGateway(port, platformApiUrl, label) {
  const child = spawn(GATEWAY_BIN, [], {
    cwd: root,
    env: {
      ...process.env,
      REALTIME_GATEWAY_BIND: `127.0.0.1:${port}`,
      REALTIME_GATEWAY_TICKET_SECRET: SECRET,
      GATEWAY_TENANT_ID: TENANT,
      ML_INFERENCE_URL: `http://127.0.0.1:${mlPort}`,
      PLATFORM_API_URL: platformApiUrl,
      ML_API_KEY: ML_KEY,
      METRICS_DEV_OPEN: "1",
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
      GATEWAY_ALLOW_MISSING_ORIGIN: "1",
      DISABLE_RATE_LIMIT: "1",
      RUST_BACKTRACE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (data) => {
    stderr += `[${label}] ${data}`;
  });
  return child;
}

async function seedReviewableSession(prefix) {
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  const ids = {
    audit: `audit-${prefix}-${suffix}`,
    consent: `consent-${prefix}-${suffix}`,
    session: `session-${prefix}-${suffix}`,
    alignment: `alignment-${prefix}-${suffix}`,
    finding: `finding-${prefix}-${suffix}`,
  };
  seededFixtures.push(ids);
  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  const [word] = await queryJson("SELECT id FROM canonical_words WHERE ayah_id = '1:1' LIMIT 1");
  assert.ok(learner?.id && model?.id && word?.id, "the canonical DB fixture is incomplete");

  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     VALUES ($1, $2, $3, 'test.seed', 'test', $1, '{}'::jsonb)`,
    [ids.audit, TENANT, learner.id],
  );
  await queryJson(
    `INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
       external_asr_processing, guardian_approved, consent_version, audit_event_id)
     VALUES ($1, $2, $3, 'teacher-review', true, false, true, 'pilot-v1', $4)`,
    [ids.consent, TENANT, learner.id, ids.audit],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{}'::jsonb, 'fnv1a32:e2e', $4, 'guided-recite', 'e2e', false,
             0.0, 'draft', now(), 0, $5, '{}'::jsonb, $6, 'ar')`,
    [ids.session, TENANT, learner.id, model.id, ids.consent, ids.audit],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'fixture', 100, 300, 0.9, 'matched', $5, $6,
             'client-reported')`,
    [ids.alignment, TENANT, ids.session, word.id, model.id, ids.audit],
  );
  await insertDeclaredTestAcousticFinding({
    id: ids.finding,
    alignmentId: ids.alignment,
    rule: "ghunnah",
    severity: "practice",
    confidence: 0.9,
    auditEventId: ids.audit,
  });
  return { ...ids, learnerId: learner.id };
}

async function cleanupDatabaseFixtures() {
  if (seededFixtures.length === 0) return;
  const findings = seededFixtures.map((fixture) => fixture.finding);
  const alignments = seededFixtures.map((fixture) => fixture.alignment);
  const sessions = seededFixtures.map((fixture) => fixture.session);
  const consents = seededFixtures.map((fixture) => fixture.consent);
  const audits = seededFixtures.map((fixture) => fixture.audit);

  await queryJson("DELETE FROM teacher_reviews WHERE finding_id = ANY($1::text[])", [findings]);
  await queryJson(
    "DELETE FROM audit_events WHERE subject_type = 'tajweed_finding' AND subject_id = ANY($1::text[])",
    [findings],
  );
  await queryJson("DELETE FROM tajweed_findings WHERE id = ANY($1::text[])", [findings]);
  await queryJson("DELETE FROM audio_chunks WHERE session_id = ANY($1::text[])", [sessions]);
  await queryJson("DELETE FROM word_alignments WHERE id = ANY($1::text[])", [alignments]);
  await queryJson("DELETE FROM alignment_runs WHERE session_id = ANY($1::text[])", [sessions]);
  await queryJson("DELETE FROM realtime_session_tickets WHERE session_id = ANY($1::text[])", [
    sessions,
  ]);
  await queryJson("DELETE FROM recitation_sessions WHERE id = ANY($1::text[])", [sessions]);
  await queryJson("DELETE FROM consent_records WHERE id = ANY($1::text[])", [consents]);
  await queryJson("DELETE FROM audit_events WHERE id = ANY($1::text[])", [audits]);
}

function ticketFor(session) {
  return issueRealtimeTicket(
    {
      sessionId: session.session,
      tenantId: TENANT,
      learnerId: session.learnerId,
      externalAsrProcessing: false,
      audioRetention: "teacher-review",
      expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
      nonce: newNonce(),
    },
    SECRET,
  );
}

/**
 * @param {number} port
 * @param {any} session
 * @param {string} ticket
 * @returns {Promise<any>}
 */
function streamOneChunk(port, session, ticket) {
  return new Promise((resolve, reject) => {
    const url =
      `ws://127.0.0.1:${port}/v1/recitation-sessions/${encodeURIComponent(session.session)}/audio` +
      `?ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out streaming ${session.session}${stderr ? `\n${stderr}` : ""}`));
    }, 10_000);
    socket.addEventListener("open", () => socket.send(AUDIO_BYTES));
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      const ack = JSON.parse(String(event.data));
      socket.close();
      resolve(ack);
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`websocket failed: ${event instanceof ErrorEvent ? event.message : event.type}`));
    });
  });
}

async function waitForStoredChunk(session) {
  const dir = join(storageDir, "audio", "v1", TENANT, session.learnerId, session.session);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(dir)) {
      const metadata = readdirSync(dir).find(
        (name) => name.endsWith(".pcm.meta.json"),
      );
      if (metadata) {
        const parsed = parseCompleteStoredMetadata(
          readFileSync(join(dir, metadata), "utf8"),
        );
        if (parsed !== null) return parsed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`stored metadata never appeared for ${session.session}${stderr ? `\n${stderr}` : ""}`);
}

async function waitForIndex(chunkId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await queryJson("SELECT * FROM audio_chunks WHERE id = $1", [chunkId]);
    if ((rows.length > 0) === expected) return rows[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`audio index ${chunkId} did not become ${expected ? "present" : "absent"}`);
}

async function metric(port, name) {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(response.status, 200, `/metrics returned ${response.status}`);
  const body = await response.text();
  const match = new RegExp(`^${name} (\\d+)$`, "m").exec(body);
  assert.ok(match, `${name} is absent from metrics:\n${body}`);
  return Number(match[1]);
}


/**
 * @param {string[]} args
 * @returns {Promise<any>}
 */
function runRepairCommand(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "server/scripts/repair-audio-index.mjs"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_URL,
          AUDIO_STORAGE_DIR: storageDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let commandStderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      commandStderr += data;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`repair command exited ${code}: ${commandStderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`repair command returned invalid JSON: ${stdout}`));
      }
    });
  });
}

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL is required; this proof never skips its database assertions");
  assert.ok(existsSync(GATEWAY_BIN), `${GATEWAY_BIN} is missing; build the gateway first`);
  storageDir = mkdtempSync(join(tmpdir(), "qrai-teacher-audio-index-"));
  mlPort = await freePort();
  healthyGatewayPort = await freePort();
  orphanGatewayPort = await freePort();

  ml = spawn(process.execPath, [ML_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(mlPort),
      AUDIO_STORAGE_DIR: storageDir,
      ML_API_KEY: ML_KEY,
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr.on("data", (data) => {
    stderr += `[ml] ${data}`;
  });
  await waitForHealth(`http://127.0.0.1:${mlPort}/health`, "worker compatibility ingress");

  api = await startApi({
    env: {
      REALTIME_GATEWAY_TICKET_SECRET: SECRET,
      ML_INFERENCE_URL: `http://127.0.0.1:${mlPort}`,
      ML_API_KEY: ML_KEY,
    },
  });

  rejectingIndex = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"planned index outage"}');
  });
  await new Promise((resolve, reject) => {
    rejectingIndex.once("error", reject);
    rejectingIndex.listen(0, "127.0.0.1", resolve);
  });
  const rejectingPort = rejectingIndex.address().port;

  healthyGateway = startGateway(healthyGatewayPort, api.baseUrl, "gateway-healthy");
  orphanGateway = startGateway(
    orphanGatewayPort,
    `http://127.0.0.1:${rejectingPort}`,
    "gateway-orphan",
  );
  await Promise.all([
    waitForHealth(`http://127.0.0.1:${healthyGatewayPort}/health`, "healthy gateway"),
    waitForHealth(`http://127.0.0.1:${orphanGatewayPort}/health`, "orphan gateway"),
  ]);
});

after(async () => {
  try {
    await cleanupDatabaseFixtures();
  } finally {
    healthyGateway?.kill("SIGTERM");
    orphanGateway?.kill("SIGTERM");
    ml?.kill("SIGTERM");
    if (rejectingIndex) await new Promise((resolve) => rejectingIndex.close(resolve));
    if (api) await api.stop();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  }
});

test("real gateway storage becomes a durable index and audited teacher playback", async () => {
  const session = await seedReviewableSession("happy");
  const ack = await streamOneChunk(healthyGatewayPort, session, ticketFor(session));
  assert.equal(ack.accepted, true, JSON.stringify(ack));

  const metadata = await waitForStoredChunk(session);
  const row = await waitForIndex(metadata.chunkId, true);
  assert.equal(row.tenant_id, TENANT);
  assert.equal(row.session_id, session.session);
  assert.equal(row.object_key, metadata.objectKey);

  const playback = await request(api.baseUrl, `/v1/tajweed-findings/${session.finding}/audio`, {
    role: "teacher",
  });
  assert.equal(playback.status, 200, playback.text);
  const playbackBody = /** @type {any} */ (playback).body;
  assert.deepEqual(Buffer.from(playbackBody.audioBase64, "base64"), Buffer.from(AUDIO_BYTES));
  assert.equal(playbackBody.chunkId, metadata.chunkId);
  assert.ok(playbackBody.auditEventId, "teacher playback was not audited");
  assert.equal(
    await metric(healthyGatewayPort, "realtime_gateway_audio_index_enabled"),
    1,
  );
  assert.equal(
    await metric(healthyGatewayPort, "realtime_gateway_chunks_stored_unindexed_total"),
    0,
  );
});

test("an index outage is measurable and the command repairs it without a ticket", async () => {
  const session = await seedReviewableSession("repair");
  const ack = await streamOneChunk(orphanGatewayPort, session, ticketFor(session));
  assert.equal(ack.accepted, true, JSON.stringify(ack));
  const metadata = await waitForStoredChunk(session);
  await waitForIndex(metadata.chunkId, false);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      (await metric(orphanGatewayPort, "realtime_gateway_chunks_stored_unindexed_total")) > 0
    ) {
      break;
    }
    if (attempt === 99) assert.fail("the stored-unindexed metric never increased");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const dryRun = await runRepairCommand();
  assert.equal(dryRun.mode, "dry-run");
  assert.ok(dryRun.wouldRepair >= 1, JSON.stringify(dryRun));
  await waitForIndex(metadata.chunkId, false);

  const repaired = await runRepairCommand(["--apply"]);
  assert.equal(repaired.mode, "apply");
  assert.ok(repaired.repaired >= 1, JSON.stringify(repaired));
  await waitForIndex(metadata.chunkId, true);

  const playback = await request(api.baseUrl, `/v1/tajweed-findings/${session.finding}/audio`, {
    role: "teacher",
  });
  assert.equal(playback.status, 200, playback.text);
  const playbackBody = /** @type {any} */ (playback).body;
  assert.deepEqual(Buffer.from(playbackBody.audioBase64, "base64"), Buffer.from(AUDIO_BYTES));

  const second = await runRepairCommand(["--apply"]);
  assert.equal(second.repaired, 0, JSON.stringify(second));
  assert.ok(second.alreadyIndexed >= 2, JSON.stringify(second));
});

test("repair refuses path metadata that disagrees with database ownership", async () => {
  const session = await seedReviewableSession("owner");
  const forgedLearner = ROLE_USER_IDS.teacher;
  const chunkId = `${session.session}-forged-owner`;
  const dir = join(storageDir, TENANT, forgedLearner);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${chunkId}.bin`), AUDIO_BYTES);
  writeFileSync(
    join(dir, `${chunkId}.meta.json`),
    JSON.stringify({
      tenantId: TENANT,
      learnerId: forgedLearner,
      sessionId: session.session,
      chunkId,
      sampleRate: 16000,
      startMs: 0,
      endMs: 480,
      audioSize: AUDIO_BYTES.length,
      audioRetention: "teacher-review",
      objectKey: `${TENANT}/${forgedLearner}/${chunkId}.bin`,
    }),
  );

  const result = await repairAudioIndex({
    databaseUrl: DATABASE_URL,
    audioStorageDir: storageDir,
    apply: true,
  });
  assert.ok(result.refused >= 1, JSON.stringify(result));
  assert.ok(
    result.errors.some((error) => error.chunkId === chunkId && /learner ownership/.test(error.reason)),
    JSON.stringify(result),
  );
  await waitForIndex(chunkId, false);
});
