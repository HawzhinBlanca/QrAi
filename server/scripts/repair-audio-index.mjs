import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const RETAINED_AUDIO = new Set(["teacher-review", "training-opt-in"]);

/**
 * @typedef {object} RepairSummary
 * @property {"apply" | "dry-run"} mode
 * @property {number} scanned
 * @property {number} retainedCandidates
 * @property {number} skippedRetention
 * @property {number} wouldRepair
 * @property {number} repaired
 * @property {number} alreadyIndexed
 * @property {number} refused
 * @property {Array<{metadataPath: string, chunkId?: string, reason: string}>} errors
 */

function safeSegment(value, fieldName) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(`${fieldName} is not a safe storage segment`);
  }
  return value;
}

function integer(value, fieldName, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${fieldName} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function metadataPaths(audioStorageDir) {
  if (!audioStorageDir || !existsSync(audioStorageDir) || !statSync(audioStorageDir).isDirectory()) {
    throw new Error(`AUDIO_STORAGE_DIR is not a readable directory: ${audioStorageDir || "<unset>"}`);
  }
  /** @type {string[]} */
  const paths = [];
  for (const tenantEntry of readdirSync(audioStorageDir, { withFileTypes: true })) {
    if (!tenantEntry.isDirectory()) continue;
    const tenantDir = join(audioStorageDir, tenantEntry.name);
    for (const learnerEntry of readdirSync(tenantDir, { withFileTypes: true })) {
      if (!learnerEntry.isDirectory()) continue;
      const learnerDir = join(tenantDir, learnerEntry.name);
      for (const file of readdirSync(learnerDir, { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith(".meta.json")) {
          paths.push(join(learnerDir, file.name));
        }
      }
    }
  }
  return paths.sort();
}

function loadCandidate(audioStorageDir, metadataPath) {
  const parts = relative(audioStorageDir, metadataPath).split(sep);
  if (parts.length !== 3) throw new Error("metadata is not at <tenant>/<learner>/<chunk>.meta.json");
  const [pathTenant, pathLearner, metadataName] = parts;
  safeSegment(pathTenant, "path tenantId");
  safeSegment(pathLearner, "path learnerId");

  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error("metadata is not valid JSON");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("metadata must be an object");
  }

  const tenantId = safeSegment(metadata.tenantId, "metadata tenantId");
  const learnerId = safeSegment(metadata.learnerId, "metadata learnerId");
  const sessionId = safeSegment(metadata.sessionId, "metadata sessionId");
  const chunkId = safeSegment(metadata.chunkId, "metadata chunkId");
  if (tenantId !== pathTenant || learnerId !== pathLearner) {
    throw new Error("path ownership does not match metadata tenantId/learnerId");
  }
  if (metadataName !== `${chunkId}.meta.json` || basename(metadataPath) !== metadataName) {
    throw new Error("metadata filename does not match chunkId");
  }

  if (!RETAINED_AUDIO.has(metadata.audioRetention)) {
    return { skippedRetention: true, chunkId, metadataPath };
  }

  const startMs = integer(metadata.startMs, "startMs");
  const endMs = integer(metadata.endMs, "endMs");
  if (endMs <= startMs) throw new Error("startMs/endMs must satisfy 0 <= startMs < endMs");
  const sampleRate = integer(metadata.sampleRate ?? 16_000, "sampleRate", {
    minimum: 1,
    maximum: 384_000,
  });
  const expectedObjectKey = `${tenantId}/${learnerId}/${chunkId}.bin`;
  if (metadata.objectKey !== expectedObjectKey) {
    throw new Error("objectKey does not match the storage path and declared ownership");
  }

  const audioPath = join(audioStorageDir, tenantId, learnerId, `${chunkId}.bin`);
  if (!existsSync(audioPath)) throw new Error("metadata has no matching audio object");
  const audioStat = lstatSync(audioPath);
  if (!audioStat.isFile() || audioStat.isSymbolicLink()) {
    throw new Error("matching audio object must be a regular non-symlink file");
  }
  const audioSize = audioStat.size;
  if (metadata.audioSize != null && integer(metadata.audioSize, "audioSize") !== audioSize) {
    throw new Error("audioSize does not match the stored object");
  }
  if (metadata.audioSha256 != null) {
    if (!/^[a-f0-9]{64}$/.test(metadata.audioSha256)) {
      throw new Error("audioSha256 is malformed");
    }
    const actualHash = createHash("sha256").update(readFileSync(audioPath)).digest("hex");
    if (actualHash !== metadata.audioSha256) throw new Error("audioSha256 does not match the object");
  }

  return {
    skippedRetention: false,
    metadataPath,
    tenantId,
    learnerId,
    sessionId,
    chunkId,
    startMs,
    endMs,
    sampleRate,
    objectKey: expectedObjectKey,
  };
}

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
      return { status: "refused", reason: "database learner ownership disagrees with the sidecar" };
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
        : { status: "refused", reason: "existing index disagrees with the stored sidecar" };
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

/**
 * Reconcile retained audio sidecars with `audio_chunks` without trusting storage as an ownership
 * authority. The sidecar identifies a candidate; the tenant-scoped session row must independently
 * confirm both tenant and learner before any insert occurs.
 *
 * @param {{databaseUrl?: string, audioStorageDir?: string, apply?: boolean}} [options]
 * @returns {Promise<RepairSummary>}
 */
export async function repairAudioIndex(options = {}) {
  const { databaseUrl, audioStorageDir, apply = false } = options;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  /** @type {RepairSummary} */
  const summary = {
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    retainedCandidates: 0,
    skippedRetention: 0,
    wouldRepair: 0,
    repaired: 0,
    alreadyIndexed: 0,
    refused: 0,
    errors: [],
  };
  const paths = metadataPaths(audioStorageDir);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const metadataPath of paths) {
      summary.scanned += 1;
      let candidate;
      try {
        candidate = loadCandidate(audioStorageDir, metadataPath);
      } catch (error) {
        summary.refused += 1;
        summary.errors.push({ metadataPath, reason: error.message });
        continue;
      }
      if (candidate.skippedRetention) {
        summary.skippedRetention += 1;
        continue;
      }
      summary.retainedCandidates += 1;
      const outcome = await reconcileCandidate(client, candidate, apply);
      if (outcome.status === "refused") {
        summary.refused += 1;
        summary.errors.push({
          metadataPath,
          chunkId: candidate.chunkId,
          reason: outcome.reason,
        });
      } else {
        summary[outcome.status] += 1;
      }
    }
  } finally {
    await client.end();
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--apply")) {
    throw new Error("usage: node server/scripts/repair-audio-index.mjs [--apply]");
  }
  const result = await repairAudioIndex({
    databaseUrl: process.env.DATABASE_URL,
    audioStorageDir: process.env.AUDIO_STORAGE_DIR,
    apply: args.includes("--apply"),
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
