import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const oldInsecurePath = join(repo, "services", "node-api", "lib", "insecure.mjs");
const newInsecurePath = join(repo, "server", "src", "lib", "insecure.mjs");
const oldMetricsPath = join(repo, "services", "node-api", "lib", "metrics.mjs");
const newMetricsPath = join(repo, "server", "src", "lib", "metrics.mjs");
const oldJsonPath = join(repo, "services", "node-api", "lib", "json.mjs");
const newJsonPath = join(repo, "server", "src", "lib", "json.mjs");
const oldLearnerGatePath = join(repo, "services", "node-api", "lib", "learner-feedback-gate.mjs");
const newLearnerGatePath = join(repo, "server", "src", "lib", "learner-feedback-gate.mjs");
const oldProxyPath = join(repo, "services", "node-api", "lib", "proxy.mjs");
const newProxyPath = join(repo, "server", "src", "lib", "proxy.mjs");
const oldDbPath = join(repo, "services", "node-api", "lib", "db.mjs");
const newDbPath = join(repo, "server", "src", "lib", "db.mjs");
const oldTicketPath = join(repo, "services", "node-api", "lib", "ticket.mjs");
const newTicketPath = join(repo, "server", "src", "lib", "ticket.mjs");
const oldAuthzPath = join(repo, "services", "node-api", "lib", "authz.mjs");
const newAuthzPath = join(repo, "server", "src", "lib", "authz.mjs");
const oldRoutesPath = join(repo, "services/node-api/routes");
const newRoutesPath = join(repo, "server", "src", "routes");
const oldEntrypointPath = join(repo, "services", "node-api", "server.mjs");
const newApplicationPath = join(repo, "server", "src", "app.mjs");
const newEntrypointPath = join(repo, "server", "src", "main.mjs");
const routeFiles = [
  "agent-write.mjs",
  "auth.mjs",
  "index.mjs",
  "infra.mjs",
  "ml-proxy.mjs",
  "pilot.mjs",
  "privacy.mjs",
  "progress.mjs",
  "quran.mjs",
  "recitation.mjs",
  "reports.mjs",
  "review.mjs",
  "session-writes.mjs",
  "sessions.mjs",
];
const jsonCallerPaths = [
  ["server", "src", "app.mjs"],
  ["server", "src", "routes", "agent-write.mjs"],
  ["server", "src", "routes", "progress.mjs"],
  ["server", "src", "routes", "reports.mjs"],
  ["server", "src", "routes", "review.mjs"],
  ["server", "src", "routes", "session-writes.mjs"],
  ["server", "src", "routes", "sessions.mjs"],
  ["tests", "api-parity", "reports-parity.test.mjs"],
  ["tests", "api-parity", "sessions-parity.test.mjs"],
  ["tests", "node-api", "rust-json.test.mjs"],
];
const proxyCallerPaths = [
  ["server", "src", "app.mjs"],
  ["server", "src", "routes", "agent-write.mjs"],
  ["server", "src", "routes", "auth.mjs"],
  ["server", "src", "routes", "ml-proxy.mjs"],
  ["server", "src", "routes", "pilot.mjs"],
  ["server", "src", "routes", "privacy.mjs"],
  ["server", "src", "routes", "progress.mjs"],
  ["server", "src", "routes", "recitation.mjs"],
  ["server", "src", "routes", "reports.mjs"],
  ["server", "src", "routes", "review.mjs"],
  ["server", "src", "routes", "session-writes.mjs"],
  ["server", "src", "routes", "sessions.mjs"],
];
const ticketCallerPaths = [
  ["server", "src", "routes", "recitation.mjs"],
  ["tests", "gateway", "index-failure-e2e.test.mjs"],
  ["tests", "gateway", "ws-hostile-input.test.mjs"],
  ["tests", "gateway", "audio-retention-e2e.test.mjs"],
  ["tests", "e2e", "teacher-audio-index.test.mjs"],
  ["tests", "node-api", "ticket-vectors.test.mjs"],
  ["scripts", "smoke-gateway.mjs"],
  ["scripts", "chaos-realtime-reconnect.mjs"],
];
const ticketReferencePaths = [
  ["specs", "gateway-ws-sweep", "research.md"],
  ["specs", "gateway-ws-sweep", "impact-map.md"],
  ["specs", "node-backend-port", "impact-map.md"],
];
const authzCallerPaths = [
  ["server", "src", "app.mjs"],
  ["server", "src", "routes", "agent-write.mjs"],
  ["server", "src", "routes", "auth.mjs"],
  ["server", "src", "routes", "ml-proxy.mjs"],
  ["server", "src", "routes", "pilot.mjs"],
  ["server", "src", "routes", "privacy.mjs"],
  ["server", "src", "routes", "progress.mjs"],
  ["server", "src", "routes", "quran.mjs"],
  ["server", "src", "routes", "recitation.mjs"],
  ["server", "src", "routes", "reports.mjs"],
  ["server", "src", "routes", "review.mjs"],
  ["server", "src", "routes", "session-writes.mjs"],
  ["server", "src", "routes", "sessions.mjs"],
  ["tests", "node-api", "authz.test.mjs"],
];

