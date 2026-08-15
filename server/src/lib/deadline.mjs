const MAX_TIMEOUT_MS = 2_147_483_647;

/** @typedef {{ signal: AbortSignal, remainingMs: () => number, throwIfExpired: () => void }} Deadline */

/** @param {number} timeoutMs @param {string} [label] */
function assertTimeout(timeoutMs, label = "dependency timeout") {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`${label} must be a positive whole number of milliseconds`);
  }
}

/** A fixed internal signal; dependency details never belong in its public message. */
export class DeadlineExceededError extends Error {
  constructor() {
    super("dependency deadline exceeded");
    this.name = "DeadlineExceededError";
    /** @type {string} */
    this.code = "DEPENDENCY_DEADLINE_EXCEEDED";
  }
}

/** @param {any} error */
export function isDeadlineError(error) {
  return (
    error instanceof DeadlineExceededError ||
    error?.code === "DEPENDENCY_DEADLINE_EXCEEDED" ||
    error?.name === "TimeoutError" ||
    error?.name === "AbortError"
  );
}

/** One monotonic budget and one abort signal shared by every child operation. */
/**
 * @param {number} timeoutMs
 * @param {{ parentSignal?: AbortSignal | null }} [options]
 * @returns {Readonly<Deadline>}
 */
export function createDeadline(timeoutMs, { parentSignal = null } = {}) {
  assertTimeout(timeoutMs);
  if (parentSignal !== null && !(parentSignal instanceof AbortSignal)) {
    throw new TypeError("deadline parentSignal must be an AbortSignal");
  }

  const expiresAt = performance.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal === null
    ? timeoutSignal
    : AbortSignal.any([parentSignal, timeoutSignal]);

  return Object.freeze({
    signal,
    remainingMs() {
      return Math.max(0, Math.ceil(expiresAt - performance.now()));
    },
    throwIfExpired() {
      if (signal.aborted || performance.now() >= expiresAt) throw new DeadlineExceededError();
    },
  });
}

/** Tie a request budget to both elapsed time and an HTTP caller disconnect. */
/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {number} timeoutMs
 */
export function createIncomingRequestDeadline(request, response, timeoutMs) {
  if (typeof request?.once !== "function" || typeof response?.once !== "function") {
    throw new TypeError("incoming request and response event emitters are required");
  }
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  request.once("aborted", abort);
  response.once("close", () => {
    request.off("aborted", abort);
    if (!response.writableEnded) abort();
  });
  return createDeadline(timeoutMs, { parentSignal: disconnected.signal });
}

/**
 * Fetch under a shared deadline. The signal remains attached to the returned Response, so an abort
 * also cancels a body that stalls after its headers arrive.
 *
 * @param {string | URL} url
 * @param {RequestInit & { deadline?: Deadline | null, timeoutMs?: number,
 *   fetchImpl?: typeof fetch }} [options]
 */
export async function fetchWithDeadline(
  url,
  { deadline = null, timeoutMs = 60_000, fetchImpl = fetch, ...init } = {},
) {
  const budget = deadline ?? createDeadline(timeoutMs);
  budget.throwIfExpired();

  const signal = init.signal
    ? AbortSignal.any([budget.signal, init.signal])
    : budget.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted || isDeadlineError(error)) throw new DeadlineExceededError();
    throw error;
  }
}

/** Strict service configuration parser shared by server-owned dependency boundaries. */
/** @param {string | undefined} raw @param {string} [name] */
export function parseTimeoutSeconds(raw, name = "UPSTREAM_TIMEOUT_SECS") {
  if (!/^[0-9]+$/.test(raw ?? "")) {
    throw new TypeError(`${name} must be a whole number of seconds`);
  }
  const seconds = Number(raw);
  const timeoutMs = seconds * 1_000;
  assertTimeout(timeoutMs, name);
  return timeoutMs;
}
