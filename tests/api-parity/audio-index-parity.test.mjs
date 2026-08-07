/**
 * POST /v1/audio-chunks — the gateway records that a chunk of audio exists (ADR-0037).
 *
 *   node --test tests/api-parity/audio-index-parity.test.mjs
 *
 * This file used to document `NODE_API_PORTED="POST /v1/audio-chunks"`. That command has never
 * worked: the route has no Node handler and is not in PORTABLE, so the shell refuses to boot with
 * `NODE_API_PORTED names an unportable route`. Nobody ran it. The "shell" side here is therefore a
 * PROXY to Rust by necessity, which is the harness-soundness half of the A/B rather than a claim
 * about a port — and that is correct for a route nobody has ported.
 *
 * The missing half of playback. Audio was stored by ml-inference and NOTHING wrote the row that says
 * where it is, so `audio_chunks` was populated by a test fixture and a smoke script and by nothing
 * else — measured: of 2752 tajweed findings, zero had a session with any audio row.
 *
 * ── The credential is the session's own realtime ticket ──────────────────────────────────────────
 * Not a new shared secret. The gateway already holds a ticket platform-api MINTED for this session,
 * signed with REALTIME_GATEWAY_TICKET_SECRET, expiring in 300s, carrying tenantId / learnerId /
 * sessionId. Using it means the gateway can only index chunks for a session it was actually admitted
 * to, the scope is one session rather than the whole service, and there is no third credential to
 * rotate. A shared service key would have granted every session at once, forever.
 *
 * ── tenant and learner come from the CLAIMS, never the body ──────────────────────────────────────
 * The body says which chunk and where it sits. Who it belongs to is read from the signed ticket. A
 * body-supplied tenantId is a tenantId the caller chooses, and this route writes rows that decide
 * whose recording a teacher is later played.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import {
  TENANT,
  insertDeclaredTestAcousticFinding,
  queryJson,
  request,
  startApi,
  startShell,
} from "./lib/harness.mjs";

let api;
let shell;
let seeded;

const TICKET_SECRET = "audio-index-test-secret";

async function seedSession(retention = "teacher-review") {
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  const ids = {
    audit: `audit-idx-${suffix}`,
    consent: `consent-idx-${suffix}`,
    session: `session-idx-${suffix}`,
  };
  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     VALUES ($1, $2, $3, 'test.seed', 'test', $1, '{}'::jsonb)`,
    [ids.audit, TENANT, learner.id],
  );
  await queryJson(
    `INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
       external_asr_processing, guardian_approved, consent_version, audit_event_id)
     VALUES ($1, $2, $3, $4, true, false, true, 'pilot-v1', $5)`,
    [ids.consent, TENANT, learner.id, retention, ids.audit],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{}'::jsonb, 'fnv1a32:t', $4, 'guided-recite', 'p', false, 0.0, 'draft',
             now(), 0, $5, '{}'::jsonb, $6, 'ar')`,
    [ids.session, TENANT, learner.id, model.id, ids.consent, ids.audit],
  );
  return { ...ids, learnerId: learner.id };
}

/** A ticket minted by the real route, so this test never re-implements the signing. */
async function ticketFor(sessionId, learnerId) {
  const res = await request(api.upstreamUrl ?? api.baseUrl, "/v1/realtime-session-tickets", {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: { sessionId },
  });
  assert.equal(res.status, 200, `could not mint a ticket: ${res.text}`);
  return res.body.token;
}

