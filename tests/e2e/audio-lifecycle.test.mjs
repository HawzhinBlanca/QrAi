import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AudioObjectConflictError,
  AudioObjectIntegrityError,
  AudioObjectStoreError,
  createAudioObjectStoreFromEnv,
  createFilesystemAudioObjectStore,
  createS3AudioObjectStore,
  deriveAudioObjectKey,
} from "../../server/src/storage/audio-object-store.mjs";
import { parseCompleteStoredMetadata } from "./lib/stored-metadata.mjs";

const IDENTITY = {
  tenantId: "tenant-a",
  learnerId: "learner-a",
  sessionId: "session-a",
  chunkId: "chunk-a",
};
const RETAINED = {
  ...IDENTITY,
  audioRetention: "teacher-review",
  sampleRate: 16_000,
  startMs: 0,
  endMs: 500,
};
const AUDIO = Buffer.from("private-child-recitation");

test("sidecar polling waits for the complete JSON-line publication marker", () => {
  assert.equal(parseCompleteStoredMetadata(""), null);
  assert.equal(parseCompleteStoredMetadata('{"chunkId":"chunk-a"}'), null);
  assert.deepEqual(parseCompleteStoredMetadata('{"chunkId":"chunk-a"}\n'), {
    chunkId: "chunk-a",
  });
  assert.throws(() => parseCompleteStoredMetadata("not-json\n"), SyntaxError);
});

function preconditionFailed() {
  const error = new Error("precondition failed");
  error.$metadata = { httpStatusCode: 412 };
  return error;
}

class MemoryS3Client {
  constructor({ pageSize = 2 } = {}) {
    this.calls = [];
    this.objects = new Map();
    this.pageSize = pageSize;
    this.deleteErrorKey = null;
    this.bodyFactory = null;
    this.destroyed = false;
  }

  async send(command, options = {}) {
    const name = command.constructor.name;
    const input = command.input;
    this.calls.push({ name, input, options });
    if (options.abortSignal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (name === "HeadBucketCommand") return {};
    if (name === "PutObjectCommand") {
      if (input.IfNoneMatch !== "*") throw new Error("test S3 requires create-only writes");
      if (this.objects.has(input.Key)) throw preconditionFailed();
      this.objects.set(input.Key, {
        bytes: Buffer.from(input.Body),
        checksum: input.ChecksumSHA256,
        metadata: { ...input.Metadata },
      });
      return { ChecksumSHA256: input.ChecksumSHA256 };
    }
    if (name === "HeadObjectCommand") {
      const stored = this.objects.get(input.Key);
      if (!stored) {
        const error = new Error("not found");
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        ChecksumSHA256: stored.checksum,
        ContentLength: stored.bytes.length,
        Metadata: stored.metadata,
      };
    }
    if (name === "GetObjectCommand") {
      const stored = this.objects.get(input.Key);
      if (!stored) {
        const error = new Error("not found");
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        ChecksumSHA256: stored.checksum,
        ContentLength: stored.bytes.length,
        Metadata: stored.metadata,
        Body: this.bodyFactory?.(stored) ?? {
          transformToByteArray: async () => Uint8Array.from(stored.bytes),
        },
      };
    }
    if (name === "ListObjectsV2Command") {
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(input.Prefix)).sort();
      const offset = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
      const page = keys.slice(offset, offset + this.pageSize);
      const next = offset + page.length;
      return {
        Contents: page.map((Key) => ({ Key, Size: this.objects.get(Key).bytes.length })),
        IsTruncated: next < keys.length,
        NextContinuationToken: next < keys.length ? String(next) : undefined,
      };
    }
    if (name === "DeleteObjectsCommand") {
      const Errors = [];
      const Deleted = [];
      for (const { Key } of input.Delete.Objects) {
        if (Key === this.deleteErrorKey) {
          Errors.push({ Key, Code: "AccessDenied", Message: "denied" });
        } else {
          this.objects.delete(Key);
          Deleted.push({ Key });
        }
      }
      return { Deleted, Errors };
    }
    throw new Error(`unsupported fake S3 command ${name}`);
  }

  destroy() {
    this.destroyed = true;
  }
}

