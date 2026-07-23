import { isPilotMode } from "./pilotSession";

/**
 * fetch with a hard timeout so a hung/slow backend can never freeze the UI
 * (e.g. the practice "Analyzing…" state waiting on the ML service).
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `init.signal ?? controller.signal` (the old code) DISCARDED the timeout's own signal whenever
  // a caller passed one — silently defeating this function's whole stated purpose ("a hung/slow
  // backend can never freeze the UI") for any future caller that ever supplies its own signal. No
  // current caller does, so this was latent, not yet user-visible, but the function's own type
  // signature (plain RequestInit) allows it. Forward the caller's signal into ours instead, so
  // either one aborting the fetch.
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    // In pilot mode the browser authenticates via the HttpOnly `__Host-qrai-pilot` cookie, so it
    // must be SENT with every request. An explicit `init.credentials` from the caller wins.
    const credentials = init.credentials ?? (isPilotMode() ? "include" : undefined);
    return await fetch(input, { ...init, credentials, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
