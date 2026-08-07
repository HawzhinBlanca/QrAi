import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  AudioObjectIntegrityError,
  AudioObjectNotFoundError,
  createAudioObjectStoreFromEnv,
} from "../src/storage/audio-object-store.mjs";

const { Client } = pg;
const RETAINED_AUDIO = new Set(["teacher-review", "training-opt-in"]);

function sameIndex(row, candidate) {
  return (
    row.tenant_id === candidate.tenantId &&
    row.session_id === candidate.sessionId &&
    Number(row.start_ms) === candidate.startMs &&
    Number(row.end_ms) === candidate.endMs &&
    Number(row.sample_rate) === candidate.sampleRate &&
    row.object_key === candidate.objectKey
  );
}

async function reconcileCandidate(client, candidate, apply) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [candidate.tenantId]);
    const sessionResult = await client.query(
      `SELECT learner_id, audit_event_id
         FROM recitation_sessions
        WHERE id = $1 AND tenant_id = $2`,
      [candidate.sessionId, candidate.tenantId],
    );
    const session = sessionResult.rows[0];
    if (!session) {
      await client.query("ROLLBACK");
      return { status: "refused", reason: "session is absent from the declared tenant" };
    }
    if (session.learner_id !== candidate.learnerId) {
      await client.query("ROLLBACK");
      return { status: "refused", reason: "database learner ownership disagrees with the stored object" };
    }

    const existingResult = await client.query(
      `SELECT tenant_id, session_id, start_ms, end_ms, sample_rate, object_key
         FROM audio_chunks
        WHERE id = $1 AND tenant_id = $2`,
      [candidate.chunkId, candidate.tenantId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      await client.query("ROLLBACK");
      return sameIndex(existing, candidate)
        ? { status: "alreadyIndexed" }
        : { status: "refused", reason: "existing index disagrees with the stored object" };
    }
    if (!apply) {
      await client.query("ROLLBACK");
      return { status: "wouldRepair" };
    }

    await client.query(
      `INSERT INTO audio_chunks
         (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status,
          object_key, audit_event_id)
       VALUES ($1, $2, $3, $1, $4, $5, $6, 'aligned', $7, $8)`,
      [
        candidate.chunkId,
        candidate.tenantId,
        candidate.sessionId,
        candidate.startMs,
        candidate.endMs,
        candidate.sampleRate,
        candidate.objectKey,
        session.audit_event_id,
      ],
    );
    await client.query("COMMIT");
    return { status: "repaired" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      status: "refused",
      reason: `database rejected candidate (${error?.code ?? "unknown"})`,
    };
  }
}

async function indexedRowsForTenant(client, tenantId) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `SELECT id, tenant_id, session_id, start_ms, end_ms, sample_rate, object_key
         FROM audio_chunks
        WHERE tenant_id = $1
        ORDER BY id`,
      [tenantId],
    );
    await client.query("ROLLBACK");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Reconcile private storage with `audio_chunks` without treating an object key as ownership
 * authority. Storage supplies a candidate; the tenant-scoped session independently confirms its
 * tenant and learner before repair. Dry-run is the default. Incomplete/corrupt and inverse
 * index-without-object states are reported, never silently deleted.
 *
 * `tenantIds` is additive to tenants discovered from storage. A restricted RLS role cannot list
 * every tenant globally, so operators pass a tenant when they need inverse-orphan coverage for a
 * tenant that currently has no objects at all.
 */
