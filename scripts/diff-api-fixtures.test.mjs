import assert from "node:assert/strict";
import test from "node:test";

import { comparePlaceholderEquivalent } from "./lib/fixture-normalize.mjs";

// F4 tests — specs/api-golden-fixtures/plan.md
//
// A differ that always passes is indistinguishable from a correct one, so the important half of
// these tests asserts it FAILS on deliberately altered fixtures. Same discipline as the Phase 4
// restore drill, where truncating a table proved the row-count verification had teeth.
//
// The comparison logic is tested directly rather than through a live HTTP replay: it is the part
// that decides pass/fail, and it needs no server.

const ok = (a, b) => assert.equal(comparePlaceholderEquivalent(a, b), null);
const fails = (a, b, match) => {
  const d = comparePlaceholderEquivalent(a, b);
  assert.ok(d !== null, "expected a difference, got none");
  if (match) assert.match(d, match);
  return d;
};

// --- passes where it should ---

test("identical documents match", () => {
  ok({ status: "ok", learnerId: "learner-1" }, { status: "ok", learnerId: "learner-1" });
});

test("different placeholder ORDINALS still match — they are assignment-order dependent", () => {
  // The capture numbered this session #2; a replay numbers it #1. Same entity, different ordinal.
  ok({ id: "<ID:session#2>" }, { id: "<ID:session#1>" });
});

test("a consistent renaming across several placeholders matches", () => {
  ok(
    { a: "<ID:session#1>", b: "<ID:session#2>", c: "<ID:session#1>" },
    { a: "<ID:session#7>", b: "<ID:session#9>", c: "<ID:session#7>" },
  );
});

// --- THE failure cases: these are why the differ is worth running ---

test("FAILS when a status-like value differs", () => {
  fails({ status: "matched" }, { status: "missed" }, /expected "matched", got "missed"/);
});

test("FAILS when an error message string differs — the messages are wire contract", () => {
  fails(
    { error: "source references are required for scholar-approved content" },
    { error: "sources required" },
    /expected .*source references/,
  );
});

test("FAILS when snake_case is camelCased — the /v1/auth/token regression", () => {
  // A Node port with a global camelCase serializer produces exactly this, and it silently breaks
  // every caller of that route.
  fails(
    { token: "<JWT#1>", user_id: "learner-1", tenant_id: "t1" },
    { token: "<JWT#1>", userId: "learner-1", tenantId: "t1" },
    /keys differ/,
  );
});

test("FAILS when a reference is LOST — one expected placeholder mapping to two actual ones", () => {
  // The failure that matters most: a port that returns a different session from GET than it
  // created on POST. Ordinal-tolerant comparison must still catch this.
  fails(
    { created: "<ID:session#1>", readBack: "<ID:session#1>" },
    { created: "<ID:session#1>", readBack: "<ID:session#2>" },
    /already bound/,
  );
});

test("FAILS when two distinct entities collapse into one", () => {
  // The inverse: the port reused one id where the fixture had two distinct ones.
  fails(
    { a: "<ID:session#1>", b: "<ID:session#2>" },
    { a: "<ID:session#5>", b: "<ID:session#5>" },
    /already bound/,
  );
});

test("FAILS when a placeholder FAMILY differs — a JWT is not an id", () => {
  fails({ token: "<JWT#1>" }, { token: "<ID:session#1>" }, /family differs/);
});

test("FAILS when a placeholder is replaced by a literal value", () => {
  // Catches a port that leaks a raw id where the contract expects a generated one — and would also
  // catch a fixture that accidentally baked in a real value.
  fails({ id: "<ID:session#1>" }, { id: "session-abc" });
});

test("FAILS when an array length differs", () => {
  fails({ items: [1, 2, 3] }, { items: [1, 2] }, /expected 3 element\(s\), got 2/);
});

test("FAILS when a key is missing entirely", () => {
  fails({ a: 1, b: 2 }, { a: 1 }, /keys differ/);
});

test("FAILS when a nested value differs, and names the path", () => {
  fails(
    { session: { consent: { audioRetention: "discard" } } },
    { session: { consent: { audioRetention: "training-opt-in" } } },
    /\$\.session\.consent\.audioRetention/,
  );
});

test("FAILS on a type change that JSON would otherwise tolerate", () => {
  fails({ confidence: 0.9 }, { confidence: "0.9" });
  fails({ items: [] }, { items: {} }, /array\/non-array/);
});
