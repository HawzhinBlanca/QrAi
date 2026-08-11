/**
 * The strangler shell.
 * specs/node-backend-port/plan.md §3 · specs/migration-completion/plan.md §2 (N7)
 *
 *   client ──► THIS ──┬── ported route  ──► Postgres
 *                     └── everything else ──► Rust platform-api, verbatim
 *
 * Every route not named in `NODE_API_PORTED` is proxied unchanged. That is what makes each step of
 * the port independently reversible: backing a route out is deleting one entry, not redeploying a
 * rewrite.
 *
 * N7 moved the handlers into `routes/` and the forwarder into `lib/proxy.mjs`. What is left here is
 * exactly the shell: config, middleware order, registration, the catch-all, and error shaping.
 *
 * Env:
 *   PLATFORM_API_UPSTREAM   REQUIRED, no default — the Rust service to proxy to.
 *   NODE_API_BIND           host:port to listen on (default 127.0.0.1:8099)
 *   NODE_API_PORTED         comma-separated route keys to serve locally (default: NONE)
 * plus the same DATABASE_URL / JWT_SECRET / ALLOW_HEADER_AUTH / CORS_ALLOWED_ORIGINS the Rust
 * service reads, so the two can be started from one environment.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";

import { ApiError } from "./lib/authz.mjs";
import { createDb, superuserRoleProblem } from "./lib/db.mjs";
import {
  ALLOW_INSECURE_SECRETS,
  ALLOW_SUPERUSER_DB_ROLE,
  LEGACY_ONE_ONLY,
  LEGACY_ONE_OR_TRUE,
  insecureSecretProblems,
  relaxed,
} from "./lib/insecure.mjs";
import { stringifyRust } from "./lib/json.mjs";
import { createMetrics } from "./lib/metrics.mjs";
import { proxy } from "./lib/proxy.mjs";
import { clientKey, createRateLimiter, sendTooManyRequests } from "./lib/rate-limit.mjs";
import { DEFAULT_UPSTREAM_TIMEOUT_SECS, upstreamTimeoutMs } from "./lib/upstream.mjs";
import { ROUTES, fastifyPath } from "./routes/index.mjs";

/**
 * Route keys that MAY be served locally. Nothing is ported unless NODE_API_PORTED names it.
 *
 * A LITERAL array, deliberately, for two reasons. `scripts/cutover-readiness.mjs:33` reads this file
 * as TEXT and matches `/export const PORTABLE = \[([^\]]*)\]/s`; a computed value
 * (`ROUTES.map(r => r.key)`) makes that regex miss, and the traffic-share check then reports zero
 * portable routes while still exiting 0 — a gate that fails silently open. And an allowlist that
 * derives itself from the handlers says "anything someone wrote a handler for is servable", which is
 * the opposite of what an allowlist is for.
 *
 * `tests/node-api/routes-table.test.mjs` asserts this list and `ROUTES` describe the same set, so
 * the duplication cannot drift — the one thing a hand-maintained list is bad at.
 */
export const PORTABLE = [
  "GET /health",
  "GET /ready",
  "GET /metrics",
  "POST /v1/auth/token",
  "POST /v1/pilot/session/bootstrap",
  "POST /v1/pilot/session/logout",
  "POST /v1/pilot/invitations",
  "GET /v1/quran/surahs",
  "GET /v1/quran/surahs/{surah_number}",
  "GET /v1/quran/ayahs/{surah_number}/{ayah_number}",
  "GET /v1/learner/progress",
  "POST /v1/learner/progress",
  "GET /v1/learner/progress/weekly",
  "GET /v1/agent-runs",
  "POST /v1/agent-runs",
  "GET /v1/audit-events",
  "GET /v1/eval-runs/{model_version}",
  "GET /v1/recitation-sessions",
  "GET /v1/recitation-sessions/{id}",
  "GET /v1/recitation-sessions/{id}/alignments",
  "GET /v1/learners/active",
  "POST /v1/recitation-sessions",
  "POST /v1/recitation-sessions/{id}/alignments",
  "POST /v1/recitation-sessions/{id}/request-teacher-review",
  "GET /v1/tajweed-findings",
  "GET /v1/tajweed-findings/{id}/audio",
  "POST /v1/teacher-reviews",
  "GET /v1/teacher-review-queue",
  "GET /v1/scholar-approvals",
  "POST /v1/scholar-approvals",
  "POST /v1/ml/alignments:predict",
  "POST /v1/ml/tajweed-findings:predict",
  "POST /v1/asr/transcribe",
  "POST /v1/asr/force-align",
  "POST /v1/privacy/export",
  "POST /v1/privacy/delete",
  "POST /v1/realtime-session-tickets",
];

