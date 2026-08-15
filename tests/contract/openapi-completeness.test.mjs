import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileResponseValidators,
  loadOpenapi,
  routePairsFromRust,
} from "./lib/openapi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "packages/contracts/route-manifest.json"), "utf8"),
);
const spec = loadOpenapi(join(repoRoot, "packages/contracts/openapi.yaml"));
const runtime = routePairsFromRust(
  readFileSync(join(repoRoot, "services/platform-api/src/lib.rs"), "utf8"),
);

const key = ({ method, path }) => `${method.toUpperCase()} ${path}`;
const sortedKeys = (operations) => operations.map(key).sort();
const openapiOperations = () =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map((method) => ({ method: method.toUpperCase(), path })),
  );

test("the permanent contract and manifest preserve the exact 42-operation runtime baseline", () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.baselineSource, "services/platform-api/src/lib.rs");
  assert.equal(manifest.baselineOperations.length, 42);
  assert.deepEqual(sortedKeys(manifest.baselineOperations), sortedKeys(runtime));
});

test("the active contract is the baseline plus only implemented target additions", () => {
  const implemented = manifest.targetAdditions.filter((operation) =>
    ["implemented-node", "implemented-owner-gated"].includes(operation.implementationStatus),
  );
  assert.deepEqual(sortedKeys(openapiOperations()), sortedKeys([...runtime, ...implemented]));
  assert.equal(openapiOperations().length, 46, "the contract is baseline plus four target additions");
});

test("learner history is an implemented, strict, bounded target addition", () => {
  const addition = manifest.targetAdditions.find((operation) => operation.feature === "learner-history");
  assert.equal(addition?.implementationStatus, "implemented-node");

  const operation = spec.paths["/v1/learner/recitation-sessions"]?.get;
  assert.ok(operation, "the implemented learner-history operation is missing from OpenAPI");
  const parameters = Object.fromEntries((operation.parameters ?? []).map((parameter) => [parameter.name, parameter]));
  assert.deepEqual(parameters.limit?.schema, {
    type: "integer",
    minimum: 1,
    maximum: 50,
    default: 20,
  });
  assert.equal(parameters.cursor?.schema?.type, "string");
  assert.deepEqual(operation.responses?.["200"]?.content?.["application/json"]?.schema, {
    $ref: "#/components/schemas/LearnerRecitationHistoryPage",
  });
  for (const schema of ["LearnerRecitationHistoryItem", "LearnerRecitationHistoryPage"]) {
    assert.equal(spec.components.schemas[schema]?.additionalProperties, false, `${schema} must be strict`);
  }
});

test("device identity exposes exactly three strict owner-gated operations", () => {
  const additions = manifest.targetAdditions.filter((operation) =>
    operation.feature.startsWith("device-"),
  );
  assert.equal(additions.length, 3);
  assert.ok(additions.every((operation) => operation.implementationStatus === "implemented-owner-gated"));

  const operations = [
    ["post", "/v1/device-enrollments:exchange", "DeviceEnrollmentExchangeRequest", "DeviceCredentialBundle"],
    ["post", "/v1/device-sessions:refresh", "DeviceSessionRefreshRequest", "DeviceCredentialBundle"],
    ["delete", "/v1/device-sessions/current", null, "DeviceSessionRevocationResult"],
  ];
  for (const [method, path, requestSchema, responseSchema] of operations) {
    const operation = spec.paths[path]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${path} is absent`);
    assert.equal(operation["x-owner-gate"], "DEVICE_IDENTITY_ENABLED=1");
    assert.deepEqual(operation.responses?.["200"]?.content?.["application/json"]?.schema, {
      $ref: `#/components/schemas/${responseSchema}`,
    });
    if (requestSchema) {
      assert.deepEqual(
        operation.requestBody?.content?.["application/json"]?.schema,
        { $ref: `#/components/schemas/${requestSchema}` },
      );
    } else {
      assert.equal(operation.requestBody, undefined);
      assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    }
  }

  for (const schemaName of [
    "DeviceEnrollmentExchangeRequest",
    "DeviceSessionRefreshRequest",
    "DeviceCredentialBundle",
    "DeviceSessionRevocationResult",
  ]) {
    assert.equal(spec.components.schemas[schemaName]?.additionalProperties, false, `${schemaName} is permissive`);
  }
});

