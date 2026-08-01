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
import { createDb } from "./lib/db.mjs";
import { LEGACY_ONE_ONLY, relaxed } from "./lib/insecure.mjs";
import { stringifyRust } from "./lib/json.mjs";
import { createMetrics } from "./lib/metrics.mjs";
import { proxy } from "./lib/proxy.mjs";
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
  "GET /v1/quran/surahs",
  "GET /v1/quran/surahs/{surah_number}",
  "GET /v1/quran/ayahs/{surah_number}/{ayah_number}",
  "GET /v1/learner/progress",
  "POST /v1/learner/progress",
  "GET /v1/learner/progress/weekly",
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
  const VARY = "origin, access-control-request-method, access-control-request-headers";
  app.addHook("onSend", (_req, reply, payload, done) => {
    if (!reply.hasHeader("vary")) reply.header("vary", VARY);
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
  const ctx = { db, jwtSecret, allowHeaderAuth, ticketSecret, upstream, metrics, metricsToken, metricsDevOpen };
  for (const route of ROUTES) {
    if (!ported.has(route.key)) continue;
    // `config.axumPath` carries the AXUM spelling of the path (`{id}`) so the metrics label matches
    // Rust's. Fastify's own `routeOptions.url` is the `:id` form, which would silently produce a
    // second, differently-named series for the same endpoint on a scrape of the two processes.
    app[route.method](
      fastifyPath(route.path),
      { config: { axumPath: route.path } },
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
    // Mirrors lib.rs:84-96. An EMPTY METRICS_TOKEN counts as unset — docker-compose.yml passes
    // variables through as `"${FOO:-}"`, so treating "" as a configured token would make the gate
    // compare against the empty string and open on a header nobody sent.
    metricsToken: process.env.METRICS_TOKEN ? process.env.METRICS_TOKEN : null,
    metricsDevOpen: relaxed("METRICS_DEV_OPEN", LEGACY_ONE_ONLY),
  });
  app.listen({ host, port: Number(port) }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
