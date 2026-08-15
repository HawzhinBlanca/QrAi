/**
 * Rule-Based Tajweed Engine
 */

const QALQALAH_LETTERS = ["ق", "ط", "ب", "ج", "د"];
const IDGHAM_LETTERS = ["ي", "ر", "م", "ل", "و", "ن"];
const IQLAB_LETTER = "ب";
const IKHFA_LETTERS = ["ت", "ث", "ج", "د", "ذ", "ز", "س", "ش", "ص", "ض", "ط", "ظ", "ف", "ق", "ك"];
const TAFKHIM_LETTERS = ["خ", "ص", "ض", "ط", "ظ", "ق"];

const TAJWEED_SOURCE = {
  id: "tajweed-rules-reference",
  title: "Tajweed Rules: Deterministic Text Analysis",
  citation: "Rule-based analysis following standard tajweed rules (Madd, Ghunnah, Qalqalah, Idgham, Iqlab, Ikhfa, Tafkhim)",
};

/**
 * These findings assert NO confidence, and that is the honest value rather than a placeholder.
 *
 * Two separate facts, both true:
 *
 *  1. **Nothing here was ever measured.** There is no model, no dataset, no precision/recall, no
 *     evaluation. The detectors below are deterministic and unit-tested against real Uthmani word
 *     forms (tajweed.test.mjs pins bugs that were genuinely fixed), but "the regex is correct" is not
 *     a confidence. Until this file was corrected each rule carried its own hand-typed decimal —
 *     ikhfa 0.80, idgham 0.82, iqlab 0.83, tafkhim 0.84, madd-maleki 0.85, shaddah 0.86,
 *     qalqalah 0.87, madd-tabii 0.88, ghunnah 0.90 — ranking the rules against one another with
 *     nothing whatsoever behind the ranking.
 *
 *  2. **A text-derived finding says nothing about the learner.** `analyzeWord` reads the canonical
 *     Uthmani text and nothing else: no audio, no transcript, no timing. "An ikhfa occurs here" is
 *     true of the passage and identical for every learner who ever recites it. It is not evidence
 *     that THIS learner did anything, correctly or otherwise. `analysis_basis = 'canonical-text'`
 *     already records that (ADR-0033); this makes the number agree with it.
 *
 * Why it matters beyond honesty: `canShowLearnerFacingAiOutput` (packages/contracts) gates
 * learner-visible AI output on `confidence >= 0.82`. Those nine literals were therefore deciding
 * which rules a learner could ever be shown. ikhfa, at 0.80, could NEVER clear it — a teacher could
 * review an ikhfa finding, approve it, and the learner would still never see it, silently, because
 * of a constant nobody chose for that purpose. idgham sat at exactly 0.82, one hundredth away.
 *
 * `0` is already this codebase's idiom for "no assertion": both learner-gate mirrors zero the
 * confidence when they withhold a finding (ml_proxy.rs:215/245, routes/ml-proxy.mjs:106). So these
 * now fail the confidence gate uniformly and by construction, rather than passing it on fiction.
 * Staff still receive every finding — the analysis is for a teacher to read, which is what
 * `severity: "practice"` and the review queue are for.
 *
 * To make this a real number, an acoustic analyser has to judge the learner's actual recitation and
 * be evaluated against adjudicated labels; findings from one would carry
 * `analysis_basis = 'acoustic'` and a measured confidence. That does not exist yet, and inventing a
 * decimal here would not bring it closer.
 */
const NO_MEASURED_CONFIDENCE = 0;

