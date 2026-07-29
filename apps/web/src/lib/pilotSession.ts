/**
 * Pilot (no-login) session state.
 *
 * A learner opens an admin-minted invite link (`?invite=<token>`); the app exchanges it for a
 * `__Host-qrai-pilot` cookie via POST /v1/pilot/session/bootstrap (see api.ts `bootstrapPilotSession`).
 * The cookie is HttpOnly — JavaScript cannot read it — so the browser authenticates by SENDING it
 * (`credentials: "include"`), not by asserting `x-user-id`/`x-tenant-id` headers. We keep only the
 * non-secret bits the client still needs: the CSRF token (required on mutating requests) and the
 * identity the server returned (used for request BODIES like `learnerId`; the server re-derives the
 * real actor from the cookie, so a tampered body just fails server-side).
 *
 * Persisted to localStorage so a page reload keeps the pilot identity in sync with the cookie, which
 * itself survives the reload server-side (8h idle / 24h absolute).
 */
export interface PilotIdentity {
  userId: string;
  tenantId: string;
  displayName: string;
  role: string;
  csrfToken: string;
}

const STORAGE_KEY = "qrai-pilot-session";

function loadStored(): PilotIdentity | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PilotIdentity>;
    // Only treat it as a session if the fields we actually rely on are present.
    if (parsed.userId && parsed.tenantId && parsed.csrfToken) {
      return parsed as PilotIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

let current: PilotIdentity | null = loadStored();

/** The active pilot identity, or null when not in pilot mode. */
export function getPilotIdentity(): PilotIdentity | null {
  return current;
}

/** True when the app should authenticate via the pilot cookie + CSRF instead of dev headers. */
export function isPilotMode(): boolean {
  return current !== null;
}

/** CSRF token to send as `x-csrf-token` on mutating pilot requests, or null. */
export function getPilotCsrf(): string | null {
  return current?.csrfToken ?? null;
}

/** Set (or clear, with null) the active pilot identity and mirror it to localStorage. */
export function setPilotIdentity(identity: PilotIdentity | null): void {
  current = identity;
  if (typeof localStorage === "undefined") return;
  try {
    if (identity) localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / quota — in-memory state still holds for this page load.
  }
}
