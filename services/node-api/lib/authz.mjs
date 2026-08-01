/**
 * §2.3 — the ownership gate, and the actor it operates on.
 * specs/node-backend-port/plan.md N3
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 * Rust's `require_self_or_any` compares two non-`Option` `String`s, and the owner id comes from
 * `row.try_get::<String,_>()`, which ERRORS on a missing column or NULL. Neither side can be absent.
 *
 * In JavaScript both sides can be `undefined` — a renamed DB column, a JWT without the claim — and
 * **`undefined === undefined` is `true`**. The gate would pass for every caller. This is the only
 * ownership check on 8 endpoints: privacy delete, session read, alignment persist, realtime ticket
 * mint, progress, and the ML proxy's consent gate.
 *
 * So this refuses degenerate input BEFORE comparing. It never compares two values it has not first
 * proven to be non-empty strings.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { jwtVerify } from "jose";

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    /** Server-side only. Never serialized into a response. */
    this.detail = detail;
  }
}

/**
 * An axum EXTRACTOR rejection — a request rejected before the handler ran.
 *
 * These do not use the `{"error": …}` JSON body every in-handler failure uses. `Json<T>` failing to
 * deserialize, and `Path<i32>` failing to parse, both return `text/plain; charset=utf-8` with the
 * extractor's own message. Found twice by the differ (N9 on a path parameter, N12a on a body), so
 * it is one type rather than a second bespoke helper each time it turns up.
 *
 * The message TEXT of a serde rejection is a recorded, unfixed divergence: reproducing it
 * byte-for-byte means reimplementing serde's error formatting including line/column offsets, and it
 * leaks deserializer internals. The STATUS and the CONTENT-TYPE are what clients branch on, and
 * those are matched.
 */
export class RejectionError extends ApiError {
  constructor(message, status) {
    super(message, status);
    this.name = "RejectionError";
    this.contentType = "text/plain; charset=utf-8";
  }
}

/**
 * The wire messages are transcribed VERBATIM from services/platform-api/src/types.rs:334-340.
 * Phase 5's differ treats an error string as contract ("FAILS when an error message string differs
 * — the messages are wire contract"), and the A/B against Rust caught three of mine that read
 * better and were wrong. The `detail` argument is for server-side context only; it never reaches a
 * client, because a message that varies with internal state is a topology leak.
 */
export const Unauthorized = (detail) => new ApiError("missing or invalid authorization", 401, detail);
export const Forbidden = (detail) => new ApiError("actor is not allowed to perform this action", 403, detail);
export const NotFound = (detail) => new ApiError("record not found", 404, detail);

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Port of `require_self_or_any` (services/platform-api/src/auth.rs).
 *
 * Fails CLOSED on degenerate input rather than comparing it. `throw` on `undefined` is the entire
 * point — returning early, or comparing first and checking after, reintroduces the bypass.
 */
export function requireSelfOrAny(actor, ownerId, allowedRoles) {
  if (!isNonEmptyString(ownerId)) {
    throw Forbidden("ownership check received a non-string owner id");
  }
  if (!actor || !isNonEmptyString(actor.userId)) {
    throw Forbidden("ownership check received an actor with no user id");
  }
  if (actor.userId === ownerId) return;
  if (!Array.isArray(allowedRoles) || !allowedRoles.includes(actor.role)) {
    throw Forbidden("actor is neither the owner nor a permitted role");
  }
}

/**
 * Port of `Actor::require_any` (services/platform-api/src/auth.rs).
 *
 * Deliberately separate from `requireSelfOrAny`: `get_progress` applies BOTH, and with different
 * lists — `require_any([Learner, Teacher, Admin, Ops])` then `require_self_or_any(id, [Teacher,
 * Admin, Ops])`. A scholar therefore fails at the FIRST gate, which collapsing the two into one
 * check would silently change.
 */
