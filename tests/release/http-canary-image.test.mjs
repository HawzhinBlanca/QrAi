import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEPLOYABLE_IMAGE_KEYS } from "../../scripts/lib/deployable-images.mjs";
import {
  REQUIRED_HTTP_CANARY_IMAGE_STAGES,
  assertHttpCanaryImageEvidenceForPromotion,
  createHttpCanaryImageEvidence,
  httpCanaryImageCommandPlan,
} from "../../scripts/lib/http-canary-image.mjs";
import {
  TRANSITION_CANARY_ROUTE_KEYS,
  loadHttpCanaryRouteKeys,
  runHttpCanaryAudioIndexProbe,
  runHttpCanaryHostileProbe,
  runHttpCanaryRouteProbe,
} from "../../scripts/lib/http-canary-probe.mjs";
import {
  composeImageEnvironment,
  createReleaseDeploymentSelection,
} from "../../scripts/lib/release-deployment.mjs";

const candidateSha = "0123456789abcdef0123456789abcdef01234567";
const previousSha = "89abcdef0123456789abcdef0123456789abcdef";
const createdAt = "2026-08-08T08:00:00.000Z";
const completedAt = "2026-08-08T08:10:00.000Z";
const expiresAt = "2026-08-09T08:10:00.000Z";

function digests(seed) {
  return Object.fromEntries(
    DEPLOYABLE_IMAGE_KEYS.map((key, index) => [
      key,
      `sha256:${String(seed + index).repeat(64)}`,
    ]),
  );
}

function selection() {
  return createReleaseDeploymentSelection({
    candidateSha,
    candidateImageDigests: digests(1),
    previousSha,
    previousImageDigests: digests(2),
    namespace: "ExampleOwner",
    createdAt,
  });
}

function runningImages(value = selection()) {
  const env = composeImageEnvironment(value, "candidate");
  const references = {
    "platform-api": env.PLATFORM_API_IMAGE,
    "node-api": env.NODE_BACKEND_IMAGE,
    "job-worker": env.NODE_BACKEND_IMAGE,
    "node-realtime": env.NODE_BACKEND_IMAGE,
    migrations: env.MIGRATION_RUNNER_IMAGE,
    "realtime-gateway": env.REALTIME_GATEWAY_IMAGE,
    "asr-inference": env.ASR_INFERENCE_IMAGE,
    web: env.WEB_IMAGE,
  };
  const imageIds = new Map();
  return Object.entries(references).map(([service, reference], index) => {
    if (!imageIds.has(reference)) imageIds.set(reference, `sha256:${String(index + 1).repeat(64)}`);
    return {
      service,
      containerId: `${service}-container-${index}`,
      reference,
      imageId: imageIds.get(reference),
    };
  });
}

function stages() {
  return REQUIRED_HTTP_CANARY_IMAGE_STAGES.map((name, index) => ({
    name,
    status: "passed",
    startedAt: `2026-08-08T08:0${index}:00.000Z`,
    completedAt: `2026-08-08T08:0${index}:30.000Z`,
    commandSha256: `sha256:${String(index + 1).repeat(64)}`,
    outputSha256: `sha256:${String(index + 2).repeat(64)}`,
    ...(name === "rust-unavailable-routes"
      ? {
          details: {
            rustRunning: false,
            retainedAttempted: 39,
            retainedFallbacks: 0,
            transitionAttempted: 4,
            transitionDependencyFailures: 4,
          },
        }
      : {}),
  }));
}

function validEvidenceInput() {
  return {
    sourceState: { headSha: candidateSha, clean: true },
    selection: selection(),
    environment: { class: "staging-isolated", provider: "self-hosted" },
    actorClass: "release-operator",
    evidenceClass: "live-candidate",
    executionMode: "immutable-compose-images",
    startedAt: createdAt,
    completedAt,
    expiresAt,
    topology: {
      renderedSha256: `sha256:${"a".repeat(64)}`,
      webTarget: "node-api:8082",
      gatewayTarget: "http://node-api:8082",
      nodeRouteMode: "retained-canary",
      rustUpstream: "http://platform-api:8080",
    },
    routeKeys: loadHttpCanaryRouteKeys(),
    images: runningImages(),
    stages: stages(),
    validatedAt: completedAt,
  };
}

test("the actual-image route probe covers every retained route and the four Rust transitions", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    const transition = TRANSITION_CANARY_ROUTE_KEYS.some((route) =>
      route.startsWith(`${init.method} `) && key.endsWith(route.split(" ").slice(1).join(" ")),
    );
    requests.push({ key, body: init.body });
    return new Response(transition ? '{"error":"compatibility service unavailable"}' : "{}", {
      status: transition ? 502 : 400,
      headers: {
        "content-type": "application/json",
        "x-qrai-route-owner": transition ? "rust-compatibility" : "node-local",
      },
    });
  };

  const result = await runHttpCanaryRouteProbe({
    baseUrl: "https://candidate.example.test",
    rustAvailable: false,
    fetchImpl,
  });

  assert.equal(result.retainedAttempted, 39);
  assert.equal(result.retainedFallbacks, 0);
  assert.equal(result.transitionAttempted, 4);
  assert.equal(result.transitionDependencyFailures, 4);
  assert.equal(requests.length, 43);
  assert.deepEqual(result.routeKeys, loadHttpCanaryRouteKeys());
  assert.deepEqual(result.transitionRouteKeys, TRANSITION_CANARY_ROUTE_KEYS);
});

