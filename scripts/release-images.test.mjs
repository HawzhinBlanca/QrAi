import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPLOYABLE_IMAGE_KEYS,
  parseImageDigestDocument,
  releaseReference,
  releaseTag,
} from "./lib/deployable-images.mjs";
import { digestFromBuildMetadata } from "./release-images.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = `sha256:${"a".repeat(64)}`;

test("release tags use the full candidate SHA in the durable registry", () => {
  assert.equal(
    releaseTag("platform-api", sha, "ExampleOwner"),
    `ghcr.io/exampleowner/qrai-platform-api:${sha}`,
  );
  assert.equal(
    releaseReference("web", digest, "ExampleOwner"),
    `ghcr.io/exampleowner/qrai-web@${digest}`,
  );
});

test("the publisher accepts only an immutable Buildx digest", () => {
  assert.equal(
    digestFromBuildMetadata(JSON.stringify({ "containerimage.digest": digest }), "web"),
    digest,
  );
  for (const metadata of ["not-json", "{}", JSON.stringify({ "containerimage.digest": "latest" })]) {
    assert.throws(() => digestFromBuildMetadata(metadata, "web"), /valid JSON|imageDigests\.web/);
  }
});

test("release digest documents have one exact entry per deployable artifact", () => {
  const document = Object.fromEntries(
    DEPLOYABLE_IMAGE_KEYS.map((key, index) => [key, `sha256:${String(index + 1).repeat(64)}`]),
  );
  assert.deepEqual(parseImageDigestDocument(JSON.stringify(document)), document);

  delete document[DEPLOYABLE_IMAGE_KEYS[0]];
  assert.throws(() => parseImageDigestDocument(JSON.stringify(document)), /imageDigests\.platform-api/);
});
