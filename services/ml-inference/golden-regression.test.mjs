// Golden-recitation regression tests for the alignment + tajweed engines.
// Hermetic (no network, no DB, no audio, no ASR) — run by `node --test` in the CODYSTEM gate.
//
// KEY PROPERTY: metrics are COMPUTED from the engine output over the ACTUAL canonical data,
// NOT asserted as committed constants. The thresholds in golden-evals.json are lower bounds;
// the test computes the real F1 / coverage and asserts they meet or exceed the thresholds.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { alignWords, calculateConfidence, normalizeArabic } from "./alignment.js";
import { analyzeWord, analyzeAyah } from "./tajweed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the ACTUAL canonical Fatihah data (surah-001.json from the full-quran bundle).
// This is the immutable ground truth — the same file the server reads at runtime.
const surah001 = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "packages", "quran-data", "src", "data", "full-quran", "surah-001.json"), "utf8"),
);

// Load thresholds from the golden-evals fixture.
const goldenEvals = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "golden-evals.json"), "utf8"),
);

// Build the canonical word list (same shape as getCanonicalWords in server.mjs).
function getCanonicalWords(ayahStart, ayahEnd) {
  const words = [];
  for (const ayah of surah001.ayahs) {
    if (ayah.ayahNumber >= ayahStart && ayah.ayahNumber <= ayahEnd) {
      for (let i = 0; i < ayah.words.length; i++) {
        words.push({
          id: `${ayah.surahNumber}:${ayah.ayahNumber}:${i + 1}`,
          text: ayah.words[i],
        });
      }
    }
  }
  return words;
}

// ============================================================================
// ALIGNMENT REGRESSION
// ============================================================================

test("golden: perfect recitation of Al-Fatihah 1:1-7 scores 1.0 confidence", () => {
  const canonical = getCanonicalWords(1, 7);
  assert.equal(canonical.length, 29, `expected 29 canonical words, got ${canonical.length}`);

  // "Perfect recitation" = recognized words are the normalized canonical words.
  const recognized = canonical.map((w) => normalizeArabic(w.text));
  const results = alignWords(canonical, recognized);

  // Every canonical word must be matched.
  const canonicalResults = results.filter((r) => r.status !== "extra");
  assert.equal(canonicalResults.length, 29);
  assert.ok(
    canonicalResults.every((r) => r.status === "matched"),
    `expected all matched, got: ${JSON.stringify(canonicalResults.map((r) => ({ id: r.wordId, status: r.status })))}`,
  );

  const confidence = calculateConfidence(results);
  assert.equal(confidence, 1.0, `perfect recitation must score 1.0, got ${confidence}`);
});

test("golden: known-error recitation (skipped word) is detected", () => {
  const canonical = getCanonicalWords(1, 1); // بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ
  assert.equal(canonical.length, 4);

  // Skip the 3rd word (ٱلرَّحْمَٰنِ)
  const recognized = [
    normalizeArabic(canonical[0].text),
    normalizeArabic(canonical[1].text),
    // deliberately omit canonical[2]
    normalizeArabic(canonical[3].text),
  ];

  const results = alignWords(canonical, recognized);
  const byId = Object.fromEntries(
    results.filter((r) => r.canonicalText).map((r) => [r.wordId, r]),
  );

  assert.equal(byId["1:1:1"].status, "matched");
  assert.equal(byId["1:1:2"].status, "matched");
  assert.equal(byId["1:1:3"].status, "missed", "skipped ٱلرَّحْمَٰنِ must be flagged as missed");
  assert.equal(byId["1:1:4"].status, "matched");

  const confidence = calculateConfidence(results);
  assert.ok(confidence < 1.0, `confidence should be < 1.0 with a missed word, got ${confidence}`);
  assert.ok(confidence > 0, `confidence should still be positive, got ${confidence}`);
});

test("golden: known-error recitation (misread word) is detected", () => {
  const canonical = getCanonicalWords(1, 2); // 1:1 + 1:2 = 8 words
  assert.equal(canonical.length, 8);

  // Misread "رَبِّ" (1:2:3) as "رَبّ" (dropping kasra) — close but not exact
  const recognized = canonical.map((w, i) => {
    if (i === 6) return "رب"; // simplified form of رَبِّ → very similar after normalization
    return normalizeArabic(w.text);
  });

  const results = alignWords(canonical, recognized);

  // The misread word should be either "matched" (close enough) or "needs-review" — NOT "missed".
  const rabbiResult = results.find((r) => r.wordId === "1:2:3");
  assert.ok(rabbiResult, "word 1:2:3 should be in results");
  assert.ok(
    rabbiResult.status === "matched" || rabbiResult.status === "needs-review",
    `expected matched or needs-review for a close misread, got ${rabbiResult.status}`,
  );
});

