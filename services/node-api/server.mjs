/**
 * N2/N4/N5 — the strangler shell.
 * specs/node-backend-port/plan.md §3
 *
 *   client ──► THIS ──┬── ported route  ──► Postgres
 *                     └── everything else ──► Rust platform-api, verbatim
 *
 * Every route not listed in `PORTED` is proxied unchanged. That is what makes each step of the port
 * independently reversible: backing a route out is deleting one entry, not redeploying a rewrite.
 *
 * Env:
 *   PLATFORM_API_UPSTREAM   REQUIRED, no default — the Rust service to proxy to.
 *   NODE_API_BIND           host:port to listen on (default 127.0.0.1:8099)
 *   NODE_API_PORTED         comma-separated route keys to serve locally (default: NONE)
 * plus the same DATABASE_URL / JWT_SECRET / ALLOW_HEADER_AUTH / CORS_ALLOWED_ORIGINS the Rust
 * service reads, so the two can be started from one environment.
 */
import { createHash, randomUUID } from "node:crypto";

import Fastify from "fastify";
import cors from "@fastify/cors";

import { ApiError, NotFound, requireAnyRole, requireSelfOrAny, resolveActor } from "./lib/authz.mjs";
import { createDb } from "./lib/db.mjs";
import { issueRealtimeTicket } from "./lib/ticket.mjs";

/** services/platform-api/src/lib.rs:19 */
const REALTIME_TICKET_TTL_SECONDS = 300;

