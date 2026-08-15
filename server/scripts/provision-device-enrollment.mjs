import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  generateDeviceToken,
  hashDeviceToken,
} from "../src/identity/device-sessions.mjs";
import { createDb } from "../src/lib/db.mjs";

export const DEVICE_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

const NEW_USER_ROLES = new Set(["learner", "teacher", "scholar"]);
const OPTION_KEYS = new Set(["adminId", "databaseUrl", "newUser", "tenantId", "userId"]);
const FLAGS = new Map([
  ["--tenant-id", "tenantId"],
  ["--admin-id", "adminId"],
  ["--user-id", "userId"],
  ["--new-user-role", "newUserRole"],
  ["--new-user-display-name", "newUserDisplayName"],
  ["--new-user-language", "newUserLanguage"],
]);

const requireText = (value, label, maximum = 200) => {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
};

const validateNewUser = (value) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("newUser must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "displayName,language,role") {
    throw new TypeError("newUser accepts exactly displayName, language, and role");
  }
  if (!NEW_USER_ROLES.has(value.role)) {
    throw new TypeError("a missing user may be created only as learner, teacher, or scholar");
  }
  return Object.freeze({
    displayName: requireText(value.displayName, "newUser.displayName"),
    language: requireText(value.language, "newUser.language", 32),
    role: value.role,
  });
};

export function parseProvisionArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("arguments must be an array");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const field = FLAGS.get(flag);
    if (!field) throw new TypeError(`unknown argument ${String(flag)}`);
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`missing value for ${flag}`);
    }
    if (values.has(field)) throw new TypeError(`duplicate argument ${flag}`);
    values.set(field, value);
  }
  for (const field of ["tenantId", "adminId", "userId"]) {
    if (!values.has(field)) throw new TypeError(`missing required argument ${field}`);
  }

  const newUserFields = ["newUserRole", "newUserDisplayName", "newUserLanguage"];
  const suppliedNewUserFields = newUserFields.filter((field) => values.has(field));
  if (suppliedNewUserFields.length !== 0 && suppliedNewUserFields.length !== newUserFields.length) {
    throw new TypeError(
      "new user creation requires --new-user-role, --new-user-display-name, and --new-user-language",
    );
  }

  return Object.freeze({
    tenantId: values.get("tenantId"),
    adminId: values.get("adminId"),
    userId: values.get("userId"),
    ...(suppliedNewUserFields.length === 0 ? {} : {
      newUser: {
        role: values.get("newUserRole"),
        displayName: values.get("newUserDisplayName"),
        language: values.get("newUserLanguage"),
      },
    }),
  });
}

export async function provisionDeviceEnrollment(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("provisioning options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new TypeError(`unknown provisioning option ${key}`);
  }
  const databaseUrl = requireText(options.databaseUrl, "databaseUrl", 4_096);
  const tenantId = requireText(options.tenantId, "tenantId");
  const adminId = requireText(options.adminId, "adminId");
  const userId = requireText(options.userId, "userId");
  const requestedNewUser = validateNewUser(options.newUser);
  const db = createDb(databaseUrl, { max: 2 });
  try {
    await db.assertRestrictedRole();
    return await db.withTenant(tenantId, async (tx) => {
      const [admin] = await tx`
        SELECT id FROM users
         WHERE tenant_id = ${tenantId} AND id = ${adminId} AND role = 'admin'`;
      if (!admin) throw new Error("an existing in-tenant admin is required");

      let [target] = await tx`
        SELECT id, role FROM users
         WHERE tenant_id = ${tenantId} AND id = ${userId}`;
      let createdUser = false;
      if (target) {
        if (requestedNewUser) {
          throw new Error("new-user fields are forbidden when the target user already exists");
        }
      } else {
        if (!requestedNewUser) {
          throw new Error("the target user does not exist; approved new-user fields are required");
        }
        [target] = await tx`
          INSERT INTO users (id, tenant_id, display_name, role, language)
          VALUES (${userId}, ${tenantId}, ${requestedNewUser.displayName},
                  ${requestedNewUser.role}, ${requestedNewUser.language})
          RETURNING id, role`;
        createdUser = true;
      }

      const invitationToken = generateDeviceToken("invitation");
      const invitationId = `device-invitation-${randomUUID()}`;
      const auditEventId = `audit-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + DEVICE_INVITATION_TTL_MS);
      await tx`
        INSERT INTO audit_events
          (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
        VALUES (${auditEventId}, ${tenantId}, ${adminId}, 'device.enrollment.invited',
                'user', ${target.id}, ${tx.json({ created_user: createdUser })})`;
      await tx`
        INSERT INTO device_enrollment_invitations
          (id, tenant_id, user_id, created_by, token_hash, expires_at, audit_event_id)
        VALUES (${invitationId}, ${tenantId}, ${target.id}, ${adminId},
                ${hashDeviceToken(invitationToken, "invitation")}, ${expiresAt}, ${auditEventId})`;

      return Object.freeze({
        invitationId,
        invitationToken,
        tenantId,
        userId: target.id,
        createdUser,
        expiresAt: expiresAt.toISOString(),
      });
    });
  } finally {
    await db.end();
  }
}

async function main() {
  const input = parseProvisionArguments(process.argv.slice(2));
  const result = await provisionDeviceEnrollment({ databaseUrl: process.env.DATABASE_URL, ...input });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("device enrollment provisioning failed\n");
    process.exitCode = 1;
  });
}
