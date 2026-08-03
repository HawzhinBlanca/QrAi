/**
 * F1 — normalizer for golden API fixtures (specs/api-golden-fixtures/plan.md).
 *
 * WHY THIS EXISTS AND WHY IT IS BUILT FIRST: nine families of server-generated fields vary on every
 * request (trace ids, row ids, audit-event ids, JWTs, session ids, timestamps, CSRF tokens). A raw
 * capture therefore fails on its SECOND run against the very service that produced it. Without
 * normalization there is no usable baseline at all.
 *
 * It is tested standalone, before any capture, because a wrong normalizer produces wrong fixtures
 * whose error is INVISIBLE — every fixture it writes simply agrees with every other one.
 *
 * ── Design decisions that matter ────────────────────────────────────────────────────────────────
 *
 * 1. KEY CASING IS NEVER NORMALIZED. Explicit non-goal. `POST /v1/auth/token` is the only
 *    snake_case response body in an otherwise camelCase API (token, user_id, tenant_id, role,
 *    audit_event_id). A Node port with a global camelCase serializer breaks every caller of that
 *    route, and a normalizer that "tidied" key casing would hide exactly that regression.
 *
 * 2. VOLATILE FIELDS ARE AN EXPLICIT ALLOWLIST, not a name pattern. `learnerId`, `tenantId`,
 *    `userId` and `wordId` all end in "Id" but are KNOWN values — seeded, or echoed back from the
 *    request. Placeholdering them would throw away the strongest assertions in the fixture set
 *    (e.g. that a cross-tenant read really did return the caller's tenant).
 *
 * 3. IDs ARE PREFIXED UUIDs, and the prefix is preserved. `next_id()` (types.rs:404) produces
 *    `{prefix}-{uuid}`, so `session-550e8400-...` normalizes to `<ID:session#1>`, not `<UUID>`.
 *    The prefix names the entity type and IS contractual — a port that returns `sess-...` or an
 *    unprefixed uuid must fail. Seeded ids like `learner-1` are NOT uuid-suffixed and stay literal.
 *
 * 4. THE SAME VALUE GETS THE SAME PLACEHOLDER within one capture run (`#1`, `#2`, …). This
 *    preserves referential integrity ACROSS steps: if POST returns session X and a later GET
 *    returns session Y, they normalize differently and the differ catches it. A stateless
 *    normalizer would map both to `<ID:session>` and silently accept a port that loses the link.
 *
 * 5. IT RAISES rather than silently passing. If a field on the volatile allowlist holds a value
 *    that does not match its expected shape, that is a FINDING — the API changed, or the field was
 *    mis-classified. Quietly emitting it verbatim would bake a real value into a committed fixture
 *    (and, for tokens, into git).
 */

/** Bare RFC-4122 UUID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `next_id()` output: a prefix, then a UUID. The prefix may itself contain hyphens. */
const PREFIXED_UUID_RE = /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** Three base64url segments. */
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
/** `rt_v2.<session>.<tenant>.<learner>.<bool>.<retention>.<exp>.<nonce>.<sig>` — the realtime ticket. */
const RT_TICKET_RE = /^rt_v2\./;

/**
 * Field names whose values are SERVER-GENERATED and therefore vary per run.
 *
 * Deliberately omitted (known values that must stay literal): learnerId, tenantId, userId, wordId,
 * ayahId, surahNumber, role, language, status, reviewStatus, consentVersion.
 */
const VOLATILE = new Map([
  ["id", "id"],
  ["auditEventId", "id"],
  ["audit_event_id", "id"],
  ["sessionId", "id"],
  ["session_id", "id"],
  ["alignmentRunId", "id"],
  ["agentRunId", "id"],
  ["nonce", "id"],
  ["traceId", "trace"],
  ["trace_id", "trace"],
  ["token", "token"],
  ["csrfToken", "csrf"],
  ["csrf_token", "csrf"],
  ["startedAt", "time"],
  ["completedAt", "time"],
  ["createdAt", "time"],
  ["created_at", "time"],
  ["updatedAt", "time"],
  ["occurredAt", "time"],
  ["expiresAt", "time"],
  ["lastSeenAt", "time"],
  ["nextReviewAt", "time"],
]);