test("the first security leaf has one owner under the server package", async () => {
  assert.equal(existsSync(oldInsecurePath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newInsecurePath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newInsecurePath).href);
  assert.deepEqual(Object.keys(module).sort(), [
    "ALLOW_INSECURE_SECRETS",
    "LEGACY_ONE_ONLY",
    "LEGACY_ONE_OR_TRUE",
    "LEGACY_VAR",
    "insecureSecretProblems",
    "isRelaxed",
    "relaxed",
  ]);
});

test("the runtime and direct contract caller import the new owner", () => {
  const serverSource = readFileSync(newEntrypointPath, "utf8");
  const bootGuardSource = readFileSync(join(repo, "tests", "node-api", "boot-guard.test.mjs"), "utf8");

  assert.match(serverSource, /from "\.\/lib\/insecure\.mjs"/);
  assert.match(bootGuardSource, /from "\.\.\/\.\.\/server\/src\/lib\/insecure\.mjs"/);
  assert.doesNotMatch(serverSource, /services\/node-api\/lib\/insecure\.mjs/);
  assert.doesNotMatch(bootGuardSource, /services\/node-api\/lib\/insecure\.mjs/);
});

test("the metrics leaf has one owner under the server package", async () => {
  assert.equal(existsSync(oldMetricsPath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newMetricsPath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newMetricsPath).href);
  assert.deepEqual(Object.keys(module).sort(), [
    "LATENCY_BUCKETS_MS",
    "createMetrics",
    "escape",
    "metricsAccessAllowed",
  ]);
});

test("every metrics runtime and contract caller imports the new owner", () => {
  const serverSource = readFileSync(newApplicationPath, "utf8");
  const infraSource = readFileSync(join(repo, "server", "src", "routes", "infra.mjs"), "utf8");
  const metricsTestSource = readFileSync(
    join(repo, "tests", "node-api", "metrics-render.test.mjs"),
    "utf8",
  );

  assert.match(serverSource, /from "\.\/lib\/metrics\.mjs"/);
  assert.match(infraSource, /from "\.\.\/lib\/metrics\.mjs"/);
  assert.match(metricsTestSource, /from "\.\.\/\.\.\/server\/src\/lib\/metrics\.mjs"/);
  assert.doesNotMatch(serverSource, /services\/node-api\/lib\/metrics\.mjs/);
  assert.doesNotMatch(infraSource, /services\/node-api\/lib\/metrics\.mjs/);
  assert.doesNotMatch(metricsTestSource, /services\/node-api\/lib\/metrics\.mjs/);
});

test("the Rust-wire JSON leaf has one owner under the server package", async () => {
  assert.equal(existsSync(oldJsonPath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newJsonPath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newJsonPath).href);
  assert.deepEqual(Object.keys(module).sort(), [
    "f32",
    "f64",
    "formatF32",
    "formatF64",
    "sortKeysDeep",
    "stringifyRust",
  ]);
});

