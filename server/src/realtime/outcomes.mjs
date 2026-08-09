import {
  AudioIndexDomainError,
  audioIndexCandidate,
  indexAudioChunkRecord,
  inspectAudioChunkIndexInTransaction,
} from "../storage/audio-index.mjs";

export const AUDIO_DELIVERY_OUTCOMES = Object.freeze([
  "indexed",
  "discarded",
  "stored_unindexed",
  "stored_unindexed_unrecorded",
  "accepted_lost",
  "accepted_lost_unrecorded",
  "rejected",
]);

const LOST_REASONS = new Set(["store-failed", "store-aborted"]);
const MAX_LOST_BATCH = 800;

function assertDb(db) {
  if (
    !db ||
    typeof db.withTenant !== "function" ||
    typeof db.assertRestrictedRole !== "function"
  ) {
    throw new TypeError("realtime outcomes require a complete tenant database boundary");
  }
}

function candidateFrom(input) {
  return audioIndexCandidate({
    tenantId: input?.identity?.tenantId,
    learnerId: input?.identity?.learnerId,
    sessionId: input?.identity?.sessionId,
    audioRetention: input?.identity?.audioRetention,
    chunkId: input?.chunk?.chunkId,
    startMs: input?.chunk?.startMs,
    endMs: input?.chunk?.endMs,
    sampleRate: input?.chunk?.sampleRate,
  });
}

function diagnosticRow(candidate, initialOutcome, reasonCode) {
  return {
    tenant_id: candidate.tenantId,
    session_id: candidate.sessionId,
    chunk_id: candidate.chunkId,
    start_ms: candidate.startMs,
    end_ms: candidate.endMs,
    sample_rate: candidate.sampleRate,
    initial_outcome: initialOutcome,
    reason_code: reasonCode,
  };
}

function sameDiagnostic(row, expected) {
  return (
    row?.tenant_id === expected.tenant_id &&
    row.session_id === expected.session_id &&
    row.chunk_id === expected.chunk_id &&
    Number(row.start_ms) === expected.start_ms &&
    Number(row.end_ms) === expected.end_ms &&
    Number(row.sample_rate) === expected.sample_rate &&
    row.initial_outcome === expected.initial_outcome &&
    row.reason_code === expected.reason_code
  );
}

async function incrementLostCounts(tx, tenantId, inserted) {
  const increments = new Map();
  for (const { session_id: sessionId } of inserted) {
    increments.set(sessionId, (increments.get(sessionId) ?? 0) + 1);
  }
  for (const [sessionId, increment] of increments) {
    await tx`
      UPDATE recitation_sessions
      SET lost_chunk_count = lost_chunk_count + ${increment}
      WHERE tenant_id = ${tenantId} AND id = ${sessionId}`;
  }
}

async function insertDiagnostics(tx, rows) {
  const inserted = await tx`
    INSERT INTO realtime_audio_chunk_outcomes
    ${tx(
      rows,
      "tenant_id",
      "session_id",
      "chunk_id",
      "start_ms",
      "end_ms",
      "sample_rate",
      "initial_outcome",
      "reason_code",
    )}
    ON CONFLICT (tenant_id, session_id, chunk_id) DO NOTHING
    RETURNING tenant_id, session_id, chunk_id`;
  if (inserted.length === rows.length) return inserted;
  for (const expected of rows) {
    const [existing] = await tx`
      SELECT tenant_id, session_id, chunk_id, start_ms, end_ms, sample_rate,
             initial_outcome, reason_code
      FROM realtime_audio_chunk_outcomes
      WHERE tenant_id = ${expected.tenant_id}
        AND session_id = ${expected.session_id}
        AND chunk_id = ${expected.chunk_id}`;
    if (!sameDiagnostic(existing, expected)) {
      throw new AudioIndexDomainError(
        "immutable-conflict",
        "chunk id already has different immutable realtime outcome metadata",
      );
    }
  }
  return inserted;
}

async function recordRows(db, candidates, initialOutcome, reasonCode) {
  if (candidates.length === 0 || candidates.length > MAX_LOST_BATCH) {
    throw new TypeError(`realtime outcome batch must contain 1..${MAX_LOST_BATCH} chunks`);
  }
  const tenantId = candidates[0].tenantId;
  if (candidates.some((candidate) => candidate.tenantId !== tenantId)) {
    throw new TypeError("realtime outcome batch must belong to one tenant");
  }
  const rows = candidates.map((candidate) =>
    diagnosticRow(candidate, initialOutcome, reasonCode));
  await db.withTenant(tenantId, async (tx) => {
    const inserted = await insertDiagnostics(tx, rows);
    if (initialOutcome === "accepted-lost") {
      await incrementLostCounts(tx, tenantId, inserted);
    }
  });
}

