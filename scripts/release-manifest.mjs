import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const manifestPath = join("specs", "number-one-release", "release-manifest.json");

const trackedSpecFiles = [
  join("specs", "number-one-release", "plan.md"),
  join("specs", "number-one-release", "spec.md"),
  join("specs", "number-one-release", "research.md"),
  join("specs", "number-one-release", "impact-map.md"),
  join("specs", "number-one-release", "tasks.md")
];

function getGitSha() {
  return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
}

function checkCleanWorkingTree() {
  try {
    execSync("git diff --exit-code", { stdio: "ignore" });
    execSync("git diff --cached --exit-code", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getFileSha256(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`File not found for hashing: ${filePath}`);
  }
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function getDockerImageDigests() {
  const services = ["platform-api", "realtime-gateway", "ml-inference", "asr-inference", "web"];
  const digests = {};
  for (const svc of services) {
    try {
      // Try to get local docker image ID or digest if available
      const imageId = execSync(`docker compose images -q ${svc}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      digests[svc] = imageId || null;
    } catch {
      digests[svc] = null;
    }
  }
  return digests;
}

function generate() {
  console.log("Generating release manifest...");

  if (!checkCleanWorkingTree()) {
    console.error("ERROR: Git working tree is dirty. Cannot generate manifest on a dirty tree.");
    process.exit(1);
  }

  const sha = getGitSha();
  const timestamp = new Date().toISOString();
  const traceId = `release-trace-${createHash("sha256").update(sha + timestamp).digest("hex").slice(0, 16)}`;
  
  const artifactHashes = {};
  for (const file of trackedSpecFiles) {
    artifactHashes[file] = getFileSha256(file);
  }

  const manifest = {
    schemaVersion: "1.0.0",
    timestamp,
    candidateSha: sha,
    traceId,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pnpmVersion: execSync("pnpm --version", { encoding: "utf8" }).trim()
    },
    imageDigests: getDockerImageDigests(),
    artifactHashes
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Release manifest successfully generated at: ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

function verify() {
  console.log("Verifying release manifest...");

  if (!existsSync(manifestPath)) {
    console.error(`ERROR: Release manifest not found at ${manifestPath}`);
    process.exit(1);
  }

  const manifestContent = readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch (err) {
    console.error(`ERROR: Failed to parse manifest JSON: ${err.message}`);
    process.exit(1);
  }

  // 1. Verify Git working tree is clean
  if (!checkCleanWorkingTree()) {
    console.error("ERROR: Git working tree is dirty. Stale or modified files present.");
    process.exit(1);
  }

  // 2. Verify Current SHA matches Candidate SHA (or parent SHA if the manifest itself was just committed)
  const currentSha = getGitSha();
  let matched = currentSha === manifest.candidateSha;
  if (!matched) {
    try {
      const parentSha = execSync("git rev-parse HEAD~1", { encoding: "utf8" }).trim();
      matched = parentSha === manifest.candidateSha;
    } catch {}
  }
  if (!matched) {
    console.error(`ERROR: Commit SHA mismatch! Current: ${currentSha}, Manifest candidate: ${manifest.candidateSha}`);
    process.exit(1);
  }

  // 3. Verify Artifact hashes match exactly
  for (const [file, expectedHash] of Object.entries(manifest.artifactHashes)) {
    if (!existsSync(file)) {
      console.error(`ERROR: Spec file missing: ${file}`);
      process.exit(1);
    }
    const actualHash = getFileSha256(file);
    if (actualHash !== expectedHash) {
      console.error(`ERROR: Hash mismatch for ${file}! Expected: ${expectedHash}, Actual: ${actualHash}`);
      process.exit(1);
    }
  }

  console.log("SUCCESS: Release manifest verified. Evidence integrity matches the candidate SHA.");
}

const args = process.argv.slice(2);
if (args.includes("--generate")) {
  generate();
} else if (args.includes("--verify")) {
  verify();
} else {
  console.log("Usage: node scripts/release-manifest.mjs [--generate | --verify]");
  process.exit(2);
}
