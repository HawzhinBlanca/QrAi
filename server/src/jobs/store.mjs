import { randomUUID } from "node:crypto";

export const JOB_KINDS = Object.freeze([
  "session.finalize",
  "session.evaluate",
  "privacy.export",
  "privacy.delete",
]);

export const JOB_STATUSES = Object.freeze(["queued", "running", "retry", "completed", "dead"]);

const KIND_SET = new Set(JOB_KINDS);
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const FORBIDDEN_DOCUMENT_FIELDS = new Set([
  "audio",
  "audiobase64",
  "audiobytes",
  "audiocontent",
  "audiodata",
  "authorization",
  "credential",
  "credentials",
  "apikey",
  "password",
  "pcm",
  "secret",
  "token",
  "transcript",
  "uri",
  "url",
  "waveform",
]);

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function requiredString(value, name, max = 256) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function wholeNumber(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function inspectJson(value, path, depth, state, limits) {
  if (depth > 8) throw new TypeError("job document exceeds the maximum depth");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`job document ${path} must be finite`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 4_096) throw new TypeError(`job document ${path} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) {
      throw new TypeError(`job document ${path} contains an oversized array`);
    }
    value.forEach((item, index) => inspectJson(item, `${path}[${index}]`, depth + 1, state, limits));
    return;
  }
  if (!isPlainObject(value)) throw new TypeError(`job document ${path} must contain only JSON values`);
  const entries = Object.entries(value);
  state.fields += entries.length;
  if (state.fields > 1_024) throw new TypeError("job document contains too many fields");
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 128) throw new TypeError(`job document field ${path} is invalid`);
    if (FORBIDDEN_DOCUMENT_FIELDS.has(key.toLowerCase())) {
      throw new TypeError(`job document contains forbidden field ${key}`);
    }
    inspectJson(item, `${path}.${key}`, depth + 1, state, limits);
  }
}

export function validateJobDocument(
  value,
  { name = "document", maxBytes = 8_192, maxArrayItems = 512 } = {},
) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be a JSON object`);
  wholeNumber(maxBytes, "maxBytes", 1, 1_048_576);
  wholeNumber(maxArrayItems, "maxArrayItems", 1, 10_000);
  inspectJson(value, name, 0, { fields: 0 }, { maxArrayItems });
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new TypeError(`${name} must be bounded JSON no larger than ${maxBytes} bytes`);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    subjectId: row.subject_id,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    status: row.status,
    priority: Number(row.priority),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: iso(row.available_at),
    leaseOwner: row.lease_owner,
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: iso(row.lease_expires_at),
    result: row.result,
    lastErrorCode: row.last_error_code,
    auditEventId: row.audit_event_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
    deadAt: iso(row.dead_at),
  });
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key already belongs to a different job request");
    this.name = "IdempotencyConflictError";
  }
}

export class StaleJobLeaseError extends Error {
  constructor() {
    super("job lease is stale or no longer running");
    this.name = "StaleJobLeaseError";
  }
}

export class JobReplayForbiddenError extends Error {
  constructor() {
    super("dead-job replay requires an in-tenant admin or operations actor");
    this.name = "JobReplayForbiddenError";
  }
}

function validateLease({ tenantId, jobId, workerId, leaseGeneration }) {
  requiredString(tenantId, "tenantId");
  requiredString(jobId, "jobId");
  requiredString(workerId, "workerId", 128);
  wholeNumber(leaseGeneration, "leaseGeneration", 1, Number.MAX_SAFE_INTEGER);
}

