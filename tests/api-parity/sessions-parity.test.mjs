/**
 * N14a — the four READ operations on recitation sessions.
 * specs/migration-completion/plan.md §2 · port of handlers/recitation.rs
 *
 *   NODE_API_PORTED="GET /v1/recitation-sessions,GET /v1/recitation-sessions/{id},GET /v1/recitation-sessions/{id}/alignments,GET /v1/learners/active" \
 *     node --test tests/api-parity/sessions-parity.test.mjs
 *
 * ── One column, two serialization rules, in the same file ───────────────────────────────────────
 * `quran_ref` is jsonb. `get_session` deserializes it into a TYPED `QuranReference` struct, so it
 * comes back in the struct's DECLARATION order with the struct's fallbacks. `list_sessions` passes
 * the same column through as an untyped `serde_json::Value`, so it comes back with BTreeMap
 * ALPHABETICAL keys and whatever was stored. Reading either handler alone makes the other look
 * wrong; only a byte comparison against both settles it.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB } from "./lib/ab.mjs";
import { formatF32, formatF64 } from "../../server/src/lib/json.mjs";
import { TENANT, queryJson, request, startApi, startShell } from "./lib/harness.mjs";

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
const PORTED = "GET /v1/recitation-sessions,GET /v1/recitation-sessions/{id},GET /v1/recitation-sessions/{id}/alignments,GET /v1/learners/active";

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
let session;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { NODE_API_PORTED: PORTED } });
  const [row] = await queryJson(
    `SELECT s.id, s.learner_id FROM recitation_sessions s
     WHERE s.tenant_id = $1
       AND EXISTS (SELECT 1 FROM word_alignments w WHERE w.session_id = s.id)
     ORDER BY s.id LIMIT 1`,
    [TENANT],
  );
  const [fallback] = row
    ? [row]
    : await queryJson(
        "SELECT id, learner_id FROM recitation_sessions WHERE tenant_id = $1 ORDER BY id LIMIT 1",
        [TENANT],
      );
  assert.ok(fallback, "this suite needs at least one seeded recitation session");
  session = fallback;
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const ROLES = ["learner", "teacher", "scholar", "admin", "ops"];

test("GET /v1/recitation-sessions is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, { path: "/v1/recitation-sessions", role });
  }
});

test("listing sessions is STAFF only — a learner cannot enumerate the tenant", async () => {
  const status = async (role) =>
    (await request(shell.baseUrl, "/v1/recitation-sessions", { role })).status;
  assert.equal(await status("learner"), 403, "a learner may read their own session, not list all");
  assert.equal(await status("scholar"), 403);
  assert.equal(await status("teacher"), 200);
  assert.equal(await status("admin"), 200);
});

test("list_sessions keys are ALPHABETICAL — json!, and quranRef is an untyped Value", async () => {
  const res = await request(shell.baseUrl, "/v1/recitation-sessions", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "the corpus must have sessions or this proves nothing");
  assert.deepEqual(Object.keys(res.body[0]), [
    "confidence",
    "id",
    "latencyMs",
    "learnerId",
    "mode",
    "quranRef",
    "reviewStatus",
    "startedAt",
  ]);
});

test("GET /v1/recitation-sessions/{id} is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, { path: `/v1/recitation-sessions/${session.id}`, role });
  }
});

test("get_session keys are DECLARATION order — a struct, not a json! literal", async () => {
  const res = await request(shell.baseUrl, `/v1/recitation-sessions/${session.id}`, { role: "admin" });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body), [
    "id",
    "tenantId",
    "learnerId",
    "quranRef",
    "sourceChecksum",
    "modelVersion",
    "language",
    "mode",
    "practicePlanId",
    "externalProcessingAllowed",
    "confidence",
    "reviewStatus",
    "consent",
    "auditEventId",
  ]);
  assert.deepEqual(Object.keys(res.body.quranRef), [
    "surahNumber",
    "ayahStart",
    "ayahEnd",
    "wordStart",
    "wordEnd",
    "display",
  ], "QuranReference is a typed struct here — declaration order, and wordStart/wordEnd always present");
  assert.deepEqual(Object.keys(res.body.consent), [
    "recordingConsent",
    "audioRetention",
    "anonymizedLearning",
    "externalAsrProcessing",
    "guardianApproved",
    "consentVersion",
  ]);
});

/**
 * A RECORDED GAP, same shape as the one in `reports-parity`.
 *
 * `RecitationSession.confidence` is `f32` (types.rs:200), so it is narrowed and printed
 * shortest-for-a-single. Swapping `f32()` for `f64()` runs GREEN here: every seeded session has
 * confidence 0.0, which both formatters print identically. Assert the PREMISE so this stops being
 * silent the moment a session carries a real confidence.
 */
