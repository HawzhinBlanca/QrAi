import { prepareSessionEvaluation } from "../routes/ml-proxy.mjs";
import { preparePrivacyWorkflow } from "../routes/privacy.mjs";
import { prepareSessionFinalization } from "../routes/session-writes.mjs";

import { ApiError } from "../lib/api-errors.mjs";

function captureApiError(prepare) {
  return Promise.resolve()
    .then(prepare)
    .catch((error) => {
      if (!(error instanceof ApiError)) throw error;
      if (
        !Number.isInteger(error.status) ||
        error.status < 400 ||
        error.status > 599 ||
        typeof error.message !== "string" ||
        error.message.length === 0 ||
        error.message.length > 256
      ) {
        throw Object.assign(new Error("workflow API error is invalid"), {
          jobErrorCode: "handler_invalid",
        });
      }
      return {
        result: {
          responseError: {
            message: error.message,
            status: error.status,
          },
        },
        commit: async () => undefined,
      };
    });
}

export function createWorkflowHandlers(ctx) {
  if (!ctx?.db || typeof ctx.db.withTenant !== "function") {
    throw new TypeError("createWorkflowHandlers: a tenant database is required");
  }
  if (
    !ctx.inference ||
    typeof ctx.inference.predictAlignment !== "function" ||
    typeof ctx.inference.predictTajweed !== "function" ||
    typeof ctx.inference.transcribeSession !== "function"
  ) {
    throw new TypeError("createWorkflowHandlers: a local inference runtime is required");
  }
  return Object.freeze({
    "session.finalize": ({ job, signal }) => captureApiError(() => prepareSessionFinalization({
      ctx,
      tenantId: job.tenantId,
      actorId: job.actorId,
      sessionId: job.payload.sessionId,
      requestTrace: job.payload.requestTrace,
      signal,
    })),
    "session.evaluate": ({ job, signal }) =>
      captureApiError(() => prepareSessionEvaluation({ ctx, job, signal })),
    "privacy.export": ({ job, signal }) =>
      captureApiError(() => preparePrivacyWorkflow({ ctx, job, signal })),
    "privacy.delete": ({ job, signal }) =>
      captureApiError(() => preparePrivacyWorkflow({ ctx, job, signal })),
  });
}