test("retained baseline plus explicit additions mechanically produces the target", () => {
  const retained = manifest.baselineOperations.filter((operation) => operation.target === "retain");
  const retired = manifest.baselineOperations.filter((operation) => operation.target === "retire");
  const additions = manifest.targetAdditions;
  const target = [...retained, ...additions];
  const targetKeys = sortedKeys(target);

  assert.equal(retired.length, 4);
  assert.equal(retained.length, 38);
  assert.deepEqual(
    additions.map((operation) => operation.feature).sort(),
    ["device-enrollment", "device-session-refresh", "device-session-revocation", "learner-history"],
  );
  assert.equal(new Set(targetKeys).size, targetKeys.length, "the target route set contains duplicates");
  assert.equal(
    target.length,
    retained.length + additions.length,
    "the target count must be derived from classified operations, never typed independently",
  );
});

test("no current operation hides behind x-unvalidated", () => {
  const permissive = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation?.["x-unvalidated"] === true) permissive.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(permissive, []);
});

test("all four inference proxies point at strict producer-owned schemas", () => {
  const bindings = [
    ["POST /v1/ml/alignments:predict", "AlignmentPredictionResponse"],
    ["POST /v1/ml/tajweed-findings:predict", "TajweedPredictionResponse"],
    ["POST /v1/asr/transcribe", "TranscribeResponse"],
    ["POST /v1/asr/force-align", "ForceAlignResponse"],
  ];

  for (const [operationKey, schemaName] of bindings) {
    const [method, path] = operationKey.split(" ");
    assert.deepEqual(
      spec.paths[path]?.[method.toLowerCase()]?.responses?.["200"]?.content?.["application/json"]?.schema,
      { $ref: `#/components/schemas/${schemaName}` },
    );
    assert.equal(spec.components.schemas[schemaName]?.additionalProperties, false);
  }
});

test("session creation exposes no client-selectable model identity", () => {
  const requestSchema =
    spec.paths["/v1/recitation-sessions"]?.post?.requestBody?.content?.["application/json"]
      ?.schema;
  assert.ok(requestSchema, "session creation request schema is missing");
  assert.equal(requestSchema.properties?.modelVersion, undefined);
  assert.equal(requestSchema.properties?.modelAttribution, undefined);
  assert.ok(!requestSchema.required?.includes("modelVersion"));
  assert.ok(!requestSchema.required?.includes("modelAttribution"));
});

