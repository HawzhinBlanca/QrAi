import { ApiError } from "./authz.mjs";
import { createDeadline, fetchWithDeadline } from "./deadline.mjs";

export { createDeadline } from "./deadline.mjs";

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
