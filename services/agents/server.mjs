// Quran AI Agents service — supervised workflow tools, not religious authorities.
//
// The Tajweed Explainer agent reads REAL tajweed findings from platform-api, turns each
// into a learner-facing explanation candidate (deterministic, sourced), enforces the
// human-review gate, and records a real agent_run via platform-api. Every learner-facing
// answer must pass the source/review gate in packages/contracts before display.
//
// Run: `node server.mjs`  (GET /health, POST /run)

import http from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createDeadline,
  createIncomingRequestDeadline,
  fetchWithDeadline,
  isDeadlineError,
  parseTimeoutSeconds,
} from "../../server/src/lib/deadline.mjs";
import { runTajweedExplainer } from "./lib/tajweedExplainer.mjs";
import { runMistakePatternSummarizer } from "./lib/mistakePatterns.mjs";
import { runPracticeRecommender } from "./lib/practiceRecommender.mjs";

const PORT = Number(process.env.AGENTS_PORT || 8092);
const PLATFORM_API_URL = process.env.PLATFORM_API_URL || "http://127.0.0.1:8080";
const TENANT_ID = process.env.AGENTS_TENANT_ID || "hikmah-pilot-erbil";
const UPSTREAM_TIMEOUT_MS = parseTimeoutSeconds(process.env.UPSTREAM_TIMEOUT_SECS ?? "60");

// Ops identity for the internal calls. In production this is a real ops JWT (Bearer);
// in dev the header fallback works when platform-api runs with ALLOW_HEADER_AUTH=1.
function authHeaders() {
  const token = process.env.AGENTS_API_TOKEN;
  if (token) return { authorization: `Bearer ${token}` };
  return { "x-tenant-id": TENANT_ID, "x-user-id": "ops-1", "x-user-role": "ops" };
}

// Inbound gate on this service's own HTTP surface (mirrors the API keys used by the other
// internal inference services). Every POST /run* here spends real
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

class PlatformDependencyError extends Error {}

async function platformJson(path, init, deadline) {
  let response;
  try {
    response = await fetchWithDeadline(`${PLATFORM_API_URL}${path}`, {
      ...init,
      deadline,
    });
  } catch (error) {
    if (isDeadlineError(error)) throw error;
    throw new PlatformDependencyError("platform dependency unavailable");
  }
  if (!response.ok) throw new PlatformDependencyError("platform dependency failed");
  try {
    return await response.json();
  } catch (error) {
    if (isDeadlineError(error)) throw error;
    throw new PlatformDependencyError("platform dependency returned invalid JSON");
  }
}

async function fetchTajweedFindings(deadline) {
  return platformJson("/v1/tajweed-findings", { headers: authHeaders() }, deadline);
}

async function fetchLearnerProgress(learnerId, deadline) {
  const path = `/v1/learner/progress?learnerId=${encodeURIComponent(learnerId)}`;
  return platformJson(path, { headers: authHeaders() }, deadline);
}

/** The COMPLETE set of distinct learner ids with at least one recitation session — from the dedicated
 *  /v1/learners/active endpoint, NOT the UI-capped session listing (which silently drops learners past
 *  its 50-row LIMIT and made the recommender skip them). */
async function fetchActiveLearnerIds(deadline) {
  return toArray(await platformJson("/v1/learners/active", { headers: authHeaders() }, deadline));
}

async function recordAgentRun(run, deadline) {
  return platformJson("/v1/agent-runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(run),
  }, deadline);
}

/** Existing agent runs (for dedup). Each carries `findingId` (surfaced from the run's trace by
 *  platform-api's list_agent_runs) — the explainer skips findings that already have a run. */
async function fetchExistingAgentRuns(deadline) {
  return toArray(await platformJson("/v1/agent-runs", { headers: authHeaders() }, deadline));
}

