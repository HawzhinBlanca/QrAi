import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const retiredService = path.join(repoRoot, "services/tajweed-neural");

test("the superseded standalone Tajweed experiment stays retired", async () => {
  await assert.rejects(access(retiredService), { code: "ENOENT" });
});

test("living topology and release documents cannot reactivate the retired service", async () => {
  const activeTopologyFiles = [
    "docker-compose.yml",
    "docs/architecture/10-10-platform.md",
    "docs/SHIP_READINESS.md",
  ];

  for (const relativePath of activeTopologyFiles) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /services\/tajweed-neural|TAJWEED_NEURAL|tajweed-neural/,
      `${relativePath}: retired service is still described as active topology`,
    );
  }
});