test("the f32 narrowing on session confidence is NOT exercised by this corpus", async () => {
  const res = await request(shell.baseUrl, `/v1/recitation-sessions/${session.id}`, { role: "admin" });
  assert.equal(res.status, 200);
  const v = res.body.confidence;
  if (typeof v !== "number") return;
  assert.equal(
    formatF32(v),
    formatF64(v),
    `confidence = ${v} now prints differently as f32 (${formatF32(v)}) than as f64 ` +
      `(${formatF64(v)}). The A/B above genuinely covers the narrowing now — confirm it.`,
  );
});

test("a learner may read their OWN session and is 403 on another learner's", async () => {
  // Ownership is checked AFTER the row is found, so "not yours" is 403 and "does not exist" is 404.
  // Collapsing them would be a small privacy improvement and a behaviour change; it is transcribed.
  const { shell: own } = await assertAB(shell.baseUrl, rustUrl, {
    path: `/v1/recitation-sessions/${session.id}`,
    role: "learner",
    userId: session.learner_id,
  });
  assert.equal(own.status, 200, "the owning learner must be able to read it");

  const { shell: other } = await assertAB(shell.baseUrl, rustUrl, {
    path: `/v1/recitation-sessions/${session.id}`,
    role: "learner",
    userId: "learner-someone-else",
  });
  assert.equal(other.status, 403);
});

test("an unknown session id is 404, identically", async () => {
  for (const id of ["no-such-session", "..%2Fetc", "%20"]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
      path: `/v1/recitation-sessions/${id}`,
      role: "admin",
    });
    assert.equal(s.status, 404);
  }
});

test("GET /v1/learners/active is byte-identical and NOT truncated", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, { path: "/v1/learners/active", role });
  }
  const res = await request(shell.baseUrl, "/v1/learners/active", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  // The whole point of this endpoint: `list_sessions` caps at 50 rows, so deriving "active
  // learners" from it silently drops learners once volume exceeds the cap. Assert the counts
  // against the database, not against the other endpoint.
  const rows = await queryJson(
    "SELECT COUNT(DISTINCT learner_id)::int AS n FROM recitation_sessions WHERE tenant_id = $1",
    [TENANT],
  );
  assert.equal(res.body.length, rows[0].n, "this list must be the COMPLETE distinct set, unlimited");
  assert.deepEqual(res.body, [...res.body].sort(), "ORDER BY learner_id");
});

test("GET .../alignments is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, {
      path: `/v1/recitation-sessions/${session.id}/alignments`,
      role,
    });
  }
});

test("alignments: an UNKNOWN session is an empty array, not a 404", async () => {
  // Transcribed, not improved. A 404 here would tell a caller which session ids exist in the
  // tenant, and this endpoint has no ownership check to lean on.
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/recitation-sessions/no-such-session/alignments",
    role: "admin",
  });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body, []);
});

