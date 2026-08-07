import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the worker owns an injectable local inference runtime", () => {
  const methods = {
    predictAlignment: async () => ({ finalizable: false }),
    predictTajweed: async () => ({ annotations: [], findings: [] }),
    transcribeSession: async () => ({ transcribed: false }),
  };
  const inference = createInferenceRuntime(methods);

  assert.equal(inference.predictAlignment, methods.predictAlignment);
  assert.equal(inference.predictTajweed, methods.predictTajweed);
  assert.equal(inference.transcribeSession, methods.transcribeSession);
  assert.ok(Object.isFrozen(inference));
});

test("session evaluation calls the injected runtime directly", async () => {
  const calls = [];
  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("evaluation must not call alignment"),
    predictTajweed: async (input, deadline) => {
      calls.push({ input, deadline });
      return { annotations: [], findings: [], sessionId: input.sessionId };
    },
    transcribeSession: async () => assert.fail("evaluation must not call transcription"),
  });
  const handlers = createWorkflowHandlers({
    db: { withTenant: async () => assert.fail("evaluation preparation must not open a transaction") },
    inference,
    upstreamTimeoutMs: 500,
  });
  const job = {
    actorId: "learner-local",
    payload: {
      input: { sessionId: "session-local" },
      requestTrace: "trace-local",
      responseRole: "learner",
    },
    subjectId: "session-local",
    tenantId: "tenant-local",
  };

  const prepared = await handlers["session.evaluate"]({ job, signal: new AbortController().signal });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, job.payload.input);
  assert.ok(calls[0].deadline.signal instanceof AbortSignal);
  assert.deepEqual(prepared.result.response, {
    annotations: [],
    findings: [],
    sessionId: "session-local",
  });
  assert.equal(typeof prepared.commit, "function");
});

test("the API cannot compose or execute workflow handlers", () => {
  const app = source("server/src/app.mjs");
  const worker = source("server/src/worker.mjs");

  assert.doesNotMatch(app, /createJobRuntime|createWorkflowHandlers|jobRuntime/);
  assert.match(worker, /createInferenceRuntime/);
  assert.match(worker, /createWorkflowHandlers\([^)]*inference/s);
});