/** Route keys that MAY be served locally. Nothing is ported unless NODE_API_PORTED names it. */
export const PORTABLE = ["GET /v1/learner/progress", "POST /v1/realtime-session-tickets"];

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function buildServer(config) {
  const {
    upstream,
    ported = new Set(),
    databaseUrl,
    jwtSecret = "quran-ai-dev-secret",
    allowHeaderAuth = false,
    corsAllowedOrigins = null,
    ticketSecret = "smoke-secret",
    ticketTtlSeconds = 300,
    logger = false,
  } = config;

  if (!upstream) throw new TypeError("buildServer: upstream is required and has no default");

  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 });
  const db = ported.size > 0 && databaseUrl ? createDb(databaseUrl) : null;

  // ── Middleware order is a security invariant (§2.5) ───────────────────────────────────────────
  // Effective order in Rust is CORS → maintenance → rate limit → trace → metrics → handler. CORS is
  // outermost so a preflight is never rate-limited and a 429/503 still carries CORS headers.
  // Registering it first here is that same ordering made structural — and `ordering.test.mjs`
  // asserts it, because in any Node framework this is otherwise a line-number accident.
  //
  // §2.4: NEVER `origin: true`. tower-http emits the literal `*` when CORS_ALLOWED_ORIGINS is unset,
  // and browsers refuse to combine `*` with credentials — so today a cross-origin page cannot send
  // the __Host-qrai-pilot cookie. `origin: true` REFLECTS the request Origin, which IS valid with
  // credentials. That is strictly weaker, and with the near-certain follow-on `credentials: true` it
  // is full CSRF against every pilot learner.
  const allowList =
    typeof corsAllowedOrigins === "string" && corsAllowedOrigins.trim() !== ""
      ? corsAllowedOrigins.split(",").map((o) => o.trim()).filter(Boolean)
      : null;
  app.register(cors, {
    origin: allowList ?? "*", // literal "*", never `true`
    credentials: false, // hard-banned; asserted by a test on every response
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // Boot assertion, not a comment: `credentials: true` anywhere in this config is unshippable.
  if (config.corsCredentials === true) {
    throw new Error(
      "CORS credentials are hard-banned (§2.4): combined with a reflected Origin this is CSRF " +
        "against every pilot learner. Remove it rather than making it configurable.",
    );
  }

  const key = (req) => `${req.method} ${req.routeOptions?.url ?? new URL(req.url, "http://x").pathname}`;

  // ── Ported: GET /v1/learner/progress (N4) ─────────────────────────────────────────────────────
  if (ported.has("GET /v1/learner/progress")) {
    app.get("/v1/learner/progress", async (req, reply) => {
      const resolved = await resolveActor(req, { jwtSecret, allowHeaderAuth });
      if (resolved.delegate) return proxy(req, reply, upstream);
      const { actor } = resolved;

      // TWO gates, with DIFFERENT lists — handlers/progress.rs:81-96. A scholar fails the first one;
      // collapsing them into a single check would silently grant scholars access.
      requireAnyRole(actor, ["learner", "teacher", "admin", "ops"]);
      const requested = req.query.learnerId;
      const learnerId = requested ?? actor.userId;
      if (requested !== undefined) {
        // Note the allowlist: teacher/admin/ops, NOT scholar. Transcribed from the Rust, not guessed
        // — my first attempt included scholar, which would have been a real privilege widening.
        requireSelfOrAny(actor, requested, ["teacher", "admin", "ops"]);
      }

      const body = await db.withTenant(actor.tenantId, async (tx) => {
        const [{ count: totalSessions }] = await tx`
          SELECT COUNT(*)::int AS count FROM recitation_sessions
          WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

        const reps = await tx`
          SELECT repetitions FROM learner_progress
          WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

        // Mean per-card min(repetitions/4, 1), rounded to 3 decimals — inlined in the Rust handler
        // (progress.rs:119-124), so it is pinned here rather than re-derived.
        const mastery =
          reps.length === 0
            ? 0
            : Math.round(
                (reps.reduce((a, r) => a + Math.min(r.repetitions / 4, 1), 0) / reps.length) * 1000,
              ) / 1000;

        // chrono's `to_rfc3339()` renders `+00:00`, NOT the `Z` that Date#toISOString produces, and
        // it prints 0/3/6 fractional digits (SecondsFormat::AutoSi). Formatting this in Postgres and
        // trimming the same way is the only thing that keeps the wire value identical.
        const [{ base, us }] = await tx`
          SELECT to_char(MIN(next_review_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS base,
                 (EXTRACT(microseconds FROM MIN(next_review_at))::bigint % 1000000) AS us
          FROM learner_progress
          WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

        const days = await tx`
          SELECT DISTINCT (started_at AT TIME ZONE 'UTC')::date AS d
          FROM recitation_sessions
          WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}
          ORDER BY d DESC`;

        // serde_json is built without `preserve_order`, so `json!` serializes keys ALPHABETICALLY.
        // Insertion order here is therefore part of matching the Rust bytes, not a style choice.
        return {
          learnerId,
          mastery,
          nextReviewAt: base === null ? null : `${base}${fractional(Number(us))}+00:00`,
          streak: computeStreak(days.map((r) => r.d)),
          tenantId: actor.tenantId,
          totalSessions,
        };
      });

      return reply.send(body);
    });
  }

  // ── Ported: POST /v1/realtime-session-tickets (N5) ────────────────────────────────────────────
  // Transcribed from handlers/recitation.rs:298-400 AFTER tests/api-parity/realtime-ticket.test.mjs
  // existed. The first attempt was written without that oracle and failed 7 of its 9 checks while
  // passing every pre-existing test in the repo — wrong role lists, consent from the wrong source,
  // no sample-rate negotiation, and neither of the two rows it must persist.
  if (ported.has("POST /v1/realtime-session-tickets")) {
    app.post("/v1/realtime-session-tickets", async (req, reply) => {
      const resolved = await resolveActor(req, { jwtSecret, allowHeaderAuth });
      if (resolved.delegate) return proxy(req, reply, upstream);
      const { actor } = resolved;

      // NOT the usual staff list: teacher and scholar are refused outright. A ticket is a live
      // audio credential, and reusing the read-route allowlist would hand one to every teacher.
      requireAnyRole(actor, ["learner", "admin", "ops"]);

      // 422, not 400: axum's `Json<T>` extractor rejects a body that fails to deserialize BEFORE
      // the handler runs, and serde's rejection is 422. The A/B against Rust caught this — the
      // status is what clients branch on, so it is matched.
      //
      // RECORDED DIVERGENCE, not fixed: Rust's body is serde's own text, e.g.
      //   "Failed to deserialize the JSON body into the target type: missing field `sessionId` at
      //    line 1 column 2"
      // Reproducing that byte-for-byte would mean reimplementing serde's error formatting, including
      // line/column offsets. It also leaks deserializer internals, so copying it is not obviously
      // desirable. Named in the N6 report rather than silently smoothed over.
      const sessionId = req.body?.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new ApiError("sessionId is required", 422);
      }

      const body = await db.withTenant(actor.tenantId, async (tx) => {
        const [row] = await tx`
          SELECT id, tenant_id, learner_id, external_processing_allowed
          FROM recitation_sessions
          WHERE id = ${sessionId} AND tenant_id = ${actor.tenantId}`;
        if (!row) throw NotFound();

        requireSelfOrAny(actor, row.learner_id, ["admin", "ops"]);

        // The gateway trusts this flag to decide whether audio may leave for external ASR, so it
        // comes from the session's SERVER-SIDE column — never from the request, and never from the
        // consent snapshot JSON (which is the learner's stated preference, not the resolved gate).
        const externalAsr = row.external_processing_allowed === true;

        const requested = Array.isArray(req.body?.requestedSampleRates)
          ? req.body.requestedSampleRates.filter((sr) => [16000, 24000, 48000].includes(sr))
          : [];
        const allowedSampleRates = requested.length > 0 ? requested : [16000];

        const auditId = `audit-${randomUUID()}`;
        const ticketId = `rt-ticket-${randomUUID()}`;
        const expiresAt = Math.floor(Date.now() / 1000) + REALTIME_TICKET_TTL_SECONDS;
        const token = issueRealtimeTicket(
          {
            sessionId: row.id,
            tenantId: actor.tenantId,
            learnerId: row.learner_id,
            externalAsrProcessing: externalAsr,
            expiresAtUnixSeconds: expiresAt,
            nonce: randomUUID(),
          },
          ticketSecret,
        );

        await tx`
          INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
          VALUES (${auditId}, ${actor.tenantId}, ${actor.userId},
                  'recitation.realtime-ticket.issued', 'realtime_session_ticket', ${ticketId},
                  ${tx.json({ trace_id: req.headers["x-trace-id"] ?? null })})`;

        // Only the HASH is stored. Persisting the raw token would put a live credential in a table
        // that privacy exports and operator queries both read.
        await tx`
          INSERT INTO realtime_session_tickets
            (id, tenant_id, session_id, learner_id, token_hash, expires_at,
             allowed_sample_rates, external_asr_processing, audit_event_id)
          VALUES (${ticketId}, ${actor.tenantId}, ${row.id}, ${row.learner_id},
                  ${createHash("sha256").update(token).digest("hex")},
                  ${new Date(expiresAt * 1000)}, ${allowedSampleRates}, ${externalAsr}, ${auditId})`;

        return {
          sessionId: row.id,
          tenantId: actor.tenantId,
          learnerId: row.learner_id,
          // `expires_at.to_string()` on a u64 — a DECIMAL STRING of unix seconds. Serializing a Date
          // here would put RFC3339 on the wire and break every client that parses it as a number.
          expiresAt: String(expiresAt),
          allowedSampleRates,
          externalAsrProcessing: externalAsr,
          token,
          auditEventId: auditId,
        };
      });

      return reply.send(body);
    });
  }

  // ── Everything else: proxied verbatim ─────────────────────────────────────────────────────────
  // `setNotFoundHandler` alone IS the strangler catch-all: anything not registered above falls
  // through to it, for every method, with no route to keep in sync.
  //
  // The first attempt also registered `app.all("/*")`, which Fastify rejected at boot with
  // FST_ERR_DUPLICATED_ROUTE — `all` registers GET, Fastify auto-adds HEAD for GET, and `all`
  // registers HEAD too. That is the boot-time duplicate detection §2.1 chose Fastify for, catching a
  // real bug on its first run rather than serving one handler and silently dropping the other.
  app.setNotFoundHandler((req, reply) => proxy(req, reply, upstream));

  // Fastify parses a body only for content-types it knows. Every parity request sends
  // `content-type: application/json`, including GETs with no body at all, which the default JSON
  // parser rejects as malformed — a 400 the Rust service never returns. Treat an empty body as
  // absent rather than as invalid JSON.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === undefined || body === null || body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch {
      done(null, body); // pass through verbatim; upstream decides whether it is valid
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
    reply.code(500).send({ error: "internal error" });
  });

  app.decorate("portedRoutes", [...ported]);
  return app;
}

/**
 * chrono's SecondsFormat::AutoSi: no fractional part when it is zero, 3 digits when the value is a
 * whole millisecond, 6 otherwise. `Date#toISOString` always prints exactly 3 and always ends in `Z`,
 * so using it here would put a different string on the wire for the same instant.
 */
export function fractional(us) {
  if (!us) return "";
  if (us % 1000 === 0) return `.${String(us / 1000).padStart(3, "0")}`;
  return `.${String(us).padStart(6, "0")}`;
}

/**
 * Port of `compute_streak` (handlers/progress.rs:247). Consecutive days ending today or yesterday;
 * anything older is a streak of zero.
 */
export function computeStreak(daysDesc) {
  if (!daysDesc || daysDesc.length === 0) return 0;
  const day = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000;
  const first = day(daysDesc[0]);
  if (first !== today && first !== today - 1) return 0;

  let streak = 0;
  let expected = first;
  for (const d of daysDesc) {
    const v = day(d);
    if (v === expected) {
      streak += 1;
      expected -= 1;
    } else if (v < expected) {
      break;
    }
  }
  return streak;
}

/**
 * Forward a request upstream and copy the response back verbatim.
 *
 * Verbatim is the whole contract: status, body BYTES, and every response header except the
 * hop-by-hop ones. Set-Cookie in particular must survive with its attributes intact — the
 * `__Host-qrai-pilot` cookie's Secure/HttpOnly/SameSite/Path are exactly what a careless proxy
 * drops, and nothing downstream would notice until a pilot learner's session broke.
 */
async function proxy(req, reply, upstream) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }

  const hasBody = !["GET", "HEAD"].includes(req.method);
  const upstreamRes = await fetch(new URL(req.url, upstream), {
    method: req.method,
    headers,
    // req.body is already parsed by Fastify; re-serialize. `rawBody` would be better but needs a
    // content-type-agnostic parser, and every body this API accepts is JSON.
    body: hasBody && req.body !== undefined ? JSON.stringify(req.body) : undefined,
    redirect: "manual",
  });

  for (const [k, v] of upstreamRes.headers) {
    if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === "set-cookie") continue;
    reply.header(k, v);
  }
  // getSetCookie() preserves MULTIPLE Set-Cookie headers; iterating headers collapses them into one
  // comma-joined value, which silently corrupts any cookie whose Expires attribute contains a comma.
  for (const c of upstreamRes.headers.getSetCookie()) reply.header("set-cookie", c);

  reply.code(upstreamRes.status);

  const body = Buffer.from(await upstreamRes.arrayBuffer());
  // Fastify stamps a content-type on any payload it serializes. Upstream responses that carry NONE
  // — the /metrics 404, empty error bodies — would come back with one invented by the proxy, which
  // the Phase 5 differ caught as `keys differ ... got [.., content-type]`. Send nothing at all when
  // there was nothing, so a header the origin never set is never manufactured.
  if (!upstreamRes.headers.has("content-type")) {
    reply.removeHeader("content-type");
    return body.length === 0 ? reply.send() : reply.send(body);
  }
  return reply.send(body);
}

/** Started directly (not imported by a test) — mirrors the isMain gate in ml-inference/server.mjs. */
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const upstream = process.env.PLATFORM_API_UPSTREAM;
  if (!upstream) {
    console.error("PLATFORM_API_UPSTREAM is required and has no default.");
    process.exit(2);
  }
  const [host, port] = (process.env.NODE_API_BIND ?? "127.0.0.1:8099").split(":");
  const ported = new Set(
    (process.env.NODE_API_PORTED ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  for (const p of ported) {
    if (!PORTABLE.includes(p)) {
      console.error(`NODE_API_PORTED names an unportable route: ${p}`);
      process.exit(2);
    }
  }
  const app = buildServer({
    upstream,
    ported,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET ?? "quran-ai-dev-secret",
    allowHeaderAuth: ["1", "true"].includes(process.env.ALLOW_HEADER_AUTH ?? ""),
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? null,
    ticketSecret: process.env.REALTIME_GATEWAY_TICKET_SECRET ?? "smoke-secret",
  });
  app.listen({ host, port: Number(port) }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