export function buildServer(config) {
  const {
    upstream,
    ported = new Set(),
    databaseUrl,
    jwtSecret = "quran-ai-dev-secret",
    allowHeaderAuth = false,
    corsAllowedOrigins = null,
    ticketSecret = "smoke-secret",
    metricsToken = null,
    metricsDevOpen = false,
    // lib.rs:79-82 — same names, same defaults.
    mlInferenceUrl = "http://127.0.0.1:8090",
    mlApiKey = "smoke-ml-api-key",
    asrInferenceUrl = "http://127.0.0.1:8091",
    asrApiKey = "smoke-asr-api-key",
    // lib.rs `upstream_timeout` — the deadline on every ML/ASR call. Defaulted here rather than
    // read from env, so an embedded test server behaves like the real one without setting anything.
    upstreamTimeout = DEFAULT_UPSTREAM_TIMEOUT_SECS * 1000,
    // lib.rs `maintenance_guard`. Explicit rather than read from process.env here, mirroring Rust's
    // `with_maintenance_mode` — the parallel test suite must not race on a process-wide variable.
    maintenanceMode = false,
    // lib.rs:366's tower_governor layer.
    //
    // Defaults OFF here, which is NOT a weaker default than Rust's — it is the faithful mapping.
    // Rust has two constructors: `platform_router()` reads DISABLE_RATE_LIMIT and defaults ON, and
    // `platform_router_with_rate_limit(state, bool)` takes it explicitly because "tests set it
    // explicitly to avoid process-env races". `buildServer` IS the explicit form; the entry point
    // below is the env-driven one, and that is where the ON default lives.
    rateLimit = false,
    trustProxyHeaders = false,
    logger = false,
  } = config;

  if (!upstream) throw new TypeError("buildServer: upstream is required and has no default");

  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 });
  const db = ported.size > 0 && databaseUrl ? createDb(databaseUrl) : null;
  const metrics = createMetrics();

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

  // ── The maintenance kill-switch, just INSIDE cors ────────────────────────────────────────────
  //
  // lib.rs:427 `maintenance_guard`, which this port did not have. MAINTENANCE_MODE=1 is the
  // documented kill switch (docs/readiness/INVENTORIES.md, P5.5): "every route except /health,
  // /ready, /metrics returns a clean 503", so orchestrators and monitoring read the process as
  // up-in-maintenance rather than crashed.
  //
  // Measured before this existed, both services started with MAINTENANCE_MODE=1 and every portable
  // route enabled:
  //
  //     Rust        /health 200   /v1/quran/surahs 503   /v1/recitation-sessions 503
  //     Node port   /health 200   /v1/quran/surahs 200   /v1/recitation-sessions 200
  //
  // At cutover that is 37 of 42 routes still serving live traffic while `/health` reports
  // up-in-maintenance — a switch that says it worked and stopped nothing, which is worse for an
  // operator mid-incident than having no switch at all.
  //
  // `onRequest` so it short-circuits before any handler AND before the proxy catch-all: an unported
  // route must not be forwarded to a Rust service that is itself in maintenance, and a ported one
  // must not be served. Registered after `cors` so the 503 still carries the browser-readable
  // Access-Control-Allow-Origin header, which is the ordering lib.rs:413 spells out.
  //
  // The body is `{"error":"service is in maintenance"}` — byte-identical to axum's, because the
  // parity differ compares bodies and an "improved" message here is a divergence.
  const MAINTENANCE_EXEMPT = new Set(["/health", "/ready", "/metrics"]);
  if (maintenanceMode) {
    app.addHook("onRequest", (req, reply, done) => {
      // `req.url` carries the query string; the path alone decides, as `req.uri().path()` does.
      const path = req.url.split("?")[0];
      if (MAINTENANCE_EXEMPT.has(path)) return done();
      reply.code(503).header("content-type", "application/json").send({ error: "service is in maintenance" });
    });
  }

  // ── Rate limiting, just inside the kill switch ───────────────────────────────────────────────
  //
  // lib.rs:366's tower_governor layer, which this port did not have. ON by default there;
  // DISABLE_RATE_LIMIT=1 turns it off. POST /v1/auth/token and POST /v1/pilot/session/bootstrap are
  // both PORTABLE, so without this the invitation exchange is brute-forceable at cutover — the
  // throttle silently gone rather than deliberately removed.
  //
  // Order matches lib.rs: CORS outermost (a preflight is never throttled, and a 429 still carries
  // headers the browser can read), then the maintenance kill-switch, then this. Registering the
  // hooks in that sequence IS the ordering — in any Node framework it is otherwise a line-number
  // accident, which is why ordering.test.mjs exists.
  if (rateLimit) {
    const limiter = createRateLimiter();
    app.addHook("onRequest", (req, reply, done) => {
      const verdict = limiter.take(clientKey(req, trustProxyHeaders));
      if (verdict.allowed) return done();
      sendTooManyRequests(reply, verdict.waitSeconds);
    });
  }

  // tower-http's CorsLayer emits `vary` on EVERY response, including a plain GET with no Origin.
  // `@fastify/cors` emits it only on a preflight, so a locally-served response was missing it while
  // a proxied one had it (copied from Rust) — the same endpoint answering differently depending on
  // whether it happened to be ported yet. Found by the N8 A/B differ on its first run against a
  // ported route; it had been true of N4 and N5 since they landed, because nothing had ever
  // compared a locally-served response's HEADERS to Rust's.
  //
  // `hasHeader` guard: on the proxied path the header is already there, and appending would emit it
  // twice.
  //
  // Second divergence in the same place: axum's `Json` responder sets `application/json` with NO
  // charset; Fastify serializes an object as `application/json; charset=utf-8`. JSON is UTF-8 by
  // definition (RFC 8259 §8.1) so nothing MISREADS the body — but it is a different header on every
  // JSON route in the API, and a client with an exact content-type check sees a different service.
  // Found by the N9 differ; like `vary`, it had been true of N4 and N5 since they landed.
  //
  // Rewritten here rather than per-handler so a route added later cannot forget it. The equality
  // test is exact: a handler that deliberately sets some other type keeps it.
  //
  // Third correction, from N13a: `@fastify/cors` DOES emit `vary` — but only `Origin`, and only
  // when an allowlist is configured. A `hasHeader` guard alone therefore left the wrong value in
  // place whenever CORS_ALLOWED_ORIGINS was set, which is every production deploy. tower-http emits
  // the full triple in BOTH configurations.
  //
  // Forced on locally-served responses; PROXIED responses keep whatever upstream sent, verbatim.
  // Overwriting a proxied header with a constant would make the strangler lie about the origin's
  // answer, which is the one thing it must never do. `routeOptions.config.axumPath` is set only on
  // routes this process registered, so it is exactly the "served locally" test.
  const VARY = "origin, access-control-request-method, access-control-request-headers";
  app.addHook("onSend", (req, reply, payload, done) => {
    const servedLocally = Boolean(req.routeOptions?.config?.axumPath);
    if (servedLocally) reply.header("vary", VARY);
    else if (!reply.hasHeader("vary")) reply.header("vary", VARY);
    if (reply.getHeader("content-type") === "application/json; charset=utf-8") {
      reply.header("content-type", "application/json");
    }
    done(null, payload);
  });

  // serde_json keeps a float a float: a whole-number f64 serializes as `100.0`, and
  // JSON.stringify emits `100`. One serializer for every reply, so a handler cannot forget — it
  // only has to wrap the value in `f64()`. Strings and Buffers bypass this, so /health and the
  // Prometheus text are untouched.
  app.setReplySerializer((payload) => stringifyRust(payload));

  // Boot assertion, not a comment: `credentials: true` anywhere in this config is unshippable.
  if (config.corsCredentials === true) {
    throw new Error(
      "CORS credentials are hard-banned (§2.4): combined with a reflected Origin this is CSRF " +
        "against every pilot learner. Remove it rather than making it configurable.",
    );
  }

  // ── Ported routes ─────────────────────────────────────────────────────────────────────────────
  // `ctx` is built once and closed over. Handlers take it as a third argument rather than reaching
  // for module state, so a handler is testable with a stub db and no server at all.
  // `pilotAllowedOrigins` is the SAME allowlist CORS uses — Rust reads CORS_ALLOWED_ORIGINS for
  // both (auth.rs:40). Passing the parsed list rather than the raw string keeps one parse.
  const ctx = {
    db, jwtSecret, allowHeaderAuth, ticketSecret, upstream,
    metrics, metricsToken, metricsDevOpen,
    pilotAllowedOrigins: allowList,
    mlInferenceUrl, mlApiKey, asrInferenceUrl, asrApiKey,
    upstreamTimeout,
  };
  for (const route of ROUTES) {
    if (!ported.has(route.key)) continue;
    // `config.axumPath` carries the AXUM spelling of the path (`{id}`) so the metrics label matches
    // Rust's. Fastify's own `routeOptions.url` is the `:id` form, which would silently produce a
    // second, differently-named series for the same endpoint on a scrape of the two processes.
    app[route.method](
      fastifyPath(route.path),
      {
        config: { axumPath: route.path },
        // Per-route override; the two ASR routes carry audio and raise the 2 MB default to 16 MB,
        // exactly as lib.rs does with DefaultBodyLimit on those two and nothing else.
        ...(route.bodyLimit ? { bodyLimit: route.bodyLimit } : {}),
      },
      (req, reply) => route.handler(req, reply, ctx),
    );
  }

  // Port of `track_metrics` (lib.rs:398). Records EVERY request the shell sees, proxied ones
  // included — and a proxied request has no local route, so it lands under Rust's own fallback
  // label `<unmatched>`. That is not a gap: during the strangler the size of the `<unmatched>`
  // series IS the share of traffic still being forwarded, which is the number a cutover needs.
  //
  // `as_millis() as u64` in Rust TRUNCATES; `Math.floor` matches it. Rounding would put a 4.6ms
  // request in the le="5" bucket on one implementation and the le="10" bucket on the other.
  app.addHook("onResponse", (req, reply, done) => {
    metrics.record(
      req.method,
      req.routeOptions?.config?.axumPath ?? "<unmatched>",
      reply.statusCode,
      Math.floor(reply.elapsedTime),
    );
    done();
  });

  // ── Everything else: proxied verbatim ─────────────────────────────────────────────────────────
  // `setNotFoundHandler` alone IS the strangler catch-all: anything not registered above falls
  // through to it, for every method, with no route to keep in sync.
  //
  // The first attempt also registered `app.all("/*")`, which Fastify rejected at boot with
  // FST_ERR_DUPLICATED_ROUTE — `all` registers GET, Fastify auto-adds HEAD for GET, and `all`
  // registers HEAD too. That is the boot-time duplicate detection §2.1 chose Fastify for, catching a
  // real bug on its first run rather than serving one handler and silently dropping the other.
  app.setNotFoundHandler((req, reply) => proxy(req, reply, upstream, clientKey(req, trustProxyHeaders)));

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