// The core pipeline: findings -> explainer -> gate -> recorded runs. Exported for tests.
export async function runTajweedExplainerBatch({
  fetchFindings,
  record,
  fetchExisting,
  deadline = createDeadline(UPSTREAM_TIMEOUT_MS),
} = {}) {
  const getFindings = fetchFindings || (() => fetchTajweedFindings(deadline));
  const write = record || ((run) => recordAgentRun(run, deadline));
  const getExisting = fetchExisting || (() => fetchExistingAgentRuns(deadline));
  // Coerce to an array: a malformed upstream (non-array body with HTTP 200) must not throw
  // "findings is not iterable" (500) — it means "no findings".
  const findings = toArray(await getFindings());
  // Dedup: skip any finding that already has a recorded agent run. Previously every batch tick
  // re-explained and re-recorded EVERY finding, growing agent_runs unboundedly and spamming the
  // teacher review queue with duplicates of the same finding.
  const processed = new Set(
    toArray(await getExisting())
      .map((r) => r && r.findingId)
      .filter(Boolean),
  );
  const runs = [];
  let skipped = 0;
  for (const finding of findings) {
    // Skip anything we can't dedup: a finding with no id can never be recorded in `processed`, so
    // without treating it as skippable it would be re-explained and re-recorded on EVERY batch tick
    // (unbounded agent_runs growth + duplicate teacher-review-queue entries). A finding must have an
    // id to be processed exactly once.
    if (!finding || !finding.id || processed.has(finding.id)) {
      skipped += 1;
      continue;
    }
    const candidate = runTajweedExplainer(finding);
    const recorded = await write(candidate);
    runs.push(recorded);
    // Guard against duplicate finding ids within a single batch too.
    processed.add(finding.id);
  }
  return {
    agent: "Tajweed Explainer",
    processedFindings: findings.length,
    created: runs.length,
    skipped,
    runs,
  };
}

// findings -> one cohort summary run. IO injectable for tests.
export async function runMistakePatternSummarizerBatch({
  fetchFindings,
  record,
  deadline = createDeadline(UPSTREAM_TIMEOUT_MS),
} = {}) {
  const getFindings = fetchFindings || (() => fetchTajweedFindings(deadline));
  const write = record || ((run) => recordAgentRun(run, deadline));
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
export async function runPracticeRecommenderBatch({
  fetchLearnerIds,
  fetchProgress,
  record,
  now,
  deadline = createDeadline(UPSTREAM_TIMEOUT_MS),
} = {}) {
  const getLearnerIds = fetchLearnerIds || (() => fetchActiveLearnerIds(deadline));
  const getProgress = fetchProgress || ((learnerId) => fetchLearnerProgress(learnerId, deadline));
  const write = record || ((run) => recordAgentRun(run, deadline));
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
  const deadline = overrides.deadline ?? createDeadline(UPSTREAM_TIMEOUT_MS);
  const results = [
    await runTajweedExplainerBatch({ ...overrides.tajweed, deadline }),
    await runMistakePatternSummarizerBatch({ ...overrides.mistakes, deadline }),
    await runPracticeRecommenderBatch({ ...overrides.recommend, deadline }),
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
      const deadline = createIncomingRequestDeadline(req, res, UPSTREAM_TIMEOUT_MS);
      if (req.url === "/run") {
        return sendJson(res, 200, await runAllAgents({ deadline }));
      }
      if (req.url === "/run/tajweed") {
        return sendJson(res, 200, await runTajweedExplainerBatch({ deadline }));
      }
      if (req.url === "/run/mistakes") {
        return sendJson(res, 200, await runMistakePatternSummarizerBatch({ deadline }));
      }
      if (req.url === "/run/recommend") {
        return sendJson(res, 200, await runPracticeRecommenderBatch({ deadline }));
      }
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    if (isDeadlineError(err)) {
      res.setHeader("retry-after", "1");
      return sendJson(res, 503, { error: "dependency operation timed out" });
    }
    if (err instanceof PlatformDependencyError) {
      return sendJson(res, 502, { error: "platform dependency unavailable" });
    }
    return sendJson(res, 500, { error: "internal error" });
  }
});

// Only start listening when run directly (not when imported by tests). Compares canonicalized
// URLs (realpathSync + pathToFileURL), not a naive `file://${argv[1]}` string concat — the naive
// form breaks when the process is launched through a symlink (argv[1] is the symlink path while
// import.meta.url resolves to the real file) or when the path needs URL-encoding, silently
// leaving isMain false and the server never binding its port. Mirrors the identical fix already
// applied by the server-owned worker compatibility boundary.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  : false;

if (isMain) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`quran-ai agents service listening on http://127.0.0.1:${PORT}`);
    console.log(`  platform-api: ${PLATFORM_API_URL}  tenant: ${TENANT_ID}`);
  });
}

export { server };
