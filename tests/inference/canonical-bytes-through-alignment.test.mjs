/**
 * Canonical Quran bytes survive the alignment engine, proven without the Rust oracle. (W1.7, QA-2)
 *
 *   node --test tests/inference/canonical-bytes-through-alignment.test.mjs
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * `alignWords` compares canonical text against recognized text through `normalizeArabic`, which
 * strips every harakat, folds the alef variants and alef-wasla to bare alef, folds alef-maqsura to
 * yaa, folds taa-marbuta to haa, collapses whitespace and lowercases. That is correct for SCORING —
 * an ASR transcript will not carry mushaf diacritics, and a correct recitation must not be marked
 * wrong for it. It is catastrophic for OUTPUT: the engine also returns `canonicalText`, and that
 * string is the Quran.
 *
 * The gate does catch a mutation that normalizes it — but only in
 * `tests/api-parity/effect-parity.test.mjs`, via "writes the same rows in both implementations",
 * which compares Node against the Rust implementation. Measured: normalizing `canonicalText` leaves
 * all 15 alignment-engine tests, the marks-parity suite, the golden regression and the full
 * session-transcript suite green, and is caught two steps later by the A/B differ needing live
 * Postgres and both services running.
 *
 * That guard is on a deletion schedule. impact-map.md §8.3 retires `services/platform-api` and
 * lists "A/B oracle tests" among what removal affects. On the day the oracle is deleted, the only
 * thing standing between `normalizeArabic` and the canonical text handed to a learner disappears,
 * and nothing at unit level would notice.
 *
 * So this suite asserts the invariant where it cannot evaporate: directly on the engine, with no
 * database, no second implementation and no network.
 *
 * ── Escapes, never literal marks ────────────────────────────────────────────────────────────────
 * Every invisible combining mark in an expected value is written as a `\u` escape, and every
 * failure is reported as a code-point list. Combining marks are invisible in a diff — which is
 * exactly how the forced-aligner's literal-character Arabic class deleted every Arabic letter and
 * passed review (PR #258).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { alignWords, normalizeArabic } from "../../server/src/inference/alignment.mjs";

// ── Canonical words, each carrying a mark `normalizeArabic` would destroy ────────────────────────
// بِسْمِ  — kasra (U+0650) and sukun (U+0652)
const BISMI = "ب\u0650س\u0652م\u0650";
// ذَٰلِكَ — fatha (U+064E) and superscript alef (U+0670)
const DHALIKA = "ذ\u064E\u0670ل\u0650ك\u064E";
// ٱللَّٰه — alef-wasla (U+0671), which normalizeArabic folds to bare alef (U+0627)
const WASLA = "\u0671لل\u0670ه";
// رَحْمَة — taa-marbuta (U+0629), which normalizeArabic folds to haa (U+0647)
const RAHMA = "ر\u064Eح\u0652م\u064Eة";

// What an ASR actually returns for the first three.
//
// HEARD_DHALIKA deliberately keeps its own harakat: the shipped checkpoint
// (`tarteel-ai/whisper-base-ar-quran`) is fine-tuned on Quran text and "returns diacritized Quran
// text" (services/asr-inference/server.py). So a transcript carrying marks is the ordinary
// production case, not a contrivance — and without at least one such token, an assertion that
// `heardText` is unaltered cannot fail, because normalizing an already-bare word is a no-op.
// Measured: with all three heard words bare, a mutation normalizing `heardText` survived this
// entire suite.
const HEARD_BISMI = "بسم";
const HEARD_DHALIKA = "ذ\u064Eل\u0650ك";
const HEARD_WASLA = "الله";

const CANONICAL = [
  { id: "1:1:1", text: BISMI },
  { id: "2:2:1", text: DHALIKA },
  { id: "1:1:2", text: WASLA },
  { id: "1:1:3", text: RAHMA }, // deliberately never recited → the `missed` branch
];

const points = (s) => [...s].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);

/** Equality that says WHICH code point moved, because the strings themselves are unreadable here. */
function assertSameCodePoints(actual, expected, label) {
  assert.deepEqual(
    points(actual),
    points(expected),
    `${label}\n  expected ${points(expected).join(" ")}\n  actual   ${points(actual).join(" ")}`,
  );
  assert.equal(actual, expected, `${label}: strings differ despite matching code points`);
}

function align() {
  return alignWords(
    CANONICAL.map((w) => ({ ...w })),
    [
      { text: HEARD_BISMI, startMs: 0, endMs: 400 },
      { text: HEARD_DHALIKA, startMs: 400, endMs: 900 },
      { text: HEARD_WASLA, startMs: 900, endMs: 1500 },
    ],
  );
}

