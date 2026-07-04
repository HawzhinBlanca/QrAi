// Unit tests for the deterministic Quran-constrained alignment engine.
// Hermetic (no network, no DB) — run by `node --test` in the CODYSTEM gate.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeArabic,
  similarity,
  alignWords,
  calculateConfidence,
} from "./alignment.js";

test("normalizeArabic strips tashkeel and unifies alef/ya variants", () => {
  // بِسْمِ (with harakat) → بسم ; different alef forms collapse to bare alef.
  assert.equal(normalizeArabic("بِسْمِ"), "بسم");
  assert.equal(normalizeArabic("أإآٱ"), "اااا");
  assert.equal(normalizeArabic("علىٰ"), "علي");
  assert.equal(normalizeArabic("  الرَّحْمَٰنِ  "), "الرحمن");
});

test("similarity is 1.0 for identical (post-normalization) words and lower for edits", () => {
  assert.equal(similarity("بِسْمِ", "بسم"), 1.0);
  assert.equal(similarity("", ""), 1.0);
  const s = similarity("الرحمن", "الرحمان");
  assert.ok(s > 0 && s < 1, `expected partial similarity, got ${s}`);
});

test("alignWords marks exact recitation as all matched", () => {
  const canonical = [
    { id: "1:1:1", text: "بِسْمِ" },
    { id: "1:1:2", text: "اللَّهِ" },
    { id: "1:1:3", text: "الرَّحْمَٰنِ" },
  ];
  const results = alignWords(canonical, ["بسم", "الله", "الرحمن"]);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === "matched"), JSON.stringify(results));
  assert.equal(calculateConfidence(results), 1.0);
});

test("alignWords flags a skipped word as missed", () => {
  const canonical = [
    { id: "1:1:1", text: "بسم" },
    { id: "1:1:2", text: "الله" },
  ];
  // Only the first word recited; second is missed.
  const results = alignWords(canonical, ["بسم"]);
  const byId = Object.fromEntries(results.map((r) => [r.wordId, r.status]));
  assert.equal(byId["1:1:1"], "matched");
  assert.equal(byId["1:1:2"], "missed");
});

const FATIHA = [
  { id: "1:1:1", text: "بسم" },
  { id: "1:1:2", text: "الله" },
  { id: "1:1:3", text: "الرحمن" },
  { id: "1:1:4", text: "الرحيم" },
];
const canonicalStatuses = (recognized) =>
  alignWords(FATIHA, recognized)
    .filter((r) => r.canonicalText) // canonical rows only (drop "extra" rows)
    .map((r) => r.status);

test("alignWords: global alignment survives insertions/repeats without desyncing (the window-desync fix)", () => {
  // The old greedy window centered on the CANONICAL index desynced once a reciter inserted/repeated
  // more than 2 words, scoring correctly-recited words as missed. The global alignment matches them.
  // 3 filler tokens BEFORE the real ayah:
  assert.deepEqual(canonicalStatuses(["اه", "اه", "اه", "بسم", "الله", "الرحمن", "الرحيم"]), [
    "matched",
    "matched",
    "matched",
    "matched",
  ]);
  // Self-correction: repeat the first word, then recite correctly:
  assert.deepEqual(canonicalStatuses(["بسم", "بسم", "الله", "الرحمن", "الرحيم"]), [
    "matched",
    "matched",
    "matched",
    "matched",
  ]);
  // Insertion in the middle:
  assert.deepEqual(canonicalStatuses(["بسم", "الله", "اه", "الرحمن", "الرحيم"]), [
    "matched",
    "matched",
    "matched",
    "matched",
  ]);
  // The inserted/filler/repeat tokens are reported as "extra", not silently consumed.
  const repeat = alignWords(FATIHA, ["بسم", "بسم", "الله", "الرحمن", "الرحيم"]);
  assert.equal(repeat.filter((r) => r.status === "extra").length, 1);
  assert.equal(calculateConfidence(repeat), 1.0);
});

test("alignWords still detects a genuinely missed word (a real error is not masked)", () => {
  // The reciter skips الرحمن entirely.
  const results = alignWords(FATIHA, ["بسم", "الله", "الرحيم"]);
  const byId = Object.fromEntries(results.map((r) => [r.wordId, r.status]));
  assert.equal(byId["1:1:1"], "matched");
  assert.equal(byId["1:1:3"], "missed"); // الرحمن
  assert.equal(byId["1:1:4"], "matched"); // الرحيم aligned to the last recited word, not desynced
});

test("alignWords is ORDER-STRICT — a word transposition is flagged, not silently accepted", () => {
  // Quran recitation is order-critical. The global alignment is monotonic (matches can't cross), so
  // swapping two adjacent words scores one correct + one missed rather than "both fine". This
  // intentionally flags a wrong-order recitation for review instead of auto-accepting it as the old
  // local-window matcher did. Trade-off: an ASR that mis-orders two acoustically-close words yields a
  // needless review — acceptable, since order errors are real recitation errors worth surfacing.
  const results = alignWords(
    [
      { id: "c1", text: "الرحمن" },
      { id: "c2", text: "الرحيم" },
    ],
    ["الرحيم", "الرحمن"], // transposed
  );
  const statuses = results.filter((r) => r.canonicalText).map((r) => r.status);
  assert.ok(
    statuses.includes("missed"),
    `a transposition should flag a word, got ${JSON.stringify(statuses)}`,
  );
});

test("calculateConfidence weights needs-review above misread and below matched", () => {
  // Regression: needs-review must NOT score 0 (it used to tie with 'missed').
  assert.equal(calculateConfidence([{ status: "matched" }]), 1.0);
  assert.equal(calculateConfidence([{ status: "needs-review" }]), 0.8);
  assert.equal(calculateConfidence([{ status: "misread" }]), 0.5);
  assert.equal(calculateConfidence([{ status: "missed" }]), 0.0);
  assert.equal(calculateConfidence([{ status: "extra" }]), 0.0);

  // Monotonic: better recitation → higher confidence.
  const good = calculateConfidence([{ status: "matched" }, { status: "needs-review" }]);
  const worse = calculateConfidence([{ status: "matched" }, { status: "misread" }]);
  assert.ok(good > worse, `needs-review (${good}) should beat misread (${worse})`);

  // An ayah recited entirely at 0.85–0.94 similarity is no longer reported as 0%.
  const allNeedsReview = calculateConfidence([
    { status: "needs-review" },
    { status: "needs-review" },
  ]);
  assert.equal(allNeedsReview, 0.8);
});

test("calculateConfidence returns 0 for an empty result set", () => {
  assert.equal(calculateConfidence([]), 0);
});

test("calculateConfidence scores canonical accuracy — a stray 'extra' word can't lower a perfect recitation", () => {
  // All canonical words matched, plus one ASR-noise "extra" token. This previously scored 2/3 ≈ 0.67
  // (extra counted in the denominator) and could force needless teacher review; now it is 1.0.
  assert.equal(
    calculateConfidence([{ status: "matched" }, { status: "matched" }, { status: "extra" }]),
    1.0,
  );
  // A genuinely missed canonical word still lowers the score (independent of extras).
  assert.equal(
    calculateConfidence([{ status: "matched" }, { status: "missed" }, { status: "extra" }]),
    0.5, // 1.0 over 2 canonical words
  );
  // All extras (nothing canonical recited) stays 0.
  assert.equal(calculateConfidence([{ status: "extra" }, { status: "extra" }]), 0);
});