function validateStoredResult(candidate, stored) {
  if (
    !stored ||
    typeof stored !== "object" ||
    stored.objectKey !== candidate.objectKey ||
    !/^[0-9a-f]{64}$/.test(stored.sha256 ?? "") ||
    !Number.isSafeInteger(stored.size) ||
    stored.size <= 0
  ) {
    throw new AudioIndexDomainError(
      "invalid-store-result",
      "object store returned invalid immutable audio metadata",
    );
  }
}

/**
 * Atomically mark a newly created repair index as repaired. An accepted-lost row may legitimately
 * become repaired when a timed-out conditional PUT committed remotely after the caller lost its
 * response, so repaired_at is independent from the initial observation.
 */
export async function markAudioChunkRepairedInTransaction(tx, input) {
  const candidate = audioIndexCandidate(input);
  const inspected = await inspectAudioChunkIndexInTransaction(tx, candidate);
  if (inspected.status !== "already-indexed") {
    throw new AudioIndexDomainError(
      "repair-index-missing",
      "a realtime outcome cannot be repaired before its exact playback index exists",
    );
  }
  const [transitioned] = await tx`
    INSERT INTO realtime_audio_chunk_outcomes
      (tenant_id, session_id, chunk_id, start_ms, end_ms, sample_rate,
       initial_outcome, reason_code, repaired_at)
    VALUES (${candidate.tenantId}, ${candidate.sessionId}, ${candidate.chunkId},
            ${candidate.startMs}, ${candidate.endMs}, ${candidate.sampleRate},
            'stored-unindexed', 'reconciled-orphan', clock_timestamp())
    ON CONFLICT (tenant_id, session_id, chunk_id) DO UPDATE
      SET repaired_at = EXCLUDED.repaired_at
      WHERE realtime_audio_chunk_outcomes.start_ms = EXCLUDED.start_ms
        AND realtime_audio_chunk_outcomes.end_ms = EXCLUDED.end_ms
        AND realtime_audio_chunk_outcomes.sample_rate = EXCLUDED.sample_rate
        AND realtime_audio_chunk_outcomes.repaired_at IS NULL
    RETURNING initial_outcome`;
  if (transitioned?.initial_outcome === "accepted-lost") {
    await tx`
      UPDATE recitation_sessions
      SET lost_chunk_count = GREATEST(lost_chunk_count - 1, 0)
      WHERE tenant_id = ${candidate.tenantId} AND id = ${candidate.sessionId}`;
  }
  if (transitioned) return;

  const [existing] = await tx`
    SELECT tenant_id, session_id, chunk_id, start_ms, end_ms, sample_rate,
           initial_outcome, repaired_at
    FROM realtime_audio_chunk_outcomes
    WHERE tenant_id = ${candidate.tenantId}
      AND session_id = ${candidate.sessionId}
      AND chunk_id = ${candidate.chunkId}`;
  if (
    !existing ||
    Number(existing.start_ms) !== candidate.startMs ||
    Number(existing.end_ms) !== candidate.endMs ||
    Number(existing.sample_rate) !== candidate.sampleRate ||
    existing.repaired_at === null
  ) {
    throw new AudioIndexDomainError(
      "immutable-conflict",
      "repair candidate disagrees with durable realtime outcome metadata",
    );
  }
}

export function createRealtimeAudioOutcomeAuthority({ db } = {}) {
  assertDb(db);

  async function stored(input) {
    const candidate = candidateFrom(input);
    try {
      validateStoredResult(candidate, input.stored);
      if (candidate.audioRetention === "discard") return "discarded";
      await indexAudioChunkRecord({ db, input: candidate });
      return "indexed";
    } catch (error) {
      const reasonCode = error instanceof AudioIndexDomainError && error.code === "immutable-conflict"
        ? "index-conflict"
        : "index-failed";
      try {
        await recordRows(db, [candidate], "stored-unindexed", reasonCode);
        return "stored_unindexed";
      } catch {
        return "stored_unindexed_unrecorded";
      }
    }
  }

  async function lost(input) {
    if (!LOST_REASONS.has(input?.reasonCode)) {
      throw new TypeError("realtime accepted-loss reason is invalid");
    }
    const candidate = candidateFrom(input);
    await recordRows(db, [candidate], "accepted-lost", input.reasonCode);
    return "accepted_lost";
  }

  async function lostMany(input) {
    if (!LOST_REASONS.has(input?.reasonCode) || !Array.isArray(input?.entries)) {
      throw new TypeError("realtime accepted-loss batch is invalid");
    }
    const candidates = input.entries.map(candidateFrom);
    await recordRows(db, candidates, "accepted-lost", input.reasonCode);
    return "accepted_lost";
  }

  return Object.freeze({ lost, lostMany, stored });
}
