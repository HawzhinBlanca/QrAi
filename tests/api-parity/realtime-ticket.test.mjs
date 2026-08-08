import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { TENANT, purgeSessionsByChecksum, queryJson, request, startApi, uniqueSuffix } from "./lib/harness.mjs";

// Run-scoped session checksums, so the teardown at the end of this file deletes exactly this run's
// rows and nothing else. These suites created sessions and never removed them: measured, the shared
// staging database had accumulated 64,869 recitation sessions across ~8 fixed checksums, growing by
// thousands a day. Leaked rows already broke a review-parity assertion and a Rust integration test
// once in this program (`seedQueued`), and an unbounded corpus is what makes ORDER BY without a
// unique tiebreaker, row-count deltas, and other suites' bulk teardown intermittently fail.
// Per-run rather than a shared literal: two agents run this gate against the same Postgres.
const RUN_CK_TICKET = `fnv1a32:ticket-cov-${uniqueSuffix()}`;


/**
 * N5 — coverage for `POST /v1/realtime-session-tickets`, which had NONE.
 * specs/node-backend-port/plan.md §2
 *
 * ── Why this file exists, written the hard way ──────────────────────────────────────────────────
 * Phase 7 measured that 9 of 34 method+path pairs had no fixture and no parity test, and adopted the
 * rule "a route gets coverage BEFORE it gets ported". Then I ported this one first anyway and got it
 * wrong in four separate ways — wrong role allowlists, consent read from `consent_snapshot` instead
 * of the `external_processing_allowed` column, no audit_events row, no realtime_session_tickets row,
 * and no sample-rate negotiation. Every existing oracle stayed green, because none of them touch
 * this route.
 *
 * This file is what should have existed first. It runs against WHICHEVER implementation is serving
 * the route, so it is the oracle for the port rather than a description of it.
 *
 * The ticket is the only credential that crosses a service boundary — the realtime-gateway trusts
 * whatever this mints — which makes it the worst possible route to have had no check.
 */

let api;
before(async () => {
  api = await startApi();
});
after(async () => {
  await api?.stop();
});

