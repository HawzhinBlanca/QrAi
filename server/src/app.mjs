/**
 * Side-effect-free Fastify composition for the Node API.
 * specs/node-backend-port/plan.md §3 · specs/migration-completion/plan.md §2 (N7)
 *
 *   standalone:   client ──► every executable route ──► Node/Postgres
 *   compatibility: client ──┬── selected local route ──► Node/Postgres
 *                            └── everything else ───────► explicit Rust oracle/canary
 *
 * No upstream is the production-shaped default and cannot proxy. Supplying an upstream explicitly
 * enables the reversible compatibility shell used by parity and canary verification.
 *
 * N7 moved the handlers into `routes/` and the forwarder into `lib/proxy.mjs`. What is left here is
 * exactly the shell: config, middleware order, registration, the catch-all, and error shaping.
 *
 * Process environment parsing and socket ownership live in `main.mjs`; importing this module never
 * binds a port. That keeps construction injectable while the strangler remains reversible.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createJobStore } from "./jobs/store.mjs";
import { createTokenBucketLimiter } from "./lib/admission.mjs";
import { ApiError } from "./lib/authz.mjs";
import { createDb } from "./lib/db.mjs";
import { createIncomingRequestDeadline, isDeadlineError } from "./lib/deadline.mjs";
import { stringifyRust } from "./lib/json.mjs";
import { createMetrics } from "./lib/metrics.mjs";
import { proxy } from "./lib/proxy.mjs";
import { shutdownPhases } from "./lib/shutdown.mjs";
import { ROUTES, ROUTE_KEYS, fastifyPath } from "./routes/index.mjs";

export function createApplication(config) {
  const {
    upstream,
    compatibilityRouteKeys = new Set(),
    databaseUrl,
    jwtSecret = "quran-ai-dev-secret",
    allowHeaderAuth = false,
    corsAllowedOrigins = null,
    ticketSecret = "smoke-secret",
    metricsToken = null,
    metricsDevOpen = false,
    enforceRestrictedDbRole = true,
    deviceIdentityEnabled = false,
    maintenanceMode = false,
    rateLimitEnabled = true,
    canaryProofHeaders = false,
    trustedProxyHops = 0,
    rateLimitOptions = {},
    // lib.rs:79-82 — same names, same defaults.
    mlInferenceUrl = "http://127.0.0.1:8098",
    mlApiKey = "smoke-ml-api-key",
    asrInferenceUrl = "http://127.0.0.1:8091",
    asrApiKey = "smoke-asr-api-key",
    audioObjectStore = null,
    upstreamTimeoutMs = 60_000,
    shutdownGraceMs = 8_000,
    logger = false,
  } = config;

  if (!(compatibilityRouteKeys instanceof Set)) {
    throw new TypeError("createApplication: compatibilityRouteKeys must be a Set");
  }
  if (!upstream && compatibilityRouteKeys.size > 0) {
    throw new TypeError("createApplication: compatibilityRouteKeys requires an upstream");
  }
  for (const routeKey of compatibilityRouteKeys) {
    if (!ROUTE_KEYS.includes(routeKey)) {
      throw new TypeError(`createApplication: unknown executable route ${routeKey}`);
    }
  }
  if (
    !Number.isSafeInteger(upstreamTimeoutMs) ||
    upstreamTimeoutMs <= 0 ||
    upstreamTimeoutMs > 2_147_483_647
  ) {
    throw new TypeError("createApplication: upstreamTimeoutMs must be a positive whole number");
  }
  let shutdown;
  try {
    shutdown = shutdownPhases(shutdownGraceMs);
  } catch (error) {
    throw new TypeError(`createApplication: ${error.message}`);
  }
  if (typeof maintenanceMode !== "boolean") {
    throw new TypeError("createApplication: maintenanceMode must be boolean");
  }
  if (typeof enforceRestrictedDbRole !== "boolean") {
    throw new TypeError("createApplication: enforceRestrictedDbRole must be boolean");
  }
  if (typeof deviceIdentityEnabled !== "boolean") {
    throw new TypeError("createApplication: deviceIdentityEnabled must be boolean");
  }
  if (typeof rateLimitEnabled !== "boolean") {
    throw new TypeError("createApplication: rateLimitEnabled must be boolean");
  }
  if (typeof canaryProofHeaders !== "boolean") {
    throw new TypeError("createApplication: canaryProofHeaders must be boolean");
  }
  if (canaryProofHeaders && !upstream) {
    throw new TypeError("createApplication: canaryProofHeaders requires an upstream");
  }
  if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 32) {
    throw new TypeError("createApplication: trustedProxyHops must be a whole number from 0 to 32");
  }
  if (rateLimitOptions === null || typeof rateLimitOptions !== "object" || Array.isArray(rateLimitOptions)) {
    throw new TypeError("createApplication: rateLimitOptions must be an object");
  }
  if (
    audioObjectStore !== null &&
    (!audioObjectStore ||
      typeof audioObjectStore.get !== "function" ||
      typeof audioObjectStore.listLearner !== "function" ||
      typeof audioObjectStore.deleteLearner !== "function" ||
      typeof audioObjectStore.assertReady !== "function" ||
      typeof audioObjectStore.close !== "function")
  ) {
    throw new TypeError("createApplication: audioObjectStore does not implement the storage boundary");
  }

  const enabledRoutes = ROUTES.filter(
    (route) => route.ownerGate === undefined ||
      (route.ownerGate === "device-identity" && deviceIdentityEnabled),
  );
  const enabledRouteKeys = new Set(enabledRoutes.map((route) => route.key));
  for (const route of ROUTES) {
    if (route.ownerGate !== undefined && route.ownerGate !== "device-identity") {
      throw new TypeError(`createApplication: unknown owner gate ${route.ownerGate}`);
    }
  }
  if (upstream) {
    for (const routeKey of compatibilityRouteKeys) {
      if (!enabledRouteKeys.has(routeKey)) {
        throw new TypeError(`createApplication: owner-gated route is disabled: ${routeKey}`);
      }
    }
  }

  const apiMode = upstream ? "compatibility" : "standalone";
  const localRouteKeys = upstream ? compatibilityRouteKeys : enabledRouteKeys;
  const app = Fastify({
    logger,
    bodyLimit: 2 * 1024 * 1024,
    // Keep active requests alive for the process controller's drain phase. On pinned Fastify 5.11,
    // the native-server close branch treats the documented `"idle"` value as truthy and invokes
    // closeAllConnections(), dropping active requests. `false` delegates idle reaping to Node 22's
    // server.close(); the process controller alone owns timed active-socket destruction.
    forceCloseConnections: false,
    return503OnClosing: true,
    // Zero ignores every forwarded identity header. A positive count trusts only that many nearest
    // hops; process startup makes the opt-in explicit and refuses inert/invalid hop configuration.
    trustProxy: trustedProxyHops === 0 ? false : trustedProxyHops,
  });
  const db = localRouteKeys.size > 0 && databaseUrl
      ? createDb(databaseUrl, {
        closeTimeoutMs: shutdown.resourceCloseMs,
        statementTimeoutMs: Math.min(10_000, upstreamTimeoutMs),
        // postgres.js exposes connect_timeout in whole seconds. Round up so a sub-second request
        // still has a connection attempt, but never retain the old independent 10-second default.
        connectTimeout: Math.max(1, Math.min(10, Math.ceil(upstreamTimeoutMs / 1_000))),
      })
    : null;
  const metrics = createMetrics();
  const rateLimiter = rateLimitEnabled ? createTokenBucketLimiter(rateLimitOptions) : null;
  const jobStore = db ? createJobStore({ db }) : null;

  if (db) {
    // `onReady` completes before Fastify binds a listening socket. A privileged connection makes
    // forced RLS an illusion, so it is a boot failure rather than a degraded readiness state.
    if (enforceRestrictedDbRole) {
      app.addHook("onReady", async () => db.assertRestrictedRole());
    }
    app.addHook("onClose", async () => db.end());
  }
  if (audioObjectStore) {
    app.addHook("onReady", async () => audioObjectStore.assertReady());
    app.addHook("onClose", async () => audioObjectStore.close());
  }

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
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.decorateRequest("deadline", null);
  app.addHook("onRequest", async (req, reply) => {
    req.deadline = createIncomingRequestDeadline(req.raw, reply.raw, upstreamTimeoutMs);
  });

  // CORS is registered first and can end a valid preflight before these hooks spend capacity.
  // Maintenance is next: it is an operational kill switch, so blocked work neither authenticates
  // nor consumes a rate token. Its three exact probes continue into admission and their handlers.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?", 1)[0];
    if (maintenanceMode && !["/health", "/ready", "/metrics"].includes(path)) {
      return reply.code(503).send({ error: "service is in maintenance" });
    }
  });

  // Authorization is deliberately later, inside handlers. Admission never trusts caller-supplied
  // role/tenant data and uses only Fastify's peer/trusted-hop IP resolution.
  app.addHook("onRequest", async (req, reply) => {
    if (!rateLimiter) return;
    const decision = rateLimiter.consume(req.ip);
    if (!decision.allowed) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
      return reply.code(429).send({ error: "rate limit exceeded" });
    }
  });

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
    if (canaryProofHeaders) {
      reply.header("x-qrai-route-owner", servedLocally ? "node-local" : "rust-compatibility");
    }
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

  // ── Local routes ──────────────────────────────────────────────────────────────────────────────
  // `ctx` is built once and closed over. Handlers take it as a third argument rather than reaching
  // for module state, so a handler is testable with a stub db and no server at all.
  // `pilotAllowedOrigins` is the SAME allowlist CORS uses — Rust reads CORS_ALLOWED_ORIGINS for
  // both (auth.rs:40). Passing the parsed list rather than the raw string keeps one parse.
  const ctx = {
    db, jwtSecret, allowHeaderAuth, ticketSecret, upstream,
    metrics, metricsToken, metricsDevOpen,
    pilotAllowedOrigins: allowList,
    mlInferenceUrl, mlApiKey, asrInferenceUrl, asrApiKey, upstreamTimeoutMs, audioObjectStore,
    jobStore,
  };
  for (const route of ROUTES) {
    if (!localRouteKeys.has(route.key)) continue;
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
      (req, reply) => route.handler(req, reply, {
        ...ctx,
        deadline: req.deadline,
        db: db?.forDeadline(req.deadline) ?? null,
      }),
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

  // ── Explicit compatibility fallback ───────────────────────────────────────────────────────────
  // Only compatibility mode owns a catch-all. Standalone deliberately keeps Fastify's local 404,
  // so an unrecognised path cannot acquire a hidden Rust dependency.
  //
  // The first attempt also registered `app.all("/*")`, which Fastify rejected at boot with
  // FST_ERR_DUPLICATED_ROUTE — `all` registers GET, Fastify auto-adds HEAD for GET, and `all`
  // registers HEAD too. That is the boot-time duplicate detection §2.1 chose Fastify for, catching a
  // real bug on its first run rather than serving one handler and silently dropping the other.
  if (upstream) app.setNotFoundHandler((req, reply) => proxy(req, reply, upstream));

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
const SQLSTATE_QUERY_CANCELLED = "57014";

// Only framework errors whose public wording is fixed here may use a framework-supplied status.
// An arbitrary dependency error can carry `statusCode`; trusting that property would turn a secret
// connection/detail message into a public 5xx response and bypass the generic redaction branch.
const PUBLIC_FASTIFY_ERRORS = new Map([
  ["FST_ERR_CTP_BODY_TOO_LARGE", { status: 413, message: "Request body is too large" }],
  ["FST_ERR_CTP_INVALID_MEDIA_TYPE", { status: 415, message: "Unsupported Media Type" }],
]);

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
    const publicFastifyError = PUBLIC_FASTIFY_ERRORS.get(err?.code);
    if (publicFastifyError) {
      return reply
        .code(publicFastifyError.status)
        .send({ error: publicFastifyError.message });
    }
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
    if (err?.code === SQLSTATE_QUERY_CANCELLED) {
      reply.header("retry-after", "1");
      return reply.code(503).send({ error: "database operation timed out" });
    }
    if (isDeadlineError(err)) {
      reply.header("retry-after", "1");
      return reply.code(503).send({ error: "dependency operation timed out" });
    }
    reply.code(500).send({ error: "internal error" });
  });

  app.decorate("apiMode", apiMode);
  app.decorate("localRouteKeys", [...localRouteKeys]);
  return app;
}
