import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";

import {
  DATABASE_URL,
  OTHER_TENANT,
  RLS_PROBE_ROLE,
  TENANT,
  insertDeclaredTestAcousticFinding,
  purgeSessionsByChecksum,
  queryJson,
  request,
  startApi,
  uniqueSuffix,
  withDb,
} from "./lib/harness.mjs";

// Run-scoped session checksums, so the teardown at the end of this file deletes exactly this run's
// rows and nothing else. These suites created sessions and never removed them: measured, the shared
// staging database had accumulated 64,869 recitation sessions across ~8 fixed checksums, growing by
// thousands a day. Leaked rows already broke a review-parity assertion and a Rust integration test
// once in this program (`seedQueued`), and an unbounded corpus is what makes ORDER BY without a
// unique tiebreaker, row-count deltas, and other suites' bulk teardown intermittently fail.
// Per-run rather than a shared literal: two agents run this gate against the same Postgres.
const RUN_CK_PRIVACY = `fnv1a32:privacy-scope-${uniqueSuffix()}`;
const RUN_CK_CONSENT = `fnv1a32:consent-gate-${uniqueSuffix()}`;


/**
 * PAR2 — the 18 incident-class tests that run under the default server configuration.
 * specs/api-parity-suite/plan.md §4
 *
 * Every test names the Rust original it was transcribed from as `integration.rs:<line>`, so a
 * reviewer can diff the assertion against the source instead of trusting the transcription. A
 * transcription that quietly weakens an assertion passes forever and protects nothing — which is
 * what PAR4's teeth check exists to catch, and why these comments are not decoration.
 */

