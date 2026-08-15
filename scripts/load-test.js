/**
 * Candidate-bound k6 classroom/burst/soak proof.
 *
 * Required environment:
 *   CANDIDATE_HTTP, JOB_WORKER_HTTP, CANARY_BEARER_TOKEN,
 *   CANDIDATE_SOURCE_SHA, NODE_BACKEND_IMAGE_ID, CANARY_TOPOLOGY_SHA256,
 *   CANARY_LOAD_PROFILE=classroom|burst|soak, CANARY_LOAD_EVIDENCE_PATH
 *
 * The target, token, identities, scenarios, and thresholds have no release-mode fallback. Run only
 * against the disposable candidate environment; durable scenarios create real tenant-owned rows.
 */
import http from "k6/http";
import exec from "k6/execution";
import { check, group, sleep } from "k6";
import { Rate } from "k6/metrics";

import {
  CANARY_LOAD_PROFILES,
  CANARY_LOAD_THRESHOLDS,
  createCanaryLoadEvidence,
} from "./lib/canary-load-evidence.mjs";

function required(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is required for candidate load evidence`);
  return value;
}

function httpTarget(name) {
  const value = required(name).replace(/\/$/, "");
  if (!/^https?:\/\//.test(value) || /@/.test(value)) {
    throw new Error(`${name} must be an http(s) URL without embedded credentials`);
  }
  return value;
}

const CANDIDATE_HTTP = httpTarget("CANDIDATE_HTTP");
const JOB_WORKER_HTTP = httpTarget("JOB_WORKER_HTTP");
const CANARY_BEARER_TOKEN = required("CANARY_BEARER_TOKEN");
const CANDIDATE_SOURCE_SHA = required("CANDIDATE_SOURCE_SHA");
const NODE_BACKEND_IMAGE_ID = required("NODE_BACKEND_IMAGE_ID");
const CANARY_TOPOLOGY_SHA256 = required("CANARY_TOPOLOGY_SHA256");
const CANARY_LOAD_EVIDENCE_PATH = required("CANARY_LOAD_EVIDENCE_PATH");
const profile = required("CANARY_LOAD_PROFILE");
if (!(profile in CANARY_LOAD_PROFILES)) throw new Error("CANARY_LOAD_PROFILE is unsupported");
const startedAt = new Date().toISOString();

const errors = new Rate("errors");
const thresholdOptions = Object.fromEntries(
  Object.entries(CANARY_LOAD_THRESHOLDS).map(([metric, expression]) => [metric, [expression]]),
);

export const options = {
  scenarios: {
    [profile]: {
      ...CANARY_LOAD_PROFILES[profile],
      exec: "canaryScenario",
      tags: { profile },
    },
  },
  thresholds: thresholdOptions,
  noConnectionReuse: false,
  discardResponseBodies: false,
};

const identityHeaders = {
  authorization: `Bearer ${CANARY_BEARER_TOKEN}`,
  "content-type": "application/json",
};

function record(response, predicates) {
  const ok = check(response, predicates);
  errors.add(!ok);
  return ok;
}

function classroomRead() {
  group("candidate classroom read", () => {
    const health = http.get(`${CANDIDATE_HTTP}/health`, { tags: { surface: "node-http" } });
    record(health, { "candidate health 200": (response) => response.status === 200 });

    const surahs = http.get(`${CANDIDATE_HTTP}/v1/quran/surahs`, {
      tags: { surface: "node-http" },
    });
    record(surahs, {
      "surah list 200": (response) => response.status === 200,
      "surah list complete": (response) => {
        try { return JSON.parse(response.body).length >= 114; } catch { return false; }
      },
    });

    const worker = http.get(`${JOB_WORKER_HTTP}/ready`, { tags: { surface: "job-worker" } });
    record(worker, { "worker ready 200": (response) => response.status === 200 });
  });
}

function progressWrite(iteration) {
  group("candidate classroom effect", () => {
    const response = http.post(
      `${CANDIDATE_HTTP}/v1/learner/progress`,
      JSON.stringify({ quality: iteration % 6, ayahRef: `1:${iteration % 7 + 1}` }),
      { headers: identityHeaders, tags: { surface: "node-http" } },
    );
    record(response, {
      "progress write 200": (result) => result.status === 200,
      "progress effect returned": (result) => {
        try { return typeof JSON.parse(result.body).sm2State === "object"; } catch { return false; }
      },
    });
  });
}

function durableJob(iteration) {
  group("candidate durable job", () => {
    const suffix = `${exec.vu.idInTest}-${iteration}-${Date.now()}`;
    const create = http.post(
      `${CANDIDATE_HTTP}/v1/recitation-sessions`,
      JSON.stringify({
        learnerId: "learner-1",
        quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
        sourceChecksum: `fnv1a32:canary-load-${suffix}`,
        language: "ckb",
        consent: {
          audioRetention: "discard",
          anonymizedLearning: false,
          externalAsrProcessing: false,
          guardianApproved: true,
          consentVersion: "pilot-v1",
        },
      }),
      { headers: identityHeaders, tags: { surface: "node-http" } },
    );
    if (!record(create, { "session create 200": (response) => response.status === 200 })) return;
    let sessionId;
    try { sessionId = JSON.parse(create.body).id; } catch { sessionId = null; }
    if (!sessionId) {
      errors.add(true);
      return;
    }
    const finalize = http.post(
      `${CANDIDATE_HTTP}/v1/recitation-sessions/${encodeURIComponent(sessionId)}/finalize`,
      "{}",
      { headers: identityHeaders, tags: { surface: "durable-job" }, timeout: "65s" },
    );
    record(finalize, {
      "durable finalization completed": (response) => response.status === 200,
    });
  });
}

export function canaryScenario() {
  const iteration = exec.scenario.iterationInTest;
  if (iteration % 10 === 9) durableJob(iteration);
  else if (iteration % 5 === 4) progressWrite(iteration);
  else classroomRead();
  sleep(0.05);
}

function thresholdResults(data) {
  return Object.fromEntries(
    Object.entries(CANARY_LOAD_THRESHOLDS).map(([metricName, expression]) => {
      const result = data.metrics[metricName]?.thresholds?.[expression]?.ok;
      if (typeof result !== "boolean") {
        throw new Error(`k6 omitted threshold result ${metricName}:${expression}`);
      }
      return [metricName, result];
    }),
  );
}

export function handleSummary(data) {
  const evidence = createCanaryLoadEvidence({
    sourceSha: CANDIDATE_SOURCE_SHA,
    nodeImageId: NODE_BACKEND_IMAGE_ID,
    topologySha256: CANARY_TOPOLOGY_SHA256,
    profile,
    startedAt,
    completedAt: new Date().toISOString(),
    metrics: {
      httpP95Ms: data.metrics.http_req_duration?.values?.["p(95)"],
      errorRate: data.metrics.errors?.values?.rate,
      checksRate: data.metrics.checks?.values?.rate,
      totalRequests: data.metrics.http_reqs?.values?.count,
      droppedIterations: data.metrics.dropped_iterations?.values?.count ?? 0,
    },
    thresholds: thresholdResults(data),
  });
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  return {
    stdout: output,
    [CANARY_LOAD_EVIDENCE_PATH]: output,
  };
}