const createSession = async (learnerId, consent = {}) => {
  const res = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "admin",
    body: {
      learnerId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: RUN_CK_TICKET,

      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: {
        audioRetention: "discard",
        anonymizedLearning: true,
        externalAsrProcessing: false,
        guardianApproved: true,
        consentVersion: "pilot-v1",
        ...consent,
      },
    },
  });
  assert.equal(res.status, 200, `session setup failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
};

const mint = (sessionId, { body = {}, ...opts } = {}) =>
  // `...opts` is destructured so it can never clobber the merged body — spreading it after `body`
  // dropped sessionId entirely and turned every sample-rate case into a 4xx.
  request(api.baseUrl, "/v1/realtime-session-tickets", {
    method: "POST",
    role: "learner",
    ...opts,
    body: { sessionId, ...body },
  });

// --- the response contract ---

test("a minted ticket carries every contractual field", async () => {
  const sessionId = await createSession("learner-1");
  const res = await mint(sessionId);
  assert.equal(res.status, 200);

  assert.deepEqual(
    Object.keys(res.body).sort(),
    [
      "allowedSampleRates",
      "auditEventId",
      "expiresAt",
      "externalAsrProcessing",
      "learnerId",
      "sessionId",
      "tenantId",
      "token",
    ],
    "the response shape is a wire contract the gateway and the web client both read",
  );
  assert.equal(res.body.sessionId, sessionId);
  assert.equal(res.body.tenantId, TENANT);
  assert.equal(res.body.learnerId, "learner-1");
  // `expires_at.to_string()` on a u64 — a DECIMAL STRING of unix seconds, not an ISO timestamp.
  assert.match(res.body.expiresAt, /^\d+$/, "expiresAt is unix seconds as a string, not RFC3339");
});

test("the token is a well-formed rt_v2 ticket whose fields match the response", async () => {
  const sessionId = await createSession("learner-1");
  const { body } = await mint(sessionId);
  const parts = body.token.split(".");
  assert.equal(parts.length, 9);
  const [version, session, tenant, learner, ext, retention, expires] = parts;
  assert.equal(version, "rt_v2");
  assert.equal(session, sessionId);
  assert.equal(tenant, TENANT);
  assert.equal(learner, "learner-1");
  assert.equal(ext, String(body.externalAsrProcessing), "the token must agree with the JSON body");
  assert.equal(retention, "discard", "the session above consented to `discard`");
  assert.equal(expires, body.expiresAt);
  assert.match(parts[8], /^[0-9a-f]{64}$/, "signature is lowercase hex HMAC-SHA256");
});

test("audioRetention in the token is the SESSION's stored consent", async () => {
  // The gateway has no database. Whatever is in this field is what ml-inference uses to decide how
  // long a learner's recorded voice is kept — "discard" deletes it in an hour, "teacher-review" in
  // seven days, "training-opt-in" never. So it has to come from the consent record written when the
  // session was created, exactly like `externalAsrProcessing` below.
  //
  // Before this field existed the gateway forwarded no retention at all and ml-inference defaulted
  // every chunk to "discard": a learner who chose to keep their recitation for their teacher had it
  // deleted an hour later, silently.
  for (const choice of ["discard", "teacher-review", "training-opt-in"]) {
    const sessionId = await createSession("learner-1", { audioRetention: choice });
    const { body } = await mint(sessionId);
    assert.equal(
      body.token.split(".")[5],
      choice,
      `a session consented to '${choice}' must mint a ticket carrying it`,
    );
  }
});

test("a client cannot ask for a retention the session did not consent to", async () => {
  // The mint request body has no say. A learner who chose "discard" must not be able to talk the
  // server into a ticket that keeps their audio for training — nor the reverse, which would silently
  // discard a recording a teacher was waiting for.
  const sessionId = await createSession("learner-1", { audioRetention: "discard" });
  const { body } = await mint(sessionId, { body: { audioRetention: "training-opt-in" } });
  assert.equal(body.token.split(".")[5], "discard", "the request body overrode stored consent");
});

// --- consent, which the ticket carries to the gateway ---

test("externalAsrProcessing comes from the SESSION, not from the request", async () => {
  // The gateway decides whether audio may leave for external ASR based on this flag. It must be the
  // server's stored value; a client-supplied one would let a learner grant themselves consent.
  const denied = await createSession("learner-1", { externalAsrProcessing: false, guardianApproved: true });
  const allowed = await createSession("learner-1", { externalAsrProcessing: true, guardianApproved: true });

  const a = await mint(denied);
  assert.equal(a.body.externalAsrProcessing, false);
  assert.equal(a.body.token.split(".")[4], "false");

  const b = await mint(allowed);
  assert.equal(b.body.externalAsrProcessing, true);
  assert.equal(b.body.token.split(".")[4], "true");
});

test("external processing stays FALSE when guardian approval is missing, whatever the client asked", async () => {
  // Mirrors the `&&` gate on session creation: ASR consent alone is not enough.
  const sessionId = await createSession("learner-1", {
    externalAsrProcessing: true,
    guardianApproved: false,
  });
  const res = await mint(sessionId);
  assert.equal(res.body.externalAsrProcessing, false);
  assert.equal(res.body.token.split(".")[4], "false");
});

// --- sample-rate negotiation ---

test("sample rates default to [16000] and unsupported values are filtered out", async () => {
  const sessionId = await createSession("learner-1");
  const dflt = await mint(sessionId);
  assert.deepEqual(dflt.body.allowedSampleRates, [16000], "no request means 16 kHz");

  const some = await mint(sessionId, { body: { requestedSampleRates: [48000, 22050, 24000] } });
  assert.deepEqual(some.body.allowedSampleRates, [48000, 24000], "22050 is not supported");

  const none = await mint(sessionId, { body: { requestedSampleRates: [22050, 8000] } });
  assert.deepEqual(none.body.allowedSampleRates, [16000], "an empty result falls back to 16 kHz");
});

// --- authorization ---

test("a learner cannot mint a ticket for ANOTHER learner's session", async () => {
  // learner-2 is not part of the base seed; create it so the session insert's FK holds.
  const other = `learner-ticket-other-${uniqueSuffix()}`;
  await queryJson(
    `INSERT INTO users (id, tenant_id, display_name, role, language)
     VALUES ($1, $2, 'Ticket Other', 'learner', 'ckb')`,
    [other, TENANT],
  );
  const sessionId = await createSession(other);
  const res = await request(api.baseUrl, "/v1/realtime-session-tickets", {
    method: "POST",
    role: "learner", // x-user-id = learner-1
    body: { sessionId },
  });
  assert.equal(res.status, 403);
});

test("teacher and scholar are refused; ops and admin are allowed", async () => {
  // require_any([Learner, Admin, Ops]) then require_self_or_any(learner, [Admin, Ops]).
  // Teacher is permitted on most read routes but NOT here — a port that reused the usual staff list
  // would hand a teacher a live audio credential.
  const sessionId = await createSession("learner-1");
  for (const role of ["teacher", "scholar"]) {
    const res = await request(api.baseUrl, "/v1/realtime-session-tickets", {
      method: "POST",
      role,
      body: { sessionId },
    });
    assert.equal(res.status, 403, `${role} must not mint a realtime ticket`);
  }
  for (const role of ["ops", "admin"]) {
    const res = await request(api.baseUrl, "/v1/realtime-session-tickets", {
      method: "POST",
      role,
      body: { sessionId },
    });
    assert.equal(res.status, 200, `${role} must be able to mint`);
  }
});

test("a nonexistent session is 404 and a cross-tenant one is not readable", async () => {
  const res = await mint(`session-does-not-exist-${uniqueSuffix()}`);
  assert.equal(res.status, 404);

  const sessionId = await createSession("learner-1");
  const foreign = await request(api.baseUrl, "/v1/realtime-session-tickets", {
    method: "POST",
    role: "learner",
    tenant: "other-tenant",
    body: { sessionId },
  });
  assert.ok([403, 404].includes(foreign.status), `cross-tenant mint was ${foreign.status}`);
});

// --- the persistence the response does not show ---

test("minting writes an audit event AND a realtime_session_tickets row storing only a HASH", async () => {
  // Neither is visible in the response, so a port could omit both and look correct. The token hash
  // matters especially: storing the raw token would put a live credential in the database.
  const sessionId = await createSession("learner-1");
  const { body } = await mint(sessionId);

  const audit = await queryJson("SELECT action, subject_type FROM audit_events WHERE id = $1", [
    body.auditEventId,
  ]);
  assert.equal(audit.length, 1, "the mint must be audited");
  assert.equal(audit[0].action, "recitation.realtime-ticket.issued");
  assert.equal(audit[0].subject_type, "realtime_session_ticket");

  const tickets = await queryJson(
    `SELECT token_hash, session_id, learner_id, external_asr_processing, allowed_sample_rates
     FROM realtime_session_tickets WHERE audit_event_id = $1`,
    [body.auditEventId],
  );
  assert.equal(tickets.length, 1, "the ticket must be persisted");
  assert.equal(tickets[0].session_id, sessionId);
  assert.equal(tickets[0].learner_id, "learner-1");
  assert.match(tickets[0].token_hash, /^[0-9a-f]{64}$/, "sha256 hex");
  assert.notEqual(tickets[0].token_hash, body.token, "the RAW token must never be stored");
  assert.deepEqual(tickets[0].allowed_sample_rates, [16000]);
});

// Registered last: node:test runs `after` hooks in registration order, so this drains the
// rows once the hooks above have stopped the services still able to write them.
after(async () => {
  let left = 0;
  left += await purgeSessionsByChecksum(RUN_CK_TICKET);
  assert.equal(left, 0, `teardown left ${left} session(s) behind`);
});