let api;
let workerDb;
let workerLoop;
let workerRunning = false;
const privacyExportLearners = new Set();
before(async () => {
  workerDb = createDb(DATABASE_URL);
  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("privacy export must not align"),
    predictTajweed: async () => assert.fail("privacy export must not evaluate Tajweed"),
    transcribeSession: async () => assert.fail("privacy export must not transcribe"),
  });
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db: workerDb }),
    handlers: createWorkflowHandlers({
      db: workerDb,
      inference,
      upstreamTimeoutMs: 1_000,
    }),
    workerId: "default-parity-privacy-export-worker",
    leaseMs: 2_000,
    operationTimeoutMs: 1_500,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  workerRunning = true;
  workerLoop = (async () => {
    while (workerRunning) {
      const learners = [...privacyExportLearners];
      if (learners.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const jobId = await workerDb.withTenant(TENANT, async (tx) => {
        const [row] = await tx`
          SELECT id
          FROM background_jobs
          WHERE tenant_id = ${TENANT}
            AND kind = 'privacy.export'
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
  api = await startApi();
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
  if (workerFailure) throw workerFailure;
});

const seedLearner = async (id, tenant = TENANT) => {
  await queryJson(
    `INSERT INTO users (id, tenant_id, display_name, role, language)
     VALUES ($1, $2, 'Parity Learner', 'learner', 'ckb')`,
    [id, tenant],
  );
  return id;
};

const FATIHAH_REF = {
  surahNumber: 1,
  ayahStart: 1,
  ayahEnd: 7,
  display: "Al-Fatihah 1:1-7",
};

const DISCARD_CONSENT = {
  audioRetention: "discard",
  anonymizedLearning: true,
  externalAsrProcessing: false,
  guardianApproved: true,
  consentVersion: "pilot-v1",
};

const PILOT_ORIGIN = "https://pilot.example";

/** integration.rs:1769 — create_test_session_for_learner */
const createSession = async (learnerId) => {
  const created = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "admin",
    body: {
      learnerId,
      quranRef: FATIHAH_REF,
      sourceChecksum: RUN_CK_PRIVACY,

      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: DISCARD_CONSENT,
    },
  });
  assert.equal(created.status, 200, `session setup failed: ${JSON.stringify(created.body)}`);
  return created.body.id;
};

/**
 * integration.rs:1795 — seed_reviewed_finding. Each row needs its own audit_event first (FK), so
 * this is one statement per table rather than one big insert.
 */
const seedReviewedFinding = async (sessionId, label) => {
  const s = uniqueSuffix();
  const ids = {
    alignment: `wa-parity-${label}-${s}`,
    finding: `tf-parity-${label}-${s}`,
    review: `review-parity-${label}-${s}`,
    alignmentAudit: `audit-wa-parity-${label}-${s}`,
    findingAudit: `audit-tf-parity-${label}-${s}`,
    reviewAudit: `audit-review-parity-${label}-${s}`,
  };

  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     VALUES ($1, $7, 'ops-1', 'test.seed', 'word_alignment', $2),
            ($3, $7, 'ops-1', 'test.seed', 'tajweed_finding', $4),
            ($5, $7, 'teacher-1', 'test.seed', 'teacher_review', $6)`,
    [
      ids.alignmentAudit,
      ids.alignment,
      ids.findingAudit,
      ids.finding,
      ids.reviewAudit,
      ids.review,
      TENANT,
    ],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id)
     VALUES ($1, $4, $2, '1:1:1', 'بسم', 0, 100, 0.9, 'matched', 'model-v0.3', $3)`,
    [ids.alignment, sessionId, ids.alignmentAudit, TENANT],
  );
  await insertDeclaredTestAcousticFinding({
    id: ids.finding,
    alignmentId: ids.alignment,
    confidence: 0.8,
    reviewStatus: "teacher-review-required",
    auditEventId: ids.findingAudit,
  });
  await queryJson(
    `INSERT INTO teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id)
     VALUES ($1, $4, $2, 'teacher-1', 'accepted', 'parity suite seed', $3)`,
    [ids.review, ids.finding, ids.reviewAudit, TENANT],
  );
  return ids;
};

/** integration.rs:3458 — extract the raw __Host-qrai-pilot token from Set-Cookie. */
const pilotCookieFrom = (res) => {
  for (const raw of res.headers.getSetCookie()) {
    const value = raw.startsWith("__Host-qrai-pilot=")
      ? raw.slice("__Host-qrai-pilot=".length).split(";")[0]
      : "";
    if (value) return value;
  }
  return null;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Tenant isolation — 6
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:3097 — adversarial_sql_isolation_prevents_cross_tenant_access
test("hostile SQL under another tenant's context reads nothing and cannot insert", async () => {
  // tenant: null — this test supplies its OWN hostile context; the harness default would mask it.
  await withDb(async (client) => {
    // Session-level, matching the Rust pool's after_connect. The original's comment records why:
    // a `SET LOCAL` layered on a pool already pinned to the victim tenant FAILED OPEN in CI.
    await client.query("SET app.tenant_id = 'tenant-b'");
    await client.query("BEGIN");
    // CI's DATABASE_URL is a superuser, and superusers bypass RLS unconditionally — without this
    // the test could never fail, whatever the policies said.
    await client.query(`SET LOCAL ROLE ${RLS_PROBE_ROLE}`);

    const [{ ctx }] = (
      await client.query("SELECT current_setting('app.tenant_id', true) AS ctx")
    ).rows;
    assert.equal(ctx, "tenant-b", "hostile tenant context must be active before the RLS probes");

    const [{ count }] = (
      await client.query("SELECT count(*)::int AS count FROM users WHERE tenant_id = $1", [TENANT])
    ).rows;
    assert.equal(count, 0, "hostile SQL read must return 0 rows for another tenant");

    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO users (id, tenant_id, display_name, role, language)
           VALUES ('adversarial-user', $1, 'Adversarial', 'learner', 'ckb')`,
          [TENANT],
        ),
      (err) => {
        assert.equal(err.code, "42501", `expected an RLS violation, got ${err.code}: ${err.message}`);
        return true;
      },
    );
    await client.query("ROLLBACK");
  }, { tenant: null });
});