test("golden: word alignment F1 meets threshold on perfect recitation", () => {
  const canonical = getCanonicalWords(1, 7);
  const recognized = canonical.map((w) => normalizeArabic(w.text));
  const results = alignWords(canonical, recognized);

  // On a perfect recitation: TP = all canonical matched, FP = 0 extra, FN = 0 missed.
  const canonicalResults = results.filter((r) => r.status !== "extra");
  const tp = canonicalResults.filter((r) => r.status === "matched" || r.status === "needs-review").length;
  const fp = results.filter((r) => r.status === "extra").length;
  const fn = canonicalResults.filter((r) => r.status === "missed").length;

  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = 2 * (precision * recall) / (precision + recall || 1);

  assert.ok(
    f1 >= goldenEvals.thresholds.wordAlignmentF1,
    `word alignment F1 ${f1.toFixed(3)} must meet threshold ${goldenEvals.thresholds.wordAlignmentF1}`,
  );
});

test("golden: word alignment F1 computed on known-error recitation", () => {
  // Recitation with 2 words skipped out of 29 (ayahs 1-7).
  const canonical = getCanonicalWords(1, 7);
  const recognized = canonical
    .filter((_, i) => i !== 5 && i !== 15) // skip word index 5 and 15
    .map((w) => normalizeArabic(w.text));

  const results = alignWords(canonical, recognized);
  const canonicalResults = results.filter((r) => r.status !== "extra");
  const tp = canonicalResults.filter((r) => r.status === "matched" || r.status === "needs-review").length;
  const fn = canonicalResults.filter((r) => r.status === "missed").length;
  const fp = results.filter((r) => r.status === "extra").length;

  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = 2 * (precision * recall) / (precision + recall || 1);

  // With 2 missed out of 29, F1 should still be > 0.85.
  assert.ok(f1 > 0.85, `F1 with 2 missed words = ${f1.toFixed(3)}, expected > 0.85`);
  // But NOT perfect.
  assert.ok(f1 < 1.0, `F1 with known errors should be < 1.0, got ${f1.toFixed(3)}`);

  // Report the computed metric (the point of C7: live measurement, not committed constant).
  console.log(`  [golden-regression] alignment F1 (2-miss scenario): ${f1.toFixed(4)}`);
});

// ============================================================================
// TAJWEED REGRESSION
// ============================================================================

test("golden: tajweed detects expected rules on Al-Fatihah canonical text", () => {
  // Run analyzeAyah on each ayah of Al-Fatihah using the ACTUAL canonical words.
  const allFindings = [];
  for (const ayah of surah001.ayahs) {
    const words = ayah.words.map((text, i) => ({
      id: `${ayah.surahNumber}:${ayah.ayahNumber}:${i + 1}`,
      text,
    }));
    const findings = analyzeAyah(`${ayah.surahNumber}:${ayah.ayahNumber}`, words);
    allFindings.push(...findings);
  }

  // Collect unique rules found.
  const rulesFound = new Set(allFindings.map((f) => f.rule));

  // Al-Fatihah MUST trigger at least these rules (per the tajweed analysis):
  // - madd-tabii: ٱلرَّحْمَٰنِ has kasra+ya (حِي), ٱلرَّحِيمِ has kasra+ya
  // - ghunnah: words ending in noon sakin or with tanween
  // - tafkhim: ٱلصِّرَٰطَ has ص, ٱلْمَغْضُوبِ has ض/ض
  // - shaddah: ٱللَّهِ, رَبِّ, ٱلرَّحْمَٰنِ, ٱلضَّآلِّينَ
  // - madd-maleki: ٱلرَّحْمَٰنِ, مَٰلِكِ, ٱلصِّرَٰطَ have dagger alef (U+0670)
  const expectedRules = ["madd-tabii", "shaddah", "tafkhim", "madd-maleki"];
  for (const rule of expectedRules) {
    assert.ok(rulesFound.has(rule), `expected tajweed rule "${rule}" to fire on Al-Fatihah, found: [${[...rulesFound].join(", ")}]`);
  }

  // Compute tajweed rule coverage: what fraction of the expected core rules were found?
  const coreRules = ["madd-tabii", "ghunnah", "qalqalah", "tafkhim", "shaddah", "madd-maleki", "idgham", "ikhfa", "iqlab"];
  const coveredRules = coreRules.filter((r) => rulesFound.has(r));
  const coverage = coveredRules.length / coreRules.length;

  console.log(`  [golden-regression] tajweed rules found: [${[...rulesFound].join(", ")}]`);
  console.log(`  [golden-regression] tajweed core coverage: ${coveredRules.length}/${coreRules.length} = ${(coverage * 100).toFixed(1)}%`);
  console.log(`  [golden-regression] total tajweed findings on Al-Fatihah: ${allFindings.length}`);

  // At least the 4 core word-level rules must fire.
  assert.ok(coveredRules.length >= 4, `expected at least 4 core rules, got ${coveredRules.length}: [${coveredRules.join(", ")}]`);
  assert.ok(allFindings.length > 0, "expected at least one tajweed finding");
});