test("every JSON serializer runtime and contract caller imports the new owner", () => {
  for (const parts of jsonCallerPaths) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    assert.match(source, /server\/src\/lib\/json\.mjs|from "\.\.?\/lib\/json\.mjs"/, `${parts.join("/")} must import the new owner`);
    assert.doesNotMatch(
      source,
      /services\/node-api\/lib\/json\.mjs/,
      `${parts.join("/")} still imports the legacy owner`,
    );
  }
});

test("the learner-feedback authority gate has one owner under the server package", async () => {
  assert.equal(existsSync(oldLearnerGatePath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newLearnerGatePath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newLearnerGatePath).href);
  assert.deepEqual(Object.keys(module), ["clearsLearnerFeedbackGate"]);
});

test("both runtime callers and every source-policy reference use the new learner gate owner", () => {
  const reviewSource = readFileSync(join(repo, "server", "src", "routes", "review.mjs"), "utf8");
  const mlProxySource = readFileSync(
    join(repo, "server", "src", "routes", "ml-proxy.mjs"),
    "utf8",
  );
  const contractSource = readFileSync(
    join(repo, "tests", "contract", "tajweed-gate-parity.test.mjs"),
    "utf8",
  );

  assert.match(reviewSource, /from "\.\.\/lib\/learner-feedback-gate\.mjs"/);
  assert.match(mlProxySource, /from "\.\.\/lib\/learner-feedback-gate\.mjs"/);
  assert.match(contractSource, /from "\.\.\/\.\.\/server\/src\/lib\/learner-feedback-gate\.mjs"/);
  assert.equal(
    [...contractSource.matchAll(/join\(repo, "server", "src", "lib", "learner-feedback-gate\.mjs"\)/g)]
      .length,
    2,
    "both source-policy reads must inspect the moved owner",
  );
  for (const source of [reviewSource, mlProxySource, contractSource]) {
    assert.doesNotMatch(source, /services\/node-api\/lib\/learner-feedback-gate\.mjs/);
  }
});

test("the transparent HTTP proxy has one owner under the server package", async () => {
  assert.equal(existsSync(oldProxyPath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newProxyPath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newProxyPath).href);
  assert.deepEqual(Object.keys(module), ["proxy"]);
});

test("every proxy runtime caller imports the new owner", () => {
  for (const parts of proxyCallerPaths) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    assert.match(source, /server\/src\/lib\/proxy\.mjs|from "\.\.?\/lib\/proxy\.mjs"/, `${parts.join("/")} must import the new owner`);
    assert.doesNotMatch(
      source,
      /services\/node-api\/lib\/proxy\.mjs/,
      `${parts.join("/")} still imports the legacy owner`,
    );
  }
});

test("the tenant-scoped database primitive has one owner under the server package", async () => {
  assert.equal(existsSync(oldDbPath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newDbPath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newDbPath).href);
  assert.deepEqual(Object.keys(module), ["createDb"]);
});

test("the composition root and live RLS oracle import the new database owner", () => {
  const serverSource = readFileSync(newApplicationPath, "utf8");
  const tenantTestSource = readFileSync(
    join(repo, "tests", "node-api", "db-tenant.test.mjs"),
    "utf8",
  );
  const cutoverBoundarySource = readFileSync(
    join(repo, "specs", "cutover", "boundary.md"),
    "utf8",
  );

  assert.match(serverSource, /from "\.\/lib\/db\.mjs"/);
  assert.match(tenantTestSource, /from "\.\.\/\.\.\/server\/src\/lib\/db\.mjs"/);
  assert.match(cutoverBoundarySource, /`server\/src\/lib\/db\.mjs`/);
  assert.doesNotMatch(serverSource, /services\/node-api\/lib\/db\.mjs/);
  assert.doesNotMatch(tenantTestSource, /services\/node-api\/lib\/db\.mjs/);
  assert.doesNotMatch(cutoverBoundarySource, /services\/node-api\/lib\/db\.mjs/);
});

