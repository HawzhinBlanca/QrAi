import assert from "node:assert/strict";
import test from "node:test";

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";

function abortableMethod(entered) {
  return async (_input, deadline) => {
    entered(deadline.signal);
    return new Promise((_, reject) => {
      deadline.signal.addEventListener(
        "abort",
        () => reject(new Error("local inference cancelled")),
        { once: true },
      );
    });
  };
}

test("worker cancellation reaches local session transcription", async () => {
  let observedSignal;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("cancelled transcription must not align"),
    predictTajweed: async () => assert.fail("finalization must not evaluate Tajweed"),
    transcribeSession: abortableMethod((signal) => {
      observedSignal = signal;
      enteredResolve();
    }),
  });
  const db = {
    async withTenant(_tenantId, callback) {
      const tx = async (parts) => {
        if (parts[0].includes("FROM recitation_sessions")) {
          return [{
            consent_snapshot: {},
            external_asr_processing: true,
            guardian_approved: true,
            learner_id: "learner-cancel",
            model_version_id: "model-cancel",
            quran_ref: { surahNumber: 1, ayahStart: 1, ayahEnd: 1 },
          }];
        }
        throw new Error("unexpected database call before cancellation");
      };
      return callback(tx);
    },
  };
  const handlers = createWorkflowHandlers({ db, inference, upstreamTimeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = handlers["session.finalize"]({
    job: {
      actorId: "learner-cancel",
      payload: { requestTrace: null, sessionId: "session-cancel" },
      tenantId: "tenant-cancel",
    },
    signal: controller.signal,
  });

  await entered;
  controller.abort();

  await assert.rejects(pending, /local inference cancelled/);
  assert.equal(observedSignal.aborted, true);
});

test("worker cancellation reaches local Tajweed evaluation", async () => {
  let observedSignal;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("evaluation must not align"),
    predictTajweed: abortableMethod((signal) => {
      observedSignal = signal;
      enteredResolve();
    }),
    transcribeSession: async () => assert.fail("evaluation must not transcribe"),
  });
  const handlers = createWorkflowHandlers({
    db: { withTenant: async () => assert.fail("cancelled evaluation must not persist") },
    inference,
    upstreamTimeoutMs: 5_000,
  });
  const controller = new AbortController();
  const pending = handlers["session.evaluate"]({
    job: {
      actorId: "learner-cancel",
      payload: {
        input: { sessionId: "session-cancel" },
        requestTrace: null,
        responseRole: "learner",
      },
      subjectId: "session-cancel",
      tenantId: "tenant-cancel",
    },
    signal: controller.signal,
  });

  await entered;
  controller.abort();

  await assert.rejects(pending, /local inference cancelled/);
  assert.equal(observedSignal.aborted, true);
});
