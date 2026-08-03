import assert from "node:assert/strict";
import test from "node:test";

import {
  NormalizeError,
  canonicalJson,
  createNormalizer,
  normalizeBody,
} from "./lib/fixture-normalize.mjs";

// F1 tests — specs/api-golden-fixtures/plan.md
//
// The normalizer is tested before any capture exists, because a wrong normalizer produces fixtures
// whose error is invisible: every fixture it writes agrees with every other one.

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// --- determinism: the whole reason this module exists ---

test("two responses differing only in generated ids normalize identically", () => {
  const a = { id: `session-${UUID_A}`, startedAt: "2026-07-30T10:00:00Z", learnerId: "learner-1" };
  const b = { id: `session-${UUID_B}`, startedAt: "2026-07-30T11:22:33Z", learnerId: "learner-1" };
  assert.deepEqual(normalizeBody(a), normalizeBody(b));
});

test("the SAME value gets the SAME placeholder across steps (referential integrity)", () => {
  // A port that returned a different session id from GET than from POST must FAIL. A stateless
  // normalizer would map both to <ID:session> and silently accept that.
  const n = createNormalizer();
  const post = n.normalize({ id: `session-${UUID_A}` });
  const getSame = n.normalize({ sessionId: `session-${UUID_A}` });
  const getOther = n.normalize({ sessionId: `session-${UUID_B}` });

  assert.equal(post.id, "<ID:session#1>");
  assert.equal(getSame.sessionId, "<ID:session#1>", "same id must reuse the placeholder");
  assert.equal(getOther.sessionId, "<ID:session#2>", "a DIFFERENT id must not collide");
});

// --- the non-goal that protects /v1/auth/token ---

test("snake_case keys survive untouched — key casing is NEVER normalized", () => {
  const out = normalizeBody({
    token: "aaa.bbb.ccc",
    user_id: "learner-1",
    tenant_id: "hikmah-pilot-erbil",
    role: "learner",
    audit_event_id: `audit-${UUID_A}`,
  });
  assert.deepEqual(Object.keys(out), ["token", "user_id", "tenant_id", "role", "audit_event_id"]);
  assert.equal(out.user_id, "learner-1", "a known id must stay literal");
  assert.equal(out.tenant_id, "hikmah-pilot-erbil");
});

// --- the explicit allowlist, not a name pattern ---

test("known *Id fields stay literal — they are the strongest assertions in a fixture", () => {
  const out = normalizeBody({
    learnerId: "learner-1",
    tenantId: "hikmah-pilot-erbil",
    userId: "teacher-1",
    wordId: "1:1:1",
  });
  assert.deepEqual(out, {
    learnerId: "learner-1",
    tenantId: "hikmah-pilot-erbil",
    userId: "teacher-1",
    wordId: "1:1:1",
  });
});

test("seeded ids are not uuid-suffixed, so they stay literal", () => {
  assert.equal(normalizeBody({ id: "learner-1" }).id, "learner-1");
  assert.equal(normalizeBody({ id: "hikmah-pilot-erbil" }).id, "hikmah-pilot-erbil");
});

test("the id PREFIX is preserved — it names the entity type and is contractual", () => {
  const out = normalizeBody({ id: `recitation-session-${UUID_A}` });
  assert.equal(out.id, "<ID:recitation-session#1>", "a port using a different prefix must fail");
});

test("a bare uuid normalizes without a prefix", () => {
  assert.equal(normalizeBody({ id: UUID_A }).id, "<UUID#1>");
});

// --- raising, not silently passing ---

test("a non-ISO timestamp RAISES rather than being committed verbatim", () => {
  assert.throws(() => normalizeBody({ startedAt: "yesterday" }), NormalizeError);
});

test("a token that is neither JWT, uuid, nor rt_v2 ticket RAISES", () => {
  // Refusing here is what stops an unrecognised secret-shaped value reaching a committed fixture.
  assert.throws(() => normalizeBody({ token: "hunter2" }), NormalizeError);
});

test("a non-uuid csrf token RAISES", () => {
  assert.throws(() => normalizeBody({ csrfToken: "abc" }), NormalizeError);
});

test("a non-uuid trace id RAISES — the format changed or the field is mis-classified", () => {
  assert.throws(() => normalizeBody({ trace_id: "42" }), NormalizeError);
});

test("recognised token shapes are accepted and replaced", () => {
  assert.equal(normalizeBody({ token: "aaa.bbb.ccc" }).token, "<JWT#1>");
  assert.equal(normalizeBody({ token: UUID_A }).token, "<TOKEN#1>");
  assert.equal(
    normalizeBody({ token: "rt_v2.s.t.l.true.discard.123.nonce.sig" }).token,
    "<RT_TICKET#1>",
  );
});

// --- structure ---

test("nested objects and arrays are walked", () => {
  const out = normalizeBody({
    alignments: [
      { id: `align-${UUID_A}`, wordId: "1:1:1", status: "matched" },
      { id: `align-${UUID_B}`, wordId: "1:1:2", status: "missed" },
    ],
  });
  assert.equal(out.alignments[0].id, "<ID:align#1>");
  assert.equal(out.alignments[1].id, "<ID:align#2>");
  assert.equal(out.alignments[0].wordId, "1:1:1", "known ids untouched inside arrays");
  assert.equal(out.alignments[1].status, "missed");
});

test("null and non-string values pass through", () => {
  const out = normalizeBody({ id: null, count: 42, ok: true, note: null });
  assert.deepEqual(out, { id: null, count: 42, ok: true, note: null });
});

// --- canonical output ---

test("canonicalJson sorts keys and ends with a newline", () => {
  const s = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(s, '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
});

test("canonicalJson is stable for equal objects with different insertion order", () => {
  assert.equal(canonicalJson({ x: 1, y: 2 }), canonicalJson({ y: 2, x: 1 }));
});
