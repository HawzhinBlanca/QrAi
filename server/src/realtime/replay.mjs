import { createHash } from "node:crypto";

const U64_MAX = 18_446_744_073_709_551_615n;
const CLEANUP_OUTCOMES = Object.freeze(["succeeded", "failed"]);

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`realtime replay ${name} must be a non-empty string`);
  }
  return value;
}

function positiveWhole(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`realtime replay ${name} must be a whole number from 1 to ${maximum}`);
  }
  return value;
}

function expiry(value) {
  let parsed;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new TypeError("realtime replay expiry must be an unsigned-64-bit integer");
  }
  if (
    parsed < 0n ||
    parsed > U64_MAX ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw new TypeError("realtime replay expiry must be an unsigned-64-bit integer");
  }
  return parsed;
}

function validateClaims(claims, tenantId) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    throw new TypeError("realtime replay claims are required");
  }
  const claimTenantId = nonEmptyString(claims.tenantId, "tenant");
  if (claimTenantId !== tenantId) {
    throw new TypeError("realtime replay claim tenant does not match its authority");
  }
  return Object.freeze({
    tenantId: claimTenantId,
    sessionId: nonEmptyString(claims.sessionId, "session"),
    learnerId: nonEmptyString(claims.learnerId, "learner"),
    nonce: nonEmptyString(claims.nonce, "nonce"),
    expiresAtUnixSeconds: expiry(claims.expiresAtUnixSeconds),
  });
}

/**
 * Durable single-use authority for already-validated signed ticket claims.
 *
 * The boundary intentionally accepts claims rather than the raw ticket. Only a lowercase SHA-256
 * digest of the signed nonce crosses into Postgres, scoped by its signed tenant/session claims.
 */
export function createRealtimeReplayAuthority({
  db,
  tenantId,
  cleanupIntervalMs = 60_000,
  cleanupBatchSize = 1_000,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
}) {
  if (!db || typeof db.withTenant !== "function") {
    throw new TypeError("realtime replay requires the restricted tenant database boundary");
  }
  nonEmptyString(tenantId, "authority tenant");
  positiveWhole(cleanupIntervalMs, "cleanup interval", 86_400_000);
  positiveWhole(cleanupBatchSize, "cleanup batch size", 10_000);
  if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
    throw new TypeError("realtime replay cleanup timers must be functions");
  }

  const cleanupCounters = Object.fromEntries(CLEANUP_OUTCOMES.map((outcome) => [outcome, 0]));
  const activeCleanups = new Set();
  let deletedTotal = 0;
  let interval = null;

  async function claim(input) {
    const claims = validateClaims(input, tenantId);
    const nonceHash = createHash("sha256").update(claims.nonce, "utf8").digest("hex");
    const rows = await db.withTenant(tenantId, (tx) => tx`
      INSERT INTO realtime_ticket_replay_claims
        (tenant_id, session_id, nonce_hash, expires_at_unix_seconds)
      SELECT ${tenantId}, ${claims.sessionId}, ${nonceHash},
             ${claims.expiresAtUnixSeconds.toString()}::numeric
        FROM recitation_sessions
       WHERE tenant_id = ${tenantId}
         AND id = ${claims.sessionId}
         AND learner_id = ${claims.learnerId}
         AND ${claims.expiresAtUnixSeconds.toString()}::numeric >
             floor(extract(epoch from clock_timestamp()))::numeric
      ON CONFLICT (tenant_id, session_id, nonce_hash) DO NOTHING
      RETURNING nonce_hash`);
    return rows.length === 1 ? "fresh" : "replay";
  }

  function cleanupExpired() {
    let operation;
    operation = db.withTenant(tenantId, async (tx) => {
      const rows = await tx`
        WITH expired AS (
          SELECT tenant_id, session_id, nonce_hash
            FROM realtime_ticket_replay_claims
           WHERE tenant_id = ${tenantId}
             AND expires_at_unix_seconds <=
                 floor(extract(epoch from clock_timestamp()))::numeric
           ORDER BY expires_at_unix_seconds, session_id, nonce_hash
           FOR UPDATE SKIP LOCKED
           LIMIT ${cleanupBatchSize}
        )
        DELETE FROM realtime_ticket_replay_claims AS claim
         USING expired
         WHERE claim.tenant_id = expired.tenant_id
           AND claim.session_id = expired.session_id
           AND claim.nonce_hash = expired.nonce_hash
        RETURNING claim.nonce_hash`;
      return rows.length;
    }).then((deleted) => {
      cleanupCounters.succeeded += 1;
      deletedTotal += deleted;
      return deleted;
    }).catch((error) => {
      cleanupCounters.failed += 1;
      throw error;
    }).finally(() => {
      activeCleanups.delete(operation);
    });
    activeCleanups.add(operation);
    return operation;
  }

  function scheduledCleanup() {
    if (activeCleanups.size > 0) return;
    cleanupExpired().catch(() => {});
  }

  function start() {
    if (interval !== null) return;
    interval = setIntervalImpl(scheduledCleanup, cleanupIntervalMs);
    interval?.unref?.();
  }

  async function stop() {
    if (interval !== null) {
      clearIntervalImpl(interval);
      interval = null;
    }
    while (activeCleanups.size > 0) {
      await Promise.allSettled([...activeCleanups]);
    }
  }

  function renderMetrics() {
    let output = "# HELP realtime_replay_cleanup_total Durable replay cleanup runs by closed outcome.\n";
    output += "# TYPE realtime_replay_cleanup_total counter\n";
    for (const outcome of CLEANUP_OUTCOMES) {
      output += `realtime_replay_cleanup_total{outcome="${outcome}"} ${cleanupCounters[outcome]}\n`;
    }
    output += "# HELP realtime_replay_cleanup_deleted_total Expired replay claims deleted.\n";
    output += "# TYPE realtime_replay_cleanup_deleted_total counter\n";
    output += `realtime_replay_cleanup_deleted_total ${deletedTotal}\n`;
    return output;
  }

  return Object.freeze({ claim, cleanupExpired, start, stop, renderMetrics });
}
