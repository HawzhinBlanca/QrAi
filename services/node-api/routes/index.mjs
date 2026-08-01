/**
 * N7 — the route table.
 * specs/migration-completion/plan.md §2
 *
 * Before this, every ported route was its own `if (ported.has("...")) { app.get(...) }` block inside
 * `buildServer`. That is fine for two routes and unmaintainable for thirty-eight: the registration,
 * the `PORTABLE` allowlist and the handler body all had to be kept in agreement by hand, in three
 * places, with nothing checking that they were.
 *
 * ── `path` is NOT `key.split(" ")[1]` ───────────────────────────────────────────────────────────
 * Axum 0.8 writes path parameters `{id}`; Fastify writes them `:id`. The `key` is the AXUM/contract
 * form, because that is what `NODE_API_PORTED`, `PORTABLE`, `specs/flutter-client/openapi.yaml` and
 * `scripts/cutover-readiness.mjs`'s route pairs all speak. `path` is the Fastify form, derived once
 * here by `fastifyPath()` rather than transcribed — a hand-written second copy of 38 paths is 38
 * chances to typo a route into never being served, which looks exactly like a route that proxies.
 */
import { health, metrics, ready } from "./infra.mjs";
import { getLearnerProgress, getWeeklyProgress, updateProgress } from "./progress.mjs";
import { getAyah, getSurah, listSurahs } from "./quran.mjs";
import { createRealtimeTicket } from "./recitation.mjs";

/** `/v1/x/{id}/y` → `/v1/x/:id/y`. Axum 0.8 → Fastify. */
export function fastifyPath(axumPath) {
  return axumPath.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Every route this service is CAPABLE of serving locally.
 *
 * Being in this table does not serve it: `NODE_API_PORTED` must name the key, and its default is
 * empty. Handlers are `(req, reply, ctx)`; `ctx` carries `{ db, jwtSecret, allowHeaderAuth,
 * ticketSecret, upstream }`.
 */
export const ROUTES = [
  // ── N8: infra. No actor — an orchestrator healthcheck has no credentials. ───────────────────
  { key: "GET /health", method: "get", path: "/health", handler: health },
  { key: "GET /ready", method: "get", path: "/ready", handler: ready },
  { key: "GET /metrics", method: "get", path: "/metrics", handler: metrics },
  // ── N9: canonical Quran. Public, and NOT tenant-scoped — these are global reference tables. ──
  { key: "GET /v1/quran/surahs", method: "get", path: "/v1/quran/surahs", handler: listSurahs },
  {
    key: "GET /v1/quran/surahs/{surah_number}",
    method: "get",
    path: "/v1/quran/surahs/{surah_number}",
    handler: getSurah,
  },
  {
    key: "GET /v1/quran/ayahs/{surah_number}/{ayah_number}",
    method: "get",
    path: "/v1/quran/ayahs/{surah_number}/{ayah_number}",
    handler: getAyah,
  },
  {
    key: "GET /v1/learner/progress",
    method: "get",
    path: "/v1/learner/progress",
    handler: getLearnerProgress,
  },
  // ── N10: progress writes. The POST is the first ported route that MUTATES. ──────────────────
  {
    key: "POST /v1/learner/progress",
    method: "post",
    path: "/v1/learner/progress",
    handler: updateProgress,
  },
  {
    key: "GET /v1/learner/progress/weekly",
    method: "get",
    path: "/v1/learner/progress/weekly",
    handler: getWeeklyProgress,
  },
  {
    key: "POST /v1/realtime-session-tickets",
    method: "post",
    path: "/v1/realtime-session-tickets",
    handler: createRealtimeTicket,
  },
];
