import { deriveAudioObjectKey } from "./audio-object-store.mjs";

const RETENTION_VALUES = new Set(["discard", "teacher-review", "training-opt-in"]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AudioIndexDomainError("invalid-candidate", `${field} must be a non-empty string`);
  }
  return value;
}

function int32(value, field) {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new AudioIndexDomainError("invalid-candidate", `${field} must be an int32 integer`);
  }
  return value;
}

export class AudioIndexDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AudioIndexDomainError";
    this.code = code;
  }
}

export function audioIndexCandidate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AudioIndexDomainError("invalid-candidate", "audio index candidate must be an object");
  }
  const tenantId = requiredString(input.tenantId, "tenantId");
  const learnerId = requiredString(input.learnerId, "learnerId");
  const sessionId = requiredString(input.sessionId, "sessionId");
  const chunkId = requiredString(input.chunkId, "chunkId");
  const startMs = int32(input.startMs, "startMs");
  const endMs = int32(input.endMs, "endMs");
  if (startMs < 0 || endMs <= startMs) {
    throw new AudioIndexDomainError(
      "invalid-candidate",
      "startMs/endMs must satisfy 0 <= startMs < endMs",
    );
  }
  const sampleRate = int32(input.sampleRate, "sampleRate");
  const audioRetention = requiredString(input.audioRetention, "audioRetention");
  if (!RETENTION_VALUES.has(audioRetention)) {
    throw new AudioIndexDomainError("invalid-candidate", "audioRetention is invalid");
  }
  let objectKey;
  try {
    objectKey = deriveAudioObjectKey({ tenantId, learnerId, sessionId, chunkId });
  } catch {
    throw new AudioIndexDomainError(
      "invalid-object-key",
      "chunk identity cannot form a safe object key",
    );
  }
  return Object.freeze({
    tenantId,
    learnerId,
    sessionId,
    chunkId,
    startMs,
    endMs,
    sampleRate,
    audioRetention,
    objectKey,
  });
}

function sameIndex(row, candidate) {
  return (
    row?.tenant_id === candidate.tenantId &&
    row.session_id === candidate.sessionId &&
    Number(row.start_ms) === candidate.startMs &&
    Number(row.end_ms) === candidate.endMs &&
    Number(row.sample_rate) === candidate.sampleRate &&
    row.object_key === candidate.objectKey
  );
}

async function assertSessionAuthority(tx, candidate) {
  const [session] = await tx`
    SELECT s.audit_event_id, s.learner_id, c.audio_retention
    FROM recitation_sessions s
    JOIN consent_records c ON c.id = s.consent_record_id
    WHERE s.id = ${candidate.sessionId} AND s.tenant_id = ${candidate.tenantId}`;
  if (!session) {
    throw new AudioIndexDomainError("session-not-found", "recitation session was not found");
  }
  if (
    session.learner_id !== candidate.learnerId ||
    session.audio_retention !== candidate.audioRetention
  ) {
    throw new AudioIndexDomainError(
      "authority-mismatch",
      "session learner or retention disagrees with the audio candidate",
    );
  }
  return session;
}

export async function inspectAudioChunkIndexInTransaction(tx, input) {
  const candidate = audioIndexCandidate(input);
  const session = await assertSessionAuthority(tx, candidate);
  const [existing] = await tx`
    SELECT tenant_id, session_id, start_ms, end_ms, sample_rate, object_key
    FROM audio_chunks
    WHERE id = ${candidate.chunkId} AND tenant_id = ${candidate.tenantId}`;
  if (existing && !sameIndex(existing, candidate)) {
    throw new AudioIndexDomainError(
      "immutable-conflict",
      "chunk id already indexes different immutable audio metadata",
    );
  }
  return Object.freeze({
    candidate,
    sessionAuditEventId: session.audit_event_id,
    status: existing ? "already-indexed" : "missing",
  });
}

export async function indexAudioChunkInTransaction(tx, input) {
  const inspected = await inspectAudioChunkIndexInTransaction(tx, input);
  if (inspected.status === "already-indexed") return inspected;
  const { candidate } = inspected;
  const inserted = await tx`
    INSERT INTO audio_chunks
      (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status,
       object_key, audit_event_id)
    VALUES (${candidate.chunkId}, ${candidate.tenantId}, ${candidate.sessionId},
            ${candidate.chunkId}, ${candidate.startMs}, ${candidate.endMs},
            ${candidate.sampleRate}, 'aligned', ${candidate.objectKey},
            ${inspected.sessionAuditEventId})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) {
    const [raced] = await tx`
      SELECT tenant_id, session_id, start_ms, end_ms, sample_rate, object_key
      FROM audio_chunks
      WHERE id = ${candidate.chunkId} AND tenant_id = ${candidate.tenantId}`;
    if (!sameIndex(raced, candidate)) {
      throw new AudioIndexDomainError(
        "immutable-conflict",
        "chunk id already indexes different immutable audio metadata",
      );
    }
    return Object.freeze({ ...inspected, status: "already-indexed" });
  }
  return Object.freeze({ ...inspected, status: "indexed" });
}

function assertDb(db) {
  if (!db || typeof db.withTenant !== "function") {
    throw new TypeError("audio index requires a tenant database boundary");
  }
}

export async function inspectAudioChunkIndex({ db, input }) {
  assertDb(db);
  const candidate = audioIndexCandidate(input);
  return db.withTenant(candidate.tenantId, (tx) =>
    inspectAudioChunkIndexInTransaction(tx, candidate));
}

export async function indexAudioChunkRecord({ db, input }) {
  assertDb(db);
  const candidate = audioIndexCandidate(input);
  return db.withTenant(candidate.tenantId, (tx) => indexAudioChunkInTransaction(tx, candidate));
}
