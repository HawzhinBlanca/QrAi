/**
 * N8 — liveness, readiness, and the metrics scrape.
 * Port of services/platform-api/src/lib.rs:381-450.
 *
 * These three are the only routes in the whole API with no actor: `resolveActor` is never called,
 * because an orchestrator's healthcheck has no credentials and /metrics has its own gate.
 */
import { metricsAccessAllowed } from "../lib/metrics.mjs";

/**
 * GET /health — liveness. lib.rs:381
 *
 * `(StatusCode::OK, "ok")`: axum's `IntoResponse` for `&str` sets `text/plain; charset=utf-8`, so
 * the type is set explicitly here. Fastify would otherwise stamp `application/json` on a string
 * payload and the A/B would catch it as a header difference — which it did, on the first run.
 */
export async function health(_req, reply) {
  return reply.code(200).type("text/plain; charset=utf-8").send("ok");
}

/**
 * GET /ready — readiness, distinct from liveness. lib.rs:389
 *
 * The process can actually SERVE, i.e. its DB pool answers. 503 when Postgres is unreachable so
 * orchestrators can tell "process up" from "up but every request will fail": during a DB outage
 * /health stays 200 while /ready correctly goes 503 (P3.6).
 *
 * A missing pool is `not ready`, not a crash. Rust cannot reach this state — its pool is built at
 * boot or the process exits — but the shell builds one only when routes are ported, so the case is
 * reachable here and must fail in the same direction.
 */
export async function ready(_req, reply, ctx) {
  const send = (code, text) => reply.code(code).type("text/plain; charset=utf-8").send(text);
  if (!ctx.db) return send(503, "not ready");
  try {
    await ctx.db.sql`SELECT 1`;
    return send(200, "ready");
  } catch {
    // Deliberately no detail: the reason a database is unreachable is topology, and this endpoint
    // is reachable without credentials.
    return send(503, "not ready");
  }
}

/**
 * GET /metrics — Prometheus scrape. lib.rs:423
 *
 * 404, not 401/403, when access is refused. That is existence-hiding and it is the point: metrics
 * must never be public by default.
 */
export async function metrics(req, reply, ctx) {
  if (!metricsAccessAllowed(ctx, req.headers)) {
    // `.send()` with no payload: Rust returns StatusCode::NOT_FOUND with an EMPTY body and no
    // content-type. Sending `{ error: ... }` here would be a friendlier 404 that the differ
    // correctly rejects.
    reply.removeHeader("content-type");
    return reply.code(404).send();
  }
  return reply
    .code(200)
    .type("text/plain; version=0.0.4; charset=utf-8")
    .send(ctx.metrics.render());
}
