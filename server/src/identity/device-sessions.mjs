import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ApiError, Unauthorized } from "../lib/api-errors.mjs";

export const DEVICE_ACCESS_PREFIX = "qrai_at_v1.";
export const DEVICE_REFRESH_PREFIX = "qrai_rt_v1.";
export const DEVICE_INVITATION_PREFIX = "qrai_inv_v1.";

export const DEVICE_ACCESS_TTL_MS = 15 * 60 * 1000;
export const DEVICE_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEVICE_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_KINDS = Object.freeze({
  access: DEVICE_ACCESS_PREFIX,
  invitation: DEVICE_INVITATION_PREFIX,
  refresh: DEVICE_REFRESH_PREFIX,
});
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;
const ROLES = new Set(["learner", "teacher", "scholar", "admin", "ops"]);

const prefixFor = (kind) => {
  const prefix = TOKEN_KINDS[kind];
  if (!prefix) throw new TypeError(`unknown device credential kind: ${String(kind)}`);
  return prefix;
};

function requireDeviceToken(token, kind) {
  const prefix = prefixFor(kind);
  if (
    typeof token !== "string" ||
    !token.startsWith(prefix) ||
    !TOKEN_BODY.test(token.slice(prefix.length))
  ) {
    throw new TypeError(`invalid ${kind} device credential`);
  }
  return token;
}

function unauthorizedHash(token, kind) {
  try {
    return hashDeviceToken(token, kind);
  } catch (error) {
    if (error instanceof TypeError) throw Unauthorized(`invalid ${kind} device credential shape`);
    throw error;
  }
}

export function generateDeviceToken(kind) {
  return `${prefixFor(kind)}${randomBytes(32).toString("base64url")}`;
}

export function hashDeviceToken(token, kind) {
  return createHash("sha256").update(requireDeviceToken(token, kind), "utf8").digest("hex");
}

const issuedPayload = (credentials, accessExpiresAt, idleExpiresAt, absoluteExpiresAt) => ({
  accessExpiresAt: accessExpiresAt.toISOString(),
  accessToken: credentials.accessToken,
  absoluteExpiresAt: absoluteExpiresAt.toISOString(),
  idleExpiresAt: idleExpiresAt.toISOString(),
  refreshToken: credentials.refreshToken,
});

const newCredentials = () => ({
  accessToken: generateDeviceToken("access"),
  refreshToken: generateDeviceToken("refresh"),
});

const boundedExpiry = (now, ttlMs, absoluteExpiresAt) =>
  new Date(Math.min(now.getTime() + ttlMs, absoluteExpiresAt.getTime()));

function mappedAccessRow(row) {
  if (!row) throw Unauthorized("device access credential not found");
  return {
    absoluteExpiresAt: row.absolute_expires_at,
    accessExpiresAt: row.access_expires_at,
    familyId: row.family_id,
    generation: row.generation,
    idleExpiresAt: row.idle_expires_at,
    role: row.role,
    sessionId: row.session_id,
    status: row.status,
    tenantId: row.tenant_id,
    userId: row.user_id,
  };
}

function mappedRefreshRow(row) {
  if (!row) throw Unauthorized("device refresh credential not found");
  return {
    absoluteExpiresAt: row.absolute_expires_at,
    accessExpiresAt: row.access_expires_at,
    familyId: row.family_id,
    generation: row.generation,
    idleExpiresAt: row.idle_expires_at,
    revokedAt: row.revoked_at,
    rotatedAt: row.rotated_at,
    sessionId: row.session_id,
    status: row.status,
    tenantId: row.tenant_id,
    userId: row.user_id,
  };
}

async function discoverAccess(tx, accessHash) {
  const [row] = await tx`
    SELECT session_id, family_id, tenant_id, user_id, role, generation, status,
           access_expires_at, idle_expires_at, absolute_expires_at
      FROM app.get_device_session_by_access_hash(${accessHash})`;
  return mappedAccessRow(row);
}

async function discoverRefresh(tx, refreshHash) {
  const [row] = await tx`
    SELECT session_id, family_id, tenant_id, user_id, generation, status,
           access_expires_at, idle_expires_at, absolute_expires_at, rotated_at, revoked_at
      FROM app.get_device_session_by_refresh_hash(${refreshHash})`;
  return mappedRefreshRow(row);
}

