import { fileURLToPath } from "node:url";

import { createDb } from "../src/lib/db.mjs";
import {
  markAudioChunkRepairedInTransaction,
} from "../src/realtime/outcomes.mjs";
import {
  AudioIndexDomainError,
  indexAudioChunkInTransaction,
  inspectAudioChunkIndexInTransaction,
} from "../src/storage/audio-index.mjs";
import {
  AudioObjectIntegrityError,
  AudioObjectNotFoundError,
  createAudioObjectStoreFromEnv,
} from "../src/storage/audio-object-store.mjs";

const RETAINED_AUDIO = new Set(["teacher-review", "training-opt-in"]);

function repairRefusal(error) {
  if (!(error instanceof AudioIndexDomainError)) {
    return "database rejected candidate (unknown)";
  }
  const reasons = {
    "authority-mismatch": "database learner ownership or current retention disagrees with the stored object",
    "immutable-conflict": "existing index or outcome disagrees with the stored object",
    "invalid-candidate": "stored object has invalid index metadata",
    "invalid-object-key": "stored object identity cannot form the canonical object key",
    "session-not-found": "session is absent from the declared tenant",
  };
  return reasons[error.code] ?? "database rejected candidate (domain)";
}

async function reconcileCandidate(db, candidate, apply) {
  try {
    return await db.withTenant(candidate.tenantId, async (tx) => {
      const inspected = await inspectAudioChunkIndexInTransaction(tx, candidate);
      const [diagnostic] = await tx`
        SELECT repaired_at
        FROM realtime_audio_chunk_outcomes
        WHERE tenant_id = ${candidate.tenantId}
          AND session_id = ${candidate.sessionId}
          AND chunk_id = ${candidate.chunkId}`;
      const needsDiagnosticRepair = diagnostic && diagnostic.repaired_at === null;
      if (inspected.status === "already-indexed" && !needsDiagnosticRepair) {
        return { status: "alreadyIndexed" };
      }
      if (!apply) return { status: "wouldRepair" };
      if (inspected.status === "missing") {
        await indexAudioChunkInTransaction(tx, candidate);
      }
      await markAudioChunkRepairedInTransaction(tx, candidate);
      return { status: "repaired" };
    });
  } catch (error) {
    return {
      status: "refused",
      reason: repairRefusal(error),
    };
  }
}

async function indexedRowsForTenant(db, tenantId) {
  return db.withTenant(tenantId, (tx) => tx`
    SELECT id, tenant_id, session_id, start_ms, end_ms, sample_rate, object_key
    FROM audio_chunks
    WHERE tenant_id = ${tenantId}
    ORDER BY id`);
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
  const db = createDb(databaseUrl);
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
        audioRetention: stored.audioRetention,
      };
      const outcome = await reconcileCandidate(db, candidate, apply);
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
      for (const row of await indexedRowsForTenant(db, tenantId)) {
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
    await db.end();
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
