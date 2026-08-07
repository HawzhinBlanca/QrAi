import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { validateJobDocument } from "../../server/src/jobs/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..");
const source = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const jobRuntimeSource = [
  "server/src/jobs/wait-for-job.mjs",
  "server/src/jobs/runtime.mjs",
  "server/src/jobs/store.mjs",
  "server/src/jobs/workflows.mjs",
  "server/src/worker.mjs",
  "server/scripts/requeue-dead-job.mjs",
].map(source).join("\n");
const onlineServerSource = [
  jobRuntimeSource,
  source("server/src/routes/ml-proxy.mjs"),
  source("server/src/routes/privacy.mjs"),
  source("server/src/routes/session-writes.mjs"),
].join("\n");

test("job documents recursively refuse sensitive and dependency-address fields", () => {
  for (const field of [
    "audio",
    "audioBase64",
    "authorization",
    "credentials",
    "apiKey",
    "password",
    "secret",
    "token",
    "transcript",
    "uri",
    "url",
    "waveform",
  ]) {
    assert.throws(
      () => validateJobDocument({ safe: { [field]: "must-not-persist" } }),
      new RegExp(`forbidden field ${field}`, "i"),
    );
  }
});

test("job document byte, string, array, field, and depth limits fail closed", () => {
  assert.throws(
    () => validateJobDocument({ values: Array.from({ length: 513 }, (_, index) => index) }),
    /oversized array/i,
  );
  assert.throws(
    () => validateJobDocument({ value: "x".repeat(4_097) }),
    /oversized string/i,
  );
  assert.throws(
    () => validateJobDocument(Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`field${index}`, index]),
    )),
    /too many fields/i,
  );
  let nested = {};
  for (let index = 0; index < 10; index += 1) nested = { child: nested };
  assert.throws(() => validateJobDocument(nested), /maximum depth/i);
  assert.throws(
    () => validateJobDocument({ first: "x".repeat(4_000), second: "y".repeat(4_000) }, {
      maxBytes: 4_096,
    }),
    /bounded JSON/i,
  );
});

test("unexpected job failures persist only a fixed code and expose no secret metric label", async () => {
  const hostile = "https://internal.invalid learner transcript credential=raw-secret";
  let failedInput = null;
  const store = {
    claim: async () => ({
      id: "job-security",
      tenantId: "tenant-security",
      kind: "session.evaluate",
      attemptCount: 1,
      leaseGeneration: 1,
    }),
    complete: async () => assert.fail("a failed handler must not complete"),
    fail: async (input) => {
      failedInput = input;
      return { status: "retry" };
    },
  };
  const runtime = createJobRuntime({
    store,
    handlers: { "session.evaluate": async () => { throw new Error(hostile); } },
    workerId: "worker-security",
    leaseMs: 1_000,
    operationTimeoutMs: 100,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  const outcome = await runtime.runOne("tenant-security");
  assert.equal(outcome.outcome, "retry");
  assert.equal(failedInput.errorCode, "job_failed");
  assert.doesNotMatch(JSON.stringify(failedInput), /internal\.invalid|transcript|raw-secret/i);
  assert.doesNotMatch(runtime.renderMetrics(), /internal\.invalid|transcript|raw-secret/i);
});

test("online durable jobs cannot write evaluation authority or access release signing material", () => {
  assert.doesNotMatch(onlineServerSource, /insert\s+into\s+eval_runs/i);
  assert.doesNotMatch(jobRuntimeSource, /signing.?key|private.?key|signature_base64url/i);
  assert.doesNotMatch(jobRuntimeSource, /release_eligible\s*=|releaseEligible\s*:/i);
  assert.match(source("server/src/routes/ml-proxy.mjs"), /FROM eval_runs/i);
  assert.match(
    source("services/asr-inference/evaluate_candidate.py"),
    /never signs or promotes its output/i,
  );
});

test("the recovery command prints identifiers only and never dumps payloads or raw errors", () => {
  const recoverySource = source("server/scripts/requeue-dead-job.mjs");
  assert.doesNotMatch(recoverySource, /JSON\.stringify\([^)]*payload/s);
  assert.doesNotMatch(recoverySource, /error\.message|console\.error\(error|stderr\.write\([^)]*error/s);
  assert.match(recoverySource, /assertRestrictedRole\(\)/);
});