export async function exchangeDeviceInvitation(db, invitationToken) {
  if (!db || typeof db.withDiscoveredTenant !== "function") {
    throw Unauthorized("device identity database is unavailable");
  }
  const invitationHash = unauthorizedHash(invitationToken, "invitation");
  const credentials = newCredentials();

  return db.withDiscoveredTenant(
    async (tx) => {
      const [row] = await tx`
        SELECT invitation_id, tenant_id, user_id
          FROM app.consume_device_enrollment_invitation_by_hash(${invitationHash})`;
      if (!row) throw Unauthorized("device invitation is missing, expired, or consumed");
      return {
        invitationId: row.invitation_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
      };
    },
    async (tx, invitation) => {
      const [user] = await tx`
        SELECT role FROM users
         WHERE id = ${invitation.userId} AND tenant_id = ${invitation.tenantId}`;
      if (!user || !ROLES.has(user.role)) {
        throw Unauthorized("device invitation target is no longer an eligible user");
      }

      const now = new Date();
      const accessExpiresAt = new Date(now.getTime() + DEVICE_ACCESS_TTL_MS);
      const idleExpiresAt = new Date(now.getTime() + DEVICE_IDLE_TTL_MS);
      const absoluteExpiresAt = new Date(now.getTime() + DEVICE_ABSOLUTE_TTL_MS);
      const sessionId = `device-session-${randomUUID()}`;
      const familyId = `device-family-${randomUUID()}`;
      const auditId = `audit-${randomUUID()}`;

      await tx`
        INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
        VALUES (${auditId}, ${invitation.tenantId}, ${invitation.userId},
                'device.session.enrolled', 'device_session', ${sessionId})`;
      await tx`
        INSERT INTO device_sessions
          (id, family_id, tenant_id, user_id, generation, access_token_hash,
           refresh_token_hash, status, access_expires_at, idle_expires_at,
           absolute_expires_at, last_seen_at, audit_event_id)
        VALUES (${sessionId}, ${familyId}, ${invitation.tenantId}, ${invitation.userId}, 0,
                ${hashDeviceToken(credentials.accessToken, "access")},
                ${hashDeviceToken(credentials.refreshToken, "refresh")}, 'active',
                ${accessExpiresAt}, ${idleExpiresAt}, ${absoluteExpiresAt}, ${now}, ${auditId})`;

      return issuedPayload(credentials, accessExpiresAt, idleExpiresAt, absoluteExpiresAt);
    },
  );
}

export async function resolveDeviceAccess(db, accessToken) {
  if (!db || typeof db.withDiscoveredTenant !== "function") {
    throw Unauthorized("device identity database is unavailable");
  }
  const accessHash = unauthorizedHash(accessToken, "access");

  return db.withDiscoveredTenant(
    (tx) => discoverAccess(tx, accessHash),
    async (tx, discovered) => {
      const now = new Date();
      const absoluteExpiresAt = new Date(discovered.absoluteExpiresAt);
      const nextIdle = boundedExpiry(now, DEVICE_IDLE_TTL_MS, absoluteExpiresAt);
      const result = await tx`
        UPDATE device_sessions
           SET last_seen_at = ${now},
               idle_expires_at = GREATEST(idle_expires_at, ${nextIdle})
         WHERE id = ${discovered.sessionId}
           AND tenant_id = ${discovered.tenantId}
           AND family_id = ${discovered.familyId}
           AND status = 'active'
           AND access_expires_at > ${now}
           AND idle_expires_at > ${now}
           AND absolute_expires_at > ${now}`;
      if (result.count !== 1) throw Unauthorized("device access session is inactive or expired");

      const [user] = await tx`
        SELECT role FROM users
         WHERE id = ${discovered.userId} AND tenant_id = ${discovered.tenantId}`;
      if (!user || !ROLES.has(user.role)) {
        throw Unauthorized("device session user is unavailable");
      }
      return {
        actor: {
          tenantId: discovered.tenantId,
          userId: discovered.userId,
          role: user.role,
        },
        session: {
          familyId: discovered.familyId,
          generation: discovered.generation,
          sessionId: discovered.sessionId,
        },
      };
    },
  );
}

async function recordFamilyEvent(tx, row, action) {
  const auditId = `audit-${randomUUID()}`;
  await tx`
    INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
    VALUES (${auditId}, ${row.tenantId}, ${row.userId}, ${action},
            'device_session_family', ${row.familyId})`;
  return auditId;
}