test("strict proxy response fixtures validate and undeclared envelope fields fail", () => {
  const validators = compileResponseValidators(spec);
  const quranRef = { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "fixture" };
  const attribution = (component, implementationId) => ({
    schemaVersion: 1,
    primaryComponent: component,
    components: [
      {
        component,
        status: "active",
        implementationId,
        artifactDigest: `sha256:${"a".repeat(64)}`,
        datasetVersion: "declared-fixture",
        analysisBasis: component === "quran-aligner" ? "quran-constrained" : "acoustic",
        calibratorId: null,
      },
    ],
  });
  const fixtures = new Map([
    [
      "POST /v1/asr/transcribe 200",
      {
        text: "fixture transcript",
        language: "ar",
        duration: 1.25,
        words: [{ word: "fixture", start: 0, end: 1.25, probability: 0.9 }],
        modelVersion: "declared-asr-fixture",
        modelAttribution: attribution("asr", "declared-asr-fixture"),
        latencyMs: 1,
      },
    ],
    [
      "POST /v1/asr/force-align 200",
      {
        words: [{ word: "fixture", start: 0, end: 1.25, score: 0.9 }],
        duration: 1.25,
        modelVersion: "declared-forced-aligner-fixture",
        modelAttribution: attribution("forced-aligner", "declared-forced-aligner-fixture"),
        latencyMs: 1,
      },
    ],
    [
      "POST /v1/ml/alignments:predict 200",
      {
        traceId: "fixture-trace",
        fixtureCaseId: null,
        tenantId: "fixture-tenant",
        sessionId: "fixture-session",
        quranRef,
        sourceChecksum: "fixture-checksum",
        evidenceId: "fixture-evidence",
        modelVersion: "declared-quran-aligner-fixture",
        modelAttribution: attribution("quran-aligner", "declared-quran-aligner-fixture"),
        auditEventId: "fixture-audit",
        alignments: [
          {
            wordId: "fixture-word",
            canonicalText: "fixture",
            heardText: "",
            startMs: null,
            endMs: null,
            status: "needs-review",
            confidence: 0,
            reviewStatus: "teacher-review-required",
            tenantId: "fixture-tenant",
            quranRef,
            sourceChecksum: "fixture-checksum",
            evidenceId: "fixture-evidence",
            modelVersion: "declared-fixture",
            traceId: "fixture-trace",
            auditEventId: "fixture-audit",
          },
        ],
        confidence: 0,
        reviewStatus: "teacher-review-required",
        finalizable: false,
        nonFinalizedReason: "declared fixture has no measured audio",
        externalAsr: { called: false, reason: "not-requested" },
        latencyMs: 1,
        datasetVersion: "declared-fixture",
        algorithm: "declared-fixture",
      },
    ],
    [
      "POST /v1/ml/tajweed-findings:predict 200",
      {
        traceId: "fixture-trace",
        fixtureCaseId: null,
        tenantId: "fixture-tenant",
        sessionId: "fixture-session",
        quranRef,
        evidenceId: "fixture-evidence",
        modelVersion: "declared-fixture",
        auditEventId: "fixture-audit",
        annotations: [
          {
            wordId: "fixture-word",
            rule: "fixture-rule",
            arabicName: "fixture-name",
            category: "fixture-category",
            analysisBasis: "text-rule",
            instructional: true,
            explanation: "declared fixture, not model output",
            sources: [
              { id: "fixture-source", title: "Declared fixture", citation: "Test-only fixture" },
            ],
            tenantId: "fixture-tenant",
            sourceChecksum: "fixture-checksum",
            evidenceId: "fixture-evidence",
            traceId: "fixture-trace",
            auditEventId: "fixture-audit",
          },
        ],
        findings: [],
        latencyMs: 1,
        datasetVersion: "declared-fixture",
        algorithm: "declared-fixture",
      },
    ],
  ]);

  for (const [operationKey, fixture] of fixtures) {
    const validator = validators.get(operationKey);
    assert.ok(validator, `${operationKey}: response validator is missing`);
    assert.equal(validator.unvalidated, false);
    assert.equal(validator.validate(fixture), true, JSON.stringify(validator.validate.errors));
    assert.equal(
      validator.validate({ ...fixture, undeclaredEnvelopeField: true }),
      false,
      `${operationKey}: an undeclared response field passed a supposedly strict contract`,
    );
  }
});


test("the real ML producers satisfy the permanent response contract", async () => {
  process.env.AUDIO_STORAGE_DIR = mkdtempSync(join(tmpdir(), "qrai-openapi-producer-"));
  const { predictAlignment, predictTajweed } = await import(
    "../../server/src/inference/runtime.mjs"
  );
  const validators = compileResponseValidators(spec);
  const requests = [
    [
      "POST /v1/ml/alignments:predict 200",
      await predictAlignment({ tenantId: "contract-fixture", sessionId: "alignment-fixture" }),
    ],
    [
      "POST /v1/ml/tajweed-findings:predict 200",
      await predictTajweed({ tenantId: "contract-fixture", sessionId: "tajweed-fixture" }),
    ],
  ];

  for (const [operationKey, response] of requests) {
    const validator = validators.get(operationKey)?.validate;
    assert.ok(validator, `${operationKey}: validator missing`);
    assert.equal(validator(response), true, JSON.stringify(validator.errors));
  }
});

test("the accepted generation ADR pins one stable Dart generator before it is installed", () => {
  const decisions = readFileSync(join(repoRoot, "docs/DECISIONS.md"), "utf8");
  const section = decisions.split("## ADR-0039")[1]?.split("\n## ADR-")[0] ?? "";
  assert.match(section, /\*\*Status:\*\* Accepted/);
  assert.match(section, /OpenAPI Generator 7\.22\.0/);
  assert.match(section, /`dart-dio` generator/);
  assert.match(section, /packages\/contracts\/openapi\.yaml/);
});
