import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const serverPackagePath = join(repo, "server", "package.json");
const appPath = join(repo, "server", "src", "app.mjs");

const runtimeDependencies = {
  "@aws-sdk/client-s3": "3.1101.0",
  "@fastify/cors": "^11.3.0",
  fastify: "^5.11.0",
  jose: "^6.2.5",
  pg: "^8.22.0",
  postgres: "^3.4.9",
};

test("server is an ESM workspace with an explicit production dependency boundary", () => {
  const workspace = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
  const manifest = JSON.parse(readFileSync(serverPackagePath, "utf8"));

  assert.match(workspace, /^\s*- server\s*$/m);
  assert.equal(manifest.name, "@quran-ai/server");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.engines?.node, ">=22.13");
  assert.equal(manifest.packageManager, "pnpm@11.7.0");
  assert.deepEqual(manifest.dependencies, runtimeDependencies);
  for (const dependency of Object.keys(runtimeDependencies)) {
    assert.equal(manifest.devDependencies?.[dependency], undefined, `${dependency} must be a production dependency`);
  }
  assert.equal(manifest.exports?.["."], "./src/app.mjs");
  assert.equal(
    manifest.scripts?.lint,
    "node --check src/app.mjs src/main.mjs src/worker.mjs src/container-healthcheck.mjs src/identity/*.mjs src/inference/*.mjs src/jobs/*.mjs src/lib/*.mjs src/routes/*.mjs src/storage/*.mjs scripts/provision-device-enrollment.mjs scripts/requeue-dead-job.mjs",
  );
  assert.equal(manifest.scripts?.typecheck, "tsc --project tsconfig.json");
  assert.equal(manifest.scripts?.build, "pnpm run lint && pnpm run typecheck");
});


test("root workflows typecheck, build, and test the server package exactly once", () => {
  const rootManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const verifySource = readFileSync(join(repo, "scripts", "verify.sh"), "utf8");
  const lifecycleTest = "tests/node-api/standalone-lifecycle.test.mjs";
  const activeNodeTestLines = verifySource
    .split("\n")
    .filter((line) => line.includes("node ") && line.includes("--test "))
    .filter((line) => !line.trimStart().startsWith("#"));

  assert.match(rootManifest.scripts.typecheck, /pnpm --filter @quran-ai\/server typecheck/);
  assert.match(rootManifest.scripts.build, /pnpm --filter @quran-ai\/server build/);
  assert.match(verifySource, /typecheck: ts[^\n]*@quran-ai\/server typecheck/);
  assert.match(verifySource, /run "build"[^\n]*@quran-ai\/server build/);
  assert.equal(
    activeNodeTestLines.filter((line) => line.includes(lifecycleTest)).length,
    1,
    `${lifecycleTest} must run exactly once in canonical verification`,
  );
});

test("importing the composition root has no listen side effect and exposes one application seam", async () => {
  const source = readFileSync(appPath, "utf8");
  assert.doesNotMatch(source, /\.listen\s*\(/, "the composition root must not bind a socket on import");

  const module = await import(`${pathToFileURL(appPath).href}?import-proof=${Date.now()}`);
  assert.deepEqual(Object.keys(module), ["createApplication"]);
  assert.equal(typeof module.createApplication, "function");
});

test("the package composition root starts and closes the unchanged local health route", async (t) => {
  const { createApplication } = await import(pathToFileURL(appPath).href);
  const app = createApplication({ logger: false });
  t.after(() => app.close());

  await app.ready();
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(app.apiMode, "standalone");
  assert.ok(app.localRouteKeys.includes("GET /health"));
  assert.ok(app.localRouteKeys.length >= 40, "standalone did not register the executable API");
});