export function analyzeWord(wordId, word) {
  const findings = [];
  const normalized = word.replace(/\s+/g, "");

  // Madd Tabii
  if (/\u064E\u0627/.test(word) || /\u064F\u0648/.test(word) || /\u0650\u064A/.test(word)) {
    findings.push({
      wordId, rule: "madd-tabii", arabicName: "مد طبيعي", category: "madd",
      severity: "practice",
      explanation: "Hold the natural madd (elongation) for two counts.",
      confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
    });
  }

  // Madd Maleki (dagger alef)
  if (/[\u0670]/.test(word)) {
    findings.push({
      wordId, rule: "madd-maleki", arabicName: "مد ملكي", category: "madd",
      severity: "practice",
      explanation: "Dagger alef requires elongation. Hold for two counts.",
      confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
    });
  }

  // Ghunnah
  if (/\u0646\u0652/.test(word) || /\u0646$/.test(word) || /[\u064B\u064C\u064D]/.test(word)) {
    findings.push({
      wordId, rule: "ghunnah", arabicName: "غنة", category: "ghunnah",
      severity: "practice",
      explanation: "Apply ghunnah (nasalization) on the noon sakina or tanween.",
      confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
    });
  }

  // Qalqalah
  for (const letter of QALQALAH_LETTERS) {
    if (normalized.includes(`${letter}\u0652`)) {
      findings.push({
        wordId, rule: "qalqalah", arabicName: "قلقلة", category: "qalqalah",
        severity: "practice",
        explanation: `Qalqalah (echo) on ${letter} with sukoon.`,
        confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
      });
      break;
    }
  }

  // Tafkhim
  for (const letter of TAFKHIM_LETTERS) {
    if (normalized.includes(letter)) {
      findings.push({
        wordId, rule: "tafkhim", arabicName: "تفخيم", category: "tafkhim",
        severity: "practice",
        explanation: `Tafkhim (heaviness) on the letter ${letter}.`,
        confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
      });
      break;
    }
  }

  // Shaddah
  if (/[\u0651]/.test(word)) {
    findings.push({
      wordId, rule: "shaddah", arabicName: "شدة", category: "ghunnah",
      severity: "practice",
      explanation: "Shaddah indicates doubling of the consonant.",
      confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
    });
  }

  return findings;
}

export function analyzeAyah(ayahId, words) {
  const allFindings = [];

  for (const word of words) {
    const wordFindings = analyzeWord(word.id, word.text);
    allFindings.push(...wordFindings);
  }

  // Inter-word rules
  for (let i = 0; i < words.length - 1; i++) {
    const current = words[i].text.replace(/[\u06D6-\u06ED]+$/u, "");
    const next = words[i + 1].text;
    const endsWithNoonSakin = /\u0646\u0652?$/.test(current);
    // Tanween fath (ً) is almost always followed by a bare trailing alef in standard Uthmani
    // orthography (e.g. كِتَابًا) - the mark sits on the letter before the alef, not on the final
    // character, so it needs an optional trailing alef to match. Tanween damm/kasr (ٌ/ٍ) have no
    // trailing letter and already match without it.
    const endsWithTanween = /[\u064D\u064C\u064B]\u0627?$/.test(current);

    if (endsWithNoonSakin || endsWithTanween) {
      const nextLetter = next.replace(/[\u064B-\u065F\u0670\u0640]/g, "").trim()[0];
      if (nextLetter) {
        if (IDGHAM_LETTERS.includes(nextLetter)) {
          allFindings.push({
            wordId: words[i].id, rule: "idgham", arabicName: "إدغام", category: "idgham",
            severity: "practice",
            explanation: `Idgham: merge the noon/tanween into ${nextLetter}.`,
            confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
          });
        } else if (nextLetter === IQLAB_LETTER) {
          allFindings.push({
            wordId: words[i].id, rule: "iqlab", arabicName: "إقلاب", category: "iqlab",
            severity: "practice",
            explanation: "Iqlab: convert noon/tanween to meem before ب.",
            confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
          });
        } else if (IKHFA_LETTERS.includes(nextLetter)) {
          allFindings.push({
            wordId: words[i].id, rule: "ikhfa", arabicName: "إخفاء", category: "ikhfa",
            severity: "practice",
            explanation: `Ikhfa: hide the noon/tanween before ${nextLetter}.`,
            confidence: NO_MEASURED_CONFIDENCE, sources: [TAJWEED_SOURCE],
          });
        }
      }
    }
  }

  return allFindings;
}