/**
 * The two SQLSTATEs a caller-supplied NUL byte (U+0000) produces, depending on column type:
 *
 *   22021  character_not_in_repertoire  — into `text`:  invalid byte sequence for encoding "UTF8"
 *   22P05  untranslatable_character     — into `jsonb`: unsupported Unicode escape sequence
 *
 * Both, not just the first. `22P05` was added to the Rust original after measuring that the SAME
 * input produces a different code when the column is jsonb — which is why POST /v1/agent-runs with a
 * NUL inside `sources` was the one surface still 500ing after the first fix. The port had neither.
 *
 * ONLY these two, deliberately. SQLSTATE class 22 is "Data Exception", but not every class-22 code
 * is unambiguously caller-supplied: `22003` numeric_value_out_of_range is exactly how the SM-2
 * interval overflow surfaced, and mapping it to 400 would report a SERVER bug as a client error and
 * hide it. These two are safe because nothing in this service emits a NUL byte, so every occurrence
 * is caller-supplied by construction.
 */
const SQLSTATE_NUL_BYTE = new Set(["22021", "22P05"]);

/** postgres.js surfaces the SQLSTATE as `err.code`, the same string Postgres reports. */
function isNulByteError(err) {
  return typeof err?.code === "string" && SQLSTATE_NUL_BYTE.has(err.code);
}

  app.setErrorHandler((err, _req, reply) => {
    // An extractor rejection answers in text/plain, not the JSON error body (see RejectionError).
    if (err instanceof ApiError && err.contentType) {
      return reply.code(err.status).type(err.contentType).send(err.message);
    }
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
    if (isNulByteError(err)) {
      // Mirrors `impl From<sqlx::Error> for ApiError` (platform-api/src/types.rs). A fixed message,
      // NOT the driver's text: a database error can carry table and constraint names and, on a
      // conflict, the offending values — the 500 branch below redacts all of that, and a 400 must
      // not become the way around it. The string is byte-identical to Rust's because the A/B
      // compares response bodies.
      return reply
        .code(400)
        .send({ error: "request contains a NUL byte (U+0000), which cannot be stored" });
    }
    reply.code(500).send({ error: "internal error" });
  });

  app.decorate("portedRoutes", [...ported]);
  // Exposed so the entry point can run the superuser/BYPASSRLS assertion before listening. `null`
  // when nothing is ported: that shell never touches the database.
  app.decorate("db", db);
  return app;
}

