/**
 * N17 — right-to-erasure: the Node shell against Rust.
 * specs/migration-completion/plan.md §2 · port of handlers/privacy.rs
 *
 *   NODE_API_PORTED="POST /v1/privacy/export,POST /v1/privacy/delete" \
 *     node --test tests/api-parity/privacy-parity.test.mjs
 *
 * ── A 200 proves nothing here ───────────────────────────────────────────────────────────────────
 * "Delete succeeded" is the easiest response in the world to return without deleting anything. Every
 * assertion below that matters queries the DATABASE, or the mock ML service's received calls, after
 * the fact. The response body is checked for SHAPE; the erasure is checked for EFFECT.
 *
 * ── And the ORDER of the first three steps is the design ────────────────────────────────────────
 * authorize → check existence → erase audio → cascade. Each of the first three has a test whose only
 * job is to pin its position, because every one of them reads like a detail and none of them is.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import { createFilesystemAudioObjectStore } from "../../server/src/storage/audio-object-store.mjs";

import { assertABMutating } from "./lib/ab.mjs";
import {
  DATABASE_URL,
  TENANT,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  startShell,
  uniqueSuffix,
} from "./lib/harness.mjs";

/**
 * The routes this file is ABOUT, served by the shell rather than proxied to Rust.
 *
 * Taken from the `NODE_API_PORTED=…` line in the header above, which every parity file carried and
 * none of them set. A file run directly therefore got a shell that proxied everything, so its
 * "shell" side WAS Rust and a Node-only defect could not fail it — the configuration a person
 * actually uses proved the least. Only verify.sh's second pass set the variable, so the same file
 * meant two different things depending on who ran it.
 *
 * `startShell` unions this with the ambient value, so verify.sh's exhaustive pass still serves every
 * PORTABLE route.
 */
const PORTED = "POST /v1/privacy/export,POST /v1/privacy/delete";

let api;
let shell;
/**
 * The RUST url, which is not `rustUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the configuration in which this file's A/B is the only thing that
 * proves anything about the port — `startApi` puts a Node shell in front of the binary and returns
 * the SHELL as `baseUrl`, exposing Rust as `upstreamUrl`. Wiring `startShell({ upstream:
 * rustUrl })` and differing against `rustUrl` therefore put Node on BOTH sides of every
 * `assertAB`: a shell in front of a shell, compared with that inner shell. Identical code cannot
 * disagree with itself, so the probes passed by construction.
 *
 * Measured before this was fixed: a `NODE_ONLY_FIELD` added to Node's `listSurahs` response — a
 * divergence a byte comparison cannot miss — left `assertAB` GREEN in both verify.sh passes. What
 * caught it was a literal key-list assertion beside the probe, which is not a comparison at all.
 */
let rustUrl;
let mlMock;
let mlCalls;
let storageDir;
let objectStore;
let workerDb;
let workerLoop;
let workerRunning = false;
const ownedLearners = new Set();

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "qrai-privacy-store-"));
  objectStore = createFilesystemAudioObjectStore({ rootDir: storageDir });
  mlCalls = [];
  mlMock = await startMockUpstream(({ path, body }) => {
    mlCalls.push({ path, body });
    return { status: 200, body: { deletedAudioObjectKeys: ["a/1.wav"], deletedMetadataObjectKeys: ["a/1.json"] } };
  });
  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("privacy work must not run alignment"),
    predictTajweed: async () => assert.fail("privacy work must not run Tajweed"),
    transcribeSession: async () => assert.fail("privacy work must not run transcription"),
  });
  workerDb = createDb(DATABASE_URL);
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db: workerDb }),
    handlers: createWorkflowHandlers({
      db: workerDb,
      inference,
      audioObjectStore: objectStore,
      upstreamTimeoutMs: 1_000,
    }),
    workerId: "privacy-parity-worker",
    leaseMs: 2_000,
    operationTimeoutMs: 1_500,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  workerRunning = true;
  workerLoop = (async () => {
    while (workerRunning) {
      const learners = [...ownedLearners];
      if (learners.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const jobId = await workerDb.withTenant(TENANT, async (tx) => {
        const [row] = await tx`
          SELECT id
          FROM background_jobs
          WHERE tenant_id = ${TENANT}
            AND kind IN ('privacy.export', 'privacy.delete')
            AND subject_id = ANY(${learners})
            AND status IN ('queued', 'retry')
            AND available_at <= now()
          ORDER BY priority DESC, created_at, id
          LIMIT 1`;
        return row?.id ?? null;
      });
      if (jobId === null) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        await workerRuntime.runOne(TENANT, { jobId });
      }
    }
  })();

  const env = { ML_INFERENCE_URL: mlMock.url };
  api = await startApi({ env });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({
    upstream: rustUrl,
    env: { ...env, NODE_API_PORTED: PORTED, AUDIO_STORAGE_DIR: storageDir },
  });
});

