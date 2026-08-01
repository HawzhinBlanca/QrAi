/**
 * AR1 — the retention rule, tested without a Docker daemon.
 *
 * A bug here deletes the image you were about to roll back to, which is the one moment nobody is
 * reading test output. So the decision functions are pure and the rule is pinned directly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { REPO_PREFIX, SERVICES, imageTag, parseDigests, tagsToPrune } from "./release-images.mjs";

test("a tag is derived from the git SHA and is stable", () => {
  assert.equal(imageTag("platform-api", "9f3c1abcdef0123"), "qrai/platform-api:9f3c1ab");
  // The same commit always produces the same tag — that is what makes it a rollback TARGET rather
  // than just a build output.
  assert.equal(imageTag("web", "9f3c1abcdef0123"), imageTag("web", "9f3c1abcdef0123"));
});

test("anything that is not a git SHA is refused", () => {
  for (const bad of ["", "HEAD", "latest", "main", "../etc", "9f3c1a", "9F3C1AB"]) {
    assert.throws(() => imageTag("web", bad), TypeError, `${JSON.stringify(bad)} must be refused`);
  }
});

test("retention keeps the newest N and prunes the rest", () => {
  const tags = ["qrai/web:aaaaaaa", "qrai/web:bbbbbbb", "qrai/web:ccccccc", "qrai/web:ddddddd"];
  assert.deepEqual(tagsToPrune(tags, 3), ["qrai/web:ddddddd"]);
  assert.deepEqual(tagsToPrune(tags, 2), ["qrai/web:ccccccc", "qrai/web:ddddddd"]);
});

test("retention NEVER prunes below the keep count", () => {
  // The failure that matters: pruning when there is nothing spare leaves no rollback target at all.
  assert.deepEqual(tagsToPrune(["qrai/web:aaaaaaa"], 3), []);
  assert.deepEqual(tagsToPrune([], 3), []);
  assert.deepEqual(tagsToPrune(["qrai/web:a", "qrai/web:b"], 2), []);
});

test("retention NEVER prunes a tag that is not ours", () => {
  // `docker images` output can carry anything on a shared host. Removing someone else's image
  // during a release is not a recoverable mistake.
  const mixed = [
    "postgres:16-alpine",
    "qrai/web:aaaaaaa",
    "ghcr.io/someone/else:v1",
    "qrai/web:bbbbbbb",
    "node:22",
  ];
  assert.deepEqual(tagsToPrune(mixed, 1), ["qrai/web:bbbbbbb"]);
  for (const pruned of tagsToPrune(mixed, 0 + 1)) {
    assert.ok(pruned.startsWith(`${REPO_PREFIX}/`), `${pruned} is not ours and must not be pruned`);
  }
});

test("a keep count of zero or less is refused rather than pruning everything", () => {
  for (const keep of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => tagsToPrune(["qrai/web:a"], keep), RangeError);
  }
});

test("digests are parsed, and anything that is not a sha256 is ignored", () => {
  const parsed = parseDigests([
    "qrai/web:aaaaaaa sha256:" + "a".repeat(64),
    "qrai/api:bbbbbbb <none>",
    "  ",
    "qrai/ml:ccccccc sha256:tooshort",
  ]);
  assert.deepEqual(parsed, { "qrai/web:aaaaaaa": "sha256:" + "a".repeat(64) });
});

test("every compose-built service is covered", () => {
  // If a service is added to docker-compose.yml and not here, it has no rollback target and nothing
  // says so. The list is asserted against the compose file itself.
  assert.deepEqual(SERVICES, [
    "platform-api",
    "realtime-gateway",
    "ml-inference",
    "asr-inference",
    "web",
  ]);
});