export class NormalizeError extends Error {}

/** Per-capture-run state, so the same value maps to the same placeholder every time it appears. */
export function createNormalizer() {
  const seen = new Map(); // raw value -> placeholder
  const counters = new Map(); // placeholder family -> next ordinal

  const assign = (raw, family) => {
    if (seen.has(raw)) return seen.get(raw);
    const n = (counters.get(family) ?? 0) + 1;
    counters.set(family, n);
    const placeholder = `<${family}#${n}>`;
    seen.set(raw, placeholder);
    return placeholder;
  };

  const normalizeValue = (key, value, path) => {
    const kind = VOLATILE.get(key);
    if (kind === undefined || typeof value !== "string") return undefined;

    switch (kind) {
      case "id": {
        if (UUID_RE.test(value)) return assign(value, "UUID");
        const m = PREFIXED_UUID_RE.exec(value);
        if (m) return assign(value, `ID:${m[1]}`);
        // Seeded ids (learner-1, hikmah-pilot-erbil) are stable across runs — keep them literal,
        // they are among the most valuable assertions in the fixture.
        return null;
      }
      case "trace": {
        if (UUID_RE.test(value) || PREFIXED_UUID_RE.test(value)) return assign(value, "TRACE");
        throw new NormalizeError(
          `${path}: trace id is not a UUID (got ${JSON.stringify(value)}). The format changed, or ` +
            `this field is mis-classified. Fixtures must not bake in an unrecognised value.`,
        );
      }
      case "token": {
        if (JWT_RE.test(value)) return assign(value, "JWT");
        if (UUID_RE.test(value)) return assign(value, "TOKEN");
        if (RT_TICKET_RE.test(value)) return assign(value, "RT_TICKET");
        throw new NormalizeError(
          `${path}: token is neither a JWT, a UUID, nor an rt_v1 ticket ` +
            `(got ${JSON.stringify(value.slice(0, 24))}…). Refusing to commit an unrecognised ` +
            `secret-shaped value to a fixture.`,
        );
      }
      case "csrf": {
        if (UUID_RE.test(value)) return assign(value, "CSRF");
        throw new NormalizeError(`${path}: csrf token is not a UUID — refusing to commit it verbatim.`);
      }
      case "time": {
        if (ISO8601_RE.test(value)) return assign(value, "TIME");
        throw new NormalizeError(
          `${path}: expected an ISO-8601 timestamp, got ${JSON.stringify(value)}.`,
        );
      }
      default:
        return undefined;
    }
  };

  /** Walk a parsed JSON value, replacing volatile leaves. Key names and casing are untouched. */
  const walk = (value, path = "$", key = null) => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, key));
    if (value !== null && typeof value === "object") {
      const out = {};
      // Object.keys preserves insertion order for string keys, so key ORDER is preserved too —
      // part of the byte-exactness the fixtures depend on.
      for (const k of Object.keys(value)) out[k] = walk(value[k], `${path}.${k}`, k);
      return out;
    }
    if (key !== null) {
      const replaced = normalizeValue(key, value, path);
      if (replaced !== undefined && replaced !== null) return replaced;
    }
    // A UUID-shaped string is SERVER-GENERATED by definition, wherever it appears — including as a
    // bare array element under a key that is not on the volatile allowlist. Seeded ids
    // (learner-1, hikmah-pilot-erbil) do not match these patterns and stay literal, so this is safe
    // to apply key-independently. Found by the two-captures-identical test: a session id was
    // leaking through inside an array.
    if (typeof value === "string") {
      if (UUID_RE.test(value)) return assign(value, "UUID");
      const m = PREFIXED_UUID_RE.exec(value);
      if (m) return assign(value, `ID:${m[1]}`);
    }
    return value;
  };

  /**
   * Normalize UUIDs embedded in a URL path. Request paths carry generated ids
   * (`/v1/recitation-sessions/session-<uuid>`), so an un-normalized path makes every capture
   * differ. Uses the SAME mapping as bodies, so a path and a body referring to the same session
   * share a placeholder and cross-references stay checkable.
   */
  const normalizePath = (p) =>
    p.replace(
      /([A-Za-z-]+-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      (match) => {
        const m = PREFIXED_UUID_RE.exec(match);
        return m ? assign(match, `ID:${m[1]}`) : assign(match, "UUID");
      },
    );

  return {
    normalize: (body) => walk(body),
    normalizePath,
    /** Exposed for evidence: which raw values were replaced, and with what. Never committed. */
    mappingSize: () => seen.size,
  };
}

