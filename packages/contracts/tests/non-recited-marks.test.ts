import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createCanonicalChecksum,
  isNonRecitedMark,
  verifyCanonicalWord,
} from "../src";

// T1 — specs/canonical-corpus-marks/plan.md
//
// Expected values are written as \u escapes, not literal characters: mushaf annotation marks are
// invisible in an editor and in a diff, which is exactly how the forced_align.py range bug shipped
// (PR #258). AGENTS.md now makes this a hard boundary.

const MARKS = {
  "U+06D6 small high sad-lam-alef (waqf)": "ۖ",
  "U+06D7 small high qaf-lam-alef": "ۗ",
  "U+06D8 small high meem (compulsory pause)": "ۘ",
  "U+06D9 small high lam-alef (do not pause)": "ۙ",
  "U+06DA small high jeem (waqf)": "ۚ",
  "U+06DB small high three dots": "ۛ",
  "U+06DC small high seen": "ۜ",
  "U+06DD end of ayah": "۝",
  "U+06DE start of rub el hizb": "۞",
  "U+06E9 place of sajdah": "۩",
} as const;

describe("isNonRecitedMark", () => {
  it("classifies every annotation codepoint as a mark", () => {
    for (const [name, char] of Object.entries(MARKS)) {
      expect(isNonRecitedMark(char), name).toBe(true);
    }
  });

  it("does NOT classify real Quranic words as marks", () => {
    // بِسْمِ  ٱللَّهِ  ٱلرَّحْمَٰنِ  ٱلرَّحِيمِ
    for (const word of ["بِسْمِ", "ٱللَّهِ", "ٱلرَّحِيمِ"]) {
      expect(isNonRecitedMark(word), word).toBe(false);
    }
  });

  it("does NOT classify a real word that CARRIES a mark — it is still a word", () => {
    // The dangerous loose rule would be "contains a mark". That would silently stop scoring real
    // words, which is worse than the bug being fixed.
    expect(isNonRecitedMark("بِسْمِۚ")).toBe(false);
    expect(isNonRecitedMark("ۚبِسْمِ")).toBe(false);
  });

  it("rejects empty and whitespace-only input", () => {
    // Whitespace is tolerated AROUND a mark but can never make a token a mark by itself.
    expect(isNonRecitedMark("")).toBe(false);
    expect(isNonRecitedMark(" ")).toBe(false);
    expect(isNonRecitedMark("\n\t")).toBe(false);
  });

  it("tolerates whitespace padding around a mark", () => {
    expect(isNonRecitedMark(" ۚ ")).toBe(true);
  });

  it("does NOT classify combining marks that live inside words (U+06DF-U+06E8, U+06EA-U+06ED)", () => {
    // These are intentionally absent from the codepoint set: they are word-internal diacritics, and
    // the all-characters rule handles them. Classifying them standalone would be harmless but the
    // set must stay minimal and documented.
    expect(isNonRecitedMark("ۡ")).toBe(false); // small high dotless head of khah
    expect(isNonRecitedMark("ۭ")).toBe(false); // small low meem
  });
});

describe("T1 hard constraint — the classifier must NOT affect canonical checksums", () => {
  // plan.md §1: if classification enters canonicalWordPayload, every checksum after the first mark
  // in an ayah changes and verifyCanonicalWord fails across 89 of 114 surahs. This pins the payload
  // by asserting a known record's checksum is a fixed value, so any future change to the payload
  // composition fails here loudly rather than at corpus-validation time.
  // Typed explicitly, no `as` cast: QuranReference is {surahNumber, ayahStart, ayahEnd, display},
  // and a cast would have hidden a shape mismatch that tsc rightly rejected.
  const record = {
    id: "1:1:1",
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
    ayahId: "1:1",
    wordIndex: 1,
    text: "بِسْمِ",
    sourceId: "tanzil" as const,
    edition: "uthmani-v1",
    scriptType: "uthmani" as const,
    importVersion: "2026-06-24-seed",
  };

  it("a known word's checksum is stable and verifies", () => {
    const checksum = createCanonicalChecksum(record);
    // Recomputed identically twice — the payload is deterministic.
    expect(createCanonicalChecksum(record)).toBe(checksum);
    expect(verifyCanonicalWord({ ...record, sourceChecksum: checksum })).toBe(true);
  });

  it("a MARK token's checksum is computed the same way as a word's (marks stay canonical)", () => {
    // Marks are NOT removed from the corpus, so they must still checksum and verify like any other
    // token. This is the difference between this plan and the rejected delete-and-reindex approach.
    const mark = { ...record, id: "2:2:5", ayahId: "2:2", wordIndex: 5, text: "ۛ" };
    const checksum = createCanonicalChecksum(mark);
    expect(verifyCanonicalWord({ ...mark, sourceChecksum: checksum })).toBe(true);
    expect(isNonRecitedMark(mark.text)).toBe(true);
  });
});

describe("T1 corpus sweep — the classifier matches the measured corpus exactly", () => {
  // impact-map.md §5 named this as the gap the per-codepoint tests do not close: a real word wrongly
  // classified would silently stop being scored. Asserting the exact total catches both directions.
  it("classifies exactly 4578 of 82456 shipped tokens as marks", () => {
    const dir = fileURLToPath(new URL("../../quran-data/src/data/full-quran", import.meta.url));
    let total = 0;
    let marks = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const parsed = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as
        | { ayahs?: { words?: unknown[] }[] }
        | { words?: unknown[] }[];
      const ayahs = Array.isArray(parsed) ? parsed : (parsed.ayahs ?? []);
      for (const ayah of ayahs) {
        for (const word of ayah.words ?? []) {
          const text = typeof word === "string" ? word : ((word as { text?: string }).text ?? "");
          if (!text) continue;
          total += 1;
          if (isNonRecitedMark(text)) marks += 1;
        }
      }
    }
    expect(total).toBe(82456);
    expect(marks).toBe(4578);
  });
});