test("the realtime ticket authority has one owner under the server package", async () => {
  assert.equal(existsSync(oldTicketPath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newTicketPath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newTicketPath).href);
  assert.deepEqual(Object.keys(module).sort(), [
    "TICKET_VERSION",
    "issueRealtimeTicket",
    "newNonce",
    "signTicketPayload",
    "ticketPayload",
    "verifyRealtimeTicket",
  ]);
});

test("every ticket caller and implementation citation uses the new owner", () => {
  for (const parts of ticketCallerPaths) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    assert.match(source, /server\/src\/lib\/ticket\.mjs|from "\.\.\/lib\/ticket\.mjs"/, `${parts.join("/")} must import the new owner`);
    assert.doesNotMatch(
      source,
      /services\/node-api\/lib\/ticket\.mjs/,
      `${parts.join("/")} still imports the legacy owner`,
    );
  }
  for (const parts of ticketReferencePaths) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    assert.match(source, /server\/src\/lib\/ticket\.mjs/, `${parts.join("/")} must cite the new owner`);
    assert.doesNotMatch(source, /services\/node-api\/lib\/ticket\.mjs/);
  }
});

test("the authorization authority has one owner under the server package", async () => {
  assert.equal(existsSync(oldAuthzPath), false, "the legacy path must be removed, not duplicated");
  assert.equal(existsSync(newAuthzPath), true, "the server package must own the moved module");

  const module = await import(pathToFileURL(newAuthzPath).href);
  assert.deepEqual(Object.keys(module).sort(), [
    "ApiError",
    "Forbidden",
    "NotFound",
    "RejectionError",
    "Unauthorized",
    "pilotCookieToken",
    "requireAllowedOrigin",
    "requireAnyRole",
    "requireSelfOrAny",
    "resolveActor",
  ]);
});

test("every authorization caller and implementation citation uses the new owner", () => {
  for (const parts of authzCallerPaths) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    assert.match(source, /server\/src\/lib\/authz\.mjs|from "\.\.?\/lib\/authz\.mjs"/, `${parts.join("/")} must import the new owner`);
    assert.doesNotMatch(
      source,
      /services\/node-api\/lib\/authz\.mjs/,
      `${parts.join("/")} still imports the legacy owner`,
    );
  }
  for (const parts of [
    ["specs", "cutover", "boundary.md"],
    ["specs", "node-backend-port", "impact-map.md"],
  ]) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    assert.match(source, /server\/src\/lib\/authz\.mjs/, `${parts.join("/")} must cite the new owner`);
    assert.doesNotMatch(source, /services\/node-api\/lib\/authz\.mjs/);
  }
});

test("the complete route layer has one owner under the server package", async () => {
  const oldFiles = existsSync(oldRoutesPath)
    ? readdirSync(oldRoutesPath).filter((name) => name.endsWith(".mjs")).sort()
    : [];
  assert.deepEqual(oldFiles, [], "the legacy route tree must have no JavaScript owners");
  assert.deepEqual(readdirSync(newRoutesPath).filter((name) => name.endsWith(".mjs")).sort(), routeFiles);

  const module = await import(pathToFileURL(join(newRoutesPath, "index.mjs")).href);
  assert.deepEqual(Object.keys(module).sort(), ["ROUTES", "fastifyPath"]);
  assert.equal(module.ROUTES.length, 37, "the route composition count must not change during relocation");
});

