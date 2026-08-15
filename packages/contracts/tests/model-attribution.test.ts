import { describe, expect, it } from "vitest";

import {
  MODEL_ANALYSIS_BASES,
  MODEL_COMPONENTS,
  validateModelAttribution,
  type ModelAttribution,
  type Sha256Digest,
} from "../src";

const digest = (hex: string): Sha256Digest => `sha256:${hex.repeat(64)}`;

const completeAttribution: ModelAttribution = {
  schemaVersion: 1,
  primaryComponent: "quran-aligner",
  components: [
    {
      component: "asr",
      status: "active",
      implementationId: "openai-whisper-base@20240930",
      artifactDigest: digest("a"),
      datasetVersion: "upstream-training-data-undisclosed",
      analysisBasis: "acoustic",
      calibratorId: null,
    },
    {
      component: "forced-aligner",
      status: "active",
      implementationId: "wav2vec2-ctc-arabic@1",
      artifactDigest: digest("b"),
      datasetVersion: "upstream-training-data-undisclosed",
      analysisBasis: "acoustic",
      calibratorId: null,
    },
    {
      component: "quran-aligner",
      status: "active",
      implementationId: "quran-constrained-levenshtein@1",
      artifactDigest: digest("c"),
      datasetVersion: "alquran-cloud-quran-uthmani-2026-08-06",
      analysisBasis: "quran-constrained",
      calibratorId: null,
    },
    {
      component: "acoustic-scorer",
      status: "active",
      implementationId: "held-out-acoustic-scorer@1",
      artifactDigest: digest("d"),
      datasetVersion: "held-out-quran-audio-v1",
      analysisBasis: "acoustic",
      calibratorId: "held-out-calibrator@1",
    },
    {
      component: "calibrator",
      status: "active",
      implementationId: "held-out-calibrator@1",
      artifactDigest: digest("e"),
      datasetVersion: "held-out-quran-audio-v1",
      analysisBasis: "acoustic",
      calibratorId: null,
    },
  ],
};

describe("component-level model attribution", () => {
  it("keeps the producer vocabulary and analysis bases closed", () => {
    expect(MODEL_COMPONENTS).toEqual([
      "asr",
      "forced-aligner",
      "quran-aligner",
      "acoustic-scorer",
      "calibrator",
    ]);
    expect(MODEL_ANALYSIS_BASES).toEqual(["acoustic", "quran-constrained", "text-rule"]);
  });

  it("accepts all five explicit producer records and binds the legacy label", () => {
    expect(
      validateModelAttribution(completeAttribution, {
        legacyModelVersion: "quran-constrained-levenshtein@1",
        expectedDigests: {
          asr: digest("a"),
          "forced-aligner": digest("b"),
          "quran-aligner": digest("c"),
          "acoustic-scorer": digest("d"),
          calibrator: digest("e"),
        },
      }),
    ).toEqual(completeAttribution);
  });

  it("fails closed for unknown components and mismatched artifact digests", () => {
    const unknown = structuredClone(completeAttribution) as unknown as {
      components: Array<{ component: string }>;
    };
    unknown.components[0]!.component = "client-selected-model";
    expect(() => validateModelAttribution(unknown)).toThrow(/unknown model component/i);

    expect(() =>
      validateModelAttribution(completeAttribution, {
        expectedDigests: { "quran-aligner": digest("f") },
      }),
    ).toThrow(/artifact digest mismatch.*quran-aligner/i);
  });

  it("rejects malformed digests, duplicate records, and legacy-label disagreement", () => {
    const malformed = structuredClone(completeAttribution);
    const primary = malformed.components.find((item) => item.component === "quran-aligner");
    if (primary?.status === "active") primary.artifactDigest = "sha256:not-a-digest";
    expect(() => validateModelAttribution(malformed)).toThrow(/artifactDigest/i);

    const duplicate = structuredClone(completeAttribution);
    duplicate.components.push(duplicate.components[0]!);
    expect(() => validateModelAttribution(duplicate)).toThrow(/duplicate.*asr/i);

    expect(() =>
      validateModelAttribution(completeAttribution, { legacyModelVersion: "model-v0.3" }),
    ).toThrow(/modelVersion.*primary component/i);
  });

  it("allows an unavailable component only when it makes no artifact claim", () => {
    const withoutCalibrator = structuredClone(completeAttribution);
    const scorer = withoutCalibrator.components.find(
      (item) => item.component === "acoustic-scorer",
    );
    if (scorer?.status !== "active") throw new Error("active acoustic scorer fixture is required");
    scorer.calibratorId = null;
    withoutCalibrator.components[4] = {
      component: "calibrator",
      status: "unavailable",
      reason: "no held-out calibration artifact has been approved",
    };
    expect(validateModelAttribution(withoutCalibrator)).toEqual(withoutCalibrator);

    const dishonest = structuredClone(withoutCalibrator) as unknown as {
      components: Array<Record<string, unknown>>;
    };
    dishonest.components[4]!.artifactDigest = digest("e");
    expect(() => validateModelAttribution(dishonest)).toThrow(/unavailable.*artifact/i);
  });
});