// integration.rs:3902 — rls_backstops_a_query_that_forgets_its_tenant_context (MIG2a)
test("RLS backstops a query that forgets its tenant context entirely", async () => {
  // tenant: null is the ENTIRE point here — the test asserts the context is unset.
  // The failure mode a Node port introduces: a stray query outside begin_tenant_tx. Nothing in the
  // application exercises this, because every handler sets its context correctly.
  await withDb(async (client) => {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${RLS_PROBE_ROLE}`);

    const [{ ctx }] = (
      await client.query("SELECT current_setting('app.tenant_id', true) AS ctx")
    ).rows;
    assert.ok(
      !ctx,
      `tenant context must be UNSET for this test to mean anything, got ${JSON.stringify(ctx)}`,
    );

    const [{ count: unscoped }] = (
      await client.query("SELECT count(*)::int AS count FROM users")
    ).rows;
    assert.equal(
      unscoped,
      0,
      "RLS must fail CLOSED with no tenant context; rows here mean a forgotten scope leaks tenants",
    );

    // The rejection aborts the surrounding transaction (Postgres 25P02), which would make the
    // control query below unrunnable and turn the whole test into a false negative.
    await client.query("SAVEPOINT unscoped_insert_probe");
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO users (id, tenant_id, display_name, role, language)
           VALUES ('parity-unscoped-user', $1, 'Unscoped', 'learner', 'ckb')`,
          [TENANT],
        ),
      (err) => {
        assert.equal(err.code, "42501", `expected an RLS violation, got ${err.code}`);
        return true;
      },
    );
    await client.query("ROLLBACK TO SAVEPOINT unscoped_insert_probe");

    // Control: with the context set, the same read sees rows. Without it, the zero above could
    // just mean the table was empty and the test would prove nothing.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
    const [{ count: scoped }] = (
      await client.query("SELECT count(*)::int AS count FROM users")
    ).rows;
    assert.ok(scoped > 0, "control failed: the seeded tenant must have users");

    await client.query("ROLLBACK");
  }, { tenant: null });
});

// integration.rs:3177 — adversarial_api_isolation_prevents_cross_tenant_read
test("a foreign tenant cannot READ this tenant's learner progress", async () => {
  const learnerId = await seedLearner(`learner-a-${uniqueSuffix()}`);
  const res = await request(api.baseUrl, `/v1/learner/progress?learnerId=${learnerId}`, {
    role: "learner",
    tenant: "other-tenant",
  });
  assert.equal(res.status, 403);
});

// integration.rs:3209 — adversarial_api_isolation_prevents_cross_tenant_write
test("a foreign tenant cannot WRITE a session for this tenant's learner", async () => {
  const learnerId = await seedLearner(`learner-a-${uniqueSuffix()}`);
  const res = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    tenant: "other-tenant",
    body: {
      learnerId,
      quranRef: FATIHAH_REF,
      sourceChecksum: "fnv1a32:adversarial-write",

      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: DISCARD_CONSENT,
    },
  });
  assert.equal(res.status, 403);
});

// integration.rs:3250 — adversarial_api_isolation_prevents_cross_tenant_delete
test("a foreign tenant cannot DELETE this tenant's learner through the privacy path", async () => {
  const learnerId = await seedLearner(`learner-a-${uniqueSuffix()}`);
  const res = await request(api.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "learner",
    tenant: "other-tenant",
    body: { learnerId, kind: "delete" },
  });
  assert.equal(res.status, 403);

  // Not in the Rust original: prove the row SURVIVED. A 403 alone would still pass if the handler
  // deleted first and refused afterwards.
  const rows = await queryJson("SELECT id FROM users WHERE id = $1", [learnerId]);
  assert.equal(rows.length, 1, "the learner must still exist after a refused cross-tenant delete");
});

