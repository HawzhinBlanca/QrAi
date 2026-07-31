import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  canShowLearnerFacingAiOutput,
  canUseExternalAsr,
  isNonRecitedMark,
  modelEvalPassesReleaseGate,
  mustDiscardAudio,
  sha256Hex,
  type AgentRun,
  type AudioRetentionMode,
  type ConsentSnapshot,
  type ModelEvalRun,
} from "../src";

// MIG3 — the golden-vector corpus, executed.
//
// These cases live in fixtures/canonical-gates.json, NOT as literals here, so that a future Node
// service or Dart client asserts against the same file rather than against a re-typed copy of it.
// A case that exists only in one language's suite is exactly the drift this corpus prevents.
//
// platform-contracts.test.ts keeps its hand-written tests: they document intent in prose and are a
// second, independent check. This file proves the fixtures are real and executable — if the two ever
// disagree, that is the signal, and neither one silently wins.
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/canonical-gates.json", import.meta.url)), "utf8"),
) as Record<
  string,
  {
    cases: {
      name: string;
      input?: unknown;
      /** Combining marks are stored as code points — a literal can be reordered in transit. */
      inputCodepoints?: number[];
      expected: unknown;
      /** Present only on NFC-unstable vectors: the digest normalizing WRONGLY produces. */
      wrongIfNormalized?: string;
    }[];
  }
>;

function casesFor(fn: string) {
  const group = fixtures[fn];
  // A missing or empty group must fail, never vacuously pass — a corpus that silently covers
  // nothing is worse than no corpus, because it reads as coverage in CI.
  expect(group, `fixture group "${fn}" is missing`).toBeDefined();
  expect(group.cases.length, `fixture group "${fn}" has no cases`).toBeGreaterThan(0);
  return group.cases;
}

/**
 * `inputCodepoints` is the safe medium for combining marks — a literal can be silently reordered by
 * any tool that touches the file, which happened while this corpus was being extended (and is the
 * same class as the PR #258 diacritic-regex incident).
 */
function inputOf(c: { input?: unknown; inputCodepoints?: number[] }): string {
  return c.inputCodepoints ? String.fromCodePoint(...c.inputCodepoints) : (c.input as string);
}

describe("canonical-gates fixture corpus", () => {
  it("canShowLearnerFacingAiOutput matches every vector", () => {
    for (const c of casesFor("canShowLearnerFacingAiOutput")) {
      const input = c.input as Pick<AgentRun, "confidence" | "reviewStatus" | "sources">;
      expect(canShowLearnerFacingAiOutput(input), c.name).toBe(c.expected);
    }
  });

  it("mustDiscardAudio matches every vector", () => {
    for (const c of casesFor("mustDiscardAudio")) {
      expect(mustDiscardAudio(c.input as AudioRetentionMode), c.name).toBe(c.expected);
    }
  });

  it("canUseExternalAsr matches every vector", () => {
    for (const c of casesFor("canUseExternalAsr")) {
      expect(canUseExternalAsr(c.input as ConsentSnapshot), c.name).toBe(c.expected);
    }
  });

  it("modelEvalPassesReleaseGate matches every vector", () => {
    for (const c of casesFor("modelEvalPassesReleaseGate")) {
      expect(modelEvalPassesReleaseGate(c.input as ModelEvalRun), c.name).toBe(c.expected);
    }
  });

  it("sha256Hex matches every vector, including the Arabic UTF-8 anchor", () => {
    for (const c of casesFor("sha256Hex")) {
      // An unpopulated vector must fail loudly rather than be skipped — see the fixture's $comment.
      expect(c.expected, `${c.name}: expected value is null (unpopulated)`).not.toBeNull();
      expect(sha256Hex(inputOf(c)), c.name).toBe(c.expected);
    }
  });

  it("a vector marked NFC-unstable really is, and normalizing gives the WRONG digest", () => {
    // F3. Without this the NFC vector would be an ordinary hash case: it only proves anything if
    // normalizing actually changes the answer, and that `wrongIfNormalized` is the answer it changes
    // to. A future Dart or Swift client asserting the same file inherits the trap.
    const unstable = casesFor("sha256Hex").filter((c) => c.wrongIfNormalized !== undefined);
    expect(unstable.length, "the corpus must carry at least one NFC-unstable vector").toBeGreaterThan(0);

    for (const c of unstable) {
      const input = inputOf(c);
      expect(input, `${c.name}: must not already be in NFC`).not.toBe(input.normalize("NFC"));
      expect(sha256Hex(input.normalize("NFC")), `${c.name}: normalized digest`).toBe(c.wrongIfNormalized);
      expect(c.wrongIfNormalized, `${c.name}: the trap is vacuous`).not.toBe(c.expected);
    }
  });

  it("code-point vectors survive a surrogate-pair-splitting implementation", () => {
    // The Arabic vector catches a UTF-16 byte source. It does NOT catch iterating by code UNIT and
    // splitting a surrogate pair, which is a different bug with the same symptom.
    const astral = casesFor("sha256Hex").find((c) => c.name.includes("supplementary-plane"));
    expect(astral, "the corpus must carry a supplementary-plane vector").toBeDefined();
    const input = inputOf(astral!);
    expect(input.length, "must be a surrogate pair, i.e. more units than code points").toBeGreaterThan(
      [...input].length,
    );
    expect(sha256Hex(input)).toBe(astral!.expected);
  });

  it("isNonRecitedMark matches every vector", () => {
    for (const c of casesFor("isNonRecitedMark")) {
      // Built from codepoints, never literal characters — see the fixture group's $comment.
      const cps = (c as unknown as { inputCodepoints: number[] }).inputCodepoints;
      expect(cps, `${c.name}: missing inputCodepoints`).toBeDefined();
      const input = String.fromCodePoint(...cps);
      expect(isNonRecitedMark(input), c.name).toBe(c.expected);
    }
  });

  it("covers the fail-closed case explicitly, so the corpus cannot be trimmed down to happy paths", () => {
    // Guards the corpus itself: someone pruning "redundant" cases must not remove the one that
    // pins allowlist-not-denylist behaviour.
    const names = casesFor("canShowLearnerFacingAiOutput").map((c) => c.name);
    expect(names.some((n) => n.includes("FAILS CLOSED"))).toBe(true);
  });
});