export function requireAnyRole(actor, allowedRoles) {
  if (!actor || !isNonEmptyString(actor.role)) throw Forbidden("actor has no role");
  if (!Array.isArray(allowedRoles) || !allowedRoles.includes(actor.role)) {
    throw Forbidden(`role ${actor.role} is not permitted here`);
  }
}

/** Every field must be present and non-empty, or there is no actor. */
function actorFrom(tenantId, userId, role) {
  if (!isNonEmptyString(tenantId) || !isNonEmptyString(userId) || !isNonEmptyString(role)) {
    return null;
  }
  return { tenantId, userId, role };
}

/**
 * Resolve the caller.
 *
 * Returns `{ actor }` when this service can authenticate the request itself, or
 * `{ delegate: "reason" }` when it cannot and the request must be proxied to the Rust service.
 *
 * **Delegation is deliberate, and it is fail-SAFE.** The pilot `__Host-qrai-pilot` cookie path is
 * 306 lines of session lookup, idle-roll, CSRF and Origin checks (`handlers/pilot.rs`) that this
 * skeleton has not ported. Half-porting it would be the security regression this whole phase exists
 * to avoid, so a cookie-bearing request goes to the implementation that is already proven. Named in
 * the N6 report, not silently absorbed.
 */
export async function resolveActor(req, ctx) {
  const { jwtSecret, allowHeaderAuth } = ctx;
  const h = req.headers;

  // ORDER MATTERS, and it is Rust's: Bearer (auth.rs:100) THEN cookie (auth.rs:153) THEN dev
  // headers. A browser belonging to a staff user with a stale pilot cookie sends BOTH, and a port
  // that checked the cookie first would silently resolve the wrong identity for that request.
  // Until N13a this function returned `{ delegate }` on any cookie, which made the order moot.
  const auth = h.authorization;
  if (isNonEmptyString(auth) && auth.startsWith("Bearer ")) {
    try {
      // `algorithms` is not optional. Without it a token declaring `alg: none` — or HS256 signed
      // with a public key the attacker chose — is accepted. jose refuses by construction here.
      const { payload } = await jwtVerify(auth.slice(7), new TextEncoder().encode(jwtSecret), {
        algorithms: ["HS256"],
      });
      const actor = actorFrom(payload.tenant_id, payload.sub, payload.role);
      if (!actor) throw Unauthorized("token is missing tenant_id, sub, or role");
      return { actor };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw Unauthorized("invalid bearer token");
    }
  }

  const cookieToken = pilotCookieToken(h.cookie);
  if (cookieToken !== null) {
    // No database means nothing is ported and there is nothing to authenticate against — keep the
    // pre-N13a behaviour and let Rust do it. This is also what keeps `authz.test.mjs` hermetic.
    if (!ctx.db) return { delegate: "pilot cookie auth needs a database" };
    return { actor: await resolvePilotSession(req, cookieToken, ctx) };
  }

  if (allowHeaderAuth) {
    const actor = actorFrom(h["x-tenant-id"], h["x-user-id"], h["x-user-role"]);
    if (actor) return { actor };
  }

  throw Unauthorized("no usable credentials");
}

/** Cookie name, from `0021_pilot_identity.sql` and `handlers/pilot.rs:118`. */
const PILOT_COOKIE = "__Host-qrai-pilot=";

/**
 * Extract the pilot session token, or null.
 *
 * Split-trim-prefix, exactly as auth.rs:157 does — NOT `cookie.includes("__Host-qrai-pilot=")`,
 * which is what this function used to do and which matches a cookie *named*
 * `x__Host-qrai-pilot` whose value the caller chooses. The old code only used that test to decide
 * whether to delegate, so the looseness was harmless; as an authentication decision it would not be.
 */
export function pilotCookieToken(cookieHeader) {
  if (typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(PILOT_COOKIE)) return trimmed.slice(PILOT_COOKIE.length);
  }
  return null;
}

