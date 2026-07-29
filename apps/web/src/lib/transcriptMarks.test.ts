import { describe, expect, it } from "vitest";
import { isNonRecitedMark } from "@quran-ai/contracts";

import { buildTimingsByWordId, type AlignmentResult, type ForceAlignWord } from "./api";

// T3 — specs/canonical-corpus-marks/plan.md
//
// App.tsx builds the forced-align transcript from `recitedAligned`, and passes the SAME array to
// buildTimingsByWordId. These tests pin the two properties that matter:
//   1. no mark codepoint reaches the transcript string, and
//   2. the positional count stays in step, because buildTimingsByWordId returns undefined on any
//      mismatch — which silently loses EVERY timing rather than failing loudly.
//
// The filter itself lives inline in App.tsx (a local const inside runAlignmentAndTajweed), so it is
// reproduced here exactly. If App.tsx's predicate ever changes, these tests keep documenting the
// contract the aligner boundary depends on.

const WAQF = String.fromCodePoint(0x06da);
const SAJDAH = String.fromCodePoint(0x06e9);

const a = (wordId: string, canonicalText: string, status: AlignmentResult["status"] = "matched") =>
  ({ wordId, canonicalText, heardText: canonicalText, startMs: 0, endMs: 0, confidence: 0.9, status }) as AlignmentResult;

// Mirrors App.tsx's recitedAligned predicate.
const recited = (alignments: AlignmentResult[]) =>
  alignments.filter(
    (x) => x.status !== "extra" && x.status !== "missed" && !isNonRecitedMark(x.canonicalText),
  );

describe("T3 — the forced-align transcript excludes non-recited marks", () => {
  it("no mark codepoint survives into the transcript string", () => {
    const alignments = [a("2:2:1", "ذَٰلِكَ"), a("2:2:2", WAQF), a("2:2:3", "فِيهِ"), a("7:206:2", SAJDAH)];
    const transcript = recited(alignments).map((x) => x.canonicalText).join(" ");

    expect(transcript).not.toContain(WAQF);
    expect(transcript).not.toContain(SAJDAH);
    expect(transcript).toBe("ذَٰلِكَ فِيهِ");
  });

  it("still drops extra and missed, as before — marks are an ADDITION, not a replacement", () => {
    const alignments = [
      a("1:1:1", "بِسْمِ"),
      a("1:1:2", "ٱللَّهِ", "missed"),
      a("1:1:3", "ٱلرَّحْمَٰنِ", "extra"),
      a("1:1:4", WAQF),
    ];
    expect(recited(alignments).map((x) => x.wordId)).toEqual(["1:1:1"]);
  });

  it("keeps a real word that CARRIES a mark", () => {
    const alignments = [a("1:1:1", `بِسْمِ${WAQF}`)];
    expect(recited(alignments)).toHaveLength(1);
  });

  it("the positional timing map stays in step after filtering (would silently lose ALL timings)", () => {
    const alignments = [a("2:2:1", "ذَٰلِكَ"), a("2:2:2", WAQF), a("2:2:3", "فِيهِ")];
    const filtered = recited(alignments);
    // The aligner returns one span per TRANSCRIPT word — i.e. per filtered entry, not per alignment.
    const aligned: ForceAlignWord[] = [
      { word: "ذَٰلِكَ", start: 0, end: 0.5, score: 0.9 },
      { word: "فِيهِ", start: 0.5, end: 1.0, score: 0.9 },
    ];

    const timings = buildTimingsByWordId(filtered, aligned);
    expect(timings, "counts must line up or every timing is dropped").toBeDefined();
    expect(timings?.get("2:2:1")).toEqual({ startMs: 0, endMs: 500 });
    expect(timings?.get("2:2:3")).toEqual({ startMs: 500, endMs: 1000 });
    expect(timings?.has("2:2:2")).toBe(false);
  });

  it("proves the invariant is load-bearing: an UNFILTERED array loses every timing", () => {
    // Guards against a future refactor that filters only at the `transcript:` join and forgets
    // buildTimingsByWordId — the exact skew this design avoids.
    const alignments = [a("2:2:1", "ذَٰلِكَ"), a("2:2:2", WAQF), a("2:2:3", "فِيهِ")];
    const aligned: ForceAlignWord[] = [
      { word: "ذَٰلِكَ", start: 0, end: 0.5, score: 0.9 },
      { word: "فِيهِ", start: 0.5, end: 1.0, score: 0.9 },
    ];
    expect(buildTimingsByWordId(alignments, aligned)).toBeUndefined();
  });
});
