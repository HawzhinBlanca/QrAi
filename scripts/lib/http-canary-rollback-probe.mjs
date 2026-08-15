import { randomUUID } from "node:crypto";

import pg from "pg";

import { createHttpCanaryActorAuthorization } from "./http-canary-probe.mjs";

const { Pool } = pg;

function fail(message) {
  throw new Error(message);
}

function canonicalHttpBase(value) {
  if (typeof value !== "string") fail("rollback baseUrl is required");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("rollback baseUrl must be an http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail("rollback baseUrl must be an http(s) URL without credentials");
  }
  return value.replace(/\/$/, "");
}

async function parseJsonResponse(response, label) {
  if (!response.ok) fail(`${label} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

async function readStateFromDatabase({ pool, tenantId, learnerId, ayahRef }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `SELECT repetitions
       FROM learner_progress
       WHERE tenant_id = $1 AND learner_id = $2 AND ayah_ref = $3`,
      [tenantId, learnerId, ayahRef],
    );
    await client.query("COMMIT");
    return {
      rowCount: result.rowCount,
      repetitions: result.rowCount === 1 ? Number(result.rows[0].repetitions) : null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function assertState(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.rowCount) ||
    value.rowCount < 0 ||
    (value.repetitions !== null &&
      (!Number.isSafeInteger(value.repetitions) || value.repetitions < 0))
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

/**
 * Proves that the restored HTTP path commits one effect exactly once, then removes the synthetic
 * learner through the public privacy path and confirms the tenant-owned row is gone.
 */
export async function runHttpCanaryRollbackProbe({
  baseUrl: baseUrlValue,
  jwtSecret,
  databaseUrl,
  fetchImpl = fetch,
  readProgressState,
}) {
  const baseUrl = canonicalHttpBase(baseUrlValue);
  if (typeof jwtSecret !== "string" || jwtSecret.length < 8) fail("rollback jwtSecret is required");
  if (typeof fetchImpl !== "function") fail("rollback fetchImpl must be a function");
  if (readProgressState !== undefined && typeof readProgressState !== "function") {
    fail("rollback readProgressState must be a function");
  }
  if (!readProgressState && (typeof databaseUrl !== "string" || databaseUrl.length === 0)) {
    fail("rollback databaseUrl is required");
  }

  const suffix = randomUUID();
  const tenantId = `rollback-${suffix}`;
  const learnerId = `rollback-learner-${suffix}`;
  const ayahRef = "1:1";
  const authorization = await createHttpCanaryActorAuthorization({
    jwtSecret,
    tenantId,
    userId: learnerId,
    role: "learner",
  });
  const headers = { authorization, "content-type": "application/json" };
  const pool = readProgressState ? null : new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  const readState = readProgressState ?? ((_) => readStateFromDatabase({ pool, ..._ }));
  let primaryError = null;
  let storedEffects = null;
  let cleanupError = null;

  try {
    const health = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) fail(`rollback application health failed with HTTP ${health.status}`);

    const progress = await parseJsonResponse(
      await fetchImpl(`${baseUrl}/v1/learner/progress`, {
        method: "POST",
        headers,
        body: JSON.stringify({ quality: 5, ayahRef }),
        signal: AbortSignal.timeout(10_000),
      }),
      "rollback progress write",
    );
    if (progress?.sm2State?.repetitions !== 1) {
      fail("rollback progress response must report exactly one effect");
    }
    const state = assertState(
      await readState({ tenantId, learnerId, ayahRef }),
      "rollback stored progress state",
    );
    storedEffects = state.rowCount === 1 ? state.repetitions : 0;
    if (state.rowCount !== 1 || state.repetitions !== 1) {
      fail("rollback request must leave exactly one stored effect");
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    await parseJsonResponse(
      await fetchImpl(`${baseUrl}/v1/privacy/delete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ learnerId }),
        signal: AbortSignal.timeout(10_000),
      }),
      "rollback privacy cleanup",
    );
    const cleaned = assertState(
      await readState({ tenantId, learnerId, ayahRef }),
      "rollback cleaned progress state",
    );
    if (cleaned.rowCount !== 0) fail("rollback privacy cleanup left synthetic progress state");
  } catch (error) {
    cleanupError = error;
  } finally {
    if (pool) await pool.end().catch(() => {});
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return {
    applicationHealth: "passed",
    storedEffects,
    duplicateEffects: Math.max(0, storedEffects - 1),
    privacyCleanup: "passed",
  };
}
