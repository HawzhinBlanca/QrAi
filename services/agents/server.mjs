// Quran AI Agents service — supervised workflow tools, not religious authorities.
//
// The Tajweed Explainer agent reads REAL tajweed findings from platform-api, turns each
// into a learner-facing explanation candidate (deterministic, sourced), enforces the
// human-review gate, and records a real agent_run via platform-api. Every learner-facing
// answer must pass the source/review gate in packages/contracts before display.
//
// Run: `node server.mjs`  (GET /health, POST /run)

import http from "node:http";
import { runTajweedExplainer } from "./lib/tajweedExplainer.mjs";
import { runMistakePatternSummarizer } from "./lib/mistakePatterns.mjs";
import { runPracticeRecommender } from "./lib/practiceRecommender.mjs";

const PORT = Number(process.env.AGENTS_PORT || 8092);
const PLATFORM_API_URL = process.env.PLATFORM_API_URL || "http://127.0.0.1:8080";
const TENANT_ID = process.env.AGENTS_TENANT_ID || "hikmah-pilot-erbil";

// Ops identity for the internal calls. In production this is a real ops JWT (Bearer);
// in dev the header fallback works when platform-api runs with ALLOW_HEADER_AUTH=1.
function authHeaders() {
  const token = process.env.AGENTS_API_TOKEN;
  if (token) return { authorization: `Bearer ${token}` };
  return { "x-tenant-id": TENANT_ID, "x-user-id": "ops-1", "x-user-role": "ops" };
}

// Inbound gate on this service's own HTTP surface (mirrors ML_API_KEY / ASR_API_KEY /
// TAJWEED_NEURAL_API_KEY on the other internal services). Every POST /run* here spends real
// ops-level credentials against platform-api (writes agent_run rows, fans out over every
// active learner) — unlike the other services this one is not currently containerized or
// fronted by any proxy, but that is exactly the state ml-inference/asr-inference were in
// before they were exposed further, so the same defense-in-depth applies from the start
// rather than being retrofitted later under time pressure.
const AGENTS_SERVICE_API_KEY = process.env.AGENTS_SERVICE_API_KEY ?? "smoke-agents-api-key";

function isAuthorized(req) {
  return req.headers["x-agents-api-key"] === AGENTS_SERVICE_API_KEY;
}

/** Defensive: an upstream that returns a non-array (with HTTP 200) means "no items". */
function toArray(value) {
  return Array.isArray(value) ? value : [];
}

async function fetchTajweedFindings() {
  const res = await fetch(`${PLATFORM_API_URL}/v1/tajweed-findings`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`tajweed-findings ${res.status}`);
  return res.json();
}

async function fetchLearnerProgress(learnerId) {
  const url = `${PLATFORM_API_URL}/v1/learner/progress?learnerId=${encodeURIComponent(learnerId)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`learner-progress ${res.status}`);
  return res.json();
}

/** The COMPLETE set of distinct learner ids with at least one recitation session — from the dedicated
 *  /v1/learners/active endpoint, NOT the UI-capped session listing (which silently drops learners past
 *  its 50-row LIMIT and made the recommender skip them). */
async function fetchActiveLearnerIds() {
  const res = await fetch(`${PLATFORM_API_URL}/v1/learners/active`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`learners-active ${res.status}`);
  return toArray(await res.json());
}

async function recordAgentRun(run) {
  const res = await fetch(`${PLATFORM_API_URL}/v1/agent-runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(run),
  });
  if (!res.ok) throw new Error(`agent-runs ${res.status}: ${await res.text()}`);
  return res.json();
}

// The core pipeline: findings -> explainer -> gate -> recorded runs. Exported for tests.
export async function runTajweedExplainerBatch({ fetchFindings, record } = {}) {
  const getFindings = fetchFindings || fetchTajweedFindings;
  const write = record || recordAgentRun;
  // Coerce to an array: a malformed upstream (non-array body with HTTP 200) must not throw
  // "findings is not iterable" (500) — it means "no findings".
  const findings = toArray(await getFindings());
  const runs = [];
  for (const finding of findings) {
    const candidate = runTajweedExplainer(finding);
    const recorded = await write(candidate);
    runs.push(recorded);
  }
  return { agent: "Tajweed Explainer", processedFindings: findings.length, created: runs.length, runs };
}

// findings -> one cohort summary run. IO injectable for tests.
export async function runMistakePatternSummarizerBatch({ fetchFindings, record } = {}) {
  const getFindings = fetchFindings || fetchTajweedFindings;
  const write = record || recordAgentRun;
  const findings = toArray(await getFindings());
  const candidate = runMistakePatternSummarizer(findings);
  const runs = candidate ? [await write(candidate)] : [];
  return {
    agent: "Mistake Pattern Summarizer",
    processedFindings: findings.length,
    created: runs.length,
    runs,
  };
}

// active learners -> per-learner progress -> next-step recommendation run. IO injectable.
export async function runPracticeRecommenderBatch({ fetchLearnerIds, fetchProgress, record, now } = {}) {
  const getLearnerIds = fetchLearnerIds || fetchActiveLearnerIds;
  const getProgress = fetchProgress || fetchLearnerProgress;
  const write = record || recordAgentRun;
  const nowIso = now || new Date().toISOString();
  const learnerIds = toArray(await getLearnerIds());
  const runs = [];
  for (const learnerId of learnerIds) {
    const progress = await getProgress(learnerId);
    const candidate = runPracticeRecommender(progress, nowIso);
    runs.push(await write(candidate));
  }
  return { agent: "Practice Plan Recommender", processedLearners: learnerIds.length, created: runs.length, runs };
}

// Run every agent and aggregate. Exported for tests.
export async function runAllAgents(overrides = {}) {
  const results = [
    await runTajweedExplainerBatch(overrides.tajweed),
    await runMistakePatternSummarizerBatch(overrides.mistakes),
    await runPracticeRecommenderBatch(overrides.recommend),
  ];
  return { agents: results, created: results.reduce((sum, r) => sum + r.created, 0) };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        service: "agents",
        agents: ["Tajweed Explainer", "Mistake Pattern Summarizer", "Practice Plan Recommender"],
        platformApi: PLATFORM_API_URL,
        tenant: TENANT_ID,
      });
    }
    if (req.method === "POST" && req.url.startsWith("/run")) {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      if (req.url === "/run") {
        return sendJson(res, 200, await runAllAgents());
      }
      if (req.url === "/run/tajweed") {
        return sendJson(res, 200, await runTajweedExplainerBatch());
      }
      if (req.url === "/run/mistakes") {
        return sendJson(res, 200, await runMistakePatternSummarizerBatch());
      }
      if (req.url === "/run/recommend") {
        return sendJson(res, 200, await runPracticeRecommenderBatch());
      }
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

// Only start listening when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`quran-ai agents service listening on http://127.0.0.1:${PORT}`);
    console.log(`  platform-api: ${PLATFORM_API_URL}  tenant: ${TENANT_ID}`);
  });
}

export { server };
