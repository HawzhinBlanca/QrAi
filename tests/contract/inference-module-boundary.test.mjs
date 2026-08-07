import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

const OWNED_MODULES = [
  "server/src/inference/alignment.mjs",
  "server/src/inference/model-attribution.mjs",
  "server/src/inference/runtime.mjs",
  "server/src/inference/tajweed.mjs",
  "server/src/inference/fixtures/golden-evals.json",
];

const RELOCATED_TESTS = [
  "acoustic-shadow.test.mjs",
  "alignment.test.mjs",
  "chunk-overwrite.test.mjs",
  "golden-regression.test.mjs",
  "marks-parity.test.mjs",
  "model-attribution.test.mjs",
  "privacy-erasure.test.mjs",
  "rate-limit.test.mjs",
  "server.test.mjs",
  "session-transcript.test.mjs",
  "storage-driver.test.mjs",
  "tajweed.test.mjs",
];

test("server package owns inference implementation and runtime assets", () => {
  for (const path of OWNED_MODULES) {
    assert.ok(existsSync(join(root, path)), `missing server-owned inference asset: ${path}`);
  }

  for (const name of ["Dockerfile", "README.md", "server.mjs"]) {
    assert.ok(!existsSync(join(root, "services/ml-inference", name)), `retired ML source remains: ${name}`);
  }

  const productionSources = [
    ...readdirSync(join(root, "server/src"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.mjs$/.test(entry.name))
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")),
  ].join("\n");
  assert.doesNotMatch(productionSources, /services\/ml-inference/);
  assert.equal(
    existsSync(join(root, "scripts/privacy-audit-run.mjs")),
    false,
    "obsolete staging audit bypasses the maintained smoke/privacy boundary",
  );
});

test("ML behavior tests run from the shared inference test boundary", () => {
  for (const name of RELOCATED_TESTS) {
    assert.ok(existsSync(join(root, "tests/inference", name)), `missing relocated test: ${name}`);
    assert.ok(!existsSync(join(root, "services/ml-inference", name)), `old test remains: ${name}`);
  }

  const verify = read("scripts/verify.sh");
  assert.match(verify, /tests\/contract\/inference-module-boundary\.test\.mjs/);
  for (const name of RELOCATED_TESTS) {
    assert.match(verify, new RegExp(`tests/inference/${name.replaceAll(".", "\\.")}`));
    assert.doesNotMatch(verify, new RegExp(`services/ml-inference/${name.replaceAll(".", "\\.")}`));
  }
});

test("relocated canonical inference sources keep byte-order and escaped-regex guards", () => {
  const sources = OWNED_MODULES
    .filter((path) => /\.(?:mjs)$/.test(path))
    .map(read)
    .join("\n");
  assert.doesNotMatch(sources, /\.normalize\s*\(/, "canonical inference must not call String.normalize");
});

test("importing inference does not allocate storage or create an audit directory", () => {
  const work = mkdtempSync(join(tmpdir(), "qrai-inference-import-"));
  const storagePath = join(work, "must-not-exist");
  try {
    const entrypoint = new URL("../../server/src/inference/runtime.mjs", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entrypoint)})`],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          AUDIO_STORAGE_DRIVER: "s3",
          AUDIO_STORAGE_DIR: storagePath,
          AUDIO_S3_BUCKET: "",
          ML_USE_GOLDEN_FIXTURES: "",
          ML_ACKNOWLEDGE_FIXTURE_OUTPUT: "",
        },
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(existsSync(storagePath), false, "module import touched local storage");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
