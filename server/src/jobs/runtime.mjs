import { JOB_KINDS, StaleJobLeaseError } from "./store.mjs";

const KIND_SET = new Set(JOB_KINDS);
const OUTCOMES = new Set(["completed", "retry", "dead", "idle", "stale"]);

function positiveWhole(value, name, maximum = 86_400_000) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive whole number no greater than ${maximum}`);
  }
  return value;
}

function nonEmpty(value, name, maximum = 128) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function jitter(jobId, ceiling) {
  let hash = 2166136261;
  for (const character of jobId) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % (ceiling + 1);
}

export function retryDelayMs({ attemptCount, jobId, baseMs, maxMs }) {
  positiveWhole(attemptCount, "attemptCount", 20);
  nonEmpty(jobId, "jobId", 256);
  positiveWhole(baseMs, "baseMs");
  positiveWhole(maxMs, "maxMs");
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.min(19, attemptCount - 1)));
  const jitterCeiling = Math.min(Math.floor(exponential / 4), Math.max(0, maxMs - exponential));
  return Math.min(maxMs, exponential + jitter(jobId, jitterCeiling));
}

class OperationTimeoutError extends Error {
  constructor() {
    super("job operation exceeded its deadline");
    this.name = "OperationTimeoutError";
  }
}

function withTimeout(operation, timeoutMs, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new OperationTimeoutError());
      reject(new OperationTimeoutError());
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timer));
}

export function createJobRuntime({
  store,
  handlers,
  workerId,
  leaseMs,
  operationTimeoutMs,
  retryBaseMs = 1_000,
  retryMaxMs = 300_000,
}) {
  if (!store || typeof store.claim !== "function" || typeof store.complete !== "function") {
    throw new TypeError("createJobRuntime: a job store is required");
  }
  if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new TypeError("handlers must be an object keyed by job kind");
  }
  nonEmpty(workerId, "workerId");
  positiveWhole(leaseMs, "leaseMs", 3_600_000);
  positiveWhole(operationTimeoutMs, "operationTimeoutMs", 3_600_000);
  positiveWhole(retryBaseMs, "retryBaseMs");
  positiveWhole(retryMaxMs, "retryMaxMs");
  if (leaseMs <= operationTimeoutMs) {
    throw new TypeError("leaseMs must exceed operationTimeoutMs");
  }
  for (const [kind, handler] of Object.entries(handlers)) {
    if (!KIND_SET.has(kind) || typeof handler !== "function") {
      throw new TypeError(`handler ${kind} must be a function for a known job kind`);
    }
  }

  let draining = false;
  const active = new Map();
  const attempts = new Map();

  function record(kind, outcome) {
    if (!KIND_SET.has(kind) || !OUTCOMES.has(outcome)) return;
    const key = `${kind}\u0000${outcome}`;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  }

  async function execute(tenantId, { jobId = null } = {}) {
    if (draining) return { outcome: "idle", job: null };
    const job = await store.claim({ tenantId, workerId, leaseMs, jobId });
    if (!job) return { outcome: "idle", job: null };
    const controller = new AbortController();
    const token = Symbol(job.id);
    active.set(token, controller);
    try {
      const handler = handlers[job.kind];
      if (!handler) throw Object.assign(new Error("job handler is unavailable"), { jobErrorCode: "handler_unavailable" });
      const prepared = await withTimeout(
        handler({ job, signal: controller.signal }),
        operationTimeoutMs,
        controller,
      );
      if (
        prepared === null || typeof prepared !== "object" || Array.isArray(prepared) ||
        typeof prepared.commit !== "function"
      ) {
        throw Object.assign(new Error("job handler returned an invalid result"), { jobErrorCode: "handler_invalid" });
      }
      const completed = await store.complete({
        tenantId,
        jobId: job.id,
        workerId,
        leaseGeneration: job.leaseGeneration,
        result: prepared.result ?? {},
        commit: prepared.commit,
      });
      record(job.kind, "completed");
      return { outcome: "completed", job: completed };
    } catch (error) {
      // Another worker may reclaim an expired lease after this handler finishes
      // its external work but before the fenced commit begins. The newer lease is
      // authoritative; never let the stale worker mutate its retry/dead state.
      if (error instanceof StaleJobLeaseError) {
        record(job.kind, "stale");
        return { outcome: "stale", job: null };
      }
      const errorCode = error instanceof OperationTimeoutError
        ? "operation_timeout"
        : (typeof error?.jobErrorCode === "string" ? error.jobErrorCode : "job_failed");
      const failed = await store.fail({
        tenantId,
        jobId: job.id,
        workerId,
        leaseGeneration: job.leaseGeneration,
        errorCode,
        retryDelayMs: retryDelayMs({
          attemptCount: job.attemptCount,
          jobId: job.id,
          baseMs: retryBaseMs,
          maxMs: retryMaxMs,
        }),
      });
      record(job.kind, failed.status);
      return { outcome: failed.status, errorCode, error, job: failed };
    } finally {
      active.delete(token);
    }
  }

  function runOne(tenantId, options) {
    const promise = execute(tenantId, options);
    return promise;
  }

  async function drain({ timeoutMs }) {
    positiveWhole(timeoutMs, "timeoutMs");
    draining = true;
    for (const controller of active.values()) controller.abort(new Error("worker draining"));
    if (active.size === 0) return true;
    const deadline = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const settled = new Promise((resolve) => {
      const poll = () => {
        if (active.size === 0) resolve(true);
        else setTimeout(poll, 5).unref?.();
      };
      poll();
    });
    return Promise.race([settled, deadline]);
  }

  function renderMetrics() {
    let output = "# HELP job_attempts_total Finished durable job attempts.\n";
    output += "# TYPE job_attempts_total counter\n";
    for (const [key, count] of [...attempts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [kind, outcome] = key.split("\u0000");
      output += `job_attempts_total{kind="${kind}",outcome="${outcome}"} ${count}\n`;
    }
    output += "# HELP job_worker_active Current in-process durable job attempts.\n";
    output += "# TYPE job_worker_active gauge\n";
    output += `job_worker_active ${active.size}\n`;
    return output;
  }

  return Object.freeze({ runOne, drain, renderMetrics, isDraining: () => draining });
}