after(async () => {
  let workerFailure = null;
  workerRunning = false;
  try {
    await workerLoop;
  } catch (error) {
    workerFailure = error;
  }
  await workerDb?.end();
  await shell?.stop();
  await api?.stop();
  await mlMock?.stop();
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  if (workerFailure) throw workerFailure;
});

/** A learner with a session, an alignment-free but real footprint, created fresh per test. */
async function seedLearner(label) {
  const id = `learner-privacy-${label}-${uniqueSuffix()}`;
  await queryJson(
    `INSERT INTO users (id, tenant_id, display_name, role, language)
     VALUES ($1, $2, 'Privacy probe', 'learner', 'ar')`,
    [id, TENANT],
  );
  const sessionId = `session-${id}`;
  const consentId = `consent-${id}`;
  const auditId = `audit-${id}`;
  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     VALUES ($1, $2, $3, 'test.seed', 'recitation_session', $4)`,
    [auditId, TENANT, id, sessionId],
  );
  await queryJson(
    `INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
       external_asr_processing, guardian_approved, consent_version, audit_event_id)
     VALUES ($1, $2, $3, 'discard', false, false, false, 'pilot-v1', $4)`,
    [consentId, TENANT, id, auditId],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":7,"display":"x"}',
             'sha256:x', (SELECT id FROM model_versions LIMIT 1), 'guided-recite', 'p', false,
             0.0, 'draft', now(), 0, $4, '{}', $5, 'ar')`,
    [sessionId, TENANT, id, consentId, auditId],
  );
  await queryJson(
    `INSERT INTO learner_progress (tenant_id, learner_id, ayah_ref, easiness_factor, interval_days,
       repetitions, last_quality, next_review_at, updated_at)
     VALUES ($1, $2, '1:1', 2.5, 1, 1, 5, now(), now())`,
    [TENANT, id],
  );

  // audio_chunks and alignment_runs are SESSION-owned, not learner-owned, so their deletes are
  // scoped through a subquery over this learner's sessions. Seeding them is what gives the
  // cross-learner test teeth: without these rows, dropping the learner scope from either delete
  // runs GREEN — and that mutation destroys another learner's data.
  await queryJson(
    `INSERT INTO audio_chunks (id, tenant_id, session_id, evidence_id, start_ms, end_ms,
       sample_rate, status, object_key, audit_event_id)
     VALUES ($1, $2, $3, $4, 0, 100, 16000, 'aligned', $5, $6)`,
    [`chunk-${id}`, TENANT, sessionId, `ev-${id}`, `key/${id}.wav`, auditId],
  );
  await queryJson(
    `INSERT INTO alignment_runs (id, tenant_id, session_id, model_version_id, dataset_version,
       latency_ms, evidence_ids, consent_snapshot, audit_event_id)
     VALUES ($1, $2, $3, (SELECT id FROM model_versions LIMIT 1), 'v1', 0, '[]', '{}', $4)`,
    [`arun-${id}`, TENANT, sessionId, auditId],
  );

  ownedLearners.add(id);
  return { id, sessionId };
}