// integration.rs:2095 — teacher_of_another_tenant_cannot_read_this_tenants_sessions_findings_or_alignments
test("a teacher of another tenant reads none of this tenant's session, alignments, or findings", async () => {
  const suffix = uniqueSuffix();
  const learnerId = await seedLearner(`learner-xtenant-${suffix}`);
  const sessionId = await createSession(learnerId);
  await seedReviewedFinding(sessionId, `xtenant-${suffix}`);

  // A real, separate institution — institutions is not RLS-scoped.
  const tenantB = `tenant-b-teacher-probe-${suffix}`;
  await queryJson(
    `INSERT INTO institutions (id, name, region) VALUES ($1, 'Rival Madrasa', 'test')
     ON CONFLICT (id) DO NOTHING`,
    [tenantB],
  );

  // CONTROL first. Without it, every assertion below would also pass if the endpoints simply
  // returned nothing for everybody.
  const own = await request(api.baseUrl, `/v1/recitation-sessions/${sessionId}`, { role: "teacher" });
  assert.equal(own.status, 200, "control: in-tenant teacher reads the session");

  const ownAlignments = await request(
    api.baseUrl,
    `/v1/recitation-sessions/${sessionId}/alignments`,
    { role: "teacher" },
  );
  assert.equal(ownAlignments.status, 200);
  assert.ok(
    ownAlignments.body.length > 0,
    "control: the session HAS alignments in its own tenant, so 'empty for tenant B' means something",
  );

  const ownFindings = await request(api.baseUrl, "/v1/tajweed-findings", { role: "teacher" });
  assert.equal(ownFindings.status, 200);
  assert.ok(ownFindings.body.length > 0, "control: findings endpoint returns data for its own tenant");

  // The isolation checks: a TEACHER of tenant B, who passes every role gate.
  const stolenSession = await request(api.baseUrl, `/v1/recitation-sessions/${sessionId}`, {
    role: "teacher",
    tenant: tenantB,
  });
  assert.equal(stolenSession.status, 404, "a teacher of another tenant must not read this session");

  // Alignments answer 200 with an EMPTY list rather than 404 — the query filters on the ACTOR's
  // tenant, so tenant B matches no rows. What matters is that none of it crosses the boundary.
  const stolenAlignments = await request(
    api.baseUrl,
    `/v1/recitation-sessions/${sessionId}/alignments`,
    { role: "teacher", tenant: tenantB },
  );
  assert.equal(stolenAlignments.status, 200);
  assert.deepEqual(stolenAlignments.body, [], "the learner's recitation leaked to another tenant");

  const stolenFindings = await request(api.baseUrl, "/v1/tajweed-findings", {
    role: "teacher",
    tenant: tenantB,
  });
  assert.equal(stolenFindings.status, 200);
  assert.deepEqual(stolenFindings.body, [], "findings leaked into another tenant's teacher queue");

  const stolenSessionFindings = await request(
    api.baseUrl,
    `/v1/recitation-sessions/${sessionId}/tajweed-findings`,
    { role: "teacher", tenant: tenantB },
  );
  assert.equal(
    stolenSessionFindings.status,
    404,
    "another tenant must not learn whether this session has learner-performance findings",
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Auth / identity — 3 (the 4th, header-auth-off, needs its own server: auth-disabled.test.mjs)
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:389 — register_cannot_create_elevated_user_in_another_tenant
test("an admin cannot register an elevated user into another tenant", async () => {
  // The victim tenant must EXIST, or a 404 for "no such tenant" would mask the 403 being proven.
  const victimTenant = `tenant-cross-register-victim-${uniqueSuffix()}`;
  await queryJson(
    `INSERT INTO institutions (id, name, region) VALUES ($1, 'Victim Tenant', 'test')
     ON CONFLICT (id) DO NOTHING`,
    [victimTenant],
  );

  const cross = await request(api.baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: victimTenant,
      displayName: "Injected Admin",
      role: "admin",
      language: "en",
      password: "AttackerSet1234",
    },
  });
  assert.equal(cross.status, 403, "an admin must not create an elevated user in another tenant");

  const leaked = await queryJson(
    "SELECT count(*)::int AS count FROM users WHERE tenant_id = $1 AND role = 'admin'",
    [victimTenant],
  );
  assert.equal(leaked[0].count, 0, "no admin leaked into the victim tenant");

  // Regression: the legitimate same-tenant path still works. A blanket denial would also pass the
  // assertion above while breaking the feature.
  const sameTenant = await request(api.baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: TENANT,
      displayName: "Legit Teacher",
      role: "teacher",
      language: "ckb",
      password: "LegitTeach1234",
    },
  });
  assert.equal(sameTenant.status, 200, "an admin must still create an elevated user in their own tenant");
});

