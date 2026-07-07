/**
 * Quran-Constrained Alignment Engine
 */

export function normalizeArabic(text) {
  return text
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    // U+0629 (taa marbuta) vs U+0647 (haa): a near-universal ASR/transcription variation for
    // Arabic, since the two are acoustically similar in pause form. Without this, a correctly
    // recited word ending in taa marbuta that ASR transcribes with haa scores as low as 0.75
    // similarity (verified with a real word pair), landing in the "misread" band (0.65-0.85)
    // instead of "matched" (>=0.95) -- wrongly telling a correct reciter they made a mistake.
    .replace(/\u0629/g, "\u0647")
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

// Align the recited words to the canonical words with a GLOBAL sequence alignment
// (Needleman-Wunsch over word similarity) rather than a fixed local window. The old greedy window
// (recognized[i-2 .. i+3], centered on the CANONICAL index) permanently desynced the moment a reciter
// inserted, repeated, or restarted more than 2 words — false starts, tasbih repetition, self-correction,
// hesitation fillers — and then scored correctly-recited words as "missed" or matched them to the wrong
// neighbour. A global alignment follows the actual recited stream and survives insertions/deletions/repeats.
export function alignWords(canonicalWords, recognizedWords) {
  const matchThreshold = 0.85;
  const reviewThreshold = 0.65;
  // Gap penalty. Aligning a pair scores its similarity; skipping BOTH a canonical and a recognized word
  // (a missed word + an unrelated extra) scores 2·GAP. So a pair is aligned iff its similarity exceeds
  // 2·GAP — set to reviewThreshold, matching the old "similarity ≥ 0.65 ⇒ a (mis)read, else missed" cut.
  const GAP = reviewThreshold / 2;

  const m = canonicalWords.length;
  const n = recognizedWords.length;

  // Pairwise similarity, computed once.
  const sim = Array.from({ length: m }, (_, i) =>
    Array.from({ length: n }, (_, j) => similarity(canonicalWords[i].text, recognizedWords[j])),
  );

  // dp[i][j] = best alignment score of canonical[0..i) vs recognized[0..j); back[i][j] = the move.
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const back = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(null));
  for (let i = 1; i <= m; i++) {
    dp[i][0] = dp[i - 1][0] + GAP;
    back[i][0] = "up"; // canonical deleted (missed)
  }
  for (let j = 1; j <= n; j++) {
    dp[0][j] = dp[0][j - 1] + GAP;
    back[0][j] = "left"; // recognized inserted (extra)
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const diag = dp[i - 1][j - 1] + sim[i - 1][j - 1];
      const up = dp[i - 1][j] + GAP;
      const left = dp[i][j - 1] + GAP;
      let best = diag;
      let move = "diag";
      if (up > best) {
        best = up;
        move = "up";
      }
      if (left > best) {
        best = left;
        move = "left";
      }
      dp[i][j] = best;
      back[i][j] = move;
    }
  }

  // Backtrack: pair each canonical word with a recognized index (or -1 if missed).
  const alignedRecognized = new Array(m).fill(-1);
  const recognizedUsed = new Array(n).fill(false);
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const move = back[i][j];
    if (move === "diag") {
      alignedRecognized[i - 1] = j - 1;
      recognizedUsed[j - 1] = true;
      i--;
      j--;
    } else if (move === "up") {
      i--;
    } else {
      j--;
    }
  }

  const results = [];
  for (let k = 0; k < m; k++) {
    const canonical = canonicalWords[k];
    const rj = alignedRecognized[k];
    if (rj >= 0 && sim[k][rj] >= reviewThreshold) {
      const s = sim[k][rj];
      results.push({
        wordId: canonical.id,
        canonicalText: canonical.text,
        heardText: recognizedWords[rj],
        status: s >= matchThreshold ? (s >= 0.95 ? "matched" : "needs-review") : "misread",
        confidence: s,
        similarity: s,
      });
    } else {
      // Not aligned, or aligned only below the review threshold → missed; free any weakly-paired
      // recognized word so it is reported as an "extra" instead of silently consumed.
      if (rj >= 0) recognizedUsed[rj] = false;
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

  for (let rj = 0; rj < n; rj++) {
    if (!recognizedUsed[rj]) {
      results.push({
        wordId: `extra-${rj}`,
        canonicalText: "",
        heardText: recognizedWords[rj],
        status: "extra",
        confidence: 0.5,
        similarity: 0,
      });
    }
  }

  return results;
}

// Per-status weights for the overall confidence score, ordered by how close the
// recited word was to the canonical text (see alignWords' similarity thresholds):
//   matched (sim ≥ 0.95) → 1.0   needs-review (0.85–0.95) → 0.8
//   misread (0.65–0.85)  → 0.5   missed / extra          → 0.0
// "needs-review" previously scored 0 (identical to a skipped word), which understated
// accuracy: an ayah recited entirely at 0.85–0.94 similarity reported 0% confidence.
// It now contributes 0.8 — above "misread", below "matched" — so the score stays
// monotonic with recitation quality.
const CONFIDENCE_WEIGHTS = {
  matched: 1.0,
  "needs-review": 0.8,
  misread: 0.5,
  missed: 0.0,
  extra: 0.0,
};

export function calculateConfidence(results) {
  // Score accuracy over the CANONICAL words only. "extra" entries are recognized words that matched
  // no canonical word (ASR noise, breath/filler tokens, insertions); counting them in the denominator
  // let a few stray tokens crater the score of an otherwise-perfect recitation — and, since this score
  // gates auto-accept vs. teacher-review (confidence ≥ 0.85), forced needless teacher review.
  const canonical = results.filter((r) => r.status !== "extra");
  if (canonical.length === 0) return 0;
  const weighted = canonical.reduce((sum, r) => sum + (CONFIDENCE_WEIGHTS[r.status] ?? 0), 0);
  return weighted / canonical.length;
}