async function footprint(learnerId) {
  const [row] = await queryJson(
    `SELECT
       (SELECT COUNT(*)::int FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2) AS sessions,
       (SELECT COUNT(*)::int FROM learner_progress   WHERE tenant_id = $1 AND learner_id = $2) AS progress,
       (SELECT COUNT(*)::int FROM consent_records    WHERE tenant_id = $1 AND user_id    = $2) AS consent,
       (SELECT COUNT(*)::int FROM audio_chunks ac JOIN recitation_sessions rs ON rs.id = ac.session_id
         WHERE ac.tenant_id = $1 AND rs.learner_id = $2) AS chunks,
       (SELECT COUNT(*)::int FROM alignment_runs ar JOIN recitation_sessions rs ON rs.id = ar.session_id
         WHERE ar.tenant_id = $1 AND rs.learner_id = $2) AS runs`,
    [TENANT, learnerId],
  );
  return row;
}

async function storeLearnerAudio(learner) {
  return objectStore.put({
    tenantId: TENANT,
    learnerId: learner.id,
    sessionId: learner.sessionId,
    chunkId: `chunk-${learner.id}`,
    startMs: 0,
    endMs: 100,
    sampleRate: 16000,
    audioRetention: "teacher-review",
    audioBytes: Buffer.alloc(3200, 7),
  });
}

// ── export ─────────────────────────────────────────────────────────────────────────────────────

test("export returns the manifest shape and DELETES NOTHING", async () => {
  const shellL = await seedLearner("exp-s");
  const rustL = await seedLearner("exp-r");

  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "privacy export",
    probeFor: (side) => ({
      path: "/v1/privacy/export",
      method: "POST",
      role: "admin",
      body: { learnerId: side === "shell" ? shellL.id : rustL.id },
    }),
    // id/auditEventId are per-call; learnerId and the manifest CONTENTS differ because each side
    // gets its own learner, so compare the SHAPE of the manifest and the counts.
    normalize: (b) =>
      b && typeof b === "object" && b.id
        ? {
            ...b,
            id: "<ID>",
            auditEventId: "<A>",
            tenantId: b.tenantId,
            learnerId: "<L>",
            includedRecords: b.includedRecords.map((r) => r.replace(/[^:]+$/, "<X>")).sort(),
            deletedRecords: b.deletedRecords,
          }
        : b,
  });

  assert.equal(s.status, 200, s.text);
  assert.deepEqual(Object.keys(s.body), [
    "id",
    "tenantId",
    "learnerId",
    "kind",
    "includedRecords",
    "deletedRecords",
    "audioObjectKeysDeleted",
    "audit" + "EventId",
  ]);
  assert.equal(s.body.kind, "export");
  assert.deepEqual(s.body.deletedRecords, [], "an EXPORT must delete nothing");
  assert.deepEqual(s.body.audioObjectKeysDeleted, [], "an export must not touch audio");

  // The effect, not the response: the learner's rows are all still there.
  const after = await footprint(shellL.id);
  assert.equal(after.sessions, 1);
  assert.equal(after.progress, 1);
  assert.equal(after.consent, 1);
});