/** Started directly (not imported by a test) — mirrors the isMain gate in ml-inference/server.mjs. */
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const upstream = process.env.PLATFORM_API_UPSTREAM;
  if (!upstream) {
    console.error("PLATFORM_API_UPSTREAM is required and has no default.");
    process.exit(2);
  }
  // Before anything binds. `main.rs` ensure_secure_config panics here; this exits 2, matching the
  // other config refusals in this block rather than inventing a second convention.
  const secretProblems = insecureSecretProblems(process.env);
  if (secretProblems.length > 0) {
    for (const p of secretProblems) console.error(p);
    console.error(
      `Set ${ALLOW_INSECURE_SECRETS}=1 for local dev only. platform-api refuses the same values.`,
    );
    process.exit(2);
  }

  // Before anything binds, with the other config refusals. main.rs panics on the same values; this
  // exits 2, the convention this block already uses. Refusing here rather than at the first ML call
  // is the point: a bad timeout is a value nobody chose, and the operator must learn it at boot.
  let upstreamTimeout;
  try {
    upstreamTimeout = upstreamTimeoutMs(process.env);
  } catch (e) {
    console.error(String(e.message));
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
    // Mirrors lib.rs:84-96. An EMPTY METRICS_TOKEN counts as unset — docker-compose.yml passes
    // variables through as `"${FOO:-}"`, so treating "" as a configured token would make the gate
    // compare against the empty string and open on a header nobody sent.
    metricsToken: process.env.METRICS_TOKEN ? process.env.METRICS_TOKEN : null,
    metricsDevOpen: relaxed("METRICS_DEV_OPEN", LEGACY_ONE_ONLY),
    mlInferenceUrl: process.env.ML_INFERENCE_URL || "http://127.0.0.1:8090",
    mlApiKey: process.env.ML_API_KEY || "smoke-ml-api-key",
    asrInferenceUrl: process.env.ASR_INFERENCE_URL || "http://127.0.0.1:8091",
    asrApiKey: process.env.ASR_API_KEY || "smoke-asr-api-key",
    upstreamTimeout,
    // lib.rs:133 — same variable, same accepted values ("1"/"true"), same default.
    maintenanceMode: ["1", "true"].includes(process.env.MAINTENANCE_MODE ?? ""),
    // lib.rs:370 — `.map(|v| v != "1")`, so ONLY the exact string "1" disables it. "true" does
    // NOT, and transcribing this as the usual ["1","true"] would silently leave the limiter off
    // wherever someone set DISABLE_RATE_LIMIT=true expecting it to work like every other flag.
    rateLimit: (process.env.DISABLE_RATE_LIMIT ?? "") !== "1",
    trustProxyHeaders: ["1", "true"].includes(process.env.TRUST_PROXY_HEADERS ?? ""),
  });

  // Defense in depth, BEFORE the socket opens — main.rs:197 does the same and this port did not.
  // A superuser/BYPASSRLS connection makes all 17 tenant-isolation policies inert at once, since
  // each reads `app.is_rls_bypass_enabled() OR tenant_id = app.current_tenant_id()` and the bypass
  // is gated on `rolsuper`.
  //
  // Only when routes are actually PORTED: with none, `db` is null and this process is a pure proxy
  // that never touches the database. Refusing to boot over a role it will not use would be theatre,
  // and would break the zero-ported shell the parity suite runs on every gate.
  if (app.db && !relaxed(ALLOW_SUPERUSER_DB_ROLE, LEGACY_ONE_OR_TRUE)) {
    const problem = await superuserRoleProblem(app.db.sql);
    if (problem) {
      console.error(problem);
      process.exit(2);
    }
  }

  app.listen({ host, port: Number(port) }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
