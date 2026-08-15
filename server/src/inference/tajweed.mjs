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
 * Build a fact about the canonical text, never a judgment about a learner.
 *
 * These detectors inspect no audio, transcript, timing, or acoustic score. Consequently an
 * annotation has no confidence, severity, or review state: adding any of those fields would turn a
 * deterministic teaching note into performance-shaped output. `predictTajweed` keeps these values
 * in `annotations[]`; only a future acoustic producer may populate `findings[]`.
 */
function instructionalAnnotation(wordId, rule, arabicName, category, explanation) {
  return {
    wordId,
    rule,
    arabicName,
    category,
    analysisBasis: "text-rule",
    instructional: true,
    explanation,
    sources: [TAJWEED_SOURCE],
  };
}

export function analyzeWord(wordId, word) {
  const annotations = [];
  const normalized = word.replace(/\s+/g, "");

  // Madd Tabii
  if (/\u064E\u0627/.test(word) || /\u064F\u0648/.test(word) || /\u0650\u064A/.test(word)) {
    annotations.push(instructionalAnnotation(
      wordId, "madd-tabii", "مد طبيعي", "madd",
      "Hold the natural madd (elongation) for two counts.",
    ));
  }

  // Madd Maleki (dagger alef)
  if (/[\u0670]/.test(word)) {
    annotations.push(instructionalAnnotation(
      wordId, "madd-maleki", "مد ملكي", "madd",
      "Dagger alef requires elongation. Hold for two counts.",
    ));
  }

  // Ghunnah
  if (/\u0646\u0652/.test(word) || /\u0646$/.test(word) || /[\u064B\u064C\u064D]/.test(word)) {
    annotations.push(instructionalAnnotation(
      wordId, "ghunnah", "غنة", "ghunnah",
      "Apply ghunnah (nasalization) on the noon sakina or tanween.",
    ));
  }

  // Qalqalah
  for (const letter of QALQALAH_LETTERS) {
    if (normalized.includes(`${letter}\u0652`)) {
      annotations.push(instructionalAnnotation(
        wordId, "qalqalah", "قلقلة", "qalqalah",
        `Qalqalah (echo) on ${letter} with sukoon.`,
      ));
      break;
    }
  }

  // Tafkhim
  for (const letter of TAFKHIM_LETTERS) {
    if (normalized.includes(letter)) {
      annotations.push(instructionalAnnotation(
        wordId, "tafkhim", "تفخيم", "tafkhim",
        `Tafkhim (heaviness) on the letter ${letter}.`,
      ));
      break;
    }
  }

  // Shaddah
  if (/[\u0651]/.test(word)) {
    annotations.push(instructionalAnnotation(
      wordId, "shaddah", "شدة", "ghunnah",
      "Shaddah indicates doubling of the consonant.",
    ));
  }

  return annotations;
}

export function analyzeAyah(ayahId, words) {
  const allAnnotations = [];

  for (const word of words) {
    const wordAnnotations = analyzeWord(word.id, word.text);
    allAnnotations.push(...wordAnnotations);
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
          allAnnotations.push(instructionalAnnotation(
            words[i].id, "idgham", "إدغام", "idgham",
            `Idgham: merge the noon/tanween into ${nextLetter}.`,
          ));
        } else if (nextLetter === IQLAB_LETTER) {
          allAnnotations.push(instructionalAnnotation(
            words[i].id, "iqlab", "إقلاب", "iqlab",
            "Iqlab: convert noon/tanween to meem before ب.",
          ));
        } else if (IKHFA_LETTERS.includes(nextLetter)) {
          allAnnotations.push(instructionalAnnotation(
            words[i].id, "ikhfa", "إخفاء", "ikhfa",
            `Ikhfa: hide the noon/tanween before ${nextLetter}.`,
          ));
        }
      }
    }
  }

  return allAnnotations;
}
