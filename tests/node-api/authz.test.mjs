import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { ApiError, requireSelfOrAny, resolveActor } from "../../server/src/lib/authz.mjs";

/**
 * N3 §2.3 — the ownership gate.
 * specs/node-backend-port/plan.md §5
 *
 * Rust compares two non-`Option` `String`s and errors on a missing DB column. JavaScript compares
 * whatever it is handed, and **`undefined === undefined` is `true`** — so the naive port passes the
 * gate for every caller. This is the ONLY ownership check on 8 endpoints.
 *
 * Most of this file asserts the gate REFUSES. A gate that only has happy-path tests is
 * indistinguishable from `return true`.
 *
 * Hermetic: no database, no server.
 */

const STAFF = ["teacher", "scholar", "admin", "ops"];
const learner = { userId: "learner-1", role: "learner", tenantId: "t1" };
const ops = { userId: "ops-1", role: "ops", tenantId: "t1" };

// --- passes where it should ---

test("the owner passes", () => {
  requireSelfOrAny(learner, "learner-1", STAFF);
});

test("a permitted role passes for someone else's resource", () => {
  requireSelfOrAny(ops, "learner-1", STAFF);
});

// --- THE failure this primitive exists for ---

test("undefined === undefined must NOT pass the gate", () => {
  // The naive port. A renamed DB column yields `undefined` for the owner id; a JWT missing `sub`
  // yields `undefined` for the actor. Comparing them is `true`, and every caller owns everything.
  assert.throws(() => requireSelfOrAny({ userId: undefined, role: "learner" }, undefined, STAFF), ApiError);
  assert.throws(() => requireSelfOrAny({ userId: undefined, role: "learner" }, undefined, STAFF), /not allowed to perform/);
});

test("null === null must NOT pass the gate either", () => {
  assert.throws(() => requireSelfOrAny({ userId: null, role: "learner" }, null, STAFF), ApiError);
});

test("empty strings must NOT pass, even though they are strings and equal", () => {
  // `"" === ""` is true and both are strings, so a type check alone is not enough.
  assert.throws(() => requireSelfOrAny({ userId: "", role: "learner" }, "", STAFF), ApiError);
  assert.throws(() => requireSelfOrAny({ userId: "   ", role: "learner" }, "   ", STAFF), ApiError);
});

test("a missing owner id is refused even when the actor is perfectly valid", () => {
  // The realistic shape: the query returned a row whose owner column was renamed.
  assert.throws(() => requireSelfOrAny(learner, undefined, STAFF), /not allowed to perform/);
});

test("a missing actor is refused even when the owner id is valid", () => {
  for (const bad of [null, undefined, {}, { role: "ops" }]) {
    assert.throws(() => requireSelfOrAny(bad, "learner-1", STAFF), ApiError);
  }
});

/** node:assert's `throws` returns undefined, so the thrown value has to be captured directly. */
const caught = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return assert.fail("expected a throw, got none");
};

test("a non-owner without a permitted role is Forbidden with 403, not 401", () => {
  const other = { userId: "learner-2", role: "learner", tenantId: "t1" };
  assert.equal(caught(() => requireSelfOrAny(other, "learner-1", STAFF)).status, 403);
});

test("a malformed allowlist refuses rather than throwing a TypeError into a 500", () => {
  const other = { userId: "learner-2", role: "learner", tenantId: "t1" };
  for (const bad of [undefined, null, "ops"]) {
    assert.equal(
      caught(() => requireSelfOrAny(other, "learner-1", bad)).status,
      403,
      "a bad allowlist must fail closed, not 500",
    );
  }
});

// --- actor resolution ---

const req = (headers) => ({ headers });
const SECRET = "test-jwt-secret";
const sign = (claims) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));

test("dev-header identity resolves only when header auth is ENABLED", async () => {
  const headers = { "x-tenant-id": "t1", "x-user-id": "admin-1", "x-user-role": "admin" };
  const on = await resolveActor(req(headers), { jwtSecret: SECRET, allowHeaderAuth: true });
  assert.deepEqual(on.actor, { tenantId: "t1", userId: "admin-1", role: "admin" });

  // Production default. This is the spoofable path Phase 6's auth-disabled group exists to refuse.
  await assert.rejects(
    () => resolveActor(req(headers), { jwtSecret: SECRET, allowHeaderAuth: false }),
    (e) => e.status === 401,
  );
});

test("a partial dev-header identity resolves to NO actor, not a half-built one", async () => {
  // An actor with `role: undefined` would sail through a role check that uses `includes`.
  for (const headers of [
    { "x-tenant-id": "t1", "x-user-id": "admin-1" },
    { "x-tenant-id": "t1", "x-user-role": "admin" },
    { "x-user-id": "admin-1", "x-user-role": "admin" },
    { "x-tenant-id": "t1", "x-user-id": "", "x-user-role": "admin" },
  ]) {
    await assert.rejects(() => resolveActor(req(headers), { jwtSecret: SECRET, allowHeaderAuth: true }));
  }
});

