import { ApiError } from "../lib/authz.mjs";

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function responseFrom(job) {
  if (
    job?.status !== "completed" ||
    job.result === null || typeof job.result !== "object" || Array.isArray(job.result)
  ) {
    return null;
  }
  if (Object.hasOwn(job.result, "responseError")) {
    const error = job.result.responseError;
    if (
      error === null || typeof error !== "object" || Array.isArray(error) ||
      Object.keys(error).sort().join(",") !== "message,status" ||
      typeof error.message !== "string" || error.message.length === 0 || error.message.length > 256 ||
      !Number.isInteger(error.status) || error.status < 400 || error.status > 599
    ) {
      throw new ApiError("durable workflow returned an invalid result", 503);
    }
    throw new ApiError(error.message, error.status);
  }
  if (!Object.hasOwn(job.result, "responseJson") || typeof job.result.responseJson !== "string") {
    throw new ApiError("durable workflow returned an invalid result", 503);
  }
  try {
    return JSON.parse(job.result.responseJson);
  } catch {
    throw new ApiError("durable workflow returned an invalid result", 503);
  }
}

/**
 * Wait for a worker-owned durable job without changing the synchronous HTTP contract.
 * Concurrent identical callers observe the one authoritative lease and read its stored response.
 */
export async function waitForJobResult(ctx, job) {
  if (!ctx?.jobStore) {
    throw new ApiError("durable workflow is unavailable", 503);
  }

  // The API is an enqueue-and-wait boundary. It never claims, retries, or executes a job: only the
  // dedicated worker owns those effects and their fenced leases.
  for (;;) {
    try {
      ctx.deadline?.throwIfExpired();
    } catch (error) {
      if (job?.kind === "session.finalize" || job?.kind === "session.evaluate") {
        throw new ApiError("ML service unavailable", 502);
      }
      throw error;
    }
    const current = await ctx.jobStore.get({ tenantId: job.tenantId, jobId: job.id });
    const response = responseFrom(current);
    if (response !== null) return response;
    if (current?.status === "dead") throw new ApiError("durable workflow failed", 503);
    await sleep(10);
  }
}
