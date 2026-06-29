/**
 * Quran-Constrained Alignment Engine
 */

export function normalizeArabic(text) {
  return text
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0640/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

export function similarity(a, b) {
  const na = normalizeArabic(a);
  const nb = normalizeArabic(b);
  if (na.length === 0 && nb.length === 0) return 1.0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(na, nb);
  return 1.0 - dist / maxLen;
}

export function alignWords(canonicalWords, recognizedWords) {
  const results = [];
  const matchThreshold = 0.85;
  const reviewThreshold = 0.65;
  const usedRecognized = new Set();

  for (let i = 0; i < canonicalWords.length; i++) {
    const canonical = canonicalWords[i];

    let bestMatch = -1;
    let bestSim = 0;

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

export function calculateConfidence(results) {
  if (results.length === 0) return 0;
  const matched = results.filter((r) => r.status === "matched").length;
  const misread = results.filter((r) => r.status === "misread").length;
  const total = results.length;
  return (matched + misread * 0.5) / total;
}
