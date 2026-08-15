/**
 * Language-neutral `audio.ack` construction and validation.
 *
 * This module owns no socket and no ticket crypto. Rust remains the wire oracle until W3 canary
 * and rollback gates pass; both implementations are pinned to the fixtures in
 * packages/contracts/fixtures/realtime.
 */

export const AUDIO_ACK_KIND = "audio.ack";

export const AUDIO_ACK_FIELDS = Object.freeze([
  "kind",
  "session_id",
  "chunk_id",
  "sequence",
  "accepted",
  "trace_id",
  "message",
]);

const AUDIO_ACK_FIELD_SET = new Set(AUDIO_ACK_FIELDS);

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasExactAckFields(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === AUDIO_ACK_FIELDS.length && keys.every((key) => AUDIO_ACK_FIELD_SET.has(key));
}

function validatedAck(value) {
  if (
    !hasExactAckFields(value) ||
    value.kind !== AUDIO_ACK_KIND ||
    !isNonBlankString(value.session_id) ||
    !isNonBlankString(value.chunk_id) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.accepted !== "boolean" ||
    (value.trace_id !== null && !isNonBlankString(value.trace_id)) ||
    !isNonBlankString(value.message)
  ) {
    return null;
  }

  return {
    kind: AUDIO_ACK_KIND,
    session_id: value.session_id,
    chunk_id: value.chunk_id,
    sequence: value.sequence,
    accepted: value.accepted,
    trace_id: value.trace_id,
    message: value.message,
  };
}

/** Parse an object or JSON string without assigning semantic meaning to diagnostic `message`. */
export function parseAudioAck(input) {
  try {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    return validatedAck(value);
  } catch {
    return null;
  }
}

/** Construct the exact snake-case wire object from package-internal camel-case inputs. */
export function createAudioAck({ sessionId, chunkId, sequence, accepted, traceId, message }) {
  const ack = validatedAck({
    kind: AUDIO_ACK_KIND,
    session_id: sessionId,
    chunk_id: chunkId,
    sequence,
    accepted,
    trace_id: traceId,
    message,
  });
  if (ack === null) {
    throw new TypeError("audio ack fields must satisfy the language-neutral rt_v2 contract");
  }
  return ack;
}

/** Serialize only a complete, unambiguous ack document. */
export function serializeAudioAck(input) {
  const ack = parseAudioAck(input);
  if (ack === null) {
    throw new TypeError("cannot serialize an invalid audio ack");
  }
  return JSON.stringify(ack);
}