test("a valid Bearer token resolves", async () => {
  const token = await sign({ sub: "learner-1", tenant_id: "t1", role: "learner" });
  const { actor } = await resolveActor(req({ authorization: `Bearer ${token}` }), {
    jwtSecret: SECRET,
    allowHeaderAuth: false,
  });
  assert.deepEqual(actor, { tenantId: "t1", userId: "learner-1", role: "learner" });
});

test("a token missing a claim is REJECTED, never resolved to undefined", async () => {
  // The other half of the §2.3 bypass: a token with no `sub` yields `payload.sub === undefined`,
  // which would then compare equal to a missing owner id.
  for (const claims of [
    { tenant_id: "t1", role: "learner" },
    { sub: "learner-1", role: "learner" },
    { sub: "learner-1", tenant_id: "t1" },
  ]) {
    const token = await sign(claims);
    await assert.rejects(
      () => resolveActor(req({ authorization: `Bearer ${token}` }), { jwtSecret: SECRET, allowHeaderAuth: false }),
      (e) => e.status === 401,
    );
  }
});

test("an alg:none token is REJECTED — the most likely security regression in this port", async () => {
  // `jsonwebtoken` trusts the token-declared alg unless the allowlist is remembered. jose refuses by
  // construction because `algorithms: ['HS256']` is passed at the call site.
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: "admin-1", tenant_id: "t1", role: "admin" })).toString("base64url");
  await assert.rejects(
    () => resolveActor(req({ authorization: `Bearer ${header}.${body}.` }), { jwtSecret: SECRET, allowHeaderAuth: false }),
    (e) => e.status === 401,
  );
});

