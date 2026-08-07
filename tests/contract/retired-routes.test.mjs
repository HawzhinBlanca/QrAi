import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOpenapi } from "./lib/openapi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "packages/contracts/route-manifest.json"), "utf8"),
);
const spec = loadOpenapi(join(repoRoot, "packages/contracts/openapi.yaml"));
const decisions = readFileSync(join(repoRoot, "docs/DECISIONS.md"), "utf8");
const key = ({ method, path }) => `${method.toUpperCase()} ${path}`;

const expectedRetirements = [
  "GET /v1/agent-runs",
  "POST /v1/agent-runs",
  "POST /v1/auth/login",
  "POST /v1/auth/register",
];

test("exactly four baseline operations are deliberately retired by ADR-0038", () => {
  const retired = manifest.baselineOperations.filter((operation) => operation.target === "retire");
  assert.deepEqual(retired.map(key).sort(), expectedRetirements);
  assert.ok(retired.every((operation) => operation.decision === "ADR-0038"));
  assert.ok(retired.every((operation) => operation.removalGate === "zero-production-callers"));

  const section = decisions.split("## ADR-0038")[1]?.split("\n## ADR-")[0] ?? "";
  assert.match(section, /\*\*Status:\*\* Accepted/);
  for (const operation of expectedRetirements) assert.ok(section.includes(`\`${operation}\``));
});

test("planned retirement is visible without lying about the still-running compatibility surface", () => {
  for (const operationKey of expectedRetirements) {
    const [method, path] = operationKey.split(" ");
    const operation = spec.paths[path]?.[method.toLowerCase()];
    assert.ok(operation, `${operationKey}: current runtime operation vanished before cutover`);
    assert.equal(operation["x-target-status"], "retired");
    assert.equal(operation["x-retirement-decision"], "ADR-0038");
  }
});

test("every current production caller of a retired path is inventoried and blocks removal", () => {
  const sourceFiles = globSync(
    ["apps/**/*.{dart,js,mjs,ts,tsx}", "services/agents/**/*.{js,mjs,ts,tsx}"],
    { cwd: repoRoot },
  ).filter(
    (file) =>
      !file.includes("node_modules/") &&
      !file.includes("/dist/") &&
      !file.includes("/build/") &&
      !/\.test\.[^.]+$/.test(file),
  );

  for (const operation of manifest.baselineOperations.filter((item) => item.target === "retire")) {
    const actualCallers = sourceFiles
      .filter((file) => readFileSync(join(repoRoot, file), "utf8").includes(operation.path))
      .map((file) => relative(repoRoot, join(repoRoot, file)))
      .sort();
    assert.deepEqual(actualCallers, [...operation.transitionalCallers].sort(), `${key(operation)} callers drifted`);
    assert.equal(operation.removalState, "blocked-by-transitional-callers");
  }
});

test("retired operations cannot re-enter the mechanically generated target set", () => {
  const targetKeys = new Set([
    ...manifest.baselineOperations.filter((operation) => operation.target === "retain").map(key),
    ...manifest.targetAdditions.map(key),
  ]);
  for (const retired of expectedRetirements) assert.equal(targetKeys.has(retired), false);
});
