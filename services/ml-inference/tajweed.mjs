/**
 * Rule-Based Tajweed Engine
 *
 * Analyzes canonical Quran text and produces tajweed findings based on
 * deterministic rules. This is NOT a neural classifier — it's a
 * rule-based engine that identifies tajweed rules in the text.
 *
 * Rules implemented:
 * - Madd Tabii (natural elongation)
 * - Ghunnah (nasalization)
 * - Qalqalah (echo/bounce)
 * - Idgham (merging)
 * - Iqlab (conversion)
 * - Ikhfa (hiding)
 * - Tafkhim (heavy/emphatic)
 */

export interface TajweedRule {
  name: string;
  arabicName: string;
  category: "madd" | "ghunnah" | "qalqalah" | "idgham" | "iqlab" | "ikhfa" | "tafkhim";
  severity: "practice" | "warning" | "critical";
  explanation: string;
  sourceTitle: string;
  sourceCitation: string;
}

// Madd letters: و ا ي (after a fatha/damma/kasra)
const MADD_LETTERS = ["و", "ا", "ي", "ى"];

// Qalqalah letters: ق ط ب ج د
const QALQALAH_LETTERS = ["ق", "ط", "ب", "ج", "د"];

// Ghunnah: noon sakina or tanween followed by specific patterns
const NOON_LETTERS = ["ن", "نْ", "نٍ", "نٌ", "نً"];

// Idgham letters: ي ر م ل و ن
const IDGHAM_LETTERS = ["ي", "ر", "م", "ل", "و", "ن"];

// Iqlab: ب
const IQLAB_LETTER = "ب";

// Ikhfa letters (15 letters)
const IKHFA_LETTERS = ["ت", "ث", "ج", "د", "ذ", "ز", "س", "ش", "ص", "ض", "ط", "ظ", "ف", "ق", "ك"];

// Tafkhim (heavy) letters: خ ص ض ط ظ ق
const TAFKHIM_LETTERS = ["خ", "ص", "ض", "ط", "ظ", "ق"];

export interface TajweedFinding {
  wordId: string;
  rule: string;
  arabicName: string;
  category: string;
  severity: "practice" | "warning" | "critical";
  explanation: string;
  confidence: number;
  sources: Array<{
    id: string;
    title: string;
    citation: string;
  }>;
}

const TAJWEED_SOURCE = {
  id: "tajweed-rules-reference",
  title: "Tajweed Rules: Deterministic Text Analysis",
  citation: "Rule-based analysis following standard tajweed rules (Madd, Ghunnah, Qalqalah, Idgham, Iqlab, Ikhfa, Tafkhim)",
};

/**
 * Analyze a word for tajweed rules.
 */