test("object keys are versioned and derived from all four validated ownership parts", () => {
  assert.equal(
    deriveAudioObjectKey(IDENTITY),
    "audio/v1/tenant-a/learner-a/session-a/chunk-a.pcm",
  );
  for (const field of Object.keys(IDENTITY)) {
    for (const hostile of ["", ".", "..", "a/../b", "a\\b", "a\0b", " space"] ) {
      assert.throws(
        () => deriveAudioObjectKey({ ...IDENTITY, [field]: hostile }),
        new RegExp(field),
      );
    }
  }
});

test("filesystem put/read is create-only, hash-idempotent, isolated, and integrity checked", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "qrai-audio-store-"));
  const store = createFilesystemAudioObjectStore({ rootDir });
  const first = await store.put({ ...RETAINED, audioBytes: AUDIO });
  const retry = await store.put({ ...RETAINED, audioBytes: AUDIO });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.sha256, first.sha256);
  await assert.rejects(
    store.put({ ...RETAINED, audioBytes: Buffer.from("different") }),
    AudioObjectConflictError,
  );
  assert.deepEqual((await store.get(IDENTITY)).audioBytes, AUDIO);

  await store.put({
    ...RETAINED,
    learnerId: "learner-b",
    chunkId: "chunk-b",
    audioBytes: Buffer.from("other learner"),
  });
  assert.deepEqual((await store.listLearner(IDENTITY)).map((item) => item.objectKey), [first.objectKey]);
  assert.deepEqual(await store.deleteLearner(IDENTITY), {
    deletedObjectKeys: [first.objectKey],
    deletedOtherObjectKeys: [],
    fullyErased: true,
  });
  assert.deepEqual(await store.deleteLearner(IDENTITY), {
    deletedObjectKeys: [],
    deletedOtherObjectKeys: [],
    fullyErased: true,
  });
  assert.equal((await store.listLearner({ ...IDENTITY, learnerId: "learner-b" })).length, 1);

  const corruptIdentity = { ...IDENTITY, learnerId: "learner-b", chunkId: "chunk-b" };
  const corruptKey = deriveAudioObjectKey(corruptIdentity);
  writeFileSync(join(rootDir, corruptKey), Buffer.from("corrupted after storage"));
  await assert.rejects(store.get(corruptIdentity), AudioObjectIntegrityError);
  assert.doesNotMatch(readFileSync(join(rootDir, `${corruptKey}.meta.json`), "utf8"), /private-child/);
});

test("filesystem inventory exposes both halves of interrupted writes for reconciliation", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "qrai-audio-inventory-"));
  const store = createFilesystemAudioObjectStore({ rootDir });
  const dataOnly = { ...RETAINED, sessionId: "session-data", chunkId: "chunk-data" };
  const metadataOnly = { ...RETAINED, sessionId: "session-meta", chunkId: "chunk-meta" };
  await store.put({ ...dataOnly, audioBytes: AUDIO });
  await store.put({ ...metadataOnly, audioBytes: AUDIO });
  unlinkSync(join(rootDir, `${deriveAudioObjectKey(dataOnly)}.meta.json`));
  unlinkSync(join(rootDir, deriveAudioObjectKey(metadataOnly)));

  const inventory = await store.inventory();
  assert.deepEqual(
    inventory.map(({ objectKey, dataPresent, metadataPresent }) => ({
      objectKey,
      dataPresent,
      metadataPresent,
    })),
    [
      { objectKey: deriveAudioObjectKey(dataOnly), dataPresent: true, metadataPresent: false },
      { objectKey: deriveAudioObjectKey(metadataOnly), dataPresent: false, metadataPresent: true },
    ],
  );
});

