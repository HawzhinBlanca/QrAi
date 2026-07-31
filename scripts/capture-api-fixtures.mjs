/**
 * F2/F3 — capture golden API fixtures from the running Rust platform-api.
 * specs/api-golden-fixtures/plan.md
 *
 *   FIXTURE_TARGET_URL=http://127.0.0.1:8080 node scripts/capture-api-fixtures.mjs
 *
 * Env:
 *   FIXTURE_TARGET_URL   REQUIRED. No default — see the safety note below.
 *   FIXTURE_OUT          Output path (default: specs/api-golden-fixtures/fixtures/platform-api.json)
 *   FIXTURE_TENANT       Tenant for dev-header auth (default: hikmah-pilot-erbil)
 *
 * ── SAFETY: no default target ───────────────────────────────────────────────────────────────────
 * Same rule as scripts/restore-db.sh. A capture that fell back to a default URL could run against a
 * real environment and write live learner data into a fixture that then gets COMMITTED TO GIT.
 * Unset means exit, never guess.
 *
 * ── What this records, and why each part matters ────────────────────────────────────────────────
 * status  — including the deliberate oddities (/metrics 404-not-401, maintenance 503).
 * headers — only the contractual ones: content-type, CORS, and the __Host- cookie's ATTRIBUTES.
 *           The cookie VALUE is never recorded; the attributes (Secure/HttpOnly/SameSite/Path) are
 *           exactly what a Node port is most likely to get wrong.
 * body    — normalized by F1. Key names and CASING are preserved (the /v1/auth/token snake_case
 *           body is the case a "tidy up the keys" port breaks).
 *
 * The scenario is ORDERED because state is coupled: a session must exist before alignments can be
 * persisted, an invitation before a pilot bootstrap. Order is part of what gets recorded.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalJson, createNormalizer } from "./lib/fixture-normalize.mjs";

const target = process.env.FIXTURE_TARGET_URL;
if (!target) {
  console.error("error: FIXTURE_TARGET_URL is required and has NO default (see the safety note).");
  process.exit(2);
}
const outPath = process.env.FIXTURE_OUT ?? "specs/api-golden-fixtures/fixtures/platform-api.json";
const TENANT = process.env.FIXTURE_TENANT ?? "hikmah-pilot-erbil";

/** Headers worth recording. Everything else (Date, Content-Length, keep-alive) is noise. */
const CONTRACTUAL_HEADERS = [
  "content-type",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "www-authenticate",
];

const normalizer = createNormalizer();
const steps = [];

/** Record the cookie's ATTRIBUTES, never its value. */
function cookieShape(setCookie) {
  if (!setCookie) return undefined;
  const [pair, ...attrs] = setCookie.split(";").map((s) => s.trim());
  const name = pair.split("=")[0];
  return { name, attributes: attrs.map((a) => a.split("=")[0]).sort() };
}

async function step(name, { method = "GET", path, headers = {}, body, expect }) {
  // The auth identity is RECORDED, not re-derived. The differ previously guessed it from the step
  // name, which mis-routed steps and produced false failures — a replay harness must not infer
  // authorization from prose.
  const url = `${target}${path}`;
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`step "${name}" could not reach ${url}: ${err.message}`);
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = raw === "" ? null : JSON.parse(raw);
  } catch {
    // /metrics is Prometheus text, not JSON. Record only its shape, never the values — they are
    // counters that change on every request and would make the fixture non-deterministic.
    parsed = { "<non-json-body>": `${raw.split("\n").length} lines` };
  }

  const recordedHeaders = {};
  for (const h of CONTRACTUAL_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) recordedHeaders[h] = v;
  }
  const cookie = cookieShape(res.headers.get("set-cookie"));
  if (cookie) recordedHeaders["set-cookie"] = cookie;

  steps.push({
    name,
    // Paths carry generated ids too; normalized through the SAME mapping as bodies so a
    // path and a body referencing the same session share a placeholder.
    request: {
      method,
      path: normalizer.normalizePath(path),
      // Recorded verbatim so replay uses the same identity. Contains no secrets: these are dev
      // headers for seeded synthetic users, only usable when ALLOW_HEADER_AUTH is on.
      headers,
      ...(body === undefined ? {} : { body }),
    },
    response: {
      status: res.status,
      headers: recordedHeaders,
      body: normalizer.normalize(parsed),
    },
  });

  if (expect !== undefined && res.status !== expect) {
    throw new Error(
      `step "${name}": expected HTTP ${expect}, got ${res.status}. The API changed, or the ` +
        `scenario is wrong. Refusing to record a fixture that does not match its own expectation.`,
    );
  }
  return { status: res.status, body: parsed };
}

