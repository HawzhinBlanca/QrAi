/**
 * Quran-Constrained Alignment Engine
 *
 * Given a recognized text (from ASR or user input), aligns it against
 * the canonical Quran text using a modified Levenshtein distance
 * with Arabic-aware normalization.
 *
 * This is NOT a neural ASR model — it's a deterministic alignment
 * algorithm that takes recognized text and produces word-level
 * alignment against the canonical Quran.
 */

/**
 * Normalize Arabic text for comparison:
 * - Remove diacritics (tashkeel)
 * - Normalize alef variants
 * - Normalize ya/alef maqsura
 * - Remove tatweel
 * - Lowercase
 */
export function normalizeArabic(text: string): string {
  return text
    // Remove tashkeel (harakat)
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    // Normalize alef variants
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627") // آأإٱ → ا
    // Normalize ya
    .replace(/\u0649/g, "\u064A") // ى → ي
    // Remove tatweel
    .replace(/\u0640/g, "")
    // Normalize space
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Calculate Levenshtein distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Similarity score between 0 and 1 based on Levenshtein distance.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeArabic(a);
  const nb = normalizeArabic(b);
  if (na.length === 0 && nb.length === 0) return 1.0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(na, nb);
  return 1.0 - dist / maxLen;
}

export interface AlignmentResult {
  wordId: string;
  canonicalText: string;
  heardText: string;
  status: "matched" | "misread" | "missed" | "extra" | "needs-review";
  confidence: number;
  similarity: number;
}

/**
 * Align recognized words against canonical Quran words.
 *
 * @param canonicalWords - Array of {id, text} from canonical Quran
 * @param recognizedWords - Array of recognized text strings
 * @returns Alignment results for each canonical word
 */
export function alignWords(
  canonicalWords: Array<{ id: string; text: string }>,
  recognizedWords: string[],
): AlignmentResult[] {
  const results: AlignmentResult[] = [];
  const matchThreshold = 0.85;
  const reviewThreshold = 0.65;
  const usedRecognized = new Set<number>();

  for (let i = 0; i < canonicalWords.length; i++) {
    const canonical = canonicalWords[i];

    // Try to find the best matching recognized word
    let bestMatch = -1;
    let bestSim = 0;

    // Search in a window around the expected position
    const windowStart = Math.max(0, i - 2);
    const windowEnd = Math.min(recognizedWords.length, i + 3);

    for (let j = windowStart; j < windowEnd; j++) {
      if (usedRecognized.has(j)) continue;
      const sim = similarity(canonical.text, recognizedWords[j]);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = j;
      }
    }

    if (bestMatch >= 0 && bestSim >= matchThreshold) {
      usedRecognized.add(bestMatch);
      const status = bestSim >= 0.95 ? "matched" : bestSim >= matchThreshold ? "matched" : "needs-review";
      results.push({
        wordId: canonical.id,
        canonicalText: canonical.text,
        heardText: recognizedWords[bestMatch],
        status: bestSim >= 0.95 ? "matched" : "needs-review",
        confidence: bestSim,
        similarity: bestSim,
      });
    } else if (bestMatch >= 0 && bestSim >= reviewThreshold) {
      usedRecognized.add(bestMatch);
      results.push({
        wordId: canonical.id,
        canonicalText: canonical.text,
        heardText: recognizedWords[bestMatch],
        status: "misread",
        confidence: bestSim,
        similarity: bestSim,
      });
    } else {
      // Word was missed
      results.push({
        wordId: canonical.id,
        canonicalText: canonical.text,
        heardText: "",
        status: "missed",
        confidence: 0.3,
        similarity: 0,
      });
    }
  }

  // Check for extra words in recognized text
  for (let j = 0; j < recognizedWords.length; j++) {
    if (!usedRecognized.has(j)) {
      results.push({
        wordId: `extra-${j}`,
        canonicalText: "",
        heardText: recognizedWords[j],
        status: "extra",
        confidence: 0.5,
        similarity: 0,
      });
    }
  }

  return results;
}

/**
 * Calculate overall alignment confidence from individual word results.
 */
export function calculateConfidence(results: AlignmentResult[]): number {
  if (results.length === 0) return 0;
  const matched = results.filter((r) => r.status === "matched").length;
  const misread = results.filter((r) => r.status === "misread").length;
  const missed = results.filter((r) => r.status === "missed").length;
  const total = results.length;
  return (matched + misread * 0.5) / total;
}
