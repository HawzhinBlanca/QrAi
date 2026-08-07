/**
 * Process entrypoint for the Node API strangler.
 *
 * Environment parsing, security refusal, portable-route validation, and socket binding live here;
 * Fastify composition remains side-effect-free in `app.mjs`.
 */
import { createApplication } from "./app.mjs";
import {
  ALLOW_INSECURE_SECRETS,
  LEGACY_ONE_ONLY,
  insecureSecretProblems,
  relaxed,
} from "./lib/insecure.mjs";

/**
 * Route keys that MAY be served locally. Nothing is ported unless NODE_API_PORTED names it.
 *
 * This is deliberately a literal. `scripts/cutover-readiness.mjs` and the canonical gate read it
 * as text, while `routes-table.test.mjs` proves it cannot drift from the executable route table.
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

/** Started directly, never when imported by a test or package consumer. */
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const upstream = process.env.PLATFORM_API_UPSTREAM;
  if (!upstream) {
    console.error("PLATFORM_API_UPSTREAM is required and has no default.");
    process.exit(2);
  }

  const secretProblems = insecureSecretProblems(process.env);
  if (secretProblems.length > 0) {
    for (const problem of secretProblems) console.error(problem);
    console.error(
      `Set ${ALLOW_INSECURE_SECRETS}=1 for local dev only. platform-api refuses the same values.`,
    );
    process.exit(2);
  }

  const [host, port] = (process.env.NODE_API_BIND ?? "127.0.0.1:8099").split(":");
  const ported = new Set(
    (process.env.NODE_API_PORTED ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );
  for (const route of ported) {
    if (!PORTABLE.includes(route)) {
      console.error(`NODE_API_PORTED names an unportable route: ${route}`);
      process.exit(2);
    }
  }

  const app = createApplication({
    upstream,
    ported,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET ?? "quran-ai-dev-secret",
    allowHeaderAuth: ["1", "true"].includes(process.env.ALLOW_HEADER_AUTH ?? ""),
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? null,
    ticketSecret: process.env.REALTIME_GATEWAY_TICKET_SECRET ?? "smoke-secret",
    metricsToken: process.env.METRICS_TOKEN ? process.env.METRICS_TOKEN : null,
    metricsDevOpen: relaxed("METRICS_DEV_OPEN", LEGACY_ONE_ONLY),
    mlInferenceUrl: process.env.ML_INFERENCE_URL || "http://127.0.0.1:8090",
    mlApiKey: process.env.ML_API_KEY || "smoke-ml-api-key",
    asrInferenceUrl: process.env.ASR_INFERENCE_URL || "http://127.0.0.1:8091",
    asrApiKey: process.env.ASR_API_KEY || "smoke-asr-api-key",
  });
  app.listen({ host, port: Number(port) }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
