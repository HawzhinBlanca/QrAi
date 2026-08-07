/**
 * N13b — the three pilot-session routes. Port of handlers/pilot.rs.
 *
 * The cookie ATTRIBUTES are the contract here, not just the value. `__Host-` is a browser-enforced
 * prefix: a cookie with that name is rejected outright unless it is `Secure`, `Path=/`, and carries
 * no `Domain`. Dropping any one of them does not produce an error anywhere — the browser silently
 * refuses to store it and the learner simply never stays logged in.
 */
import { createHash, randomUUID } from "node:crypto";

import { ApiError, Forbidden, NotFound, RejectionError, Unauthorized, requireAnyRole, requireAllowedOrigin, resolveActor, pilotCookieToken } from "../lib/authz.mjs";
import { fractional } from "./progress.mjs";
import { proxy } from "../lib/proxy.mjs";

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** pilot.rs:118 — every attribute is load-bearing; see the module comment. */
const SESSION_COOKIE = (token) =>
  `__Host-qrai-pilot=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`;

/** pilot.rs:197 — the clearing cookie carries BOTH Max-Age=0 and an Expires in the past. */
const CLEAR_COOKIE =
  "__Host-qrai-pilot=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";

/** POST /v1/pilot/session/bootstrap — pilot.rs:19 */
export async function bootstrap(req, reply, ctx) {
  // Origin FIRST, before the token is even hashed. This endpoint is reachable with no credentials
  // at all — the invitation token IS the credential — so the Origin check is the only thing
  // standing between it and a cross-site page redeeming a token it phished.
  requireAllowedOrigin(req.headers, ctx.pilotAllowedOrigins);

  const token = req.body?.token;
  if (typeof token !== "string") throw new RejectionError("token is required", 422);

  const body = await ctx.db.withDiscoveredTenant(async (tx) => {
    // The tenant is not known until this locked-down SECURITY DEFINER function consumes the token.
    const [row] = await tx`
      SELECT tenant_id, learner_id FROM app.consume_pilot_invitation_by_hash(${sha256Hex(token)})`;
    // 401, not 404: missing, expired, and already-consumed invitations are the same answer.
    if (!row) throw Unauthorized("invitation not valid");
    return { tenantId: row.tenant_id, learnerId: row.learner_id };
  }, async (tx, { tenantId, learnerId }) => {
    // `withDiscoveredTenant` installed the transaction-local GUC and shared statement timeout
    // before this tenant-owned work became callable.
    const [user] = await tx`
      SELECT display_name, role FROM users WHERE id = ${learnerId} AND tenant_id = ${tenantId}`;
    if (!user) throw new ApiError("invited user not found", 500);

    // The pilot cookie pins role=learner. Minting a session for anyone else would silently
    // under-privilege them, so it is refused rather than quietly downgraded.
    if (user.role !== "learner") throw Forbidden("pilot sessions are for learners only");

    const sessionToken = randomUUID();
    const sessionId = `pilot-session-${randomUUID()}`;
    const csrfToken = randomUUID();
    const now = Date.now();

    await tx`
      INSERT INTO pilot_sessions
        (id, tenant_id, learner_id, token_hash, csrf_token, idle_expires_at, absolute_expires_at)
      VALUES (${sessionId}, ${tenantId}, ${learnerId}, ${sha256Hex(sessionToken)}, ${csrfToken},
              ${new Date(now + 8 * 3600 * 1000)}, ${new Date(now + 24 * 3600 * 1000)})`;

    // The learner is BOTH actor and subject here: nobody else acted. `$3` is bound twice in the
    // Rust for the same reason.
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
      VALUES (${`audit-${randomUUID()}`}, ${tenantId}, ${learnerId},
              'pilot.session.bootstrap', 'user', ${learnerId})`;

    return {
      sessionToken,
      // json! keys, alphabetical.
      payload: {
        csrfToken,
        displayName: user.display_name,
        role: user.role,
        tenantId,
        userId: learnerId,
      },
    };
  });

  reply.header("set-cookie", SESSION_COOKIE(body.sessionToken));
  return reply.send(body.payload);
}

/** POST /v1/pilot/session/logout — pilot.rs:142 */
export async function logout(req, reply, ctx) {
  const token = pilotCookieToken(req.headers.cookie);

  if (token !== null && token !== "") {
    const [row] = await ctx.db.sql`
      SELECT id, tenant_id, learner_id FROM app.get_pilot_session_by_hash(${sha256Hex(token)})`;

    if (row) {
      await ctx.db.withTenant(row.tenant_id, async (tx) => {
        await tx`UPDATE pilot_sessions SET revoked_at = now() WHERE id = ${row.id}`;
        await tx`
          INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
          VALUES (${`audit-${randomUUID()}`}, ${row.tenant_id}, ${row.learner_id},
                  'pilot.session.logout', 'user', ${row.learner_id})`;
      });
    }
  }

  // ALWAYS 200 with the clearing cookie, even when no session was found. Logout must be idempotent
  // and must never reveal whether the cookie it was handed was real — a 401 here tells a caller
  // that a stolen cookie has already been revoked.
  reply.header("set-cookie", CLEAR_COOKIE);
  return reply.send({ status: "logged_out" });
}

/** POST /v1/pilot/invitations — pilot.rs:225 */
export async function mintInvitation(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["admin", "ops"]);

  const learnerId = req.body?.learnerId;
  if (typeof learnerId !== "string") throw new RejectionError("learnerId is required", 422);

  // Default 7 days, clamped to [1, 720] so an admin cannot mint an effectively immortal invite.
  const requested = req.body?.ttlHours;
  const ttlHours = Math.min(Math.max(typeof requested === "number" ? Math.trunc(requested) : 168, 1), 720);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [target] = await tx`
      SELECT role FROM users WHERE id = ${learnerId} AND tenant_id = ${actor.tenantId}`;
    if (!target) throw NotFound();
    // A teacher or admin would be silently under-privileged by a cookie that pins role=learner, so
    // this is a 400 naming the rule rather than a dead invitation nobody can use.
    if (target.role !== "learner") {
      throw new ApiError("pilot invitations may only target learner accounts", 400);
    }

    const token = randomUUID();
    const invitationId = `pilot-invitation-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

    // Only the HASH is stored. The raw token is shown exactly once, so a leaked DB row cannot be
    // replayed into a session.
    await tx`
      INSERT INTO pilot_invitations (id, tenant_id, learner_id, token_hash, expires_at)
      VALUES (${invitationId}, ${actor.tenantId}, ${learnerId}, ${sha256Hex(token)}, ${expiresAt})`;

    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
      VALUES (${`audit-${randomUUID()}`}, ${actor.tenantId}, ${actor.userId},
              'pilot.invitation.minted', 'user', ${learnerId})`;

    // chrono's to_rfc3339() again — `+00:00`, not `Z`, with 0/3/6 fractional digits. Formatted in
    // Postgres for the same reason as every other timestamp in this port.
    const [{ base, us }] = await tx`
      SELECT to_char(${expiresAt}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS base,
             (EXTRACT(microseconds FROM ${expiresAt}::timestamptz)::bigint % 1000000) AS us`;

    const base_url = process.env.PILOT_INVITE_BASE_URL;
    return {
      expiresAt: `${base}${fractional(Number(us))}+00:00`,
      invitationId,
      // "invitationId" < "inviteUrl": at index 5 it is 'a' vs 'e'. Alphabetical, not eyeballed.
      inviteUrl: base_url ? `${base_url.replace(/\/+$/, "")}/?invite=${token}` : null,
      learnerId,
      token,
    };
  });

  return reply.send(body);
}