test("route runtime and executable source consumers use the server package owner", () => {
  const consumers = [
    ["server", "src", "app.mjs"],
    ["tests", "node-api", "routes-table.test.mjs"],
    ["tests", "node-api", "readiness-fault.test.mjs"],
    ["tests", "node-api", "authz.test.mjs"],
    ["tests", "contract", "learner-feedback-gate.test.mjs"],
    ["tests", "contract", "acoustic-tajweed-boundary.test.mjs"],
    ["tests", "contract", "ml-findings-shape.test.mjs"],
    ["tests", "node-api", "no-secret-logging.test.mjs"],
    ["tests", "api-parity", "authz-matrix.test.mjs"], // gitleaks:allow -- source-path tuple, not a credential
  ];
  for (const parts of consumers) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    const usesMovedRoutes =
      /server\/src\/routes|"server", "src", "routes"/.test(source) ||
      /from "\.\/routes\/index\.mjs"/.test(source) ||
      (parts.at(-1) === "no-secret-logging.test.mjs" && /"server", "src"/.test(source));
    assert.ok(usesMovedRoutes, `${parts.join("/")} must use the new route owner`);
    assert.doesNotMatch(source, /services\/node-api\/routes/);
  }
  for (const file of routeFiles) {
    const source = readFileSync(join(newRoutesPath, file), "utf8");
    assert.doesNotMatch(source, /server\/src\/lib/, `${file} retains a temporary cross-package lib path`);
  }
});

test("the Node API has one composition root and one package-owned entrypoint", async () => {
  assert.equal(existsSync(oldEntrypointPath), false, "the legacy entrypoint must be removed");
  assert.equal(existsSync(newApplicationPath), true, "the server package must own composition");
  assert.equal(existsSync(newEntrypointPath), true, "the server package must own process startup");

  const application = await import(pathToFileURL(newApplicationPath).href);
  const entrypoint = await import(pathToFileURL(newEntrypointPath).href);
  assert.deepEqual(Object.keys(application), ["createApplication"]);
  assert.deepEqual(Object.keys(entrypoint), ["PORTABLE"]);
  assert.equal(typeof application.createApplication, "function");
  assert.equal(entrypoint.PORTABLE.length, 37);

  const applicationSource = readFileSync(newApplicationPath, "utf8");
  const entrypointSource = readFileSync(newEntrypointPath, "utf8");
  assert.doesNotMatch(applicationSource, /services\/node-api/);
  assert.doesNotMatch(applicationSource, /\.listen\s*\(/);
  assert.match(entrypointSource, /from "\.\/app\.mjs"/);
  assert.match(entrypointSource, /createApplication\s*\(/);
});

test("every executable entrypoint consumer uses the server package owner", () => {
  const consumers = [
    ["server", "Dockerfile"],
    ["specs", "cutover", "boundary.md"],
    ["scripts", "cutover-readiness.mjs"],
    ["scripts", "verify.sh"],
    ["tests", "api-parity", "authz-matrix.test.mjs"],
    ["tests", "api-parity", "lib", "harness.mjs"],
    ["tests", "node-api", "boot-guard.test.mjs"],
    ["tests", "node-api", "no-secret-logging.test.mjs"],
    ["tests", "node-api", "nul-byte-is-a-400.test.mjs"], // gitleaks:allow -- source-path tuple, not a credential
    ["tests", "node-api", "routes-table.test.mjs"],
    ["tests", "node-api", "shell.test.mjs"],
  ];
  for (const parts of consumers) {
    const source = readFileSync(join(repo, ...parts), "utf8");
    assert.doesNotMatch(source, /services\/node-api\/server\.mjs/, `${parts.join("/")} is stale`);
    assert.match(
      source,
      /server\/src\/(?:app|main)\.mjs|"server", "src", "(?:app|main)\.mjs"/,
      `${parts.join("/")} must name the package owner`,
    );
  }
});

test("canonical verification invokes the module-relocation guard exactly once", () => {
  const target = "tests/node-api/module-relocation.test.mjs";
  const activeNodeTestLines = readFileSync(join(repo, "scripts", "verify.sh"), "utf8")
    .split("\n")
    .filter((line) => line.includes("node ") && line.includes("--test "))
    .filter((line) => !line.trimStart().startsWith("#"));
  assert.equal(activeNodeTestLines.filter((line) => line.includes(target)).length, 1);
});
