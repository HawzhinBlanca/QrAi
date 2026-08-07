// @ts-check

import { pathToFileURL } from "node:url";

/**
 * @typedef {object} HealthCheckOptions
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {string} [url]
 */

/**
 * Probe the Node API without importing application code or adding a runtime HTTP client package.
 * The response body is never logged or interpreted; health is only an HTTP status decision.
 *
 * @param {HealthCheckOptions} options
 * @returns {Promise<boolean>}
 */
export const checkHealth = async (options) => {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 4_000,
    url = process.env.NODE_API_HEALTHCHECK_URL ?? "http://127.0.0.1:8082/ready",
  } = options;
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) return false;

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && !(await checkHealth({}))) {
  console.error("node-api readiness check failed");
  process.exitCode = 1;
}
