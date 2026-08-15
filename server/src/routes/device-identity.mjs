/**
 * W2.16 — the complete native device identity HTTP surface.
 *
 * These handlers intentionally expose only three operations. Tenant, user, role, token lifetime,
 * and session lineage never enter through an HTTP field; the identity domain derives them from
 * the invitation/session rows. Registration is owner-gated in the composition root.
 */
import {
  DEVICE_ACCESS_PREFIX,
  exchangeDeviceInvitation,
  revokeDeviceSessionFamily,
  rotateDeviceSession,
} from "../identity/device-sessions.mjs";
import { RejectionError, Unauthorized } from "../lib/api-errors.mjs";

function onlyStringField(body, field) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RejectionError(`${field} is required`, 422);
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== field) {
    throw new RejectionError(`request body must contain only ${field}`, 422);
  }
  const value = body[field];
  if (typeof value !== "string" || value === "") {
    throw new RejectionError(`${field} is required`, 422);
  }
  return value;
}

/** POST /v1/device-enrollments:exchange — invitation material is the only input. */
export async function exchangeEnrollment(req, reply, ctx) {
  const invitationToken = onlyStringField(req.body, "invitationToken");
  return reply.send(await exchangeDeviceInvitation(ctx.db, invitationToken));
}

/** POST /v1/device-sessions:refresh — rotation and replay decisions live in the domain boundary. */
export async function refreshSession(req, reply, ctx) {
  const refreshToken = onlyStringField(req.body, "refreshToken");
  return reply.send(await rotateDeviceSession(ctx.db, refreshToken));
}

/** DELETE /v1/device-sessions/current — only a device access credential can name "current". */
export async function deleteCurrentSession(req, reply, ctx) {
  const authorization = req.headers.authorization;
  const expectedPrefix = `Bearer ${DEVICE_ACCESS_PREFIX}`;
  if (typeof authorization !== "string" || !authorization.startsWith(expectedPrefix)) {
    throw Unauthorized("current device session requires a device access credential");
  }
  return reply.send(await revokeDeviceSessionFamily(ctx.db, authorization.slice(7)));
}
