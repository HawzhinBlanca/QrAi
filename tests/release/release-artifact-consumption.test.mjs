import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEPLOYABLE_IMAGES,
  DEPLOYABLE_IMAGE_KEYS,
  parseImageDigestDocument,
  releaseRepository,
  releaseTag,
  releaseReference,
} from "../../scripts/lib/deployable-images.mjs";

const read = (path) => readFileSync(path, "utf8");
const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = `sha256:${"a".repeat(64)}`;

test("one inventory owns every release image and maps both Node roles to one backend artifact", () => {
  assert.deepEqual(DEPLOYABLE_IMAGES, [
    {
      key: "platform-api",
      composeServices: ["platform-api"],
      context: ".",
      dockerfile: "services/platform-api/Dockerfile",
    },
    {
      key: "node-backend",
      composeServices: ["node-api", "job-worker"],
      context: ".",
      dockerfile: "server/Dockerfile",
    },
    {
      key: "migration-runner",
      composeServices: ["migrations"],
      context: ".",
      dockerfile: "server/migrations.Dockerfile",
    },
    {
      key: "realtime-gateway",
      composeServices: ["realtime-gateway"],
      context: ".",
      dockerfile: "services/realtime-gateway/Dockerfile",
    },
    {
      key: "asr-inference",
      composeServices: ["asr-inference"],
      context: ".",
      dockerfile: "services/asr-inference/Dockerfile",
    },
    {
      key: "web",
      composeServices: ["web"],
      context: ".",
      dockerfile: "apps/web/Dockerfile",
    },
  ]);
  assert.deepEqual(DEPLOYABLE_IMAGE_KEYS, DEPLOYABLE_IMAGES.map(({ key }) => key));
  assert.equal(new Set(DEPLOYABLE_IMAGE_KEYS).size, DEPLOYABLE_IMAGE_KEYS.length);
});

test("registry names and immutable references are canonical, lower-case, and full-SHA bound", () => {
  assert.equal(
    releaseRepository("node-backend", "HawzhinBlanca"),
    "ghcr.io/hawzhinblanca/qrai-node-backend",
  );
  assert.equal(
    releaseTag("node-backend", sha, "HawzhinBlanca"),
    `ghcr.io/hawzhinblanca/qrai-node-backend:${sha}`,
  );
  assert.equal(
    releaseReference("node-backend", digest, "HawzhinBlanca"),
    `ghcr.io/hawzhinblanca/qrai-node-backend@${digest}`,
  );
  assert.throws(() => releaseTag("node-api", sha, "hawzhinblanca"), /unknown deployable image/);
  assert.throws(() => releaseTag("web", "short", "hawzhinblanca"), /full lowercase git sha/);
  assert.throws(() => releaseRepository("web", "bad namespace"), /registry namespace/);
});

test("digest documents require the exact canonical service keys and immutable sha256 values", () => {
  const valid = Object.fromEntries(
    DEPLOYABLE_IMAGE_KEYS.map((key, index) => [key, `sha256:${String(index + 1).repeat(64)}`]),
  );
  assert.deepEqual(parseImageDigestDocument(JSON.stringify(valid)), valid);

  const missing = { ...valid };
  delete missing.web;
  assert.throws(() => parseImageDigestDocument(JSON.stringify(missing)), /imageDigests\.web/);
  assert.throws(
    () => parseImageDigestDocument(JSON.stringify({ ...valid, "node-api": digest })),
    /unexpected image digest key.*node-api/,
  );
  assert.throws(
    () => parseImageDigestDocument(`${JSON.stringify(valid)}\nbuilding image`),
    /valid JSON/,
  );
  assert.throws(
    () => parseImageDigestDocument(JSON.stringify({ ...valid, web: "qrai/web:latest" })),
    /imageDigests\.web/,
  );
});

test("release workflow pushes durable GHCR artifacts and publishes machine JSON without tee logs", () => {
  const workflow = read(".github/workflows/release-image.yml");
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /docker\/login-action@v\d+/);
  assert.match(workflow, /registry:\s*ghcr\.io/);
  assert.match(workflow, /RELEASE_IMAGE_DIGESTS_OUTPUT/);
  assert.doesNotMatch(
    workflow,
    /^ {6}RELEASE_IMAGE_DIGESTS_OUTPUT:\s*\$\{\{\s*runner\.temp\s*\}\}/m,
    "runner context is unavailable in job-level env",
  );
  assert.match(
    workflow,
    /^ {10}RELEASE_IMAGE_DIGESTS_OUTPUT:\s*\$\{\{\s*runner\.temp\s*\}\}\/image-digests\.json/m,
  );
  assert.match(workflow, /^ {10}path:\s*\$\{\{\s*runner\.temp\s*\}\}\/image-digests\.json/m);
  assert.match(workflow, /node scripts\/release-images\.mjs/);
  assert.doesNotMatch(workflow, /tee image-digests\.json/);

  const builder = read("scripts/release-images.mjs");
  assert.match(builder, /docker["']?,\s*\[?"buildx"|docker\("buildx"/);
  assert.match(builder, /--push/);
  assert.doesNotMatch(builder, /docker\("tag"|docker\("rmi"/);
});

test("release Compose consumes exact image references, shares Node, and has no source build fallback", () => {
  const release = read("docker-compose.release.yml");
  for (const variable of [
    "PLATFORM_API_IMAGE",
    "NODE_BACKEND_IMAGE",
    "MIGRATION_RUNNER_IMAGE",
    "REALTIME_GATEWAY_IMAGE",
    "ASR_INFERENCE_IMAGE",
    "WEB_IMAGE",
  ]) {
    assert.match(release, new RegExp(`\\$\\{${variable}:\\?`), `${variable} must be required`);
  }
  assert.equal((release.match(/image:\s*"\$\{NODE_BACKEND_IMAGE:\?/g) ?? []).length, 2);
  assert.equal((release.match(/build:\s*!reset null/g) ?? []).length, DEPLOYABLE_IMAGES.length + 1);
  assert.doesNotMatch(release, /:latest\b|:-local|dockerfile:/);
});

test("ADR-0022 records durable registry artifacts rather than ephemeral runner-local rollback", () => {
  const decisions = read("docs/DECISIONS.md");
  const adr = decisions.split("## ADR-0022")[1]?.split("\n## ADR-")[0] ?? "";
  assert.match(adr, /GHCR/i);
  assert.match(adr, /durable registry/i);
  assert.match(adr, /github-hosted runner/i);
  assert.doesNotMatch(adr, /\*\*ACCEPTED[^\n]*option \(A\)/i);
});
