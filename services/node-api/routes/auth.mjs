/**
 * N12a — `POST /v1/auth/token`. Port of handlers/auth.rs `issue_token`.
 *
 * `register` and `login` are NOT here: they verify bcrypt hashes, and there is no bcrypt in
 * node:crypto or in any dependency this repo already has. That is a new runtime dependency and an
 * ADR under AGENTS.md, so it is its own slice (N12b) rather than a decision smuggled in beside a
 * route that needs nothing new.
 */
import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";

import { Forbidden, RejectionError, Unauthorized, requireAnyRole, resolveActor } from "../lib/authz.mjs";
import { proxy } from "../lib/proxy.mjs";

/** auth.rs:58 — `token_ttl_hours: 24`. */
const TOKEN_TTL_HOURS = 24;

/** POST /v1/auth/token — auth.rs:9 */
export async function issueToken(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor: caller } = resolved;

  // Minting a JWT for an arbitrary user is an admin/ops operation. Without this check anyone who
  // knows a (userId, tenantId, role) tuple could forge a session for any user, bypassing login.
  requireAnyRole(caller, ["admin", "ops"]);

  const userId = req.body?.userId;
  const tenantId = req.body?.tenantId;
  const role = req.body?.role;
  if (typeof userId !== "string" || typeof tenantId !== "string" || typeof role !== "string") {
    // axum's Json<TokenRequest> extractor rejects before the handler runs, and serde's rejection is
    // 422. The message text is serde's own (with line/column offsets) — a recorded, unfixed
    // divergence, not something to reimplement.
    throw new RejectionError("userId, tenantId and role are required", 422);
  }

  // Scoped to the caller's OWN tenant. An admin of tenant A must not mint for tenant B.
  if (caller.tenantId !== tenantId) throw Forbidden("cross-tenant token mint");

  const body = await ctx.db.withTenant(caller.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT id, tenant_id, role FROM users WHERE id = ${userId} AND tenant_id = ${tenantId}`;
    // 401, NOT 404. A 404 here distinguishes "no such user" from "wrong role" and turns this
    // endpoint into a user-enumeration oracle for anyone who already has an admin token.
    if (!row) throw Unauthorized("no such user in this tenant");

    // The role comes from the stored row, never from the request. Without this a request could
    // promote a learner by asking for an admin token.
    if (row.role !== role) throw Forbidden("requested role does not match the stored role");

    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_HOURS * 3600;
    const token = await new SignJWT({ sub: userId, tenant_id: tenantId, role, exp })
      // `Header::new(HS256)` serializes `{"typ":"JWT","alg":"HS256"}`. jsonwebtoken does not
      // REQUIRE typ when validating, so omitting it would still cross-verify — but matching the
      // header keeps the two implementations' tokens indistinguishable to anything that inspects
      // them, which is cheaper than discovering later that something did.
      .setProtectedHeader({ typ: "JWT", alg: "HS256" })
      .sign(new TextEncoder().encode(ctx.jwtSecret));

    const auditId = `audit-${randomUUID()}`;
    // actor_id is the REAL caller; subject_id is the user the token is for. Recording the target as
    // the actor would make the audit log say the learner minted their own token.
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
      VALUES (${auditId}, ${tenantId}, ${caller.userId}, 'auth.token.issued', 'auth_token', ${userId})`;

    // json! keys, alphabetical — and SNAKE_CASE. Every other route in this API is camelCase; this
    // one is not, because the handler builds a bare json! with no rename. Tidying these into
    // camelCase is the documented "/v1/auth/token regression" the fixture differ tests by name.
    return {
      audit_event_id: auditId,
      role,
      tenant_id: tenantId,
      token,
      user_id: userId,
    };
  });

  return reply.send(body);
}
