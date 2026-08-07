/**
 * Realtime ticket minting — the Node half of a cross-service wire contract.
 * specs/node-backend-port/plan.md §1, N1/N5
 *
 * The Rust original is services/shared-ticket/src/lib.rs:48-69. The UNCHANGED Rust
 * realtime-gateway validates whatever this produces, so any drift here is not a bug in one service,
 * it is an outage in two.
 *
 *   payload = "{sessionId}.{tenantId}.{learnerId}.{externalAsr}.{audioRetention}.{expiresAt}.{nonce}"
 *   ticket  = "rt_v2.{payload}.{lowercase hex HMAC-SHA256(secret, payload)}"
 *
 * `String(bool)` is "true"/"false", identical to Rust's `Display for bool` — which is why this port
 * is possible at all. Pinned by specs/node-backend-port/fixtures/ticket-vectors.json, asserted in
 * BOTH languages.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Mirrors `TICKET_VERSION` in shared-ticket/src/lib.rs — see its doc comment for the v1 -> v2 why. */
export const TICKET_VERSION = "rt_v2";

/** Field count of a well-formed ticket: version + 7 payload fields + signature. */
const TICKET_PARTS = 9;

/**
 * Reject what `validate_realtime_ticket` rejects (shared-ticket/src/lib.rs:92-99), at MINT time.
 *
 * Rust cannot construct a ticket with a `null` tenant; JavaScript can, and it would serialize as the
 * string "null" and validate happily on the far side. So every field is checked for being a
 * non-empty string here, and a separator inside a field is refused because the format is
 * dot-delimited with no escaping — an id containing "." would silently shift every later field.
 */
function requireField(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`realtime ticket: ${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (value.includes(".")) {
    throw new TypeError(
      `realtime ticket: ${name} must not contain "." — the format is dot-delimited with no escaping, ` +
        `so an embedded separator shifts every subsequent field`,
    );
  }
  return value;
}

export function ticketPayload({
  sessionId,
  tenantId,
  learnerId,
  externalAsrProcessing,
  audioRetention,
  expiresAtUnixSeconds,
  nonce,
}) {
  requireField("sessionId", sessionId);
  requireField("tenantId", tenantId);
  requireField("learnerId", learnerId);
  // Not enum-checked here, deliberately, matching the Rust original — the closed set lives in the
  // `consent_records.audio_retention` CHECK constraint. But it MUST be present: an undefined would
  // serialize as the literal "undefined", which the Rust gateway happily forwards to ml-inference,
  // which does not recognise it and falls back to deleting the audio in an hour.
  requireField("audioRetention", audioRetention);
  requireField("nonce", nonce);
  if (typeof externalAsrProcessing !== "boolean") {
    throw new TypeError(
      `realtime ticket: externalAsrProcessing must be a boolean — a truthy string would serialize ` +
        `as itself and grant external ASR consent the learner never gave`,
    );
  }
  // Rust takes u64. A float, a negative, or anything past Number.MAX_SAFE_INTEGER would render
  // differently (or in exponent notation) and produce a ticket Rust cannot parse.
  if (
    typeof expiresAtUnixSeconds !== "bigint" &&
    (!Number.isSafeInteger(expiresAtUnixSeconds) || expiresAtUnixSeconds < 0)
  ) {
    throw new TypeError(
      `realtime ticket: expiresAtUnixSeconds must be a non-negative safe integer or a BigInt, ` +
        `got ${JSON.stringify(String(expiresAtUnixSeconds))}`,
    );
  }
  return `${sessionId}.${tenantId}.${learnerId}.${externalAsrProcessing}.${audioRetention}.${expiresAtUnixSeconds}.${nonce}`;
}

export function signTicketPayload(payload, secret) {
  if (typeof secret !== "string") {
    throw new TypeError("realtime ticket: secret must be a string");
  }
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Byte-identical to `issue_realtime_ticket` (shared-ticket/src/lib.rs:48). */
export function issueRealtimeTicket(fields, secret) {
  const payload = ticketPayload(fields);
  return `${TICKET_VERSION}.${payload}.${signTicketPayload(payload, secret)}`;
}

/**
 * Verify a ticket's signature. Not used to serve traffic — the Rust gateway is the validator — but
 * required to prove a TAMPERED ticket is rejected (N5) without asking the gateway to be the only
 * evidence.
 *
 * Constant-time, mirroring `constant_time_eq` (shared-ticket/src/lib.rs:158).
 */
export function verifyRealtimeTicket(ticket, secret) {
  if (typeof ticket !== "string") return false;
  const parts = ticket.trim().split(".");
  if (parts.length !== TICKET_PARTS || parts[0] !== TICKET_VERSION) return false;
  const [, ...rest] = parts;
  const signature = rest.pop();
  const expected = signTicketPayload(rest.join("."), secret);
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
}

/** Matches the Rust minter's nonce shape: 32 lowercase hex characters. */
export function newNonce() {
  return randomBytes(16).toString("hex");
}
