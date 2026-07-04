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

export function analyzeWord(wordId, word) {
  const findings = [];
  const normalized = word.replace(/\s+/g, "");

  // Madd Tabii
  if (/َا/.test(word) || /ُو/.test(word) || /ِي/.test(word)) {
    findings.push({
      wordId, rule: "madd-tabii", arabicName: "مد طبيعي", category: "madd",
      severity: "practice",
      explanation: "Hold the natural madd (elongation) for two counts.",
      confidence: 0.88, sources: [TAJWEED_SOURCE],
    });
  }

  // Madd Maleki (dagger alef)
  if (/[\u0670]/.test(word)) {
    findings.push({
      wordId, rule: "madd-maleki", arabicName: "مد ملكي", category: "madd",
      severity: "practice",
      explanation: "Dagger alef requires elongation. Hold for two counts.",
      confidence: 0.85, sources: [TAJWEED_SOURCE],
    });
  }

  // Ghunnah
  if (/نْ/.test(word) || /ن$/.test(word) || /[ًٌٍ]/.test(word)) {
    findings.push({
      wordId, rule: "ghunnah", arabicName: "غنة", category: "ghunnah",
      severity: "practice",
      explanation: "Apply ghunnah (nasalization) on the noon sakina or tanween.",
      confidence: 0.90, sources: [TAJWEED_SOURCE],
    });
  }

  // Qalqalah
  for (const letter of QALQALAH_LETTERS) {
    if (normalized.includes(`${letter}\u0652`)) {
      findings.push({
        wordId, rule: "qalqalah", arabicName: "قلقلة", category: "qalqalah",
        severity: "practice",
        explanation: `Qalqalah (echo) on ${letter} with sukoon.`,
        confidence: 0.87, sources: [TAJWEED_SOURCE],
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
        confidence: 0.84, sources: [TAJWEED_SOURCE],
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
      confidence: 0.86, sources: [TAJWEED_SOURCE],
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
    const current = words[i].text.replace(/[ۖ-ۭ]+$/u, "");
    const next = words[i + 1].text;
    const endsWithNoonSakin = /نْ?$/.test(current);
    const endsWithTanween = /[ًٌٍ]$/.test(current);

    if (endsWithNoonSakin || endsWithTanween) {
      const nextLetter = next.replace(/[\u064B-\u065F\u0670\u0640]/g, "").trim()[0];
      if (nextLetter) {
        if (IDGHAM_LETTERS.includes(nextLetter)) {
          allFindings.push({
            wordId: words[i].id, rule: "idgham", arabicName: "إدغام", category: "idgham",
            severity: "practice",
            explanation: `Idgham: merge the noon/tanween into ${nextLetter}.`,
            confidence: 0.82, sources: [TAJWEED_SOURCE],
          });
        } else if (nextLetter === IQLAB_LETTER) {
          allFindings.push({
            wordId: words[i].id, rule: "iqlab", arabicName: "إقلاب", category: "iqlab",
            severity: "practice",
            explanation: "Iqlab: convert noon/tanween to meem before ب.",
            confidence: 0.83, sources: [TAJWEED_SOURCE],
          });
        } else if (IKHFA_LETTERS.includes(nextLetter)) {
          allFindings.push({
            wordId: words[i].id, rule: "ikhfa", arabicName: "إخفاء", category: "ikhfa",
            severity: "practice",
            explanation: `Ikhfa: hide the noon/tanween before ${nextLetter}.`,
            confidence: 0.80, sources: [TAJWEED_SOURCE],
          });
        }
      }
    }
  }

  return allFindings;
}