test("alignment canonicalText is byte-identical to canonical_words in Postgres", async () => {
  const res = await request(shell.baseUrl, `/v1/recitation-sessions/${session.id}/alignments`, {
    role: "admin",
  });
  assert.equal(res.status, 200);
  if (res.body.length === 0) return; // covered by the A/B above; nothing to compare here

  assert.deepEqual(Object.keys(res.body[0]), [
    "auditEventId",
    "canonicalText",
    "confidence",
    "datasetVersion",
    "endMs",
    "evidenceIds",
    "heardText",
    "modelAttribution",
    "modelVersion",
    "startMs",
    "status",
    "transcriptSource",
    "wordId",
  ]);

  for (const alignment of res.body) {
    assert.ok(["server-derived", "client-reported"].includes(alignment.transcriptSource));
    assert.equal(typeof alignment.modelVersion, "string");
    assert.ok(alignment.modelVersion.length > 0);
    assert.ok(Array.isArray(alignment.evidenceIds));
    if (alignment.modelAttribution === null) {
      assert.equal(alignment.datasetVersion, null);
      assert.deepEqual(alignment.evidenceIds, []);
    }
  }

  // The served text is joined from canonical_words. Compare against the row itself, so a transform
  // by EITHER implementation is caught by an oracle that went through neither.
  for (const a of res.body.slice(0, 5)) {
    const [row] = await queryJson("SELECT text_uthmani FROM canonical_words WHERE id = $1", [a.wordId]);
    assert.equal(a.canonicalText, row.text_uthmani, `word ${a.wordId} text was altered in transit`);
  }
});

// ── The consent a session reports when its snapshot cannot answer ──────────────────────────────
//
// `routes/sessions.mjs:41` states the rule: "Never fabricate a consent the learner may not have
// given... A default of `anonymized-learning: true` here would silently opt historical learners
// into training data."
//
// Every field falls back INDEPENDENTLY (`b(stored.x, false)`), and those per-field defaults are the
// reachable half of that rule: `consent_snapshot` is NOT NULL, so the whole-object branch barely
// fires, but a snapshot written before a field existed — or by a writer that stored a string where
// a boolean belongs — hits the per-field path. Sessions with `consent_snapshot = '{}'` already
// exist in this database and are served through it today. Nothing asserted the result.
test("a consent snapshot that cannot answer yields the MOST RESTRICTIVE consent", async () => {
  const sessionId = `session-consent-fallback-${process.pid}-${Date.now()}`;
  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [consentRow] = await queryJson(
    "SELECT id FROM consent_records WHERE tenant_id = $1 ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [auditRow] = await queryJson(
    "SELECT id FROM audit_events WHERE tenant_id = $1 ORDER BY id LIMIT 1",
    [TENANT],
  );

  // Hostile on purpose, and not merely EMPTY: a string where a boolean belongs and a number where a
  // string belongs. An implementation that only checked for missing keys would pass an empty
  // snapshot and still hand back `recordingConsent: "true"` — a truthy value that every downstream
  // `if (consent.recordingConsent)` would honour.
  const hostileSnapshot = JSON.stringify({
    recordingConsent: "true",
    audioRetention: 123,
    anonymizedLearning: "yes",
    guardianApproved: 1,
  });

  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":7,"display":"x"}',
             'sha256:x', (SELECT id FROM model_versions LIMIT 1), 'guided-recite', 'p', false,
             0.0, 'draft', now(), 0, $4, $5::jsonb, $6, 'ar')`,
    [sessionId, TENANT, learner.id, consentRow.id, hostileSnapshot, auditRow.id],
  );

  try {
    const path = `/v1/recitation-sessions/${sessionId}`;
    await assertAB(shell.baseUrl, rustUrl, { path, role: "ops" });

    // Absolute, not only A/B. Both implementations defaulting permissively TOGETHER is exactly what
    // happens when someone resolves a divergence by widening the reference, and a comparison cannot
    // see it. Same reason the scholar gate on /v1/learner/progress asserts 403 outright.
    const res = await request(shell.baseUrl, path, { role: "ops" });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      res.body.consent,
      {
        recordingConsent: false,
        audioRetention: "discard",
        anonymizedLearning: false,
        externalAsrProcessing: false,
        guardianApproved: false,
        consentVersion: "unknown",
      },
      "a session whose snapshot could not answer reported a consent the learner never gave",
    );
    // Named separately because it is the one the comment calls out: this field decides whether a
    // child's recorded voice may be used to train a model.
    assert.equal(res.body.consent.anonymizedLearning, false);
  } finally {
    // This row is INSERTed into the shared pilot tenant; leaving it behind would grow the session
    // list every run and eventually move a LIMIT-bounded assertion elsewhere in the suite.
    await queryJson("DELETE FROM recitation_sessions WHERE id = $1", [sessionId]);
  }
});