// integration.rs:682 — learner_progress_learner_id_is_authorized
test("staff may read any in-tenant learner's progress; a learner may read only their own", async () => {
  const ops = await request(api.baseUrl, "/v1/learner/progress?learnerId=learner-1", { role: "ops" });
  assert.equal(ops.status, 200);
  assert.equal(ops.body.learnerId, "learner-1");

  // x-user-id is learner-1, asking for learner-2.
  const cross = await request(api.baseUrl, "/v1/learner/progress?learnerId=learner-2", {
    role: "learner",
  });
  assert.equal(cross.status, 403);
});

// integration.rs:3693 — pilot_cookie_mutation_requires_origin_and_csrf
test("a pilot cookie mutation requires BOTH a valid Origin and a matching CSRF token", async () => {
  const mint = await request(api.baseUrl, "/v1/pilot/invitations", {
    method: "POST",
    role: "admin",
    body: { learnerId: "learner-1" },
  });
  assert.equal(mint.status, 200, "admin should mint an invitation");

  const boot = await request(api.baseUrl, "/v1/pilot/session/bootstrap", {
    method: "POST",
    tenant: null,
    headers: { origin: PILOT_ORIGIN },
    body: { token: mint.body.token },
  });
  const cookie = pilotCookieFrom(boot);
  assert.ok(cookie, "bootstrap must set the __Host-qrai-pilot cookie");
  const csrf = boot.body.csrfToken;
  const cookieHeader = `__Host-qrai-pilot=${cookie}`;
  const body = { quality: 5, ayahRef: "1:1" };

  const mutate = (headers) =>
    request(api.baseUrl, "/v1/learner/progress", { method: "POST", tenant: null, headers, body });

  // (a) valid Origin, NO csrf -> 401
  const noCsrf = await mutate({ origin: PILOT_ORIGIN, cookie: cookieHeader });
  assert.equal(noCsrf.status, 401, "mutation without CSRF is rejected");

  // (b) valid Origin, WRONG csrf -> 401
  const badCsrf = await mutate({
    origin: PILOT_ORIGIN,
    cookie: cookieHeader,
    "x-csrf-token": "not-the-real-token",
  });
  assert.equal(badCsrf.status, 401, "mutation with wrong CSRF is rejected");

  // (c) correct csrf, NO Origin -> 403
  const noOrigin = await mutate({ cookie: cookieHeader, "x-csrf-token": csrf });
  assert.equal(noOrigin.status, 403, "mutation without Origin is rejected");

  // (d) both correct -> accepted. Without this the three refusals above would also pass if the
  // endpoint were simply broken.
  const ok = await mutate({ origin: PILOT_ORIGIN, cookie: cookieHeader, "x-csrf-token": csrf });
  assert.equal(ok.status, 200, "correct Origin + CSRF must be accepted");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Ownership gates — 2 (the 3rd needs a mock ML upstream: ml-proxy.test.mjs)
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:1107 — request_teacher_review_flips_own_draft_session_and_is_owner_gated
test("only the session owner may request teacher review, and the flip is real", async () => {
  const learnerId = await seedLearner(`learner-send-review-${uniqueSuffix()}`);
  const sessionId = await createSession(learnerId);
  const path = `/v1/recitation-sessions/${sessionId}/request-teacher-review`;

  // A DIFFERENT learner (learner-1) may not send someone else's session.
  const denied = await request(api.baseUrl, path, { method: "POST", role: "learner", body: {} });
  assert.equal(denied.status, 403);

  const asOwner = () =>
    request(api.baseUrl, path, { method: "POST", role: "learner", userId: learnerId, body: {} });

  const sent = await asOwner();
  assert.equal(sent.status, 200);
  assert.equal(sent.body.reviewStatus, "teacher-review-required");

  // Idempotent: sending again is a 200 no-op flagged as already requested.
  const resent = await asOwner();
  assert.equal(resent.status, 200);
  assert.equal(resent.body.alreadyRequested, true);

  // The flip is real: staff read-back sees it.
  const read = await request(api.baseUrl, `/v1/recitation-sessions/${sessionId}`, { role: "ops" });
  assert.equal(read.status, 200);
  assert.equal(read.body.reviewStatus, "teacher-review-required");
});

// integration.rs:2292 — ml_proxy_refuses_analysis_for_a_session_that_does_not_exist
test("ML analysis against a nonexistent session is refused BEFORE any upstream forward", async () => {
  const res = await request(api.baseUrl, "/v1/ml/alignments:predict", {
    method: "POST",
    role: "learner",
    body: { sessionId: "session-does-not-exist-xyz", consent: { guardianApproved: true } },
  });
  assert.equal(res.status, 403, "must be refused, not forwarded");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Privacy / consent — 2 (3 more need a mock ML upstream: ml-proxy.test.mjs)
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:1664 — privacy_export_reports_included_records_but_deletes_nothing
test("a privacy EXPORT lists what it found and deletes nothing", async () => {
  const learnerId = await seedLearner(`learner-privacy-export-${uniqueSuffix()}`);
  privacyExportLearners.add(learnerId);
  const sessionId = await createSession(learnerId);

  const exported = await request(api.baseUrl, "/v1/privacy/export", {
    method: "POST",
    role: "admin",
    body: { learnerId },
  });
  assert.equal(exported.status, 200);

  // This is the path guarded by the `kind == Delete` check; if that check were inverted, an export
  // would silently start deleting the caller's data.
  assert.ok(
    exported.body.includedRecords.includes(sessionId),
    `export must include the learner's session, got ${JSON.stringify(exported.body.includedRecords)}`,
  );
  assert.deepEqual(exported.body.deletedRecords, [], "export must not delete any records");
  assert.deepEqual(exported.body.audioObjectKeysDeleted, [], "export must not erase any audio");

  const rows = await queryJson("SELECT id FROM recitation_sessions WHERE id = $1", [sessionId]);
  assert.equal(rows.length, 1, "export must not delete the learner's session");
});

// integration.rs:2908 — create_session_external_processing_requires_both_asr_consent_and_guardian_approval
test("external processing requires BOTH ASR consent and guardian approval, not either alone", async () => {
  const asrOnly = await seedLearner(`learner-consent-asr-only-${uniqueSuffix()}`);
  const both = await seedLearner(`learner-consent-both-${uniqueSuffix()}`);

  const create = (learnerId, consent) =>
    request(api.baseUrl, "/v1/recitation-sessions", {
      method: "POST",
      role: "admin",
      body: {
        learnerId,
        quranRef: FATIHAH_REF,
        sourceChecksum: RUN_CK_CONSENT,

        language: "ckb",
        mode: "guided-recite",
        practicePlanId: "fatihah-mastery-v1",
        consent,
      },
    });

  const asrOnlyRes = await create(asrOnly, {
    ...DISCARD_CONSENT,
    externalAsrProcessing: true,
    guardianApproved: false,
  });
  assert.equal(asrOnlyRes.status, 200);
  assert.equal(
    asrOnlyRes.body.externalProcessingAllowed,
    false,
    "ASR consent alone must NOT enable external processing",
  );

  const bothRes = await create(both, {
    ...DISCARD_CONSENT,
    externalAsrProcessing: true,
    guardianApproved: true,
  });
  assert.equal(bothRes.status, 200);
  assert.equal(bothRes.body.externalProcessingAllowed, true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Concurrency — 2
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:468 — concurrent_registration_with_same_email_is_race_safe
test("concurrent registrations with the same email: exactly one wins, the rest get a clean 400", async () => {
  // Registration's uniqueness check is SELECT-then-INSERT — a TOCTOU race under READ COMMITTED.
  // Measured before the fix: all 10 concurrent registrations succeeded.
  const email = `race-parity-${uniqueSuffix()}@example.com`;
  const statuses = await Promise.all(
    // Start all 5 before awaiting any: awaiting per iteration would serialize them and never
    // exercise the race at all.
    Array.from({ length: 5 }, (_, i) =>
      request(api.baseUrl, "/v1/auth/register", {
        method: "POST",
        tenant: null,
        body: {
          tenantId: TENANT,
          displayName: `Racer ${i}`,
          role: "learner",
          language: "en",
          email,
          password: "RaceTest1234",
        },
      }).then((r) => r.status),
    ),
  );

  assert.equal(
    statuses.filter((s) => s === 200).length,
    1,
    `exactly one concurrent registration must win: ${JSON.stringify(statuses)}`,
  );
  assert.equal(
    statuses.filter((s) => s === 400).length,
    4,
    `every loser needs a clean 400, never a 500 leaking the constraint: ${JSON.stringify(statuses)}`,
  );
});

// integration.rs:531 — concurrent_progress_updates_for_the_same_ayah_do_not_lose_repetitions
test("8 concurrent progress updates for one ayah lose none", async () => {
  // The race is in the read-compute-write of SM-2 state, so no DB constraint can close it — an
  // advisory lock does. Measured before the fix: 8 submissions left repetitions=4.
  const ayahRef = `1:lost-update-parity-${uniqueSuffix()}`;
  const statuses = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(api.baseUrl, "/v1/learner/progress", {
        method: "POST",
        role: "learner",
        body: { quality: 5, ayahRef },
      }).then((r) => r.status),
    ),
  );
  assert.deepEqual([...new Set(statuses)], [200], `all 8 must succeed: ${JSON.stringify(statuses)}`);

  const rows = await queryJson(
    `SELECT repetitions FROM learner_progress
     WHERE tenant_id = $1 AND learner_id = 'learner-1' AND ayah_ref = $2`,
    [TENANT, ayahRef],
  );
  assert.equal(rows.length, 1, "a progress row must exist after 8 successful submissions");
  assert.equal(
    rows[0].repetitions,
    8,
    "a lower count means the advisory lock is not serializing read-compute-write",
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Scholar / agent approval gate — 3
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:2598 — create_agent_run_rejects_approved_without_sources
test("an approved agent run without sources is rejected", async () => {
  const res = await request(api.baseUrl, "/v1/agent-runs", {
    method: "POST",
    role: "ops",
    body: {
      name: "run",
      goal: "goal",
      status: "approved",
      confidence: 0.9,
      reviewStatus: "scholar-approved",
      sources: [],
    },
  });
  assert.equal(res.status, 400, "an approved run must cite at least one source");
});

// integration.rs:2655 — create_agent_run_rejects_approved_with_an_unreviewed_review_status
test("an approved agent run with an unreviewed reviewStatus is rejected", async () => {
  // "ai-suggested" is a valid value agents write on every fresh candidate, but it must never itself
  // justify "approved" — only teacher-reviewed or scholar-approved clear the learner-facing gate.
  const res = await request(api.baseUrl, "/v1/agent-runs", {
    method: "POST",
    role: "ops",
    body: {
      name: "run",
      goal: "goal",
      status: "approved",
      confidence: 0.99,
      reviewStatus: "ai-suggested",
      sources: [{ id: "s", title: "t", citation: "c", url: null }],
    },
  });
  assert.equal(res.status, 400, "an approved run needs a reviewed reviewStatus");
});

// integration.rs:1890 — create_scholar_approval_rejects_high_risk_approval
test("a scholar-approved decision at HIGH risk is rejected even with sources", async () => {
  const res = await request(api.baseUrl, "/v1/scholar-approvals", {
    method: "POST",
    role: "scholar",
    body: {
      topic: `topic-${uniqueSuffix()}`,
      reviewerId: "ignored-should-use-actor",
      status: "scholar-approved",
      risk: "high",
      sources: [{ id: "src-1", title: "t", citation: "c", url: null }],
    },
  });
  assert.equal(res.status, 400, "high risk must be rejected regardless of sources");
});

// Registered last: node:test runs `after` hooks in registration order, so this drains the
// rows once the hooks above have stopped the services still able to write them.
after(async () => {
  let left = 0;
  left += await purgeSessionsByChecksum(RUN_CK_PRIVACY);
  left += await purgeSessionsByChecksum(RUN_CK_CONSENT);
  assert.equal(left, 0, `teardown left ${left} session(s) behind`);
});
