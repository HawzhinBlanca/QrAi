import { createTokenBucketLimiter } from "../lib/admission.mjs";
import { validateRealtimeTicket } from "../lib/ticket.mjs";

const MAX_TICKET_LIFETIME_SECONDS = 3_600n;

export const REALTIME_ADMISSION_OUTCOMES = Object.freeze([
  "accepted",
  "origin_rejected",
  "ticket_rejected",
  "rate_rejected",
]);

function refusal(outcome, statusCode, retryAfterSeconds = null) {
  return Object.freeze({
    accepted: false,
    outcome,
    retryAfterSeconds,
    statusCode,
  });
}

const ORIGIN_REFUSAL = refusal("origin_rejected", 403);
const TICKET_REFUSAL = refusal("ticket_rejected", 401);

function observedUnixSeconds(nowUnixSeconds) {
  const value = nowUnixSeconds();
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError("realtime admission clock must be non-negative");
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("realtime admission clock must return a non-negative safe integer");
  }
  return BigInt(value);
}

function traceValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Pure W3.3 admission authority. Boot-time secret/origin strength is owned by parseRealtimeConfig;
 * this boundary deliberately accepts Rust's empty-secret golden vector in direct parity tests while
 * the production process can never construct it from an unsafe configuration.
 */
export function createRealtimeAdmission({
  ticketSecret,
  tenantId,
  allowedOrigins,
  allowMissingOrigin,
  rateLimitEnabled,
  rateLimitOptions = {},
  nowUnixSeconds = () => Math.floor(Date.now() / 1_000),
}) {
  if (typeof ticketSecret !== "string") {
    throw new TypeError("realtime admission ticket secret must be a string");
  }
  if (typeof tenantId !== "string" || tenantId === "") {
    throw new TypeError("realtime admission tenant is required");
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(
    (origin) => typeof origin !== "string" || origin === "",
  )) {
    throw new TypeError("realtime admission origins must be an array of non-empty strings");
  }
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new TypeError("realtime admission origins must be unique");
  }
  if (typeof allowMissingOrigin !== "boolean") {
    throw new TypeError("realtime native no-Origin policy must be boolean");
  }
  if (typeof rateLimitEnabled !== "boolean") {
    throw new TypeError("realtime rate-limit policy must be boolean");
  }
  if (typeof nowUnixSeconds !== "function") {
    throw new TypeError("realtime admission clock must be a function");
  }

  const originSet = new Set(allowedOrigins);
  const limiter = rateLimitEnabled
    ? createTokenBucketLimiter({ capacity: 200, refillIntervalMs: 50, ...rateLimitOptions })
    : null;
  const counters = Object.fromEntries(REALTIME_ADMISSION_OUTCOMES.map((outcome) => [outcome, 0]));

  function reject(result) {
    counters[result.outcome] += 1;
    return result;
  }

  function admit({ sessionId, ticket, origin, clientIp, traceId }) {
    if (origin === undefined) {
      if (!allowMissingOrigin) return reject(ORIGIN_REFUSAL);
    } else if (typeof origin !== "string" || !originSet.has(origin)) {
      return reject(ORIGIN_REFUSAL);
    }

    const now = observedUnixSeconds(nowUnixSeconds);
    const claims = validateRealtimeTicket(sessionId, ticket, ticketSecret, now);
    if (
      claims === null ||
      claims.tenantId !== tenantId ||
      claims.expiresAtUnixSeconds - now > MAX_TICKET_LIFETIME_SECONDS
    ) {
      return reject(TICKET_REFUSAL);
    }

    if (limiter !== null) {
      if (typeof clientIp !== "string" || clientIp === "") {
        throw new TypeError("realtime admission client IP is required");
      }
      const capacity = limiter.consume(clientIp);
      if (!capacity.allowed) {
        const retryAfterSeconds = Math.max(
          1,
          Math.min(60, Math.ceil(capacity.retryAfterMs / 1_000)),
        );
        return reject(refusal("rate_rejected", 429, retryAfterSeconds));
      }
    }

    counters.accepted += 1;
    const frozenClaims = Object.freeze({ ...claims });
    return Object.freeze({
      accepted: true,
      claims: frozenClaims,
      traceId: traceValue(traceId),
    });
  }

  function renderMetrics() {
    let output = "# HELP realtime_admission_total Realtime WebSocket admission decisions by closed outcome.\n";
    output += "# TYPE realtime_admission_total counter\n";
    for (const outcome of REALTIME_ADMISSION_OUTCOMES) {
      output += `realtime_admission_total{outcome="${outcome}"} ${counters[outcome]}\n`;
    }
    return output;
  }

  return Object.freeze({ admit, renderMetrics });
}