const canonicalRows = (results) => results.filter((r) => r.status !== "extra");

test("the fixture is only meaningful if normalizeArabic would in fact change these words", () => {
  // Without this, every assertion below could pass on words that normalization leaves alone — a
  // test that cannot fail, dressed as an invariant. Each canonical word must genuinely differ from
  // its normalized form, and each must be scored as a match against its undiacritized transcript.
  for (const [label, word] of [["BISMI", BISMI], ["DHALIKA", DHALIKA], ["WASLA", WASLA], ["RAHMA", RAHMA]]) {
    assert.notEqual(
      normalizeArabic(word),
      word,
      `${label} is unchanged by normalizeArabic, so it cannot detect canonical text being normalized`,
    );
  }
  assert.equal(normalizeArabic(WASLA)[0], "\u0627", "the wasla fixture must fold to bare alef");
  assert.equal(normalizeArabic(RAHMA).at(-1), "\u0647", "the taa-marbuta fixture must fold to haa");

  // The same trap on the heard side. At least one recognized token must itself be changed by
  // normalization, or "heardText is unaltered" is a claim no mutation can violate.
  assert.notEqual(
    normalizeArabic(HEARD_DHALIKA),
    HEARD_DHALIKA,
    "no recognized fixture carries marks, so heardText normalization would go undetected",
  );
});

test("every canonical word crosses the aligner byte for byte, whatever its status", () => {
  const rows = canonicalRows(align());

  assert.equal(rows.length, CANONICAL.length, "the aligner dropped or invented a canonical row");
  for (const [index, row] of rows.entries()) {
    const expected = CANONICAL[index];
    assert.equal(row.wordId, expected.id, `row ${index} is not the canonical word it claims to be`);
    assertSameCodePoints(
      row.canonicalText,
      expected.text,
      `canonical word ${expected.id} (${row.status}) was altered on the way out of alignWords`,
    );
  }
});

test("a MISSED word's canonical text is preserved too — it is the same Quran", () => {
  // The missed branch builds its own result object, so it can drift from the matched branch
  // independently. A word the learner did not recite is still displayed to them.
  const missed = canonicalRows(align()).filter((r) => r.status === "missed");
  assert.equal(missed.length, 1, `expected exactly one missed word, got ${missed.length}`);
  assert.equal(missed[0].wordId, "1:1:3");
  assertSameCodePoints(missed[0].canonicalText, RAHMA, "the missed word's canonical text was altered");
  assert.equal(missed[0].startMs, null, "a missed word must carry no span");
  assert.equal(missed[0].endMs, null, "a missed word must carry no span");
});

test("the marks normalizeArabic removes are individually still present", () => {
  // Named code points rather than whole-string equality, so a failure says which mark vanished
  // instead of printing two visually identical strings.
  const byId = new Map(canonicalRows(align()).map((r) => [r.wordId, r.canonicalText]));

  assert.ok(byId.get("1:1:1").includes("\u0650"), "kasra U+0650 was stripped from the canonical text");
  assert.ok(byId.get("1:1:1").includes("\u0652"), "sukun U+0652 was stripped from the canonical text");
  assert.ok(byId.get("2:2:1").includes("\u064E"), "fatha U+064E was stripped from the canonical text");
  assert.ok(byId.get("2:2:1").includes("\u0670"), "superscript alef U+0670 was stripped from the canonical text");
  assert.equal(byId.get("1:1:2")[0], "\u0671", "alef-wasla U+0671 was folded to bare alef");
  assert.equal(byId.get("1:1:3").at(-1), "\u0629", "taa-marbuta U+0629 was folded to haa");
});

test("the learner's own recognized words are carried unchanged as well", () => {
  // heardText is what the learner is told they said. Normalizing or trimming it would put words in
  // their mouth just as surely as altering the canonical side.
  const rows = canonicalRows(align());
  assertSameCodePoints(rows[0].heardText, HEARD_BISMI, "heardText was altered");
  assertSameCodePoints(rows[1].heardText, HEARD_DHALIKA, "heardText was altered");
  assertSameCodePoints(rows[2].heardText, HEARD_WASLA, "heardText was altered");
  assert.equal(rows[3].heardText, "", "a missed word must not claim the learner said anything");
});

test("scoring still normalizes, so a correct recitation is not punished for lacking diacritics", () => {
  // The other half of the invariant, and the reason normalizeArabic exists at all. If this ever
  // fails, someone has 'fixed' the tests above by removing normalization from the comparison and
  // has started telling correct reciters they are wrong.
  const matched = canonicalRows(align()).filter((r) => r.status === "matched");
  assert.equal(
    matched.length,
    3,
    "undiacritized transcripts of correctly recited words stopped scoring as matched",
  );
});
