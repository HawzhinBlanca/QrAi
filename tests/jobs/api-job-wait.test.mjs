import assert from "node:assert/strict";
import test from "node:test";

import { waitForJobResult } from "../../server/src/jobs/wait-for-job.mjs";

const job = Object.freeze({ id: "job-wait", tenantId: "tenant-wait" });

test("the API only waits for a worker-owned completed result", async () => {
  let reads = 0;
  let executions = 0;
  const response = await waitForJobResult({
    deadline: { throwIfExpired() {} },
    jobRuntime: { async runOne() { executions += 1; throw new Error("API execution is forbidden"); } },
    jobStore: {
      async get() {
        reads += 1;
        if (reads === 1) return { status: "retry", result: null };
        return { status: "completed", result: { responseJson: '{"owner":"worker"}' } };
      },
    },
  }, job);

  assert.deepEqual(response, { owner: "worker" });
  assert.equal(executions, 0);
  assert.equal(reads, 2);
});

test("a completed worker error preserves its sanitized API contract", async () => {
  await assert.rejects(
    waitForJobResult({
      deadline: { throwIfExpired() {} },
      jobStore: {
        async get() {
          return {
            status: "completed",
            result: {
              responseError: {
                message: "ML service returned invalid model provenance",
                status: 502,
              },
            },
          };
        },
      },
    }, { ...job, kind: "session.finalize" }),
    (error) =>
      error?.status === 502 &&
      error?.message === "ML service returned invalid model provenance",
  );
});

test("a dead job fails closed without API execution", async () => {
  await assert.rejects(
    waitForJobResult({
      deadline: { throwIfExpired() {} },
      jobStore: { async get() { return { status: "dead", result: null }; } },
    }, job),
    (error) => error?.status === 503 && error?.message === "durable workflow failed",
  );
});

test("an inference wait deadline preserves the compatibility error and leaves work queued", async () => {
  let reads = 0;
  await assert.rejects(
    waitForJobResult({
      deadline: {
        throwIfExpired() {
          throw new Error("request deadline reached");
        },
      },
      jobStore: {
        async get() {
          reads += 1;
          return { status: "queued", result: null };
        },
      },
    }, { ...job, kind: "session.finalize" }),
    (error) => error?.status === 502 && error?.message === "ML service unavailable",
  );
  assert.equal(reads, 0);
});

test("an API deadline leaves queued work for the worker", async () => {
  let checks = 0;
  let reads = 0;
  await assert.rejects(
    waitForJobResult({
      deadline: {
        throwIfExpired() {
          checks += 1;
          if (checks > 1) throw new Error("request deadline reached");
        },
      },
      jobStore: {
        async get() {
          reads += 1;
          return { status: "queued", result: null };
        },
      },
    }, job),
    /request deadline reached/,
  );
  assert.equal(reads, 1);
});