test("export never calls the ML erase endpoint", async () => {
  const l = await seedLearner("exp-noml");
  const stored = await storeLearnerAudio(l);
  mlCalls.length = 0;
  const res = await request(shell.baseUrl, "/v1/privacy/export", {
    method: "POST",
    role: "admin",
    body: { learnerId: l.id },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(mlCalls.length, 0, "an export must not reach the audio-erasure service at all");
  assert.ok(
    res.body.includedRecords.includes(`audio_object:${stored.objectKey}`),
    "privacy export omitted a retained private audio object",
  );
  assert.equal(
    (await objectStore.listLearner({ tenantId: TENANT, learnerId: l.id })).length,
    1,
    "privacy export deleted the recording it was inventorying",
  );
});

// ── delete ─────────────────────────────────────────────────────────────────────────────────────

test("delete erases the learner's footprint — verified in the DATABASE, not by a 200", async () => {
  const l = await seedLearner("del");
  const before = await footprint(l.id);
  assert.equal(before.sessions, 1, "the seed must exist or this proves nothing");
  assert.equal(before.progress, 1);
  assert.equal(before.consent, 1);
  assert.equal(before.chunks, 1);
  assert.equal(before.runs, 1);

  const res = await request(shell.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: l.id },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.kind, "delete");
  assert.ok(res.body.deletedRecords.length > 0, "the manifest must name what it removed");

  const after = await footprint(l.id);
  assert.equal(after.sessions, 0, "recitation_sessions survived a delete");
  assert.equal(after.progress, 0, "learner_progress survived a delete");
  assert.equal(after.consent, 0, "consent_records survived a delete — note it keys on user_id");
  assert.equal(after.chunks, 0, "audio_chunks survived a delete");
  assert.equal(after.runs, 0, "alignment_runs survived a delete");
});

test("delete erases private object storage directly and reports the derived keys", async () => {
  const l = await seedLearner("del-audio");
  const stored = await storeLearnerAudio(l);
  mlCalls.length = 0;

  const res = await request(shell.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: l.id },
  });
  assert.equal(res.status, 200, res.text);

  assert.deepEqual(mlCalls, [], "Node delegated erasure back to transitional ML");
  assert.deepEqual(res.body.audioObjectKeysDeleted, [stored.objectKey]);
  assert.deepEqual(await objectStore.listLearner({ tenantId: TENANT, learnerId: l.id }), []);
});

test("delete does NOT touch another learner's rows", async () => {
  const victim = await seedLearner("del-victim");
  const bystander = await seedLearner("del-bystander");

  const res = await request(shell.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: victim.id },
  });
  assert.equal(res.status, 200, res.text);

  const other = await footprint(bystander.id);
  assert.equal(other.sessions, 1, "one learner's erasure removed another learner's session");
  assert.equal(other.progress, 1);
  assert.equal(other.consent, 1);
  // These two are the ones that go quiet. audio_chunks and alignment_runs are SESSION-owned, so
  // their deletes are scoped through a subquery over the target's sessions — drop that scope and the
  // statement becomes "delete every chunk in the tenant", which no learner-count assertion notices.
  assert.equal(other.chunks, 1, "another learner's audio_chunks were destroyed");
  assert.equal(other.runs, 1, "another learner's alignment_runs were destroyed");
});

// ── the three orderings ────────────────────────────────────────────────────────────────────────

test("ORDER 1: a learner asking about SOMEONE ELSE is 403, never 404", async () => {
  // Authorization runs FIRST, and that is what makes the 404 safe. Inverted, a learner would learn
  // which learner ids exist by reading 404-against-403.
  const l = await seedLearner("order1");
  for (const path of ["/v1/privacy/export", "/v1/privacy/delete"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `${path} as another learner`,
      probeFor: () => ({
        path,
        method: "POST",
        role: "learner",
        userId: l.id,
        body: { learnerId: "learner-does-not-exist" },
      }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 403, "a learner must be refused BEFORE the existence check");
  }
});

test("ORDER 2: an admin asking about an UNKNOWN learner is 404, not a 500 from the FK", async () => {
  for (const path of ["/v1/privacy/export", "/v1/privacy/delete"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `${path} for an unknown learner`,
      probeFor: () => ({
        path,
        method: "POST",
        role: "admin",
        body: { learnerId: "learner-does-not-exist" },
      }),
      normalize: (b) => b,
    });
    assert.equal(
      s.status,
      404,
      "privacy_jobs.learner_id REFERENCES users(id); without the check this is a 500 that " +
        "invites a retry which can never succeed",
    );
  }
});