export function createJobStore({ db }) {
  if (!db || typeof db.withTenant !== "function") {
    throw new TypeError("createJobStore: db.withTenant is required");
  }

  async function enqueue(input) {
    const tenantId = requiredString(input?.tenantId, "tenantId");
    const kind = requiredString(input?.kind, "kind", 64);
    if (!KIND_SET.has(kind)) throw new TypeError(`kind must be one of ${JOB_KINDS.join(", ")}`);
    const subjectId = requiredString(input?.subjectId, "subjectId");
    const actorId = requiredString(input?.actorId, "actorId");
    const idempotencyKey = requiredString(input?.idempotencyKey, "idempotencyKey");
    const privacyManifest = kind === "privacy.export" || kind === "privacy.delete";
    const payload = validateJobDocument(input?.payload ?? {}, {
      name: "payload",
      maxBytes: privacyManifest ? 1_048_576 : 8_192,
      maxArrayItems: privacyManifest ? 10_000 : 512,
    });
    const priority = wholeNumber(input?.priority ?? 0, "priority", -100, 100);
    const maxAttempts = wholeNumber(input?.maxAttempts ?? 5, "maxAttempts", 1, 20);
    const jobId = `job-${randomUUID()}`;
    const auditId = `audit-${randomUUID()}`;

    return db.withTenant(tenantId, async (tx) => {
      await tx`
        INSERT INTO audit_events
          (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
        VALUES
          (${auditId}, ${tenantId}, ${actorId}, ${`job.${kind}.queued`}, 'background_job',
           ${jobId}, ${tx.json({ kind })})`;

      const inserted = await tx`
        INSERT INTO background_jobs
          (id, tenant_id, kind, subject_id, actor_id, idempotency_key, payload, priority,
           max_attempts, audit_event_id)
        VALUES
          (${jobId}, ${tenantId}, ${kind}, ${subjectId}, ${actorId}, ${idempotencyKey},
           ${tx.json(payload)}, ${priority}, ${maxAttempts}, ${auditId})
        ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING
        RETURNING *`;
      if (inserted[0]) return mapRow(inserted[0]);

      await tx`DELETE FROM audit_events WHERE id = ${auditId} AND tenant_id = ${tenantId}`;
      const [existing] = await tx`
        SELECT * FROM background_jobs
        WHERE tenant_id = ${tenantId} AND kind = ${kind} AND idempotency_key = ${idempotencyKey}`;
      const same = existing &&
        existing.subject_id === subjectId &&
        existing.actor_id === actorId &&
        Number(existing.priority) === priority &&
        Number(existing.max_attempts) === maxAttempts &&
        stableJson(existing.payload) === stableJson(payload);
      if (!same) throw new IdempotencyConflictError();
      return mapRow(existing);
    });
  }

  async function claim({ tenantId, workerId, leaseMs, jobId = null }) {
    requiredString(tenantId, "tenantId");
    requiredString(workerId, "workerId", 128);
    wholeNumber(leaseMs, "leaseMs", 1, 3_600_000);
    if (jobId !== null) requiredString(jobId, "jobId");

    return db.withTenant(tenantId, async (tx) => {
      await tx`
        UPDATE background_jobs
           SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = 'lease_expired', dead_at = now(), updated_at = now()
         WHERE tenant_id = ${tenantId} AND status = 'running'
           AND lease_expires_at <= now() AND attempt_count >= max_attempts`;

      const [row] = await tx`
        WITH candidate AS (
          SELECT id
            FROM background_jobs
           WHERE tenant_id = ${tenantId}
             AND (${jobId}::text IS NULL OR id = ${jobId})
             AND attempt_count < max_attempts
             AND (
               (status IN ('queued', 'retry') AND available_at <= now())
               OR (status = 'running' AND lease_expires_at <= now())
             )
           ORDER BY priority DESC, available_at, created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        UPDATE background_jobs AS job
           SET status = 'running', attempt_count = job.attempt_count + 1,
               lease_generation = job.lease_generation + 1, lease_owner = ${workerId},
               lease_expires_at = now() + (${leaseMs}::bigint * interval '1 millisecond'),
               result = NULL, last_error_code = NULL, completed_at = NULL, dead_at = NULL,
               updated_at = now()
          FROM candidate
         WHERE job.id = candidate.id
        RETURNING job.*`;
      return mapRow(row);
    });
  }

  async function lockCurrentLease(tx, { tenantId, jobId, workerId, leaseGeneration }) {
    const [row] = await tx`
      SELECT * FROM background_jobs
       WHERE tenant_id = ${tenantId} AND id = ${jobId}
       FOR UPDATE`;
    if (
      !row || row.status !== "running" || row.lease_owner !== workerId ||
      Number(row.lease_generation) !== leaseGeneration
    ) {
      throw new StaleJobLeaseError();
    }
    return row;
  }

  async function complete(input) {
    validateLease(input);
    if (typeof input.commit !== "function") throw new TypeError("complete.commit must be a function");
    return db.withTenant(input.tenantId, async (tx) => {
      await lockCurrentLease(tx, input);
      const committedResult = await input.commit(tx);
      const result = validateJobDocument(
        committedResult === undefined ? (input.result ?? {}) : committedResult,
        { name: "result", maxBytes: 1_048_576, maxArrayItems: 10_000 },
      );
      // jsonb intentionally canonicalizes object key order, while several Rust-compatible response
      // bodies have declaration-order wire contracts. Validate the structured response first, then
      // persist its exact serialized form so an inline duplicate or later worker replay returns the
      // same bytes recursively—not merely equivalent JSON values.
      const storedResult = Object.hasOwn(result, "response")
        ? { responseJson: JSON.stringify(result.response) }
        : result;
      const [row] = await tx`
        UPDATE background_jobs
           SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
               result = ${tx.json(storedResult)}, last_error_code = NULL,
               completed_at = now(), dead_at = NULL, updated_at = now()
         WHERE tenant_id = ${input.tenantId} AND id = ${input.jobId}
           AND status = 'running' AND lease_owner = ${input.workerId}
           AND lease_generation = ${input.leaseGeneration}
        RETURNING *`;
      if (!row) throw new StaleJobLeaseError();
      return mapRow(row);
    });
  }

  async function fail(input) {
    validateLease(input);
    if (typeof input.errorCode !== "string" || !ERROR_CODE.test(input.errorCode)) {
      throw new TypeError("errorCode must be a fixed lowercase code no longer than 64 characters");
    }
    wholeNumber(input.retryDelayMs, "retryDelayMs", 0, 86_400_000);
    return db.withTenant(input.tenantId, async (tx) => {
      const current = await lockCurrentLease(tx, input);
      const isDead = Number(current.attempt_count) >= Number(current.max_attempts);
      const [row] = isDead
        ? await tx`
            UPDATE background_jobs
               SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
                   result = NULL, last_error_code = ${input.errorCode},
                   completed_at = NULL, dead_at = now(), updated_at = now()
             WHERE tenant_id = ${input.tenantId} AND id = ${input.jobId}
            RETURNING *`
        : await tx`
            UPDATE background_jobs
               SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
                   available_at = now() + (${input.retryDelayMs}::bigint * interval '1 millisecond'),
                   result = NULL, last_error_code = ${input.errorCode},
                   completed_at = NULL, dead_at = NULL, updated_at = now()
             WHERE tenant_id = ${input.tenantId} AND id = ${input.jobId}
            RETURNING *`;
      return mapRow(row);
    });
  }

  async function get({ tenantId, jobId }) {
    requiredString(tenantId, "tenantId");
    requiredString(jobId, "jobId");
    return db.withTenant(tenantId, async (tx) => {
      const [row] = await tx`
        SELECT * FROM background_jobs WHERE tenant_id = ${tenantId} AND id = ${jobId}`;
      return mapRow(row);
    });
  }

  async function summary({ tenantId }) {
    requiredString(tenantId, "tenantId");
    return db.withTenant(tenantId, async (tx) => {
      const rows = await tx`
        SELECT status, count(*)::int AS count
          FROM background_jobs WHERE tenant_id = ${tenantId} GROUP BY status`;
      const result = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
      for (const row of rows) result[row.status] = Number(row.count);
      return Object.freeze(result);
    });
  }

  async function requeueDead({ tenantId, jobId, operatorId }) {
    requiredString(tenantId, "tenantId");
    requiredString(jobId, "jobId");
    requiredString(operatorId, "operatorId");
    const replayId = `job-${randomUUID()}`;
    const auditId = `audit-${randomUUID()}`;
    // One replay per immutable dead letter. If that replay also dies, operators replay the new dead
    // job, preserving a complete lineage without resetting attempts or weakening lease generations.
    const idempotencyKey = `replay:${jobId}`;

    return db.withTenant(tenantId, async (tx) => {
      const [operator] = await tx`
        SELECT role FROM users
         WHERE tenant_id = ${tenantId} AND id = ${operatorId}`;
      if (!operator || !["admin", "ops"].includes(operator.role)) {
        throw new JobReplayForbiddenError();
      }

      const [source] = await tx`
        SELECT * FROM background_jobs
         WHERE tenant_id = ${tenantId} AND id = ${jobId}
         FOR UPDATE`;
      if (!source || source.status !== "dead") {
        throw new TypeError("only an existing dead job can be replayed");
      }
      const privacyManifest = source.kind === "privacy.export" || source.kind === "privacy.delete";
      validateJobDocument(source.payload, {
        name: "payload",
        maxBytes: privacyManifest ? 1_048_576 : 8_192,
        maxArrayItems: privacyManifest ? 10_000 : 512,
      });

      await tx`
        INSERT INTO audit_events
          (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
        VALUES
          (${auditId}, ${tenantId}, ${operatorId}, ${`job.${source.kind}.requeued`},
           'background_job', ${replayId},
           ${tx.json({ kind: source.kind, sourceJobId: source.id })})`;

      const inserted = await tx`
        INSERT INTO background_jobs
          (id, tenant_id, kind, subject_id, actor_id, idempotency_key, payload, priority,
           max_attempts, audit_event_id)
        VALUES
          (${replayId}, ${tenantId}, ${source.kind}, ${source.subject_id}, ${source.actor_id},
           ${idempotencyKey}, ${tx.json(source.payload)}, ${source.priority},
           ${source.max_attempts}, ${auditId})
        ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING
        RETURNING *`;
      if (inserted[0]) return mapRow(inserted[0]);

      await tx`DELETE FROM audit_events WHERE id = ${auditId} AND tenant_id = ${tenantId}`;
      const [existing] = await tx`
        SELECT * FROM background_jobs
         WHERE tenant_id = ${tenantId} AND kind = ${source.kind}
           AND idempotency_key = ${idempotencyKey}`;
      if (!existing) throw new Error("dead-job replay conflict did not resolve to a job");
      return mapRow(existing);
    });
  }

  return Object.freeze({ enqueue, claim, complete, fail, get, summary, requeueDead });
}
