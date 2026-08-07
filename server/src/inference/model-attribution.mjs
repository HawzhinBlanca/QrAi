import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export const MODEL_COMPONENTS = Object.freeze([
  "asr",
  "forced-aligner",
  "quran-aligner",
  "acoustic-scorer",
  "calibrator",
]);

export const MODEL_ANALYSIS_BASES = Object.freeze([
  "acoustic",
  "quran-constrained",
  "text-rule",
]);

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMPONENT_SET = new Set(MODEL_COMPONENTS);
const ANALYSIS_BASIS_SET = new Set(MODEL_ANALYSIS_BASES);

const fail = (message) => {
  throw new Error(`invalid model attribution: ${message}`);
};

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

/**
 * Runtime validator shared by the server-owned inference and API boundaries.
 * It never fills a default or rewrites a producer identity.
 */
export function validateModelAttribution(value, options = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("value must be an object");
  }
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!COMPONENT_SET.has(value.primaryComponent)) {
    fail(`unknown model component: ${String(value.primaryComponent)}`);
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    fail("components must be a non-empty array");
  }

  const seen = new Set();
  const active = new Map();
  for (const record of value.components) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail("each component record must be an object");
    }
    if (!COMPONENT_SET.has(record.component)) {
      fail(`unknown model component: ${String(record.component)}`);
    }
    if (seen.has(record.component)) fail(`duplicate model component: ${record.component}`);
    seen.add(record.component);

    if (record.status === "unavailable") {
      if (!nonEmptyString(record.reason)) {
        fail(`unavailable component ${record.component} requires a reason`);
      }
      if (Object.hasOwn(record, "artifactDigest")) {
        fail(`unavailable component ${record.component} cannot claim an artifact digest`);
      }
      continue;
    }
    if (record.status !== "active") {
      fail(`component ${record.component} has an unknown status`);
    }
    if (!nonEmptyString(record.implementationId)) {
      fail(`component ${record.component} requires implementationId`);
    }
    if (!nonEmptyString(record.artifactDigest) || !SHA256_DIGEST_PATTERN.test(record.artifactDigest)) {
      fail(
        `component ${record.component} artifactDigest must be sha256 plus 64 lowercase hex characters`,
      );
    }
    if (!nonEmptyString(record.datasetVersion)) {
      fail(`component ${record.component} requires datasetVersion`);
    }
    if (!ANALYSIS_BASIS_SET.has(record.analysisBasis)) {
      fail(`component ${record.component} has an unknown analysisBasis`);
    }
    if (
      record.calibratorId !== null &&
      (typeof record.calibratorId !== "string" || record.calibratorId.length === 0)
    ) {
      fail(`component ${record.component} has an invalid calibratorId`);
    }
    active.set(record.component, record);
  }

  const primary = active.get(value.primaryComponent);
  if (primary === undefined) fail(`primary component ${value.primaryComponent} must be active`);

  for (const record of active.values()) {
    if (record.calibratorId === null) continue;
    const calibrator = active.get("calibrator");
    if (calibrator === undefined || calibrator.implementationId !== record.calibratorId) {
      fail(`component ${record.component} names an unavailable or mismatched calibrator`);
    }
  }

  if (
    options.legacyModelVersion !== undefined &&
    options.legacyModelVersion !== primary.implementationId
  ) {
    fail(`modelVersion must equal the primary component implementationId ${primary.implementationId}`);
  }

  if (options.expectedDigests !== undefined) {
    for (const [component, expectedDigest] of Object.entries(options.expectedDigests)) {
      if (!COMPONENT_SET.has(component)) fail(`unknown expected model component: ${component}`);
      if (active.get(component)?.artifactDigest !== expectedDigest) {
        fail(`artifact digest mismatch for ${component}`);
      }
    }
  }

  return value;
}

const alignmentBytes = readFileSync(new URL("./alignment.mjs", import.meta.url));
const quranProvenance = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/quran-data/src/data/full-quran/provenance-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export const QURAN_ALIGNER_COMPONENT = Object.freeze({
  component: "quran-aligner",
  status: "active",
  implementationId: "quran-constrained-levenshtein@1",
  artifactDigest: `sha256:${createHash("sha256").update(alignmentBytes).digest("hex")}`,
  datasetVersion: `${quranProvenance.canonicalSourceId}:${quranProvenance.edition.identifier}:${quranProvenance.importVersion}`,
  analysisBasis: "quran-constrained",
  calibratorId: null,
});

export const QURAN_ALIGNMENT_ATTRIBUTION = Object.freeze({
  schemaVersion: 1,
  primaryComponent: "quran-aligner",
  components: Object.freeze([QURAN_ALIGNER_COMPONENT]),
});

validateModelAttribution(QURAN_ALIGNMENT_ATTRIBUTION, {
  legacyModelVersion: QURAN_ALIGNER_COMPONENT.implementationId,
});

/**
 * Compose attribution emitted by several bounded inference calls without allowing a later window
 * to silently replace an earlier producer. Repeated component records must be structurally exact;
 * output order follows the closed component vocabulary rather than request timing.
 */
export function mergeModelAttributions(attributions, primaryComponent) {
  if (!Array.isArray(attributions) || attributions.length === 0) {
    fail("model attribution composition requires a non-empty attribution list");
  }
  if (!COMPONENT_SET.has(primaryComponent)) {
    fail(`unknown model component: ${String(primaryComponent)}`);
  }

  const records = new Map();
  for (const attribution of attributions) {
    validateModelAttribution(attribution);
    for (const record of attribution.components) {
      const existing = records.get(record.component);
      if (existing !== undefined && !isDeepStrictEqual(existing, record)) {
        fail(`conflicting model component: ${record.component}`);
      }
      if (existing === undefined) records.set(record.component, { ...record });
    }
  }

  const merged = {
    schemaVersion: 1,
    primaryComponent,
    components: MODEL_COMPONENTS.filter((component) => records.has(component)).map(
      (component) => records.get(component),
    ),
  };
  validateModelAttribution(merged);
  return merged;
}

export function quranAlignmentAttribution(upstreamAttribution = null) {
  if (upstreamAttribution === null) return QURAN_ALIGNMENT_ATTRIBUTION;
  const attribution = mergeModelAttributions(
    [upstreamAttribution, QURAN_ALIGNMENT_ATTRIBUTION],
    "quran-aligner",
  );
  validateModelAttribution(attribution, {
    legacyModelVersion: QURAN_ALIGNER_COMPONENT.implementationId,
  });
  return attribution;
}
