import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import { createFilesystemAudioObjectStore } from "../../server/src/storage/audio-object-store.mjs";

import { assertMatchesContract } from "./lib/contract.mjs";
import {
  DATABASE_URL,
  TENANT,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  uniqueSuffix,
} from "./lib/harness.mjs";

/**
 * C3 — the seven operations that had a parity test but NO validated response schema.
 * specs/contract-coverage-closure/plan.md §5
 *
 * The existing coverage for these asserts status codes and authorization; almost none of it asserts
 * a response SHAPE. So their schemas were written from responses observed against a running server,
 * and this file is what keeps observing them — otherwise the schema is a claim nothing rechecks,
 * and `scripts/validate-openapi-responses.mjs` only covers the 26 recorded fixture steps, none of
 * which touch these paths.
 *
 * Every test here asserted the SUCCESS path only, on the reasoning that "the failure paths already
 * have coverage elsewhere". That held for their STATUS CODES and never for their BODIES — and it
 * could not have been fixed here, because until the response-level `$ref` fix
 * (tests/contract/lib/openapi.mjs) no error response had a compiled validator to assert against.
 * The last test in this file is the failure-path shape coverage that gap was hiding.
 */

let api;
let ml;
let workerDb;
let workerLoop;
let workerRunning = false;
let audioObjectStore;
let audioStorageDir;
const ownedPrivacyLearners = new Set();