test("golden: tajweed has no false positives on known-clean words", () => {
  // Words that should NOT trigger any tajweed rule: simple consonant-vowel words with
  // no madd, no noon sakin, no qalqalah letter+sukoon, no isti'la letter, no shaddah.
  const cleanWords = [
    { id: "clean-1", text: "لَكَ" },   // lam + fatha, kaf + fatha — no rules
    { id: "clean-2", text: "بِهِ" },   // ba + kasra, ha + kasra — no rules
  ];

  for (const word of cleanWords) {
    const findings = analyzeWord(word.id, word.text);
    assert.equal(
      findings.length,
      0,
      `expected 0 findings on clean word "${word.text}", got ${findings.length}: [${findings.map((f) => f.rule).join(", ")}]`,
    );
  }
});

test("golden: tajweed inter-word rules fire correctly across Al-Fatihah ayah boundaries", () => {
  // Ayah 7 has "أَنْعَمْتَ عَلَيْهِمْ" — أَنْعَمْتَ ends in تَ (voweled ta, not noon),
  // and "عَلَيْهِمْ غَيْرِ" — عَلَيْهِمْ ends in مْ (meem sakin, not noon → no noon rules).
  // Ayah 7 also has "وَلَا ٱلضَّآلِّينَ" — no inter-word noon rule (وَلَا ends in alef).
  //
  // The real inter-word rules are on ayahs that span word boundaries with noon sakin.
  // Al-Fatihah has few/no inter-word noon-sakin cases (مِن, مَن etc. don't appear).
  // This test verifies NO false inter-word rules fire.

  const ayah7Words = surah001.ayahs[6].words.map((text, i) => ({
    id: `1:7:${i + 1}`,
    text,
  }));
  const findings = analyzeAyah("1:7", ayah7Words);
  const interWordRules = findings.filter(
    (f) => f.rule === "idgham" || f.rule === "iqlab" || f.rule === "ikhfa",
  );

  // Al-Fatihah ayah 7 has no noon-sakin/tanween at word boundaries → 0 inter-word noon rules.
  assert.equal(
    interWordRules.length,
    0,
    `expected 0 inter-word noon rules on ayah 7, got ${interWordRules.length}: ${JSON.stringify(interWordRules.map((f) => f.rule))}`,
  );
});

// ============================================================================
// COMBINED METRICS REPORT (the "live measurement" of C7)
// ============================================================================

