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

async function fetchTajweedFindings() {
  const res = await fetch(`${PLATFORM_API_URL}/v1/tajweed-findings`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`tajweed-findings ${res.status}`);
  return res.json();
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
  const findings = await getFindings();
  const runs = [];
  for (const finding of findings) {
    const candidate = runTajweedExplainer(finding);
    const recorded = await write(candidate);
    runs.push(recorded);
  }
  return { agent: "Tajweed Explainer", processedFindings: findings.length, created: runs.length, runs };
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
        agents: ["Tajweed Explainer"],
        platformApi: PLATFORM_API_URL,
        tenant: TENANT_ID,
      });
    }
    if (req.method === "POST" && req.url === "/run") {
      const summary = await runTajweedExplainerBatch();
      return sendJson(res, 200, summary);
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