before(async () => {
  // Rust still exercises the compatibility erasure surface. Node's durable API is paired with a
  // separate worker below, so neither side can silently execute privacy work on the API loop.
  ml = await startMockUpstream(() => ({
    status: 200,
    body: { deletedAudioObjectKeys: [], deletedMetadataObjectKeys: [] },
  }));
  audioStorageDir = mkdtempSync(join(tmpdir(), "qrai-contract-shapes-audio-"));
  audioObjectStore = createFilesystemAudioObjectStore({ rootDir: audioStorageDir });
  workerDb = createDb(DATABASE_URL);
  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("privacy shape work must not align"),
    predictTajweed: async () => assert.fail("privacy shape work must not evaluate Tajweed"),
    transcribeSession: async () => assert.fail("privacy shape work must not transcribe"),
  });
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db: workerDb }),
    handlers: createWorkflowHandlers({
      db: workerDb,
      inference,
      audioObjectStore,
      upstreamTimeoutMs: 1_000,
    }),
    workerId: "contract-shapes-privacy-worker",
    leaseMs: 2_000,
    operationTimeoutMs: 1_500,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  workerRunning = true;
  workerLoop = (async () => {
    while (workerRunning) {
      const learners = [...ownedPrivacyLearners];
      if (learners.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const jobId = await workerDb.withTenant(TENANT, async (tx) => {
        const [row] = await tx`
          SELECT id
          FROM background_jobs
          WHERE tenant_id = ${TENANT}
            AND kind = 'privacy.delete'
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
  api = await startApi({
    env: { ML_INFERENCE_URL: ml.url, AUDIO_STORAGE_DIR: audioStorageDir },
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
  await api?.stop();
  await ml?.stop();
  await audioObjectStore?.close();
  if (audioStorageDir) rmSync(audioStorageDir, { recursive: true, force: true });
  if (workerFailure) throw workerFailure;
});

/**
 * A DRAFT session owned by learner-1.
 *
 * The `review_status = 'draft'` predicate is load-bearing, not a tidy-up. This helper used to take
 * whichever session was NEWEST for that learner, on the reasoning that choosing by owner kept
 * parallel suites from moving it — but any suite that creates a session for learner-1 moves
 * "newest", and one that advances a session past draft then hands this test a row that
 * `request-teacher-review` correctly refuses with a 400. That is exactly what happened when
 * `session-writes-parity` landed.
 *
 * The caller needs a session it can SEND for review. Saying so in the query makes the precondition
 * explicit instead of ambient, and the test stops depending on what else ran first.
 */
async function learnerSession() {
  const [session] = await queryJson(
    `SELECT id FROM recitation_sessions
     WHERE learner_id = 'learner-1' AND tenant_id = $1 AND review_status = 'draft'
     ORDER BY started_at DESC LIMIT 1`,
    ["hikmah-pilot-erbil"],
  );
  assert.ok(session, "a DRAFT recitation session owned by learner-1 is required");
  return session.id;
}

test("POST /v1/auth/register matches RegisterResult", async () => {
  const res = await request(api.baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: "hikmah-pilot-erbil",
      displayName: "Contract shape probe",
      role: "learner",
      language: "ar",
      email: `contract-${uniqueSuffix()}@example.test`,
      password: "contract-probe-password-12345",
    },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", "/v1/auth/register", res);
  // Registration hands back a usable token — a client that had to log in again afterwards would be
  // a different contract, and this is the assertion that would notice.
  assert.ok(res.body.token.length > 0);
  assert.equal(res.body.role, "learner");
});

test("GET /v1/recitation-sessions/{id}/alignments matches WordAlignment[]", async () => {
  // A session with ACTUAL alignments — an empty array satisfies any item schema, so seeding matters
  // here in a way it does not for the other reads.
  const [withRows] = await queryJson(
    "SELECT session_id, count(*)::int AS n FROM word_alignments GROUP BY session_id ORDER BY n DESC LIMIT 1",
  );
  assert.ok(withRows, "a session with persisted word alignments is required");

  const path = `/v1/recitation-sessions/${withRows.session_id}/alignments`;
  const res = await request(api.baseUrl, path, { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "this test is vacuous against an empty array");
  assertMatchesContract("GET", path, res);
});

test("POST /v1/recitation-sessions/{id}/alignments matches PersistAlignmentsResult", async () => {
  const sessionId = await learnerSession();
  const path = `/v1/recitation-sessions/${sessionId}/alignments`;
  const res = await request(api.baseUrl, path, {
    method: "POST",
    role: "learner",
    body: {
      alignments: [
        { wordId: "1:1:1", status: "matched", confidence: 0.9, startMs: 0, endMs: 100, heardText: "a", canonicalText: "b" },
        // Deliberately not a canonical word id — proves skippedUnknownWord is populated rather than
        // always zero, which a happy-path-only body would never show.
        { wordId: "extra-1", status: "matched", confidence: 0.5, startMs: 100, endMs: 200, heardText: "c", canonicalText: "d" },
      ],
    },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", path, res);
  assert.equal(res.body.persisted, 1);
  assert.equal(res.body.skippedUnknownWord, 1, "a non-canonical word id must be skipped and COUNTED");
});

test("POST /v1/recitation-sessions/{id}/request-teacher-review matches both of its shapes", async () => {
  // The response differs by branch: the first request carries auditEventId, a repeat carries
  // alreadyRequested. Both are exercised so the schema is checked against each, not just whichever
  // the seeded state happens to produce.
  const sessionId = await learnerSession();
  const path = `/v1/recitation-sessions/${sessionId}/request-teacher-review`;

  const first = await request(api.baseUrl, path, { method: "POST", role: "learner", body: {} });
  assert.equal(first.status, 200);
  assertMatchesContract("POST", path, first);

  const repeat = await request(api.baseUrl, path, { method: "POST", role: "learner", body: {} });
  assert.equal(repeat.status, 200);
  assertMatchesContract("POST", path, repeat);
  assert.equal(repeat.body.alreadyRequested, true, "a repeat must say so rather than re-requesting");
  assert.equal(repeat.body.reviewStatus, "teacher-review-required");
});

test("POST /v1/learner/progress matches ProgressUpdateResult", async () => {
  const res = await request(api.baseUrl, "/v1/learner/progress", {
    method: "POST",
    role: "learner",
    body: { quality: 4, ayahRef: "1:1" },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", "/v1/learner/progress", res);
  assert.ok(res.body.sm2State.intervalDays <= 3650, "the interval cap is what stops a chrono overflow panic");
});

test("POST /v1/learner/progress CLAMPS an out-of-range quality rather than failing", async () => {
  // The summary line in the contract claims this. Nothing asserted it, so it was documentation.
  const res = await request(api.baseUrl, "/v1/learner/progress", {
    method: "POST",
    role: "learner",
    body: { quality: 99, ayahRef: "1:2" },
  });
  assert.equal(res.status, 200, "an out-of-range quality is clamped, not a 500");
  assertMatchesContract("POST", "/v1/learner/progress", res);
  assert.ok(res.body.quality <= 5, `quality must be clamped into range, got ${res.body.quality}`);
});

test("GET /v1/agent-runs matches AgentRun[], including a run that HAS sources", async () => {
  // SEEDS its own sourced run rather than hoping one exists. The first version asserted that some
  // ambient row had sources — true on the machine this was written on, false on a fresh CI database,
  // and CI is where it failed. A test whose oracle depends on what other suites happened to leave
  // behind is not an oracle.
  const created = await request(api.baseUrl, "/v1/agent-runs", {
    method: "POST",
    role: "ops",
    body: {
      name: `contract-shape-${uniqueSuffix()}`,
      goal: "exercise the AgentRunSource item schema",
      status: "needs-human-review",
      confidence: 0.5,
      reviewStatus: "ai-suggested",
      sources: [{ id: "s1", title: "Tajweed rule", citation: "ref", url: null }],
    },
  });
  assert.equal(created.status, 200, `seeding a sourced agent run failed: ${created.text}`);

  const res = await request(api.baseUrl, "/v1/agent-runs", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "this test is vacuous against an empty array");
  assertMatchesContract("GET", "/v1/agent-runs", res);

  // `sources` is caller-supplied JSON the server returns verbatim (agent.rs:22), so the contract
  // constrains the ARRAY and not its elements. What is worth asserting is that a source round-trips
  // unchanged — that is the actual guarantee, and the thing a client depends on.
  const mine = res.body.find((run) => run.id === created.body.id);
  assert.ok(mine, "the run seeded above must appear in the listing");
  assert.deepEqual(
    mine.sources,
    [{ id: "s1", title: "Tajweed rule", citation: "ref", url: null }],
    "sources must round-trip verbatim — the server stores them as opaque JSON and normalises nothing",
  );
});

test("POST /v1/privacy/delete matches PrivacyJob", async () => {
  // Erases a learner created FOR this test, through the public registration path. Nothing seeded is
  // touched — a delete against a shared fixture learner would corrupt every other suite's data.
  const suffix = uniqueSuffix();
  const created = await request(api.baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: "hikmah-pilot-erbil",
      displayName: "Erasure shape probe",
      role: "learner",
      language: "ar",
      email: `erasure-${suffix}@example.test`,
      password: "contract-probe-password-12345",
    },
  });
  assert.equal(created.status, 200);
  ownedPrivacyLearners.add(created.body.userId);

  const res = await request(api.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: created.body.userId },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", "/v1/privacy/delete", res);
  assert.equal(res.body.kind, "delete");
  assert.equal(res.body.learnerId, created.body.userId);
});

test("GET /v1/recitation-sessions matches the contract, for a session the API created", async () => {
  // The reason this route needed a test at all. It was contracted as `RecitationSession[]` — a
  // schema REQUIRING `tenantId`, which the list does not send (a client parsing strictly, as the
  // Dart `_str` helpers do by design, would throw on every row); declaring `language` and
  // `externalProcessingAllowed`, which it does not send either; and omitting `confidence`,
  // `latencyMs` and `startedAt`, which it does send and the web teacher queue renders. Wrong in
  // both directions at once.
  //
  // It survived because the recorded fixture for this route is an EMPTY ARRAY, and an empty array
  // satisfies any `items` schema. scripts/validate-openapi-responses.mjs replayed it and passed
  // every time. An oracle that runs and checks nothing is the same failure as a test that cannot
  // fail, which is why the assertions below are all about finding a REAL row.
  //
  // A row this test creates through POST, not simply the first in the list. The shared database
  // holds 144
  // sessions with `quran_ref = '{}'`, written directly by the Rust integration suite's SQL — the
  // API refuses that body with 422 (measured), so no such row can be created through the endpoint
  // this contract describes. Validating the whole list would therefore fail on rows the service
  // could never produce, and the tempting fix — relaxing `QuranRef` until they pass — would weaken
  // a correct contract to accommodate a test fixture. That is an oracle adjusting itself to what it
  // measures.
  // CREATED THROUGH THE API, not selected from the table. `learnerSession()` picks an existing
  // draft row, and roughly one in twenty of those is a direct-SQL fixture with `quran_ref = '{}'` —
  // so this test failed on one, and the comment above claiming otherwise was simply wrong until the
  // gate caught it. A row that came through POST is the only one guaranteed to be a row the
  // endpoint can actually produce.
  const created = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    body: {
      learnerId: "learner-1",
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: `contract-list-${uniqueSuffix()}`,
      modelVersion: "model-v0.3",
      language: "ar",
      mode: "guided-recite",
      consent: {
        audioRetention: "discard",
        anonymizedLearning: false,
        externalAsrProcessing: false,
        guardianApproved: true,
        consentVersion: "v1",
      },
    },
  });
  assert.equal(created.status, 200, `could not create a session: ${JSON.stringify(created.body).slice(0, 200)}`);
  const sessionId = created.body.id;

  const res = await request(api.baseUrl, "/v1/recitation-sessions", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body) && res.body.length > 0, "this test is vacuous against an empty list");

  const row = res.body.find((s) => s.id === sessionId);
  assert.ok(row, "the session this test created was not in the list it just fetched");
  assertMatchesContract("GET", "/v1/recitation-sessions", { ...res, body: [row] });

  // `additionalProperties: false` means a field the server STARTS sending fails here rather than
  // being quietly absent from the contract every client codes against — which is how the three
  // missing fields stayed missing.
  assert.deepEqual(
    Object.keys(row).sort(),
    ["confidence", "id", "latencyMs", "learnerId", "mode", "quranRef", "reviewStatus", "startedAt"],
    "the list row shape changed; update RecitationSessionListEntry rather than this list",
  );
});

/**
 * The ERROR shapes — which, until the response-level `$ref` fix, no parity test COULD assert.
 *
 * Every error response in the contract is written `'403': { $ref: '#/components/responses/Forbidden' }`,
 * and `compileResponseValidators` walked straight past that form. So no validator existed for any of
 * them, and `assertMatchesContract` — which fails loudly on a missing validator rather than skipping —
 * would have rejected this test outright. The header above says "SUCCESS path only" and gave the
 * reason "the failure paths already have coverage elsewhere". That is true of their STATUS CODES and
 * was never true of their BODIES: nothing checked an error body's shape anywhere.
 *
 * Bodies matter here. `{ error: string }` with `additionalProperties: false` is what stops a handler
 * leaking a row, a backtrace, or an internal id into a message a rejected caller reads.
 */
test("403, 404 and 401 bodies match the contracted Error shape", async () => {
  const learnerLists = await request(api.baseUrl, "/v1/recitation-sessions", { role: "learner" });
  assert.equal(learnerLists.status, 403, "the role gate must still reject a learner listing all sessions");
  assertMatchesContract("GET", "/v1/recitation-sessions", learnerLists);

  const missing = "session-00000000-0000-4000-8000-000000000000";
  const notFound = await request(api.baseUrl, `/v1/recitation-sessions/${missing}`, { role: "admin" });
  assert.equal(notFound.status, 404);
  assertMatchesContract("GET", `/v1/recitation-sessions/${missing}`, notFound);

  const badLogin = await request(api.baseUrl, "/v1/auth/login", {
    method: "POST",
    // tenantId is REQUIRED by the handler; omitting it is a 422 body-rejection, not the 401 this
    // test is about. Same shape as the recorded fixture step "login with unknown email".
    body: {
      email: `nobody-${uniqueSuffix()}@example.invalid`,
      password: "not-a-real-password-12345",
      tenantId: "hikmah-pilot-erbil",
    },
  });
  assert.equal(badLogin.status, 401);
  assertMatchesContract("POST", "/v1/auth/login", badLogin);

  // Not merely "it validated": prove the schema is discriminating on these responses. An error body
  // is the one place a permissive schema is easiest to write and hardest to notice.
  for (const res of [learnerLists, notFound, badLogin]) {
    assert.equal(typeof res.body.error, "string", "the contracted field must be the one that is present");
    assert.deepEqual(Object.keys(res.body), ["error"], "additionalProperties: false — nothing else may ride along");
  }
});