export function analyzeWord(wordId: string, word: string): TajweedFinding[] {
  const findings: TajweedFinding[] = [];
  const normalized = word.replace(/\s+/g, "");

  // Check for Madd Tabii (natural elongation)
  // Pattern: fatha+dagger alef, damma+waw, kasra+ya
  if (/[\u064B]\s*ا/.test(word) || /[\u064C]\s*و/.test(word) || /[\u064D]\s*ي/.test(word)) {
    findings.push({
      wordId,
      rule: "madd-tabii",
      arabicName: "مد طبيعي",
      category: "madd",
      severity: "practice",
      explanation: "Hold the natural madd (elongation) for two counts. The letter after the haraka indicates the madd letter.",
      confidence: 0.88,
      sources: [TAJWEED_SOURCE],
    });
  }

  // Check for Madd Maleki (dagger alef - small alef)
  if (/[\u0670]/.test(word)) {
    findings.push({
      wordId,
      rule: "madd-maleki",
      arabicName: "مد ملكي",
      category: "madd",
      severity: "practice",
      explanation: "Dagger alef (ألف خنجرية) requires elongation. Hold for two counts.",
      confidence: 0.85,
      sources: [TAJWEED_SOURCE],
    });
  }

  // Check for Ghunnah (noon sakina or tanween)
  if (/نْ/.test(word) || /[نًٌٍ]/.test(word)) {
    findings.push({
      wordId,
      rule: "ghunnah",
      arabicName: "غنة",
      category: "ghunnah",
      severity: "practice",
      explanation: "Apply ghunnah (nasalization) on the noon sakina or tanween. Hold the nasal sound for approximately two counts.",
      confidence: 0.90,
      sources: [TAJWEED_SOURCE],
    });
  }

  // Check for Qalqalah (echo on ق ط ب ج د with sukoon)
  for (const letter of QALQALAH_LETTERS) {
    if (normalized.includes(`${letter}\u0652`)) { // sukoon
      findings.push({
        wordId,
        rule: "qalqalah",
        arabicName: "قلقلة",
        category: "qalqalah",
        severity: "practice",
        explanation: `Qalqalah (echo) on ${letter} with sukoon. Pronounce with a slight bounce without adding a vowel.`,
        confidence: 0.87,
        sources: [TAJWEED_SOURCE],
      });
      break; // Only report once per word
    }
  }

  // Check for Tafkhim (heavy letters: خ ص ض ط ظ ق)
  for (const letter of TAFKHIM_LETTERS) {
    if (normalized.includes(letter)) {
      findings.push({
        wordId,
        rule: "tafkhim",
        arabicName: "تفخيم",
        category: "tafkhim",
        severity: "practice",
        explanation: `Tafkhim (heaviness) on the letter ${letter}. Raise the back of the tongue for a full, heavy sound.`,
        confidence: 0.84,
        sources: [TAJWEED_SOURCE],
      });
      break; // Only report once per word
    }
  }

  // Check for shaddah (intensity/doubling)
  if (/[\u0651]/.test(word)) {
    findings.push({
      wordId,
      rule: "shaddah",
      arabicName: "شدة",
      category: "ghunnah",
      severity: "practice",
      explanation: "Shaddah indicates doubling of the consonant. Apply ghunnah if the doubled letter is a noon or meem.",
      confidence: 0.86,
      sources: [TAJWEED_SOURCE],
    });
  }

  return findings;
}

/**
 * Analyze a full ayah for tajweed rules.
 */
export function analyzeAyah(
  ayahId: string,
  words: Array<{ id: string; text: string }>,
): TajweedFinding[] {
  const allFindings: TajweedFinding[] = [];

  for (const word of words) {
    const wordFindings = analyzeWord(word.id, word.text);
    allFindings.push(...wordFindings);
  }

  // Also check inter-word rules (Idgham, Iqlab, Ikhfa)
  for (let i = 0; i < words.length - 1; i++) {
    const current = words[i].text;
    const next = words[i + 1].text;

    // Check for noon sakina / tanween at end of current word
    const endsWithNoonSakin = /ن$/.test(current.replace(/[\u064B-\u065F\u0670]/g, "")) ||
                               /[نًٌٍ]$/.test(current);
    const endsWithTanween = /[ًٌٍ]$/.test(current);

    if (endsWithNoonSakin || endsWithTanween) {
      const nextLetter = next.replace(/[\u064B-\u065F\u0670\u0640]/g, "").trim()[0];

      if (nextLetter) {
        // Idgham
        if (IDGHAM_LETTERS.includes(nextLetter)) {
          allFindings.push({
            wordId: words[i].id,
            rule: "idgham",
            arabicName: "إدغام",
            category: "idgham",
            severity: "practice",
            explanation: `Idgham: merge the noon/tanween into the following letter ${nextLetter}. Apply ghunnah if the letter is و ي ن م.`,
            confidence: 0.82,
            sources: [TAJWEED_SOURCE],
          });
        }
        // Iqlab
        else if (nextLetter === IQLAB_LETTER) {
          allFindings.push({
            wordId: words[i].id,
            rule: "iqlab",
            arabicName: "إقلاب",
            category: "iqlab",
            severity: "practice",
            explanation: "Iqlab: convert the noon/tanween into a meem with ghunnah before the ب.",
            confidence: 0.83,
            sources: [TAJWEED_SOURCE],
          });
        }
        // Ikhfa
        else if (IKHFA_LETTERS.includes(nextLetter)) {
          allFindings.push({
            wordId: words[i].id,
            rule: "ikhfa",
            arabicName: "إخفاء",
            category: "ikhfa",
            severity: "practice",
            explanation: `Ikhfa: hide the noon/tanween before the letter ${nextLetter}. Apply a light nasal sound for approximately two counts.`,
            confidence: 0.80,
            sources: [TAJWEED_SOURCE],
          });
        }
      }
    }
  }

  return allFindings;
}
