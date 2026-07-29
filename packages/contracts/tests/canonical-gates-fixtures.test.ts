import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  canShowLearnerFacingAiOutput,
  canUseExternalAsr,
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
) as Record<string, { cases: { name: string; input: unknown; expected: unknown }[] }>;

function casesFor(fn: string) {
  const group = fixtures[fn];
  // A missing or empty group must fail, never vacuously pass — a corpus that silently covers
  // nothing is worse than no corpus, because it reads as coverage in CI.
  expect(group, `fixture group "${fn}" is missing`).toBeDefined();
  expect(group.cases.length, `fixture group "${fn}" has no cases`).toBeGreaterThan(0);
  return group.cases;
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
      expect(sha256Hex(c.input as string), c.name).toBe(c.expected);
    }
  });

  it("covers the fail-closed case explicitly, so the corpus cannot be trimmed down to happy paths", () => {
    // Guards the corpus itself: someone pruning "redundant" cases must not remove the one that
    // pins allowlist-not-denylist behaviour.
    const names = casesFor("canShowLearnerFacingAiOutput").map((c) => c.name);
    expect(names.some((n) => n.includes("FAILS CLOSED"))).toBe(true);
  });
});