/** Convenience for one-off use (tests, single bodies). */
export function normalizeBody(body) {
  return createNormalizer().normalize(body);
}

/**
 * Canonical JSON: keys sorted, 2-space indent. Used for the committed artifact so a diff is
 * reviewable and byte-stable.
 *
 * NOTE: this sorts keys for the FILE, which is a storage concern. Key ORDER inside a response is
 * not part of the JSON contract; key NAMES and CASING are, and those are preserved everywhere.
 */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/**
 * Compare two normalized documents that may use DIFFERENT placeholder ordinals.
 *
 * Placeholder numbers are assignment-order dependent, so a capture and a replay legitimately
 * produce `<ID:session#2>` and `<ID:session#1>` for the same logical entity. Requiring exact
 * placeholder equality would report a difference where there is none — which is what the first
 * differ run did.
 *
 * Two documents are equivalent when there is a CONSISTENT ONE-TO-ONE renaming between their
 * placeholders. That still catches the failure that matters: if a port returns a different session
 * on GET than it created on POST, one expected placeholder would have to map to two different
 * actual ones, and the bijection breaks.
 *
 * Returns null when equivalent, or a human-readable description of the first difference.
 */
export function comparePlaceholderEquivalent(expected, actual, path = "$", maps = null) {
  const m = maps ?? { fwd: new Map(), rev: new Map() };

  const isPlaceholder = (v) => typeof v === "string" && /^<[^>]+>$/.test(v);

  if (isPlaceholder(expected) || isPlaceholder(actual)) {
    if (!isPlaceholder(expected) || !isPlaceholder(actual)) {
      return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    }
    // The family (<ID:session#1> -> ID:session) must match; only the ordinal may differ.
    const fam = (v) => v.slice(1, -1).split("#")[0];
    if (fam(expected) !== fam(actual)) {
      return `${path}: placeholder family differs — expected ${expected}, got ${actual}`;
    }
    const boundTo = m.fwd.get(expected);
    if (boundTo !== undefined && boundTo !== actual) {
      return `${path}: ${expected} was already bound to ${boundTo} but now maps to ${actual} ` +
        `(a reference that should point at the same entity does not)`;
    }
    const boundFrom = m.rev.get(actual);
    if (boundFrom !== undefined && boundFrom !== expected) {
      return `${path}: ${actual} is already bound to ${boundFrom} — two distinct entities collapsed into one`;
    }
    m.fwd.set(expected, actual);
    m.rev.set(actual, expected);
    return null;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${path}: array/non-array mismatch`;
    }
    if (expected.length !== actual.length) {
      return `${path}: expected ${expected.length} element(s), got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const d = comparePlaceholderEquivalent(expected[i], actual[i], `${path}[${i}]`, m);
      if (d) return d;
    }
    return null;
  }

  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return `${path}: object/non-object mismatch`;
    // Key names AND casing are compared exactly — this is what catches a camelCase port breaking
    // the snake_case /v1/auth/token body.
    const ek = Object.keys(expected).sort();
    const ak = Object.keys(actual).sort();
    if (JSON.stringify(ek) !== JSON.stringify(ak)) {
      return `${path}: keys differ — expected [${ek}], got [${ak}]`;
    }
    for (const k of ek) {
      const d = comparePlaceholderEquivalent(expected[k], actual[k], `${path}.${k}`, m);
      if (d) return d;
    }
    return null;
  }

  if (expected !== actual) {
    return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  return null;
}
