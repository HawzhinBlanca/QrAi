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
import { issueToken } from "./auth.mjs";
import { health, metrics, ready } from "./infra.mjs";
import { asrForceAlign, asrTranscribe, predictAlignment, predictTajweed } from "./ml-proxy.mjs";
import { bootstrap, logout, mintInvitation } from "./pilot.mjs";
import { getLearnerProgress, getWeeklyProgress, updateProgress } from "./progress.mjs";
import { getAyah, getSurah, listSurahs } from "./quran.mjs";
import { getEvalRun, listAgentRuns, listAuditEvents } from "./reports.mjs";
import { createRealtimeTicket } from "./recitation.mjs";
import { createScholarApproval, createTeacherReview, listScholarApprovals, listTajweedFindings, listTeacherReviewQueue } from "./review.mjs";
import { createSession, persistSessionAlignments, requestTeacherReview } from "./session-writes.mjs";
import { getSession, listActiveLearners, listSessionAlignments, listSessions } from "./sessions.mjs";

/**
 * Axum 0.8 path → Fastify path.
 *
 * Two transformations, and the second one is not cosmetic:
 *
 * 1. `{id}` → `:id`. The parameter syntax differs between the routers.
 * 2. A LITERAL colon → `::`. `/v1/ml/alignments:predict` is an axum action route where the colon is
 *    part of the path. Fastify's router (find-my-way) reads `:name` as a PARAMETER, so registering
 *    that path verbatim ALSO matches `/v1/ml/alignmentsXYZ` — the real handler serving a path the
 *    contract never mentions. Measured: the near-miss test in `ml-asr-proxy-parity` went red on the
 *    first ported run, and `::` is find-my-way's escape for a literal colon.
 *
 * Order matters: the parameter substitution runs FIRST, so the `:` it introduces is not then
 * escaped as a literal.
 */
export function fastifyPath(axumPath) {
  const parts = axumPath.split(/(\{[^}]+\})/);
  return parts
    .map((part) =>
      part.startsWith("{") && part.endsWith("}")
        ? `:${part.slice(1, -1)}`
        : part.replaceAll(":", "::"),
    )
    .join("");
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
  // ── N12a: mint a JWT for an existing user. admin/ops only. ──────────────────────────────────
  { key: "POST /v1/auth/token", method: "post", path: "/v1/auth/token", handler: issueToken },
  // ── N13b: pilot sessions. The cookie ATTRIBUTES are the contract, not just the value. ───────
  {
    key: "POST /v1/pilot/session/bootstrap",
    method: "post",
    path: "/v1/pilot/session/bootstrap",
    handler: bootstrap,
  },
  {
    key: "POST /v1/pilot/session/logout",
    method: "post",
    path: "/v1/pilot/session/logout",
    handler: logout,
  },
  {
    key: "POST /v1/pilot/invitations",
    method: "post",
    path: "/v1/pilot/invitations",
    handler: mintInvitation,
  },
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
  // ── N11: read-only reporting. Three routes, three DIFFERENT staff role lists. ───────────────
  { key: "GET /v1/agent-runs", method: "get", path: "/v1/agent-runs", handler: listAgentRuns },
  { key: "GET /v1/audit-events", method: "get", path: "/v1/audit-events", handler: listAuditEvents },
  {
    key: "GET /v1/eval-runs/{model_version}",
    method: "get",
    path: "/v1/eval-runs/{model_version}",
    handler: getEvalRun,
  },
  // ── N14a: recitation READS. The three writes are N14b. ──────────────────────────────────────
  { key: "GET /v1/recitation-sessions", method: "get", path: "/v1/recitation-sessions", handler: listSessions },
  {
    key: "GET /v1/recitation-sessions/{id}",
    method: "get",
    path: "/v1/recitation-sessions/{id}",
    handler: getSession,
  },
  {
    key: "GET /v1/recitation-sessions/{id}/alignments",
    method: "get",
    path: "/v1/recitation-sessions/{id}/alignments",
    handler: listSessionAlignments,
  },
  { key: "GET /v1/learners/active", method: "get", path: "/v1/learners/active", handler: listActiveLearners },
  // ── N14b: recitation WRITES. Consent capture, FK ordering, provenance, and a cascade. ───────
  { key: "POST /v1/recitation-sessions", method: "post", path: "/v1/recitation-sessions", handler: createSession },
  {
    key: "POST /v1/recitation-sessions/{id}/alignments",
    method: "post",
    path: "/v1/recitation-sessions/{id}/alignments",
    handler: persistSessionAlignments,
  },
  {
    key: "POST /v1/recitation-sessions/{id}/request-teacher-review",
    method: "post",
    path: "/v1/recitation-sessions/{id}/request-teacher-review",
    handler: requestTeacherReview,
  },
  // ── N15: the review gates. Two of these five are where the AI-feedback rule refuses. ────────
  { key: "GET /v1/tajweed-findings", method: "get", path: "/v1/tajweed-findings", handler: listTajweedFindings },
  { key: "POST /v1/teacher-reviews", method: "post", path: "/v1/teacher-reviews", handler: createTeacherReview },
  {
    key: "GET /v1/teacher-review-queue",
    method: "get",
    path: "/v1/teacher-review-queue",
    handler: listTeacherReviewQueue,
  },
  { key: "GET /v1/scholar-approvals", method: "get", path: "/v1/scholar-approvals", handler: listScholarApprovals },
  { key: "POST /v1/scholar-approvals", method: "post", path: "/v1/scholar-approvals", handler: createScholarApproval },
  // ── N16: ML/ASR proxies. The two ASR routes carry audio, so they raise the body limit. ──────
  {
    key: "POST /v1/ml/alignments:predict",
    method: "post",
    path: "/v1/ml/alignments:predict",
    handler: predictAlignment,
  },
  {
    key: "POST /v1/ml/tajweed-findings:predict",
    method: "post",
    path: "/v1/ml/tajweed-findings:predict",
    handler: predictTajweed,
  },
  {
    key: "POST /v1/asr/transcribe",
    method: "post",
    path: "/v1/asr/transcribe",
    handler: asrTranscribe,
    // lib.rs:283 — DefaultBodyLimit::max(16 MB). A few minutes of 16 kHz mono base64 WAV. Every
    // other route keeps the 2 MB default.
    bodyLimit: 16 * 1024 * 1024,
  },
  {
    key: "POST /v1/asr/force-align",
    method: "post",
    path: "/v1/asr/force-align",
    handler: asrForceAlign,
    bodyLimit: 16 * 1024 * 1024,
  },
  {
    key: "POST /v1/realtime-session-tickets",
    method: "post",
    path: "/v1/realtime-session-tickets",
    handler: createRealtimeTicket,
  },
];
