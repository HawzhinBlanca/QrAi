import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MODEL_ANALYSIS_BASES,
  MODEL_COMPONENTS,
  QURAN_ALIGNER_COMPONENT,
  mergeModelAttributions,
  quranAlignmentAttribution,
  validateModelAttribution,
} from "../../server/src/inference/model-attribution.mjs";

const digest = (hex) => `sha256:${hex.repeat(64)}`;

const attribution = () => ({
  schemaVersion: 1,
  primaryComponent: "asr",
  components: [
    {
      component: "asr",
      status: "active",
      implementationId: "declared-asr-fixture",
      artifactDigest: digest("a"),
      datasetVersion: "declared-fixture",
      analysisBasis: "acoustic",
      calibratorId: null,
    },
  ],
});

test("runtime attribution uses the same closed component and analysis vocabularies", () => {
  assert.deepEqual(MODEL_COMPONENTS, [
    "asr",
    "forced-aligner",
    "quran-aligner",
    "acoustic-scorer",
    "calibrator",
  ]);
  assert.deepEqual(MODEL_ANALYSIS_BASES, ["acoustic", "quran-constrained", "text-rule"]);
});

test("runtime validation rejects unknown components and mismatched expected digests", () => {
  const unknown = attribution();
  unknown.components[0].component = "client-selected-model";
  assert.throws(() => validateModelAttribution(unknown), /unknown model component/i);

  assert.throws(
    () => validateModelAttribution(attribution(), { expectedDigests: { asr: digest("b") } }),
    /artifact digest mismatch.*asr/i,
  );
});

test("the Quran aligner digest identifies the exact executable source bytes", () => {
  const source = readFileSync(new URL("../../server/src/inference/alignment.mjs", import.meta.url));
  const expected = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  assert.equal(QURAN_ALIGNER_COMPONENT.artifactDigest, expected);
});

test("composed Quran alignment attribution preserves validated upstream ASR provenance", () => {
  const composed = quranAlignmentAttribution(attribution());
  assert.equal(composed.primaryComponent, "quran-aligner");
  assert.deepEqual(
    composed.components.map((component) => component.component),
    ["asr", "quran-aligner"],
  );
  assert.equal(
    composed.components.at(-1).implementationId,
    QURAN_ALIGNER_COMPONENT.implementationId,
  );
});

test("window attribution merges identical ASR records with a forced aligner in stable order", () => {
  const forced = {
    schemaVersion: 1,
    primaryComponent: "forced-aligner",
    components: [
      {
        component: "forced-aligner",
        status: "active",
        implementationId: "declared-forced-aligner-fixture",
        artifactDigest: digest("b"),
        datasetVersion: "declared-fixture",
        analysisBasis: "acoustic",
        calibratorId: null,
      },
    ],
  };

  const merged = mergeModelAttributions([attribution(), forced, attribution()], "asr");
  assert.equal(merged.primaryComponent, "asr");
  assert.deepEqual(
    merged.components.map((component) => component.component),
    ["asr", "forced-aligner"],
  );
  assert.deepEqual(merged.components[0], attribution().components[0]);
  assert.deepEqual(merged.components[1], forced.components[0]);
});

test("window attribution refuses missing evidence and conflicting records for one component", () => {
  assert.throws(
    () => mergeModelAttributions([], "asr"),
    /non-empty attribution list/i,
  );

  const conflict = attribution();
  conflict.components[0].artifactDigest = digest("c");
  assert.throws(
    () => mergeModelAttributions([attribution(), conflict], "asr"),
    /conflicting model component: asr/i,
  );
});
