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
export async function resolveActor(req, { jwtSecret, allowHeaderAuth }) {
  const h = req.headers;

  if (h.cookie?.includes("__Host-qrai-pilot=")) {
    return { delegate: "pilot cookie auth is not ported (handlers/pilot.rs)" };
  }

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

  if (allowHeaderAuth) {
    const actor = actorFrom(h["x-tenant-id"], h["x-user-id"], h["x-user-role"]);
    if (actor) return { actor };
  }

  throw Unauthorized("no usable credentials");
}