export async function repairAudioIndex(options = {}) {
  const {
    databaseUrl,
    audioStorageDir,
    audioObjectStore = null,
    apply = false,
    tenantIds = [],
    env = process.env,
  } = options;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const ownsStore = audioObjectStore === null;
  const store = audioObjectStore ?? createAudioObjectStoreFromEnv({
    env: {
      ...env,
      ...(audioStorageDir ? { AUDIO_STORAGE_DIR: audioStorageDir } : {}),
    },
    production: env.NODE_ENV === "production",
  });
  const summary = {
    mode: apply ? "apply" : "dry-run",
    driver: store.driver,
    scanned: 0,
    retainedCandidates: 0,
    skippedRetention: 0,
    wouldRepair: 0,
    repaired: 0,
    alreadyIndexed: 0,
    incompleteObjects: 0,
    indexWithoutObject: 0,
    refused: 0,
    errors: [],
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const inventory = await store.inventory();
    const readableByKey = new Map();
    const tenants = new Set(tenantIds);
    for (const entry of inventory) {
      summary.scanned += 1;
      if (entry.identity?.tenantId) tenants.add(entry.identity.tenantId);
      if (!entry.dataPresent || !entry.metadataPresent || !entry.identity) {
        summary.incompleteObjects += 1;
        summary.refused += 1;
        summary.errors.push({
          objectKey: entry.objectKey,
          chunkId: entry.identity?.chunkId,
          reason: "object data/metadata pair is incomplete or has an invalid identity",
        });
        continue;
      }
      let stored;
      try {
        stored = await store.get({ ...entry.identity, legacy: entry.legacy });
      } catch (error) {
        summary.refused += 1;
        summary.errors.push({
          objectKey: entry.objectKey,
          chunkId: entry.identity.chunkId,
          reason:
            error instanceof AudioObjectIntegrityError || error instanceof AudioObjectNotFoundError
              ? "object failed data/metadata integrity validation"
              : "object storage read failed",
        });
        continue;
      }
      readableByKey.set(stored.objectKey, stored);
      if (!RETAINED_AUDIO.has(stored.audioRetention)) {
        summary.skippedRetention += 1;
        continue;
      }
      if (!Number.isSafeInteger(stored.startMs) || !Number.isSafeInteger(stored.endMs)) {
        summary.refused += 1;
        summary.errors.push({
          objectKey: stored.objectKey,
          chunkId: stored.chunkId,
          reason: "retained object has no usable audio span",
        });
        continue;
      }
      summary.retainedCandidates += 1;
      const candidate = {
        tenantId: stored.tenantId,
        learnerId: stored.learnerId,
        sessionId: stored.sessionId,
        chunkId: stored.chunkId,
        startMs: stored.startMs,
        endMs: stored.endMs,
        sampleRate: stored.sampleRate,
        objectKey: stored.objectKey,
      };
      const outcome = await reconcileCandidate(client, candidate, apply);
      if (outcome.status === "refused") {
        summary.refused += 1;
        summary.errors.push({
          objectKey: stored.objectKey,
          chunkId: stored.chunkId,
          reason: outcome.reason,
        });
      } else {
        summary[outcome.status] += 1;
      }
    }

    for (const tenantId of [...tenants].sort()) {
      if (typeof tenantId !== "string" || tenantId.trim() === "") {
        throw new Error("tenantIds must contain non-empty strings");
      }
      for (const row of await indexedRowsForTenant(client, tenantId)) {
        if (!readableByKey.has(row.object_key)) {
          summary.indexWithoutObject += 1;
          summary.errors.push({
            objectKey: row.object_key,
            chunkId: row.id,
            reason: "database index has no readable matching audio object",
          });
        }
      }
    }
  } finally {
    await client.end();
    if (ownsStore) await store.close();
  }
  return summary;
}

function parseArgs(args) {
  const tenantIds = [];
  let apply = false;
  for (const argument of args) {
    if (argument === "--apply") apply = true;
    else if (argument.startsWith("--tenant=")) tenantIds.push(argument.slice("--tenant=".length));
    else throw new Error("usage: node server/scripts/repair-audio-index.mjs [--apply] [--tenant=ID ...]");
  }
  return { apply, tenantIds };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envTenantIds = (process.env.AUDIO_RECONCILE_TENANT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const result = await repairAudioIndex({
    databaseUrl: process.env.DATABASE_URL,
    audioStorageDir: process.env.AUDIO_STORAGE_DIR,
    apply: args.apply,
    tenantIds: [...envTenantIds, ...args.tenantIds],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.refused > 0) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`audio index repair failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