/**
 * Enforce the pilot Origin policy — auth.rs `require_allowed_origin`.
 *
 * The header must be PRESENT and non-empty. An absent Origin is 403, not a pass: a same-site form
 * post from an attacker's page is the case this exists for, and treating "no Origin" as "same
 * origin" is how that check gets quietly removed.
 */
function requireAllowedOrigin(headers, allowed) {
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "") throw Forbidden("origin header required");
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(origin)) {
    throw Forbidden("origin is not in the allowlist");
  }
}

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Port of auth.rs:165-256 — resolve a pilot session cookie into an Actor.
 *
 * Three things here are load-bearing and none of them is obvious from the shape of the code:
 *
 * 1. The LOOKUP goes through `app.get_pilot_session_by_hash`, a SECURITY DEFINER function, on the
 *    RAW pool. There is no tenant context at auth time — that is the whole reason the function
 *    exists — so it cannot run inside `withTenant`.
 * 2. The idle-expiry ROLL must run INSIDE `withTenant`. `pilot_sessions` has FORCE ROW LEVEL
 *    SECURITY with a `tenant_id = app.current_tenant_id()` policy. Running the UPDATE on the raw
 *    pool matches ZERO rows under the restricted role and reports nothing, so every request looks
 *    like it rolled the session while the session actually expires 8 hours after bootstrap
 *    regardless of activity. That shipped, and it passed tests because the test pool sets the
 *    tenant GUC on every connection.
 * 3. `rowCount !== 1` is a REFUSAL, not a log line. A silent zero-row UPDATE is what made the
 *    original bug invisible.
 */
async function resolvePilotSession(req, token, ctx) {
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  const [row] = await ctx.db.sql`
    SELECT id, tenant_id, learner_id, csrf_token, idle_expires_at, absolute_expires_at
    FROM app.get_pilot_session_by_hash(${tokenHash})`;
  if (!row) throw Unauthorized("no pilot session for that cookie");

  const now = Date.now();
  if (now > row.idle_expires_at.valueOf() || now > row.absolute_expires_at.valueOf()) {
    throw Unauthorized("pilot session expired");
  }

  if (MUTATING.has(req.method)) {
    // Origin FIRST, then CSRF. A correct CSRF token must not rescue a missing Origin — they are
    // two independent gates and the order is observable (403 vs 401).
    requireAllowedOrigin(req.headers, ctx.pilotAllowedOrigins);

    const presented = req.headers["x-csrf-token"];
    if (typeof presented !== "string") throw Unauthorized("missing CSRF token");
    // Compare DIGESTS, not raw strings: the comparison's timing then reveals nothing about the
    // token. `timingSafeEqual` needs equal lengths, which two SHA-256 digests always have.
    const a = createHash("sha256").update(presented, "utf8").digest();
    const b = createHash("sha256").update(row.csrf_token, "utf8").digest();
    if (!timingSafeEqual(a, b)) throw Unauthorized("CSRF token mismatch");
  }

  const newIdle = new Date(now + 8 * 3600 * 1000);
  const rolled = await ctx.db.withTenant(row.tenant_id, async (tx) => {
    const result = await tx`
      UPDATE pilot_sessions SET last_seen_at = now(), idle_expires_at = ${newIdle}
      WHERE id = ${row.id} AND tenant_id = ${row.tenant_id}`;
    return result.count;
  });

  if (rolled !== 1) {
    // Deliberately loud, and deliberately a refusal. Serving the request would mean the session
    // silently stops being extended and expires mid-use with no signal anywhere.
    console.error(
      `pilot session ${row.id} idle-expiry roll affected ${rolled} rows, expected 1 — the session ` +
        "was resolved but could not be updated (RLS context or policy?)",
    );
    throw Unauthorized("pilot session could not be refreshed");
  }

  // A pilot session is ALWAYS a learner. Deriving the role from anything else would make a cookie
  // that any invitation produces into a privilege escalation.
  return { tenantId: row.tenant_id, userId: row.learner_id, role: "learner" };
}
