/**
 * Process entrypoint for the Node API.
 *
 * With no upstream it starts the complete standalone registry. An explicit upstream enables the
 * reversible compatibility shell used by parity/canary verification.
 */
import { createApplication } from "./app.mjs";
import {
  ALLOW_INSECURE_SECRETS,
  ALLOW_SUPERUSER_DB_ROLE,
  LEGACY_ONE_ONLY,
  LEGACY_ONE_OR_TRUE,
  insecureSecretProblems,
  relaxed,
} from "./lib/insecure.mjs";
import { installProcessShutdown, parseShutdownGraceSeconds } from "./lib/shutdown.mjs";
import { loadRetainedCanaryRouteKeys } from "./routes/canary.mjs";
import { ROUTES, ROUTE_KEYS } from "./routes/index.mjs";
import { createAudioObjectStoreFromEnv } from "./storage/audio-object-store.mjs";

/** Started directly, never when imported by a test or package consumer. */
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const upstream = process.env.PLATFORM_API_UPSTREAM?.trim() || null;

  const secretProblems = insecureSecretProblems(process.env);
  if (secretProblems.length > 0) {
    for (const problem of secretProblems) console.error(problem);
    console.error(
      `Set ${ALLOW_INSECURE_SECRETS}=1 for local dev only. platform-api refuses the same values.`,
    );
    process.exit(2);
  }

  const [host, port] = (process.env.NODE_API_BIND ?? "127.0.0.1:8099").split(":");
  const rawUpstreamTimeout = process.env.UPSTREAM_TIMEOUT_SECS ?? "60";
  if (!/^[0-9]+$/.test(rawUpstreamTimeout)) {
    console.error(
      `UPSTREAM_TIMEOUT_SECS must be a whole number of seconds, got ${JSON.stringify(rawUpstreamTimeout)}`,
    );
    process.exit(2);
  }
  const upstreamTimeoutSeconds = Number(rawUpstreamTimeout);
  const upstreamTimeoutMs = upstreamTimeoutSeconds * 1000;
  if (
    !Number.isSafeInteger(upstreamTimeoutSeconds) ||
    upstreamTimeoutSeconds <= 0 ||
    !Number.isSafeInteger(upstreamTimeoutMs) ||
    upstreamTimeoutMs > 2_147_483_647
  ) {
    console.error(
      "UPSTREAM_TIMEOUT_SECS must be positive and small enough for a bounded Node AbortSignal",
    );
    process.exit(2);
  }
  let shutdownGraceMs;
  try {
    shutdownGraceMs = parseShutdownGraceSeconds(process.env.SHUTDOWN_GRACE_SECS ?? "8");
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  let audioObjectStore;
  try {
    audioObjectStore = createAudioObjectStoreFromEnv({
      env: process.env,
      production: process.env.NODE_ENV === "production",
    });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const routeMode = process.env.NODE_API_ROUTE_MODE?.trim() || "explicit-compatibility";
  if (!["explicit-compatibility", "retained-canary"].includes(routeMode)) {
    console.error("NODE_API_ROUTE_MODE must be explicit-compatibility or retained-canary.");
    process.exit(2);
  }
  const explicitRouteKeys = (process.env.NODE_API_PORTED ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (routeMode === "retained-canary" && explicitRouteKeys.length > 0) {
    console.error("NODE_API_PORTED must be empty when NODE_API_ROUTE_MODE=retained-canary.");
    process.exit(2);
  }
  let compatibilityRouteKeys;
  try {
    compatibilityRouteKeys = new Set(
      routeMode === "retained-canary"
        ? loadRetainedCanaryRouteKeys(ROUTES)
        : explicitRouteKeys,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (!upstream && compatibilityRouteKeys.size > 0) {
    console.error("NODE_API_PORTED is compatibility-only and requires PLATFORM_API_UPSTREAM.");
    process.exit(2);
  }

  const rawDeviceIdentityEnabled = process.env.DEVICE_IDENTITY_ENABLED?.trim() ?? "";
  if (!["", "0", "1"].includes(rawDeviceIdentityEnabled)) {
    console.error("DEVICE_IDENTITY_ENABLED must be exactly 1 to enable or 0/unset to disable.");
    process.exit(2);
  }
  const deviceIdentityEnabled = rawDeviceIdentityEnabled === "1";
  for (const route of compatibilityRouteKeys) {
    if (!ROUTE_KEYS.includes(route)) {
      console.error(`NODE_API_PORTED names an unknown executable route: ${route}`);
      process.exit(2);
    }
  }

  const trustProxyHeaders = ["1", "true"].includes(process.env.TRUST_PROXY_HEADERS ?? "");
  const rawTrustedProxyHops = process.env.TRUST_PROXY_HOPS?.trim() ?? "";
  if (!trustProxyHeaders && rawTrustedProxyHops !== "") {
    console.error("TRUST_PROXY_HOPS requires TRUST_PROXY_HEADERS=1 or true.");
    process.exit(2);
  }
  let trustedProxyHops = 0;
  if (trustProxyHeaders) {
    const raw = rawTrustedProxyHops || "1";
    if (!/^[0-9]+$/.test(raw)) {
      console.error(`TRUST_PROXY_HOPS must be a positive whole number, got ${JSON.stringify(raw)}`);
      process.exit(2);
    }
    trustedProxyHops = Number(raw);
    if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 1 || trustedProxyHops > 32) {
      console.error("TRUST_PROXY_HOPS must be between 1 and 32.");
      process.exit(2);
    }
  }

  const app = createApplication({
    upstream,
    compatibilityRouteKeys,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET ?? "quran-ai-dev-secret",
    allowHeaderAuth: ["1", "true"].includes(process.env.ALLOW_HEADER_AUTH ?? ""),
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? null,
    ticketSecret: process.env.REALTIME_GATEWAY_TICKET_SECRET ?? "smoke-secret",
    metricsToken: process.env.METRICS_TOKEN ? process.env.METRICS_TOKEN : null,
    metricsDevOpen: relaxed("METRICS_DEV_OPEN", LEGACY_ONE_ONLY),
    enforceRestrictedDbRole: !relaxed(ALLOW_SUPERUSER_DB_ROLE, LEGACY_ONE_OR_TRUE),
    deviceIdentityEnabled,
    maintenanceMode: ["1", "true"].includes(process.env.MAINTENANCE_MODE ?? ""),
    // Preserve Rust's exact compatibility switch: only literal "1" disables admission.
    rateLimitEnabled: process.env.DISABLE_RATE_LIMIT !== "1",
    // Proof-only ownership marker. It is absent in standalone and ordinary compatibility modes,
    // so the normal public wire contract does not acquire a migration-internal header.
    canaryProofHeaders: routeMode === "retained-canary",
    trustedProxyHops,
    mlInferenceUrl: process.env.ML_INFERENCE_URL || "http://127.0.0.1:8098",
    mlApiKey: process.env.ML_API_KEY || "smoke-ml-api-key",
    asrInferenceUrl: process.env.ASR_INFERENCE_URL || "http://127.0.0.1:8091",
    asrApiKey: process.env.ASR_API_KEY || "smoke-asr-api-key",
    audioObjectStore,
    upstreamTimeoutMs,
    shutdownGraceMs,
  });
  const shutdown = installProcessShutdown(app, { graceMs: shutdownGraceMs });
  app.listen({ host, port: Number(port) }).catch((error) => {
    console.error(error);
    void shutdown.shutdown("startup-error", { exitCode: 1 });
  });
}