test("the hostile candidate probe requires clean client failures from Node-owned routes", async () => {
  const seen = [];
  const result = await runHttpCanaryHostileProbe({
    baseUrl: "https://candidate.example.test",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response('{"error":"invalid input"}', {
        status: init.body?.length > 2_000_000 ? 413 : 400,
        headers: {
          "content-type": "application/json",
          "x-qrai-route-owner": "node-local",
        },
      });
    },
  });
  assert.equal(result.attempted, 5);
  assert.equal(result.serverFailures, 0);
  assert.ok(seen.some(({ init }) => init.body?.includes("\\u0000")));
  assert.ok(seen.some(({ init }) => init.body?.length > 2_000_000));
});

test("the image audio proof creates a retained session, mints a ticket, and commits its chunk index", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    seen.push({ path, init });
    const body = path === "/v1/recitation-sessions"
      ? { id: "session-canary" }
      : path === "/v1/realtime-session-tickets"
        ? { token: ["rt_v2", "fixture", "signature"].join(".") }
        : { indexed: true, chunkId: JSON.parse(init.body).chunkId };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-qrai-route-owner": "node-local",
      },
    });
  };
  const proof = await runHttpCanaryAudioIndexProbe({
    baseUrl: "https://candidate.example.test",
    jwtSecret: "unit-test-jwt-secret",
    fetchImpl,
  });
  assert.equal(proof.sessionId, "session-canary");
  assert.equal(proof.indexed, true);
  assert.deepEqual(seen.map(({ path }) => path), [
    "/v1/recitation-sessions",
    "/v1/realtime-session-tickets",
    "/v1/audio-chunks",
  ]);
  assert.ok(seen.every(({ init }) => init.headers.authorization.startsWith("Bearer ")));
  assert.equal(seen.at(-1).init.headers["x-realtime-ticket"], "rt_v2.fixture.signature");
});

test("accepted evidence binds source, two immutable selections, topology, routes, containers, and proof stages", () => {
  const evidence = createHttpCanaryImageEvidence(validEvidenceInput());
  assert.equal(evidence.schemaVersion, "qrai-http-canary-image-evidence/v1");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.sourceSha, candidateSha);
  assert.equal(evidence.selection.previous.sourceSha, previousSha);
  assert.equal(evidence.routeKeys.length, 39);
  assert.equal(evidence.images.length, 8);
  assert.equal(evidence.stages.length, REQUIRED_HTTP_CANARY_IMAGE_STAGES.length);
  assert.equal(evidence.executionMode, "immutable-compose-images");
  assert.deepEqual(
    assertHttpCanaryImageEvidenceForPromotion(evidence, { validatedAt: completedAt }),
    evidence,
  );
});

test("candidate evidence fails closed on dirty, expired, substituted, or incomplete proof", () => {
  const cases = [
    [(copy) => { copy.sourceState.clean = false; }, /source tree must be clean/],
    [(copy) => { copy.sourceState.headSha = previousSha; }, /source SHA.*candidate/i],
    [(copy) => { copy.validatedAt = "2026-08-09T08:10:00.001Z"; }, /expired/],
    [(copy) => { copy.validatedAt = "2026-08-08T08:09:59.999Z"; }, /future|completion/i],
    [(copy) => { copy.selection.createdAt = "2026-08-08T08:00:00.001Z"; }, /selection.*before.*proof/i],
    [(copy) => { copy.evidenceClass = "fixture"; }, /live candidate/],
    [(copy) => { copy.executionMode = "source-processes"; }, /immutable Compose images/],
    [(copy) => { copy.topology.webTarget = "platform-api:8080"; }, /webTarget/],
    [(copy) => { copy.routeKeys.pop(); }, /exact retained canary route inventory/],
    [(copy) => { copy.images.pop(); }, /running image.*exactly/i],
    [(copy) => { copy.images[1].reference = copy.selection.previous.imageDigests["node-backend"]; }, /reference/],
    [(copy) => { copy.images[1].imageId = "local-source-image"; }, /imageId/],
    [(copy) => { copy.stages.pop(); }, /proof stages.*exactly/i],
    [(copy) => { copy.stages.at(-1).status = "failed"; }, /must have passed/],
    [(copy) => { copy.stages[1].startedAt = "2026-08-08T08:00:29.999Z"; }, /stage order/i],
    [(copy) => { copy.stages.find(({ name }) => name === "rust-unavailable-routes").details.retainedFallbacks = 1; }, /retainedFallbacks/],
  ];

  for (const [mutate, pattern] of cases) {
    const copy = structuredClone(validEvidenceInput());
    mutate(copy);
    assert.throws(() => createHttpCanaryImageEvidence(copy), pattern);
  }
});

test("the operator plan uses the release canary stack and never substitutes source servers or builds", () => {
  const plan = httpCanaryImageCommandPlan({ projectName: "qrai-canary" });
  const rendered = JSON.stringify(plan);
  assert.match(rendered, /docker-compose\.release\.yml/);
  assert.match(rendered, /docker-compose\.canary\.yml/);
  assert.match(rendered, /release-deployment\.mjs/);
  assert.match(rendered, /smoke-api\.mjs/);
  assert.match(rendered, /smoke-gateway\.mjs/);
  assert.match(rendered, /stop.*platform-api/);
  assert.doesNotMatch(rendered, /cargo run|pnpm api:dev|server\/src\/main\.mjs|--build|docker build/);
});

test("the operator runner inspects running topology, restores Rust, and writes evidence once", () => {
  const source = readFileSync("scripts/http-canary-image.mjs", "utf8");
  assert.match(source, /git[\s\S]*status[\s\S]*--porcelain/);
  assert.match(source, /validateRunningTopology\(compose, commandEnvironment\)/);
  assert.match(source, /runHttpCanaryAudioIndexProbe/);
  assert.match(source, /platformStopped[\s\S]*restorePlatformApi/);
  assert.match(source, /flag:\s*"wx"/);
  assert.doesNotMatch(source, /cargo run|pnpm api:dev|server\/src\/main\.mjs|--build|docker build/);
});
