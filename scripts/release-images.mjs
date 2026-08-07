#!/usr/bin/env node
/**
 * AR1 — build immutable, digest-pinned deployable images, and keep the previous ones.
 * docs/DECISIONS.md ADR-0022 · specs/migration-completion/plan.md §3
 *
 * ── Why `docker compose build` is not this ──────────────────────────────────────────────────────
 * `.github/workflows/docker-build.yml` already builds every image, and that is NOT a rollback
 * target. It produces no stable identifier, records no digest, and retains nothing — the next build
 * replaces it. "We can build the image" and "we can go back to the image that was running" are
 * different claims, and only the second one helps at 3am.
 *
 * A rollback target needs three things, and this script produces all three:
 *   1. a STABLE tag, derived from the git SHA, so a specific commit's image can be named later;
 *   2. the image DIGEST, so what is deployed is verifiable rather than assumed — the release
 *      manifest already demands these (`scripts/release-manifest.mjs` assertImageDigests);
 *   3. RETENTION, so the previous image still exists when the current one turns out to be wrong.
 *
 * ── What option (A) does NOT give ───────────────────────────────────────────────────────────────
 * These tags live only on the host that built them. A replacement host has nothing to roll back to,
 * so this is INCIDENT rollback, not disaster recovery. ADR-0022 says so and the owner accepted it
 * with that limit understood; `docs/DECISIONS.md` records it rather than leaving it to be
 * discovered during an outage.
 *
 * The decision functions are exported and pure, so `release-images.test.mjs` can test the retention
 * rule without a Docker daemon — the same reason `insecure.rs` splits `is_relaxed` from the process
 * environment.
 */
import { execFileSync } from "node:child_process";

/** Every service that ships as an image. `postgres` is upstream and already digest-addressable. */
export const SERVICES = [
  "platform-api",
  "node-api",
  "realtime-gateway",
  "ml-inference",
  "asr-inference",
  "web",
];

export const REPO_PREFIX = "qrai";

/** `qrai/platform-api:9f3c1ab`. Short SHA: long enough to be unambiguous, short enough to read. */
export function imageTag(service, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new TypeError(`expected a git SHA, got ${JSON.stringify(sha)}`);
  }
  return `${REPO_PREFIX}/${service}:${sha.slice(0, 7)}`;
}

/**
 * Which tags to remove, given every tag that exists for one service and how many to keep.
 *
 * `existing` is newest-first, as `docker images --format` returns with its default ordering.
 *
 * The rule is deliberately conservative: it never prunes below `keep`, and it never prunes a tag
 * that is not ours. A retention bug here deletes the thing you were about to roll back to, so the
 * two guards are worth more than the brevity of `slice(keep)` alone.
 */
export function tagsToPrune(existing, keep) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new RangeError(`keep must be a positive integer, got ${keep}`);
  }
  const ours = existing.filter((t) => t.startsWith(`${REPO_PREFIX}/`));
  return ours.slice(keep);
}

/** Parse `docker images` digest output into `{ [tag]: "sha256:…" }`. */
export function parseDigests(lines) {
  const out = {};
  for (const line of lines) {
    const [tag, id] = line.trim().split(/\s+/);
    if (!tag || !id) continue;
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) continue;
    out[tag] = id;
  }
  return out;
}

// ── side effects below ──────────────────────────────────────────────────────────────────────────

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });

function main() {
  const gitSha =
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const keep = Number(process.env.RELEASE_IMAGE_KEEP ?? 3);

  const digests = {};
  for (const service of SERVICES) {
    const tag = imageTag(service, gitSha);
    console.log(`building ${tag}`);
    // `docker compose build` cannot tag by SHA, which is exactly why it is not a rollback target.
    docker("compose", "build", service);
    // Re-tag compose's output under the stable name.
    const composeImage = `${process.env.COMPOSE_PROJECT_NAME ?? "qrai"}-${service}`;
    docker("tag", composeImage, tag);

    const id = docker("image", "inspect", tag, "--format", "{{.Id}}").trim();
    digests[tag] = id;
  }

  // Retention, per service, so one noisy service cannot evict another's rollback target.
  for (const service of SERVICES) {
    const existing = docker(
      "images",
      `${REPO_PREFIX}/${service}`,
      "--format",
      "{{.Repository}}:{{.Tag}}",
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const tag of tagsToPrune(existing, keep)) {
      console.log(`pruning ${tag}`);
      docker("rmi", tag);
    }
  }

  // The manifest verifier already demands these (release-manifest.mjs assertImageDigests). Emitting
  // them for real is the point: the alternative was relaxing the verifier to match reality.
  console.log(JSON.stringify(digests, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