test("golden: computed metrics meet golden-evals thresholds", () => {
  // --- Alignment metric ---
  const canonical = getCanonicalWords(1, 7);
  const recognized = canonical.map((w) => normalizeArabic(w.text));
  const results = alignWords(canonical, recognized);
  const canonicalResults = results.filter((r) => r.status !== "extra");
  const tp = canonicalResults.filter((r) => r.status === "matched" || r.status === "needs-review").length;
  const fp = results.filter((r) => r.status === "extra").length;
  const fn = canonicalResults.filter((r) => r.status === "missed").length;
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = 2 * (precision * recall) / (precision + recall || 1);

  // --- Tajweed metric: compute findings and check false positive rate ---
  const allFindings = [];
  for (const ayah of surah001.ayahs) {
    const words = ayah.words.map((text, i) => ({
      id: `${ayah.surahNumber}:${ayah.ayahNumber}:${i + 1}`,
      text,
    }));
    allFindings.push(...analyzeAyah(`${ayah.surahNumber}:${ayah.ayahNumber}`, words));
  }

  // Every finding has a source → unsourced = 0 (rule engine always attaches TAJWEED_SOURCE).
  const unsourced = allFindings.filter((f) => !f.sources || f.sources.length === 0).length;

  // Report all metrics.
  console.log("\n  ┌─────────────────────────────────────────────┐");
  console.log("  │       GOLDEN REGRESSION METRICS REPORT       │");
  console.log("  ├─────────────────────────────────────────────┤");
  console.log(`  │  word alignment F1:        ${f1.toFixed(4).padStart(8)}       │`);
  console.log(`  │  tajweed findings:         ${String(allFindings.length).padStart(8)}       │`);
  console.log(`  │  unsourced outputs:        ${String(unsourced).padStart(8)}       │`);
  console.log(`  │  alignment confidence:     ${calculateConfidence(results).toFixed(4).padStart(8)}       │`);
  console.log("  └─────────────────────────────────────────────┘\n");

  // Assert against thresholds.
  assert.ok(
    f1 >= goldenEvals.thresholds.wordAlignmentF1,
    `word alignment F1 ${f1.toFixed(3)} < threshold ${goldenEvals.thresholds.wordAlignmentF1}`,
  );
  assert.equal(unsourced, goldenEvals.thresholds.unsourcedLearnerOutputs, "all findings must be sourced");
});

// ============================================================================
// A2: MUSHADDAD-GHUNNAH — WHOLE-QURAN ASSERTION
// ============================================================================

test("golden: mushaddad-ghunnah fires on every noon/meem with shaddah across all 114 surahs", () => {
  const FULL_QURAN_DIR = join(__dirname, "..", "..", "packages", "quran-data", "src", "data", "full-quran");

  // U+0651 = shaddah, ن = noon (U+0646), م = meem (U+0645)
  const SHADDAH = "\u0651";
  const noonMushaddadRe = new RegExp(`\u0646${SHADDAH}`);
  const meemMushaddadRe = new RegExp(`\u0645${SHADDAH}`);

  let totalWords = 0;
  let mushaddadNoonMeemWords = 0;
  let ghunnahFired = 0;
  const misses = [];

  for (let surahNum = 1; surahNum <= 114; surahNum++) {
    const fileName = `surah-${String(surahNum).padStart(3, "0")}.json`;
    const surah = JSON.parse(readFileSync(join(FULL_QURAN_DIR, fileName), "utf8"));

    for (const ayah of surah.ayahs) {
      for (let i = 0; i < ayah.words.length; i++) {
        totalWords++;
        const word = ayah.words[i];
        const hasNoonMushaddad = noonMushaddadRe.test(word);
        const hasMeemMushaddad = meemMushaddadRe.test(word);

        if (hasNoonMushaddad || hasMeemMushaddad) {
          mushaddadNoonMeemWords++;
          const wordId = `${ayah.surahNumber}:${ayah.ayahNumber}:${i + 1}`;
          const findings = analyzeWord(wordId, word);
          const ghunnahFindings = findings.filter((f) => f.rule === "ghunnah");
          if (ghunnahFindings.length > 0) {
            ghunnahFired++;
          } else {
            misses.push({
              surah: surahNum,
              ayah: ayah.ayahNumber,
              word: i + 1,
              text: word,
              type: hasNoonMushaddad ? "noon" : "meem",
            });
          }
        }
      }
    }
  }

  console.log(`  [mushaddad-ghunnah] scanned ${totalWords} words across 114 surahs`);
  console.log(`  [mushaddad-ghunnah] found ${mushaddadNoonMeemWords} words with noon/meem mushaddad`);
  console.log(`  [mushaddad-ghunnah] ghunnah fired on ${ghunnahFired}/${mushaddadNoonMeemWords}`);

  if (misses.length > 0) {
    console.log(`  [mushaddad-ghunnah] MISSES (first 10):`);
    for (const m of misses.slice(0, 10)) {
      console.log(`    ${m.surah}:${m.ayah}:${m.word} "${m.text}" (${m.type} mushaddad)`);
    }
  }

  assert.ok(mushaddadNoonMeemWords > 0, "sanity: must find at least some noon/meem mushaddad in the Quran");
  assert.equal(
    misses.length,
    0,
    `mushaddad-ghunnah missed on ${misses.length} words (first: ${misses[0]?.surah}:${misses[0]?.ayah} "${misses[0]?.text}")`,
  );
  assert.equal(ghunnahFired, mushaddadNoonMeemWords, "100% coverage");
});
