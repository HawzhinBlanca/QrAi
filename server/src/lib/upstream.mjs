import { ApiError } from "./authz.mjs";
import { createDeadline, fetchWithDeadline } from "./deadline.mjs";

export { createDeadline } from "./deadline.mjs";

/** Matches `DEFAULT_UPSTREAM_TIMEOUT_SECS` in lib.rs. */
export const DEFAULT_UPSTREAM_TIMEOUT_SECS = 60;

/**
 * The largest value `AbortSignal.timeout()` can express: its argument is clamped to a 32-bit
 * signed millisecond count, and anything above throws at CALL time — i.e. per request, as a 500,
 * long after boot.
 */
const MAX_TIMEOUT_SECS = Math.floor(2 ** 31 / 1000);

/**
 * Resolve `UPSTREAM_TIMEOUT_SECS` from an environment, in milliseconds.
 */
export function upstreamTimeoutMs(env = process.env) {
  const raw = (env.UPSTREAM_TIMEOUT_SECS ?? "").trim();
  if (raw === "") return DEFAULT_UPSTREAM_TIMEOUT_SECS * 1000;

  if (!/^\+?\d+$/.test(raw)) {
    throw new Error(
      `UPSTREAM_TIMEOUT_SECS must be a whole number of seconds, got ${JSON.stringify(raw)}`,
    );
  }
  const secs = Number(raw);

  if (secs === 0) {
    throw new Error(
      "UPSTREAM_TIMEOUT_SECS=0 aborts every ML/ASR call before it is sent (AbortSignal.timeout(0) " +
        "fires immediately). Set a positive number of seconds.",
    );
  }
  if (secs > MAX_TIMEOUT_SECS) {
    throw new Error(
      `UPSTREAM_TIMEOUT_SECS=${secs} exceeds the ${MAX_TIMEOUT_SECS}s this runtime can express ` +
        "(AbortSignal.timeout takes a 32-bit millisecond count). Set a smaller number of seconds.",
    );
  }
  return secs * 1000;
}

/**
 * JSON POST with one bounded AbortSignal and generic failures. Response bodies and caught errors are
 * deliberately not logged: either can contain learner transcript data or internal dependency URLs.
 */
export async function postJson({
  url,
  keyHeader,
  keyValue,
  body,
  label,
  service,
  timeoutMs = 60_000,
  deadline = null,
  fetchImpl = fetch,
}) {
  const budget = deadline ?? createDeadline(timeoutMs);
  let response;
  try {
    response = await fetchWithDeadline(url, {
      deadline: budget,
      fetchImpl,
      method: "POST",
      headers: { "content-type": "application/json", [keyHeader]: keyValue },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(`${service} proxy ${label} send error`);
    throw new ApiError(`${service} service unavailable`, 502);
  }

  if (!response.ok) {
    console.warn(`${service} proxy ${label} upstream status ${response.status}`);
    throw new ApiError(`${service} service error`, 502);
  }

  try {
    return await response.json();
  } catch {
    console.error(`${service} proxy ${label}: upstream response was not valid JSON (parse error)`);
    throw new ApiError(`${service} service returned an invalid response`, 502);
  }
}