test("a token signed with the WRONG secret is rejected", async () => {
  const token = await new SignJWT({ sub: "admin-1", tenant_id: "t1", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("attacker-secret"));
  await assert.rejects(
    () => resolveActor(req({ authorization: `Bearer ${token}` }), { jwtSecret: SECRET, allowHeaderAuth: false }),
    (e) => e.status === 401,
  );
});

test("a no-database compatibility request delegates only when an upstream is explicit", async () => {
  // DB-backed pilot lookup is local. This vector isolates the reversible compatibility fallback.
  const { delegate, actor } = await resolveActor(
    req({ cookie: "__Host-qrai-pilot=sometoken" }),
    { jwtSecret: SECRET, allowHeaderAuth: true, upstream: "http://127.0.0.1:1" },
  );
  assert.ok(delegate, "compatibility must identify the no-database request for delegation");
  assert.equal(actor, undefined);
});

test("a no-database standalone pilot request fails closed", async () => {
  await assert.rejects(
    () => resolveActor(req({ cookie: "__Host-qrai-pilot=sometoken" }), {
      jwtSecret: SECRET,
      allowHeaderAuth: true,
      upstream: null,
    }),
    (error) => error instanceof ApiError && error.status === 401,
  );
});

test("a Bearer token wins over dev headers when both are present", async () => {
  // Otherwise a spoofed header could downgrade a real token's identity.
  const token = await sign({ sub: "learner-1", tenant_id: "t1", role: "learner" });
  const { actor } = await resolveActor(
    req({ authorization: `Bearer ${token}`, "x-user-id": "admin-1", "x-user-role": "admin", "x-tenant-id": "t1" }),
    { jwtSecret: SECRET, allowHeaderAuth: true },
  );
  assert.equal(actor.role, "learner", "the signed identity must win over the spoofable one");
});

// ── The shared gate corpus, executed against the node-api learner gate ────────────────────────────
//
// `packages/contracts/fixtures/canonical-gates.json` holds one table of cases for
// `canShowLearnerFacingAiOutput` — the only thing stopping unreviewed AI output reaching a learner —
// so that every implementation is held to the same expectations. #358 added the Rust gate and the
// agents gate to that list and recorded the three that still were not on it. This is one of them:
// `clearsLearnerGate` in routes/ml-proxy.mjs, the predicate that decides whether a tajweed finding
// is redacted before it reaches a learner's device.
//
// It was covered only by A/B parity, which compares the shell to Rust and is blind to a change
// applied to both — the hole this whole session opened with.

import { clearsLearnerGate } from "../../server/src/routes/ml-proxy.mjs";

const GATE_CORPUS = JSON.parse(
  readFileSync(
    new URL("../../packages/contracts/fixtures/learner-feedback-gate.json", import.meta.url),
    "utf8",
  ),
);

test("the ml-proxy learner gate agrees with the shared corpus on every case", () => {
  const cases = GATE_CORPUS?.cases;
  assert.ok(Array.isArray(cases), "learner-feedback-gate.json has no cases");

  // Fail CLOSED on a shrinking corpus: an empty `cases` makes the loop below vacuous and this test
  // green while asserting nothing — the same shape as the licence gate that once reported
  // "0 unapproved" because it had been handed zero packages.
  assert.ok(
    cases.length >= 8,
    `the corpus is down to ${cases.length} cases for the learner gate; it had 11`,
  );
  assert.ok(
    cases.some((c) => c.expected === true) && cases.some((c) => c.expected === false),
    "the corpus must contain both answers, or a gate hardcoded to false satisfies it — which would " +
      "withhold every finding from every learner and no negative case would notice",
  );

  for (const c of cases) {
    const input = structuredClone(GATE_CORPUS.base);
    Object.assign(input, c.patch ?? {});
    for (const field of c.remove ?? []) delete input[field];
    assert.equal(
      clearsLearnerGate(input),
      c.expected,
      `ml-proxy disagrees with the shared corpus.\n  case: ${c.name}\n  input: ${JSON.stringify(input)}`,
    );
  }
});

// --- the same row, forwarded as well as checked ---

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

test("both ml_proxy implementations forward the learner from the row they authorised against", () => {
  // The ownership gate above reads `learner_id` off the session row. That same value must also be
  // FORWARDED to the consolidated inference runtime, because it keys external-ASR and prediction rows
  // by sessionId: with no learner on the request those rows are attributable to nobody, and a
  // learner-scoped privacy export has to drop them. The Rust side sends it; the Node port did not,
  // so a cutover to node-api would have silently reverted it — the drift ADR-0034 exists for.
  //
  // A source check, deliberately: the Node proxy needs a live Postgres to reach that branch, so a
  // behavioural test of it is DB-gated and would not run in this hermetic step. Weaker than driving
  // the code, and still enough to catch one implementation losing the line.
  const node = read("server/src/routes/ml-proxy.mjs");
  const rust = read("services/platform-api/src/handlers/ml_proxy.rs");

  assert.match(
    node,
    /forwarded\.learnerId\s*=\s*row\.learner_id/,
    "the Node ML proxy does not forward the session row's learner to inference",
  );
  assert.match(
    rust,
    /"learnerId"\.to_owned\(\)/,
    "platform-api's ML proxy does not forward the session row's learner to ml-inference",
  );

  // Server-authoritative, not client-echoed. Taking it from the request body would let a caller
  // file their audit rows under another learner, which is the failure the DB lookup exists to avoid.
  assert.doesNotMatch(
    node,
    /forwarded\.learnerId\s*=\s*body\.learnerId/,
    "the forwarded learner must come from the session row, never from the caller's body",
  );
});

// --- the learner gate must fail CLOSED on shapes it cannot reason about ---

test("node-api's learner redaction fails CLOSED on malformed ML responses, like the Rust original", async () => {
  // handlers/ml_proxy.rs documents that BOTH branches below used to forward the value unredacted —
  // the gate failing open on exactly the input it cannot reason about — and fixed them. This port
  // kept the old behaviour, so a cutover to node-api would have silently reopened an ADR-0028 gate
  // the Rust side had already closed. Reachable without anyone editing the gate: a partially
  // migrated model server, a debug build with a different schema, a compromised ML service.
  const { redactWithheldFindings } = await import("../../server/src/routes/ml-proxy.mjs");

  // 1. `findings` present but not an array — drop it, do not forward it.
  const notAnArray = { findings: "MODEL-TEXT-A-LEARNER-MUST-NOT-SEE" };
  redactWithheldFindings(notAnArray);
  assert.deepEqual(notAnArray.findings, [], "ungated model output was forwarded to a learner");

  // 2. A finding that is not an object — replace wholesale, keeping the array length the clients
  //    count for "N notes are waiting for a teacher".
  const notObjects = { findings: ["MODEL-TEXT-A-LEARNER-MUST-NOT-SEE", 42, null] };
  redactWithheldFindings(notObjects);
  assert.equal(notObjects.findings.length, 3, "the count clients render must survive redaction");
  for (const f of notObjects.findings) {
    assert.equal(f.withheld, true);
    assert.equal(f.confidence, 0);
    assert.deepEqual(f.sources, []);
  }
  assert.ok(
    !JSON.stringify(notObjects).includes("MUST-NOT-SEE"),
    "model text survived redaction and would reach the learner",
  );

  // 3. No `findings` key at all is a legitimate shape and stays untouched.
  const noKey = { sessionId: "s1" };
  redactWithheldFindings(noKey);
  assert.deepEqual(noKey, { sessionId: "s1" }, "a response with no findings must not be rewritten");

  // 4. The happy path still redacts an unapproved OBJECT finding rather than passing it through.
  const unapproved = {
    findings: [{ reviewStatus: "ai-suggested", confidence: 0.99, sources: [{ id: "s" }], explanation: "MUST-NOT-SEE" }],
  };
  redactWithheldFindings(unapproved);
  assert.equal(unapproved.findings[0].explanation, "");
  assert.equal(unapproved.findings[0].withheld, true);
});
