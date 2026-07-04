// Unit tests for the rule-based tajweed engine (services/ml-inference/tajweed.js).
// These assert CORRECT hafs behavior (not merely current behavior), using the ACTUAL word forms of
// the bundled alquran.cloud quran-uthmani edition — where the common noon-sakin particles (مِن, مَن,
// عَن …) are written with a BARE final noon (no explicit sukoon), and tanween is often followed by a
// small Uthmani annotation mark. The negative tests pin the fixed bugs: madd-tabii keyed off the
// wrong diacritics, and a bare-noon match that false-fired ghunnah / idgham / iqlab / ikhfa on a
// VOWELED noon.

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWord, analyzeAyah } from "./tajweed.js";

const rules = (word) => analyzeWord("w", word).map((f) => f.rule);
const ayahRules = (...texts) =>
  analyzeAyah(
    "a",
    texts.map((text, i) => ({ id: String(i + 1), text })),
  ).map((f) => f.rule);

test("madd tabii fires on a base short vowel + its homogeneous long letter", () => {
  assert.ok(rules("قَالَ").includes("madd-tabii"), "fatha + alef (قَا)");
  assert.ok(rules("ٱلرَّحِيمِ").includes("madd-tabii"), "kasra + ya (حِي)");
  assert.ok(rules("نُور").includes("madd-tabii"), "damma + waw (نُو)");
});

test("madd tabii does NOT fire when there is no homogeneous long vowel", () => {
  assert.ok(!rules("مَن").includes("madd-tabii"));
});

test("ghunnah fires on a noon-sakin (bare or marked) or tanween", () => {
  assert.ok(rules("مِن").includes("ghunnah"), "bare final noon = implicitly sakin");
  assert.ok(rules("مِنْ").includes("ghunnah"), "explicit noon+sukoon");
  assert.ok(rules("كِتَابٌ").includes("ghunnah"), "tanween (ٌ)");
});

test("ghunnah does NOT fire on a VOWELED noon (the over-firing bug)", () => {
  // Each has a noon carrying a short vowel, not sukoon/tanween → no ghunnah. The old rule matched a
  // bare noon anywhere and fired on all of them.
  assert.ok(!rules("نَعْبُدُ").includes("ghunnah"), "noon + fatha at start");
  assert.ok(!rules("نَا").includes("ghunnah"), "noon + fatha");
  assert.ok(!rules("ٱلَّذِينَ").includes("ghunnah"), "noon + fatha at end");
});

test("qalqalah fires on a qalqalah letter carrying sukoon; not otherwise", () => {
  assert.ok(rules("أَقْرَب").includes("qalqalah"), "qaf + sukoon (قْ)");
  assert.ok(!rules("لَكَ").includes("qalqalah"), "no qalqalah letter with sukoon");
});

test("tafkhim fires on an isti'la letter; a fully-muraqqaq word has none", () => {
  assert.ok(rules("قَالَ").includes("tafkhim"), "contains qaf");
  assert.ok(!rules("لَكَ").includes("tafkhim"), "no isti'la letter");
});

test("inter-word iqlab: a noon-sakin/tanween word followed by baa", () => {
  // Bare final noon (the real bundle form of مِن), and tanween — both before a word starting with baa.
  assert.ok(ayahRules("مِن", "بَعْدِ").includes("iqlab"), "bare noon-sakin + baa");
  // Tanween followed by the Uthmani small-meem iqlab mark (U+06E2), the real form in 2:10 أَلِيمٌۢ.
  const tanweenWithMark = "أَلِيمٌۢ"; // أَلِيمٌۢ
  assert.ok(ayahRules(tanweenWithMark, "بِمَا").includes("iqlab"), "tanween + trailing mark + baa");
});

test("inter-word: NO iqlab/idgham/ikhfa after a word ending in a VOWELED noon (the bug)", () => {
  // ٱلَّذِينَ ends in a voweled noon (نَ) → no noon rule across the boundary, despite baa next. The
  // old rule stripped ALL harakat then matched a final noon.
  const r = ayahRules("ٱلَّذِينَ", "بَعْدِ");
  assert.ok(!r.includes("iqlab"));
  assert.ok(!r.includes("idgham"));
  assert.ok(!r.includes("ikhfa"));
});

test("inter-word: idgham (noon-sakin + yaa) and ikhfa (noon-sakin + qaf)", () => {
  // Real bundle forms: bare مَن يَعْمَلْ (4:123) and bare مِن قَبْلِكَ.
  assert.ok(ayahRules("مَن", "يَعْمَلْ").includes("idgham"), "bare noon sakin + ya → idgham");
  assert.ok(ayahRules("مِن", "قَبْلِكَ").includes("ikhfa"), "bare noon sakin + qaf → ikhfa");
});

// KNOWN LIMITATION (for scholar review, not yet implemented): ghunnah also applies to a noon or meem
// MUSHADDAD (نّ / مّ). The engine currently reports only "shaddah" for these, not "ghunnah".
test(
  "ghunnah on noon/meem mushaddad (إِنَّ, ثُمَّ)",
  { todo: "mushaddad ghunnah not yet implemented — flagged for scholar review" },
  () => {
    assert.ok(rules("إِنَّ").includes("ghunnah"), "noon mushaddad");
    assert.ok(rules("ثُمَّ").includes("ghunnah"), "meem mushaddad");
  },
);