before(async () => {
  const env = { REALTIME_GATEWAY_TICKET_SECRET: TICKET_SECRET };
  api = await startApi({ env });
  shell = await startShell({ upstream: api.upstreamUrl ?? api.baseUrl, env });
  seeded = await seedSession();
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const impls = () => [
  ["shell", shell.baseUrl],
  ["rust", api.upstreamUrl ?? api.baseUrl],
];

const chunkBody = (over = {}) => ({
  sessionId: seeded.session,
  chunkId: `chunk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`,
  startMs: 640,
  endMs: 1230,
  sampleRate: 16000,
  objectKey: `${TENANT}/${seeded.learnerId}/x.bin`,
  ...over,
});

const rowsFor = (chunkId) =>
  queryJson("SELECT tenant_id, session_id, start_ms, end_ms FROM audio_chunks WHERE id = $1", [chunkId]);

test("a valid ticket indexes the chunk", async () => {
  for (const [impl, base] of impls()) {
    const token = await ticketFor(seeded.session, seeded.learnerId);
    const body = chunkBody();
    const res = await request(base, "/v1/audio-chunks", {
      method: "POST",
      tenant: null,
      headers: { "x-realtime-ticket": token },
      body,
    });
    assert.equal(res.status, 200, `${impl}: ${res.text}`);

    const [row] = await rowsFor(body.chunkId);
    assert.ok(row, `${impl}: the route returned 200 and wrote no row`);
    assert.equal(row.tenant_id, TENANT, `${impl}: the row's tenant did not come from the ticket`);
    assert.equal(row.session_id, seeded.session);
    assert.equal(Number(row.start_ms), 640, `${impl}: the span did not survive`);
    assert.equal(Number(row.end_ms), 1230);
  }
});

test("no ticket, a forged one, or one for another session is refused", async () => {
  const good = await ticketFor(seeded.session, seeded.learnerId);
  const other = await seedSession();
  const otherToken = await ticketFor(other.session, other.learnerId);

  for (const [impl, base] of impls()) {
    for (const [label, headers] of [
      ["no ticket", {}],
      ["forged ticket", { "x-realtime-ticket": "not.a.ticket" }],
      ["ticket signed for a DIFFERENT session", { "x-realtime-ticket": otherToken }],
      // A valid ticket with its signature truncated: the claims still read, so a route that parsed
      // without verifying would accept it.
      ["ticket with a broken signature", { "x-realtime-ticket": `${good.slice(0, -4)}AAAA` }],
    ]) {
      const body = chunkBody();
      const res = await request(base, "/v1/audio-chunks", {
        method: "POST",
        tenant: null,
        headers,
        body,
      });
      assert.equal(res.status, 401, `${impl}: "${label}" answered ${res.status}, not 401`);
      assert.equal(
        (await rowsFor(body.chunkId)).length,
        0,
        `${impl}: "${label}" was refused but still wrote a row`,
      );
    }
  }
});

test("the body cannot choose the tenant — the ticket does", async () => {
  // A body-supplied tenantId is a tenantId the caller chooses, and this row decides whose recording
  // a teacher is later played. The route must ignore it entirely.
  for (const [impl, base] of impls()) {
    const token = await ticketFor(seeded.session, seeded.learnerId);
    const body = chunkBody({ tenantId: "tenant-quran-ai", learnerId: "someone-else" });
    const res = await request(base, "/v1/audio-chunks", {
      method: "POST",
      tenant: null,
      headers: { "x-realtime-ticket": token },
      body,
    });
    assert.equal(res.status, 200, `${impl}: ${res.text}`);
    const [row] = await rowsFor(body.chunkId);
    assert.equal(
      row.tenant_id,
      TENANT,
      `${impl}: a caller-supplied tenantId reached the row — cross-tenant write`,
    );
  }
});

test("a retry of the same chunk is idempotent, not a conflict", async () => {
  // The gateway retries a chunk whose response was lost. A second POST must be a no-op: failing it
  // would make a delivered chunk look undelivered, and the gateway would count a loss that did not
  // happen.
  for (const [impl, base] of impls()) {
    const token = await ticketFor(seeded.session, seeded.learnerId);
    const body = chunkBody();
    const first = await request(base, "/v1/audio-chunks", {
      method: "POST", tenant: null, headers: { "x-realtime-ticket": token }, body,
    });
    const second = await request(base, "/v1/audio-chunks", {
      method: "POST", tenant: null, headers: { "x-realtime-ticket": token }, body,
    });
    assert.equal(first.status, 200, `${impl}: ${first.text}`);
    assert.equal(second.status, 200, `${impl}: a retry answered ${second.status}: ${second.text}`);
    assert.equal((await rowsFor(body.chunkId)).length, 1, `${impl}: the retry duplicated the row`);
  }
});

test("an unusable span is refused — the same rule the alignment writers use", async () => {
  // #360/#361. A chunk whose span identifies no audio is unlocatable, and this index exists so a
  // finding can be located. Refusing here keeps the DB CHECK constraint from being the only thing
  // holding the line.
  for (const [impl, base] of impls()) {
    for (const [label, span] of [
      ["zero-length", { startMs: 500, endMs: 500 }],
      ["inverted", { startMs: 900, endMs: 400 }],
      ["negative", { startMs: -1, endMs: 100 }],
      ["missing", { startMs: undefined, endMs: undefined }],
    ]) {
      const token = await ticketFor(seeded.session, seeded.learnerId);
      const body = chunkBody(span);
      const res = await request(base, "/v1/audio-chunks", {
        method: "POST", tenant: null, headers: { "x-realtime-ticket": token }, body,
      });
      assert.ok(
        res.status >= 400 && res.status < 500,
        `${impl}: "${label}" was accepted with ${res.status}`,
      );
      assert.equal(
        (await rowsFor(body.chunkId)).length,
        0,
        `${impl}: "${label}" was refused but still wrote a row`,
      );
    }
  }
});

test("indexing a chunk makes its finding's audio reachable — the whole point", async () => {
  // End to end through the two halves that now exist: index the chunk here, and the review queue
  // stops saying the recording was never captured. Without this the route is a write nobody reads.
  const s = await seedSession("teacher-review");
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  const [word] = await queryJson("SELECT id FROM canonical_words WHERE ayah_id = '1:1' LIMIT 1");
  const alignmentId = `wa-idx-${Date.now().toString(36)}`;
  const findingId = `tf-idx-${Date.now().toString(36)}`;
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'x', 700, 1100, 0.9, 'matched', $5, $6, 'client-reported')`,
    [alignmentId, TENANT, s.session, word.id, model.id, s.audit],
  );
  await insertDeclaredTestAcousticFinding({
    id: findingId,
    alignmentId,
    rule: "ghunnah",
    severity: "practice",
    confidence: 0.9,
    auditEventId: s.audit,
  });

  // Asserted through the PER-FINDING audio route, not the queue list. The list is
  // `ORDER BY confidence DESC LIMIT 200`, and a canonical-text finding now carries confidence 0
  // (ADR-0036) — so a freshly seeded one sorts to the bottom and falls outside the page. That is a
  // real property of the queue worth knowing, and it is not what this test is about.
  const audioPath = `/v1/tajweed-findings/${findingId}/audio`;

  const before = await request(shell.baseUrl, audioPath, { role: "teacher" });
  assert.equal(
    before.status,
    404,
    `premise: with no chunk indexed this finding has no audio to reach, got ${before.status}`,
  );

  const token = await ticketFor(s.session, s.learnerId);
  const res = await request(shell.baseUrl, "/v1/audio-chunks", {
    method: "POST",
    tenant: null,
    headers: { "x-realtime-ticket": token },
    body: {
      sessionId: s.session,
      chunkId: `chunk-e2e-${Date.now().toString(36)}`,
      startMs: 600,
      endMs: 1400,
      sampleRate: 16000,
      objectKey: `${TENANT}/${s.learnerId}/e2e.bin`,
    },
  });
  assert.equal(res.status, 200, res.text);

  // After indexing the route gets PAST the consent and index checks and goes to storage, which is
  // not running here — so a 502 is the proof. Still 404 would mean the row was written and nothing
  // reads it, which is the failure this whole piece exists to prevent.
  const after = await request(shell.baseUrl, audioPath, { role: "teacher" });
  assert.notEqual(
    after.status,
    404,
    "the chunk was indexed but the finding still reports no audio — the index is not being read",
  );
  assert.equal(
    after.status,
    502,
    `expected the route to reach storage and fail there (502), got ${after.status}: ${after.text}`,
  );
});
