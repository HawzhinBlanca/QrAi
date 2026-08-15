/**
 * Quran-Constrained Alignment Engine
 */

/**
 * Mushaf ANNOTATION codepoints — waqf (pause) signs, end-of-ayah, rub-el-hizb, sajdah. These are not
 * recited, so they must never be scored.
 *
 * DUPLICATED from `isNonRecitedMark` in packages/contracts/src/index.ts, deliberately and with a
 * pinned test: the inference runtime uses the contract fixture directly, so it cannot
 * import @quran-ai/contracts. `marks-parity.test.mjs` reads the shared fixture corpus at
 * packages/contracts/fixtures/canonical-gates.json and asserts this implementation agrees with it
 * case for case — so the two copies cannot drift silently. That fixture exists for exactly this.
 *
 * Escapes, never literal characters: a literal-character Arabic class in forced_align.py merged two
 * ranges, deleted every Arabic letter, and passed review (PR #258). AGENTS.md hard boundary.
 */
const NON_RECITED_MARKS = new Set([
  0x06d6, 0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06dd, 0x06de, 0x06e9,
]);

export function isNonRecitedMark(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  let sawMark = false;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (NON_RECITED_MARKS.has(cp)) {
      sawMark = true;
      continue;
    }
    if (/\s/u.test(char)) continue;
    return false;
  }
  return sawMark;
}

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

// Hamza-on-carrier (ؤ hamza-on-waw, ئ hamza-on-yaa) vs the bare carrier (و, ي) is a documented
// Arabic ASR transcription ambiguity -- but unlike taa marbuta/haa above, it is NOT a confirmed
// acoustic equivalence: hamza articulation is itself a real tajweed correctness point (hamzat
// al-qat' is a genuine glottal stop the reciter must produce), so treating ؤ/ئ as fully equal to
// و/ي would risk scoring a genuine dropped/mispronounced hamza as "matched" -- a false positive,
// and a more serious failure mode for this product than the false "misread" taa-marbuta/haa was
// causing. Pending a scholar ruling (see docs/SCHOLAR_REVIEW.md's sign-off pattern), this instead
// gives a SUBSTITUTION of hamza-on-carrier <-> bare-carrier partial credit (0.5 instead of a full
// 1) -- enough that ASR noise alone can no longer tip a correct recitation into "misread"/"missed"
// (see tests/inference/alignment.test.mjs), while an outright DROPPED hamza (an insertion/deletion,
// not a same-position substitution, e.g. "شيء" -> "شي") still costs a full edit and stays flagged,
// since that is a real, uncorrected error a Quran teacher would catch, not an orthographic ambiguity.
const HAMZA_CARRIER_SUBSTITUTIONS = new Set([
  "\u0624\u0648", "\u0648\u0624", // hamza-on-waw <-> waw
  "\u0626\u064A", "\u064A\u0626", // hamza-on-yaa <-> yaa
]);

function substitutionCost(ca, cb) {
  if (ca === cb) return 0;
  if (HAMZA_CARRIER_SUBSTITUTIONS.has(ca + cb)) return 0.5;
  return 1;
}

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = substitutionCost(a[i - 1], b[j - 1]);
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
/**
 * `recognizedTimings[j]` is where recognized word `j` was heard, when the ASR reported it.
 *
 * Optional and index-parallel to `recognizedWords`, so every existing caller (which passes two
 * arguments) keeps its exact behaviour: no timings in, no span out.
 *
 * A span only ever comes from the recognized word this canonical word was actually PAIRED with.
 * A `missed` word gets none — nothing was heard for it, and inventing a span would put a tajweed
 * finding at a moment of audio the learner never recited there. `usable_span` refuses those
 * downstream, which is the behaviour that surfaced this whole defect and is correct.
 */
export function alignWords(canonicalWords, recognizedWords, recognizedTimings = null) {
  /** The heard span for recognized index `j`, or nothing if it was not reported or is unusable. */
  const spanFor = (j) => {
    const t = Array.isArray(recognizedTimings) ? recognizedTimings[j] : null;
    if (!t) return null;
    const { startMs, endMs } = t;
    // The same rule platform-api's `usable_span` applies, enforced at the source rather than
    // emitting a span that is guaranteed to be rejected later.
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return null;
    if (startMs < 0 || endMs <= startMs) return null;
    return { startMs, endMs };
  };
  // Non-recited mushaf marks (waqf/sajdah/hizb) are excluded from the alignment ENTIRELY rather than
  // aligned and then filtered. 4,578 of the corpus's 82,456 word tokens are such marks. Feeding one
  // into the DP asks the aligner to find audio for a silent symbol, which distorts that token's span
  // AND its neighbours' (the same reasoning the caller already applies to "missed" words). Excluding
  // them up front means no matched/misread/missed status is ever produced for a mark, so a bad status
  // cannot leak downstream. Marks stay in the corpus and stay displayed — see
  // specs/canonical-corpus-marks/plan.md.
  const recitedWords = canonicalWords.filter((w) => !isNonRecitedMark(w.text));
  canonicalWords = recitedWords;

  // During the W1.6/W1.7 transition callers may still pass bare strings. Measured tokens are the
  // same text plus the producer-owned location of that text in session audio. Keep one token array
  // throughout the DP so a source span follows only the recognized token it came from; it is never
  // inferred from a neighbouring canonical word. Validation of untrusted request tokens belongs at
  // the service boundary (`predictAlignment`), while this deterministic engine preserves values.
  const recognizedTokens = recognizedWords.map((word) =>
    typeof word === "string"
      ? { text: word, startMs: null, endMs: null }
      : { text: word.text, startMs: word.startMs, endMs: word.endMs },
  );
  const recognizedText = recognizedTokens.map((token) => token.text);

  const matchThreshold = 0.85;
  const reviewThreshold = 0.65;
  // Gap penalty. Aligning a pair scores its similarity; skipping BOTH a canonical and a recognized word
  // (a missed word + an unrelated extra) scores 2·GAP. So a pair is aligned iff its similarity exceeds
  // 2·GAP — set to reviewThreshold, matching the old "similarity ≥ 0.65 ⇒ a (mis)read, else missed" cut.
  const GAP = reviewThreshold / 2;

  const m = canonicalWords.length;
  const n = recognizedTokens.length;

  // Pairwise similarity, computed once.
  const sim = Array.from({ length: m }, (_, i) =>
    Array.from({ length: n }, (_, j) => similarity(canonicalWords[i].text, recognizedText[j])),
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
        heardText: recognizedTokens[rj].text,
        startMs: recognizedTokens[rj].startMs,
        endMs: recognizedTokens[rj].endMs,
        status: s >= matchThreshold ? (s >= 0.95 ? "matched" : "needs-review") : "misread",
        confidence: s,
        similarity: s,
        ...(spanFor(rj) ?? {}),
      });
    } else {
      // Not aligned, or aligned only below the review threshold → missed; free any weakly-paired
      // recognized word so it is reported as an "extra" instead of silently consumed.
      if (rj >= 0) recognizedUsed[rj] = false;
      results.push({
        wordId: canonical.id,
        canonicalText: canonical.text,
        heardText: "",
        startMs: null,
        endMs: null,
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
        heardText: recognizedTokens[rj].text,
        startMs: recognizedTokens[rj].startMs,
        endMs: recognizedTokens[rj].endMs,
        status: "extra",
        confidence: 0.5,
        similarity: 0,
        ...(spanFor(rj) ?? {}),
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