test("S3 put uses conditional creation, full SHA-256, private metadata, and bounded cancellation", async () => {
  const client = new MemoryS3Client();
  const store = createS3AudioObjectStore({ client, bucket: "private-audio" });
  const first = await store.put({ ...RETAINED, audioBytes: AUDIO });
  const retry = await store.put({ ...RETAINED, audioBytes: AUDIO });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);

  const put = client.calls.find((call) => call.name === "PutObjectCommand");
  assert.equal(put.input.Bucket, "private-audio");
  assert.equal(put.input.Key, deriveAudioObjectKey(IDENTITY));
  assert.equal(put.input.IfNoneMatch, "*");
  assert.match(put.input.ChecksumSHA256, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(put.input.ACL, undefined, "bucket-owner-enforced storage must receive no object ACL");
  assert.equal(put.input.Metadata["qrai-tenant-id"], IDENTITY.tenantId);
  assert.equal(put.input.Metadata["qrai-session-id"], IDENTITY.sessionId);

  await assert.rejects(
    store.put({ ...RETAINED, audioBytes: Buffer.from("conflicting bytes") }),
    AudioObjectConflictError,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.get(IDENTITY, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(client.calls.at(-1).options.abortSignal, controller.signal);

  let bodyDestroyed = false;
  client.bodyFactory = () => ({
    transformToByteArray: () => new Promise(() => {}),
    destroy(error) {
      bodyDestroyed = error?.name === "AbortError";
    },
  });
  const bodyController = new AbortController();
  const stalledRead = store.get(IDENTITY, { signal: bodyController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  bodyController.abort();
  await assert.rejects(stalledRead, { name: "AbortError" });
  assert.equal(bodyDestroyed, true, "aborted response body was not destroyed");

  await store.close();
  assert.equal(client.destroyed, true);
});

test("S3 learner list paginates every page and never escapes the derived prefix", async () => {
  const client = new MemoryS3Client({ pageSize: 2 });
  const store = createS3AudioObjectStore({ client, bucket: "private-audio" });
  for (let index = 0; index < 5; index += 1) {
    await store.put({
      ...RETAINED,
      sessionId: `session-${index}`,
      chunkId: `chunk-${index}`,
      audioBytes: Buffer.from(`audio-${index}`),
    });
  }
  await store.put({ ...RETAINED, learnerId: "learner-b", audioBytes: Buffer.from("foreign") });
  const listed = await store.listLearner(IDENTITY);
  assert.equal(listed.length, 5);
  const listCalls = client.calls.filter((call) => call.name === "ListObjectsV2Command");
  assert.equal(listCalls.length, 3);
  for (const call of listCalls) assert.equal(call.input.Prefix, "audio/v1/tenant-a/learner-a/");
});

test("S3 delete inspects HTTP-200 per-key errors and never claims partial erasure", async () => {
  const client = new MemoryS3Client({ pageSize: 2 });
  const store = createS3AudioObjectStore({ client, bucket: "private-audio" });
  for (let index = 0; index < 3; index += 1) {
    await store.put({
      ...RETAINED,
      sessionId: `delete-session-${index}`,
      chunkId: `delete-chunk-${index}`,
      audioBytes: Buffer.from(`delete-${index}`),
    });
  }
  client.deleteErrorKey = deriveAudioObjectKey({
    ...IDENTITY,
    sessionId: "delete-session-1",
    chunkId: "delete-chunk-1",
  });
  await assert.rejects(store.deleteLearner(IDENTITY), AudioObjectStoreError);
  assert.equal(client.objects.has(client.deleteErrorKey), true, "the failed key vanished from the fake store");
  client.deleteErrorKey = null;
  assert.equal((await store.deleteLearner(IDENTITY)).deletedObjectKeys.length, 1);
  const unknownKey = "audio/v1/tenant-a/learner-a/interrupted-upload.tmp";
  client.objects.set(unknownKey, { bytes: Buffer.from("partial"), checksum: null, metadata: {} });
  const unknownDeletion = await store.deleteLearner(IDENTITY);
  assert.deepEqual(unknownDeletion, {
    deletedObjectKeys: [],
    deletedOtherObjectKeys: [unknownKey],
    fullyErased: true,
  });
  assert.equal(client.objects.has(unknownKey), false, "an unknown learner object survived S3 erasure");
  assert.deepEqual(await store.deleteLearner(IDENTITY), {
    deletedObjectKeys: [],
    deletedOtherObjectKeys: [],
    fullyErased: true,
  });
});

test("production configuration refuses filesystem fallback and incomplete S3 settings", () => {
  assert.throws(
    () => createAudioObjectStoreFromEnv({ env: {}, production: true }),
    /AUDIO_STORAGE_DRIVER is required/,
  );
  assert.throws(
    () => createAudioObjectStoreFromEnv({
      env: { AUDIO_STORAGE_DRIVER: "filesystem", AUDIO_STORAGE_DIR: "/tmp/not-created" },
      production: true,
    }),
    /development\/test only/,
  );
  assert.throws(
    () => createAudioObjectStoreFromEnv({ env: { AUDIO_STORAGE_DRIVER: "s3" }, production: true }),
    /AUDIO_STORAGE_S3_BUCKET/,
  );
  assert.throws(
    () => createAudioObjectStoreFromEnv({ env: { AUDIO_STORAGE_DRIVER: "unknown" } }),
    /unsupported AUDIO_STORAGE_DRIVER/,
  );
});