async function revokeFamily(tx, row, replay) {
  const now = new Date();
  await recordFamilyEvent(
    tx,
    row,
    replay ? "device.session.refresh_replay" : "device.session.revoked",
  );
  const result = replay
    ? await tx`
        UPDATE device_sessions
           SET status = CASE
                 WHEN id = ${row.sessionId} AND rotated_at IS NOT NULL THEN 'replayed'
                 ELSE 'revoked'
               END,
               revoked_at = COALESCE(revoked_at, ${now})
         WHERE family_id = ${row.familyId} AND tenant_id = ${row.tenantId}`
    : await tx`
        UPDATE device_sessions
           SET status = CASE WHEN status = 'replayed' THEN 'replayed' ELSE 'revoked' END,
               revoked_at = COALESCE(revoked_at, ${now})
         WHERE family_id = ${row.familyId} AND tenant_id = ${row.tenantId}`;
  if (result.count < 1) throw new ApiError("device session family could not be revoked", 500);
}

export async function rotateDeviceSession(db, refreshToken) {
  if (!db || typeof db.withDiscoveredTenant !== "function") {
    throw Unauthorized("device identity database is unavailable");
  }
  const refreshHash = unauthorizedHash(refreshToken, "refresh");
  const credentials = newCredentials();

  const outcome = await db.withDiscoveredTenant(
    (tx) => discoverRefresh(tx, refreshHash),
    async (tx, current) => {
      const now = new Date();
      if (current.status === "rotated" || current.status === "replayed") {
        await revokeFamily(tx, current, true);
        return { kind: "replayed" };
      }
      if (current.status !== "active") return { kind: "invalid" };

      const absoluteExpiresAt = new Date(current.absoluteExpiresAt);
      if (
        new Date(current.idleExpiresAt).getTime() <= now.getTime() ||
        absoluteExpiresAt.getTime() <= now.getTime()
      ) {
        await revokeFamily(tx, current, false);
        return { kind: "expired" };
      }

      const rotated = await tx`
        UPDATE device_sessions
           SET status = 'rotated', rotated_at = ${now}
         WHERE id = ${current.sessionId} AND tenant_id = ${current.tenantId} AND status = 'active'`;
      if (rotated.count !== 1) throw Unauthorized("device refresh generation lost its lock");

      const accessExpiresAt = boundedExpiry(now, DEVICE_ACCESS_TTL_MS, absoluteExpiresAt);
      const idleExpiresAt = boundedExpiry(now, DEVICE_IDLE_TTL_MS, absoluteExpiresAt);
      const nextSessionId = `device-session-${randomUUID()}`;
      const auditId = await recordFamilyEvent(tx, current, "device.session.refreshed");
      await tx`
        INSERT INTO device_sessions
          (id, family_id, previous_session_id, tenant_id, user_id, generation,
           access_token_hash, refresh_token_hash, status, access_expires_at,
           idle_expires_at, absolute_expires_at, last_seen_at, audit_event_id)
        VALUES (${nextSessionId}, ${current.familyId}, ${current.sessionId}, ${current.tenantId},
                ${current.userId}, ${current.generation + 1},
                ${hashDeviceToken(credentials.accessToken, "access")},
                ${hashDeviceToken(credentials.refreshToken, "refresh")}, 'active',
                ${accessExpiresAt}, ${idleExpiresAt}, ${absoluteExpiresAt}, ${now}, ${auditId})`;

      return {
        kind: "rotated",
        payload: issuedPayload(credentials, accessExpiresAt, idleExpiresAt, absoluteExpiresAt),
      };
    },
  );

  if (outcome.kind !== "rotated") {
    throw Unauthorized(`device refresh ${outcome.kind}`);
  }
  return outcome.payload;
}

export async function revokeDeviceSessionFamily(db, accessToken) {
  if (!db || typeof db.withDiscoveredTenant !== "function") {
    throw Unauthorized("device identity database is unavailable");
  }
  const accessHash = unauthorizedHash(accessToken, "access");
  await db.withDiscoveredTenant(
    (tx) => discoverAccess(tx, accessHash),
    async (tx, current) => revokeFamily(tx, current, false),
  );
  return { revoked: true };
}