const devHeaders = (role, userId) => ({
  "x-tenant-id": TENANT,
  "x-user-id": userId,
  "x-user-role": role,
});

async function main() {
  // ── infrastructure ────────────────────────────────────────────────────────────────────────────
  await step("health", { path: "/health", expect: 200 });
  await step("ready", { path: "/ready", expect: 200 });

  // F3: /metrics returns 404 — NOT 401 — for a bad token. Deliberate: it hides the endpoint's
  // existence. A port that "fixes" this to 401 leaks that the endpoint is there.
  await step("metrics rejects a bad token with 404, not 401", {
    path: "/metrics",
    headers: { "x-metrics-token": "wrong-token" },
    expect: 404,
  });

  // ── read paths ────────────────────────────────────────────────────────────────────────────────
  await step("quran surah list", { path: "/v1/quran/surahs", expect: 200 });
  await step("quran single ayah", { path: "/v1/quran/ayahs/1/1", expect: 200 });
  await step("quran ayah not found", { path: "/v1/quran/ayahs/1/999", expect: 404 });

  // ── auth ──────────────────────────────────────────────────────────────────────────────────────
  // F3: login must not reveal whether an account exists. Both cases return the same status.
  await step("login with unknown email", {
    method: "POST",
    path: "/v1/auth/login",
    body: { tenantId: TENANT, email: "nobody@example.invalid", password: "wrong-password-1" },
    expect: 401,
  });

  // /v1/auth/token — THE snake_case response body. Recorded verbatim so a camelCase port fails.
  await step("issue token for a seeded learner (snake_case body)", {
    method: "POST",
    path: "/v1/auth/token",
    headers: devHeaders("admin", "admin-1"),
    body: { tenantId: TENANT, userId: "learner-1", role: "learner" },
    expect: 200,
  });

  await step("issue token rejects a role mismatch", {
    method: "POST",
    path: "/v1/auth/token",
    headers: devHeaders("admin", "admin-1"),
    body: { tenantId: TENANT, userId: "learner-1", role: "admin" },
    expect: 403,
  });

  await step("issue token rejects a cross-tenant caller", {
    method: "POST",
    path: "/v1/auth/token",
    headers: { ...devHeaders("admin", "admin-1"), "x-tenant-id": "some-other-tenant" },
    body: { tenantId: TENANT, userId: "learner-1", role: "learner" },
    expect: 403,
  });

  // ── authorization failures ────────────────────────────────────────────────────────────────────
  await step("learner cannot list all sessions (role gate)", {
    path: "/v1/recitation-sessions",
    headers: devHeaders("learner", "learner-1"),
    expect: 403,
  });

  await step("teacher can list sessions", {
    path: "/v1/recitation-sessions",
    headers: devHeaders("teacher", "teacher-1"),
    expect: 200,
  });

  await step("session not found", {
    // Deliberately NOT uuid-shaped: a uuid here would be normalized to a placeholder that replay
    // cannot resolve (nothing produces it). A literal id stays literal and replays cleanly.
    path: "/v1/recitation-sessions/session-does-not-exist",
    headers: devHeaders("teacher", "teacher-1"),
    expect: 404,
  });

  await step("active learners", {
    path: "/v1/learners/active",
    headers: devHeaders("teacher", "teacher-1"),
    expect: 200,
  });

  // ── stateful scenario (order matters — FK-forced writes) ──────────────────────────────────────
  const created = await step("create a recitation session", {
    method: "POST",
    path: "/v1/recitation-sessions",
    headers: devHeaders("learner", "learner-1"),
    body: {
      learnerId: "learner-1",
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "1:1-7" },
      sourceChecksum: "sha256:fixture-capture-not-a-real-checksum",
      modelVersion: "model-v0.3",  // FK into model_versions — must be a seeded row
      language: "ar",
      consent: {
        recordingConsent: true,
        audioRetention: "discard",
        anonymizedLearning: false,
        externalAsrProcessing: false,
        guardianApproved: false,
        consentVersion: "pilot-v1",
      },
    },
    // RECORDED FACT, not a preference: create returns 200, not the RESTful 201. Captured as-is.
    // Changing it is a separate, visible API decision — not something to slip into a migration.
    expect: 200,
  });
  const sessionId = created.body?.id ?? created.body?.sessionId;

  if (sessionId) {
    await step("read back the created session", {
      path: `/v1/recitation-sessions/${sessionId}`,
      headers: devHeaders("learner", "learner-1"),
      expect: 200,
    });

    // F3: the ownership gate. A DIFFERENT learner must not read this session.
    await step("another learner cannot read the session (ownership gate)", {
      path: `/v1/recitation-sessions/${sessionId}`,
      headers: devHeaders("learner", "learner-2"),
      expect: 403,
    });
  }

  // ── learner progress ──────────────────────────────────────────────────────────────────────────
  await step("learner progress", {
    path: "/v1/learner/progress?learnerId=learner-1",
    headers: devHeaders("learner", "learner-1"),
    expect: 200,
  });

  await step("weekly progress", {
    path: "/v1/learner/progress/weekly?learnerId=learner-1",
    headers: devHeaders("learner", "learner-1"),
    expect: 200,
  });

  // ── review surfaces ───────────────────────────────────────────────────────────────────────────
  await step("tajweed findings", {
    path: "/v1/tajweed-findings",
    headers: devHeaders("teacher", "teacher-1"),
    expect: 200,
  });

  await step("teacher review queue", {
    path: "/v1/teacher-review-queue",
    headers: devHeaders("teacher", "teacher-1"),
    expect: 200,
  });

  // F3: an agent run claiming approval without sources must be rejected — the MissingSources
  // ApiError variant, and one of the system's core safety rules.
  await step("agent run approved without sources is rejected", {
    method: "POST",
    path: "/v1/agent-runs",
    headers: devHeaders("ops", "ops-1"),
    body: {
      name: "tajweed-explainer",
      goal: "explain a tajweed finding",
      status: "completed",
      confidence: 0.99,
      reviewStatus: "scholar-approved",
      sources: [],
      learnerId: "learner-1",
    },
    expect: 400,
  });

  // ── privacy ───────────────────────────────────────────────────────────────────────────────────
  // Seeded synthetic learner only. A fixture holding real learner data would be a privacy incident
  // committed to git.
  await step("privacy export for a synthetic learner", {
    method: "POST",
    path: "/v1/privacy/export",
    headers: devHeaders("learner", "learner-1"),
    body: { learnerId: "learner-1" },
    expect: 200,
  });

  await step("privacy export rejects another learner's data", {
    method: "POST",
    path: "/v1/privacy/export",
    headers: devHeaders("learner", "learner-2"),
    body: { learnerId: "learner-1" },
    expect: 403,
  });

  // ── pilot identity ────────────────────────────────────────────────────────────────────────────
  await step("non-admin cannot mint a pilot invitation", {
    method: "POST",
    path: "/v1/pilot/invitations",
    headers: devHeaders("learner", "learner-1"),
    body: { learnerId: "learner-1" },
    expect: 403,
  });

  await step("pilot bootstrap rejects an unknown token", {
    method: "POST",
    path: "/v1/pilot/session/bootstrap",
    body: { token: "00000000-0000-4000-8000-000000000000" },
    // RECORDED FACT: an unknown invite token yields 403, not 401.
    expect: 403,
  });

  // ── write the artifact ────────────────────────────────────────────────────────────────────────
  const artifact = {
    $comment: [
      "Golden API fixtures recorded from the Rust platform-api (F2/F3).",
      "",
      "These record REALITY, not intent: anything odd here is odd in the service, and a port must",
      "reproduce it. The /v1/auth/token snake_case body is preserved deliberately — changing it is",
      "a separate, visible decision, not something to bury in a migration.",
      "",
      "Volatile values are placeholders (<ID:prefix#n>, <JWT#n>, <TIME#n>). The same raw value maps",
      "to the same placeholder throughout, so cross-step references are still checked.",
      "Key names and CASING are never normalized.",
      "",
      "Coverage is bounded by this scenario. Routes reachable only from unusual states are NOT",
      "covered; see specs/api-golden-fixtures/plan.md.",
    ],
    capturedFrom: "rust-platform-api",
    stepCount: steps.length,
    steps,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, canonicalJson(artifact));
  console.log(`captured ${steps.length} steps -> ${outPath}`);
}

main().catch((err) => {
  console.error(`capture failed: ${err.message}`);
  process.exit(1);
});
