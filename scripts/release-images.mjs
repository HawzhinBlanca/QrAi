#!/usr/bin/env node
/**
 * Publish every release image to GHCR under the candidate's full Git SHA and
 * write a machine-only JSON map of the resulting immutable image digests.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEPLOYABLE_IMAGES,
  parseImageDigestDocument,
  releaseTag,
} from "./lib/deployable-images.mjs";

const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] });

export function digestFromBuildMetadata(metadataText, imageKey) {
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new TypeError(`build metadata for ${imageKey} must be valid JSON`);
  }
  const digest = metadata?.["containerimage.digest"];
  parseImageDigestDocument(
    JSON.stringify(
      Object.fromEntries(DEPLOYABLE_IMAGES.map(({ key }) => [key, key === imageKey ? digest : `sha256:${"0".repeat(64)}`])),
    ),
  );
  return digest;
}

export function publishReleaseImages({ gitSha, namespace, outputPath }) {
  if (!outputPath) {
    throw new TypeError("RELEASE_IMAGE_DIGESTS_OUTPUT is required");
  }

  const metadataDirectory = mkdtempSync(join(tmpdir(), "qrai-release-images-"));
  const imageDigests = {};
  try {
    for (const image of DEPLOYABLE_IMAGES) {
      const tag = releaseTag(image.key, gitSha, namespace);
      const metadataPath = join(metadataDirectory, `${image.key}.json`);
      console.log(`publishing ${tag}`);
      docker("buildx", "build",
        "--push",
        "--file",
        image.dockerfile,
        "--tag",
        tag,
        "--metadata-file",
        metadataPath,
        image.context,
      );
      imageDigests[image.key] = digestFromBuildMetadata(readFileSync(metadataPath, "utf8"), image.key);
    }

    const validated = parseImageDigestDocument(JSON.stringify(imageDigests));
    writeFileSync(outputPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    console.log(`published ${DEPLOYABLE_IMAGES.length} immutable release images`);
    return validated;
  } finally {
    rmSync(metadataDirectory, { recursive: true, force: true });
  }
}

function main() {
  const gitSha =
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  publishReleaseImages({
    gitSha,
    namespace: process.env.RELEASE_REGISTRY_NAMESPACE,
    outputPath: process.env.RELEASE_IMAGE_DIGESTS_OUTPUT,
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