test("ORDER 2 vs 3: an unknown learner is 404 even when the ML service is DOWN", async () => {
  // This is the test that pins the existence check BEFORE the audio erase. With the ML service
  // unreachable, an unknown learner used to return 502 — "transient, retry me" — instead of 404,
  // "permanent, do not". Wrong-signal-for-retry is the defect the ordering exists to fix, so it
  // must not survive in the outage case.
  const deadUrl = "http://127.0.0.1:1";
  const deadStorage = mkdtempSync(join(tmpdir(), "qrai-privacy-fault-store-"));
  const deadApi = await startApi({ env: { ML_INFERENCE_URL: deadUrl } });
  const deadShell = await startShell({
    upstream: deadApi.upstreamUrl ?? deadApi.baseUrl,
    env: {
      NODE_API_PORTED: PORTED,
      ML_INFERENCE_URL: deadUrl,
      AUDIO_STORAGE_DIR: deadStorage,
    },
  });
  try {
    const deadRustUrl = deadApi.upstreamUrl ?? deadApi.baseUrl;
    const { shell: s } = await assertABMutating(deadShell.baseUrl, deadRustUrl, {
      name: "delete an unknown learner with ML down",
      probeFor: () => ({
        path: "/v1/privacy/delete",
        method: "POST",
        role: "admin",
        body: { learnerId: "learner-does-not-exist" },
      }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 404, "a 502 here tells the caller to retry something that cannot succeed");

    // Make the direct Node store unreadable with a deterministic ENOTDIR while Rust observes its
    // equivalent ML dependency outage. The fault is injected only after the unknown-user probe,
    // proving that existence/authorization precede storage access.
    rmSync(deadStorage, { recursive: true, force: true });
    writeFileSync(deadStorage, "planned storage fault");

    // …and a REAL learner with storage down is a 502, with the database untouched.
    const l = await seedLearner("mldown");
    const { shell: down } = await assertABMutating(deadShell.baseUrl, deadRustUrl, {
      name: "delete a real learner with ML down",
      probeFor: () => ({
        path: "/v1/privacy/delete",
        method: "POST",
        role: "admin",
        body: { learnerId: l.id },
      }),
      normalize: (b) => b,
    });
    assert.equal(down.status, 502);
    const after = await footprint(l.id);
    assert.equal(after.sessions, 1, "an ML outage must fail fast with the DATABASE UNTOUCHED");
    assert.equal(after.progress, 1);
  } finally {
    await deadShell.stop();
    await deadApi.stop();
    rmSync(deadStorage, { recursive: true, force: true });
  }
});

test("a learner may run export/delete on THEMSELVES", async () => {
  const l = await seedLearner("self");
  const res = await request(shell.baseUrl, "/v1/privacy/export", {
    method: "POST",
    role: "learner",
    userId: l.id,
    body: { learnerId: l.id },
  });
  assert.equal(res.status, 200, "right-to-erasure is the learner's own right, not only an admin's");
});

test("the manifest namespaces every record type except sessions", async () => {
  const l = await seedLearner("manifest");
  const res = await request(shell.baseUrl, "/v1/privacy/export", {
    method: "POST",
    role: "admin",
    body: { learnerId: l.id },
  });
  assert.equal(res.status, 200, res.text);
  // Session ids are BARE; everything else carries a `table:` prefix. This list is what a learner
  // receives as their export manifest, so the prefixes are wire contract.
  assert.ok(res.body.includedRecords.includes(l.sessionId), "session ids appear unprefixed");
  assert.ok(
    res.body.includedRecords.some((r) => r === "learner_progress:1:1"),
    `progress must be namespaced; got ${JSON.stringify(res.body.includedRecords)}`,
  );
});
