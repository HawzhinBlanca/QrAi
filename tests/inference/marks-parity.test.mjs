import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { alignWords, isNonRecitedMark } from "../../server/src/inference/alignment.mjs";

// T2 — specs/canonical-corpus-marks/plan.md
//
// services/ml-inference is NOT a pnpm workspace member, so it cannot import @quran-ai/contracts and
// `isNonRecitedMark` has to be duplicated here. This file is the pin that stops the two copies from
// drifting: it reads the SAME fixture corpus the TypeScript suite reads and asserts identical
// results. That corpus (built in MIG3) exists for exactly this cross-runtime problem.

const FIXTURE = "../../packages/contracts/fixtures/canonical-gates.json";

test("isNonRecitedMark agrees with the shared contracts fixture, case for case", () => {
  const fixture = JSON.parse(readFileSync(new URL(FIXTURE, import.meta.url), "utf8"));
  const group = fixture.isNonRecitedMark;
  assert.ok(group, "fixture group isNonRecitedMark is missing — did the corpus move?");
  assert.ok(group.cases.length > 0, "fixture group has no cases (would pass vacuously)");

  for (const c of group.cases) {
    // Built from codepoints, never literal characters — the marks are invisible in a diff.
    const input = String.fromCodePoint(...c.inputCodepoints);
    assert.equal(
      isNonRecitedMark(input),
      c.expected,
      `${c.name}: ml-inference disagrees with the contracts fixture`,
    );
  }
});

// --- alignWords must not score marks, and must not let them perturb neighbours ---

const WAQF = String.fromCodePoint(0x06da); // small high jeem
const w = (id, text) => ({ id, text });

test("alignWords returns no alignment for a mark token", () => {
  const canonical = [w("2:2:1", "ذَٰلِكَ"), w("2:2:2", WAQF), w("2:2:3", "فِيهِ")];
  const results = alignWords(canonical, ["ذلك", "فيه"]);

  assert.equal(results.length, 2, "a mark must not produce an alignment row");
  assert.deepEqual(
    results.map((r) => r.wordId),
    ["2:2:1", "2:2:3"],
    "only the recited words are scored",
  );
});

test("a mark does not perturb its neighbours' statuses (the distortion this fixes)", () => {
  // Same recitation, same real words — once with a mark between them, once without. The statuses of
  // the real words must be identical. Before the fix the aligner had to place the silent mark, which
  // shifted the surrounding spans.
  const withMark = alignWords(
    [w("2:2:1", "ذَٰلِكَ"), w("2:2:2", WAQF), w("2:2:3", "فِيهِ")],
    ["ذلك", "فيه"],
  );
  const withoutMark = alignWords([w("2:2:1", "ذَٰلِكَ"), w("2:2:3", "فِيهِ")], ["ذلك", "فيه"]);

  assert.deepEqual(
    withMark.map((r) => [r.wordId, r.status]),
    withoutMark.map((r) => [r.wordId, r.status]),
    "statuses must match an ayah that never had a mark",
  );
});

test("a mark is not scored even when the learner recites nothing", () => {
  // The original bug's worst face: a silent symbol reported as a MISSED word the learner failed to say.
  const results = alignWords([w("7:206:1", "وَلَهُ"), w("7:206:2", String.fromCodePoint(0x06e9))], []);
  assert.equal(results.length, 1);
  assert.equal(results[0].wordId, "7:206:1");
  assert.ok(
    !results.some((r) => r.wordId === "7:206:2"),
    "a sajdah mark must never be reported as missed",
  );
});

test("a real word carrying a mark is still scored", () => {
  // The loose-rule failure mode: dropping real words. Worse than the bug being fixed.
  const results = alignWords([w("1:1:1", `بِسْمِ${WAQF}`)], ["بسم"]);
  assert.equal(results.length, 1, "a word with a trailing mark must still be scored");
  assert.equal(results[0].wordId, "1:1:1");
});
