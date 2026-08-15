import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const SCHEMA_VERSION = "1";
const KEY_ROOT = "audio/v1";
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const ALLOWED_RETENTION = new Set(["discard", "teacher-review", "training-opt-in"]);
const ALLOWED_SAMPLE_RATES = new Set([16_000, 24_000, 48_000]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class AudioObjectStoreError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AudioObjectStoreError";
  }
}

export class AudioObjectConflictError extends AudioObjectStoreError {
  constructor() {
    super("audio object identity already contains different content or metadata");
    this.name = "AudioObjectConflictError";
  }
}

export class AudioObjectNotFoundError extends AudioObjectStoreError {
  constructor() {
    super("audio object was not found");
    this.name = "AudioObjectNotFoundError";
  }
}

export class AudioObjectIntegrityError extends AudioObjectStoreError {
  constructor() {
    super("audio object failed integrity validation");
    this.name = "AudioObjectIntegrityError";
  }
}

function safeSegment(value, fieldName) {
  if (
    typeof value !== "string" ||
    !SEGMENT.test(value) ||
    value.includes("..") ||
    value.includes("\0")
  ) {
    throw new TypeError(`${fieldName} is not a safe storage identity segment`);
  }
  return value;
}

function identityOf(value) {
  return {
    tenantId: safeSegment(value?.tenantId, "tenantId"),
    learnerId: safeSegment(value?.learnerId, "learnerId"),
    sessionId: safeSegment(value?.sessionId, "sessionId"),
    chunkId: safeSegment(value?.chunkId, "chunkId"),
  };
}

function sessionOf(value) {
  return {
    tenantId: safeSegment(value?.tenantId, "tenantId"),
    learnerId: safeSegment(value?.learnerId, "learnerId"),
    sessionId: safeSegment(value?.sessionId, "sessionId"),
  };
}

export function deriveAudioObjectKey(value) {
  const identity = identityOf(value);
  return `${KEY_ROOT}/${identity.tenantId}/${identity.learnerId}/${identity.sessionId}/${identity.chunkId}.pcm`;
}

export function deriveAudioLearnerPrefix(value) {
  const tenantId = safeSegment(value?.tenantId, "tenantId");
  const learnerId = safeSegment(value?.learnerId, "learnerId");
  return `${KEY_ROOT}/${tenantId}/${learnerId}/`;
}

export function parseAudioObjectKey(key) {
  if (typeof key !== "string") throw new TypeError("objectKey must be a string");
  const parts = key.split("/");
  if (parts.length !== 6 || parts[0] !== "audio" || parts[1] !== "v1") {
    throw new TypeError("objectKey is not a versioned audio key");
  }
  const file = parts[5];
  if (!file.endsWith(".pcm")) throw new TypeError("objectKey is not a PCM audio object");
  return identityOf({
    tenantId: parts[2],
    learnerId: parts[3],
    sessionId: parts[4],
    chunkId: file.slice(0, -4),
  });
}

function sha256(bytes) {
  const digest = createHash("sha256").update(bytes).digest();
  return { base64: digest.toString("base64"), hex: digest.toString("hex") };
}

function equalDigest(leftHex, rightHex) {
  if (!/^[a-f0-9]{64}$/.test(leftHex ?? "") || !/^[a-f0-9]{64}$/.test(rightHex ?? "")) {
    return false;
  }
  return timingSafeEqual(Buffer.from(leftHex, "hex"), Buffer.from(rightHex, "hex"));
}

function nullableSpan(startMs, endMs) {
  if (startMs == null && endMs == null) return { startMs: null, endMs: null };
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs > 2_147_483_647
  ) {
    throw new TypeError("startMs/endMs must both be null or satisfy 0 <= startMs < endMs");
  }
  return { startMs, endMs };
}

function putDocument(value) {
  const identity = identityOf(value);
  if (!Buffer.isBuffer(value.audioBytes) && !(value.audioBytes instanceof Uint8Array)) {
    throw new TypeError("audioBytes must be bytes");
  }
  const audioBytes = Buffer.from(value.audioBytes);
  if (audioBytes.length === 0 || audioBytes.length > MAX_AUDIO_BYTES) {
    throw new TypeError(`audioBytes must contain 1..${MAX_AUDIO_BYTES} bytes`);
  }
  if (!ALLOWED_RETENTION.has(value.audioRetention)) {
    throw new TypeError("audioRetention is not an allowed retention mode");
  }
  if (!ALLOWED_SAMPLE_RATES.has(value.sampleRate)) {
    throw new TypeError("sampleRate is not an allowed audio sample rate");
  }
  const span = nullableSpan(value.startMs, value.endMs);
  const digest = sha256(audioBytes);
  return {
    audioBytes,
    metadata: {
      schemaVersion: SCHEMA_VERSION,
      ...identity,
      ...span,
      sampleRate: value.sampleRate,
      audioRetention: value.audioRetention,
      audioSize: audioBytes.length,
      audioSha256: digest.hex,
      storedAt: new Date().toISOString(),
      objectKey: deriveAudioObjectKey(identity),
    },
    checksumBase64: digest.base64,
  };
}

function sameLogicalObject(stored, incoming) {
  return (
    stored?.schemaVersion === SCHEMA_VERSION &&
    stored.tenantId === incoming.tenantId &&
    stored.learnerId === incoming.learnerId &&
    stored.sessionId === incoming.sessionId &&
    stored.chunkId === incoming.chunkId &&
    stored.startMs === incoming.startMs &&
    stored.endMs === incoming.endMs &&
    stored.sampleRate === incoming.sampleRate &&
    stored.audioRetention === incoming.audioRetention &&
    stored.audioSize === incoming.audioSize &&
    stored.objectKey === incoming.objectKey &&
    equalDigest(stored.audioSha256, incoming.audioSha256)
  );
}

function validateStoredMetadata(value, expectedIdentity, objectKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AudioObjectIntegrityError();
  const identity = identityOf(value);
  if (deriveAudioObjectKey(identity) !== objectKey) throw new AudioObjectIntegrityError();
  for (const field of Object.keys(expectedIdentity)) {
    if (identity[field] !== expectedIdentity[field]) throw new AudioObjectIntegrityError();
  }
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.objectKey !== objectKey ||
    !ALLOWED_RETENTION.has(value.audioRetention) ||
    !ALLOWED_SAMPLE_RATES.has(value.sampleRate) ||
    !Number.isSafeInteger(value.audioSize) ||
    value.audioSize <= 0 ||
    value.audioSize > MAX_AUDIO_BYTES ||
    !/^[a-f0-9]{64}$/.test(value.audioSha256 ?? "")
  ) {
    throw new AudioObjectIntegrityError();
  }
  try {
    nullableSpan(value.startMs, value.endMs);
  } catch {
    throw new AudioObjectIntegrityError();
  }
  return { ...value, ...identity };
}

function abortError() {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function consumeS3Body(body, signal) {
  throwIfAborted(signal);
  if (!signal) return body.transformToByteArray();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => {
      const error = abortError();
      body.destroy?.(error);
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => body.transformToByteArray()),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isCode(error, code) {
  return error?.code === code;
}

function isStatus(error, status) {
  return error?.$metadata?.httpStatusCode === status;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw new AudioObjectIntegrityError();
  }
}

async function fileExists(path) {
  try {
    const details = await stat(path);
    return details.isFile();
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function listFilesRecursively(root, relative = "") {
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFilesRecursively(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/**
 * Delete one already-validated learner subtree without ever following links outside it.
 *
 * Directory entries are traversed explicitly: regular files, links, sockets, and other leaf
 * entries are unlinked; directories are entered and then removed bottom-up. A concurrent writer or
 * an entry that cannot be removed leaves the root present, which is returned as `fullyErased=false`
 * instead of being hidden behind a success literal.
 */
async function eraseFilesystemTree(root, relativeRoot, signal) {
  const deletedFiles = [];

  async function eraseDirectory(relative) {
    throwIfAborted(signal);
    let rootDetails;
    try {
      rootDetails = await lstat(join(root, relative));
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    if (!rootDetails.isDirectory()) {
      // In particular, unlink a learner-root symlink itself; never let readdir follow it.
      await unlink(join(root, relative));
      deletedFiles.push(relative);
      return;
    }
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await eraseDirectory(child);
        continue;
      }
      await unlink(join(root, child)).catch((error) => {
        if (!isCode(error, "ENOENT")) throw error;
      });
      deletedFiles.push(child);
    }
    await rmdir(join(root, relative)).catch((error) => {
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error;
    });
  }

  await eraseDirectory(relativeRoot);
  let fullyErased = false;
  try {
    await lstat(join(root, relativeRoot));
  } catch (error) {
    if (isCode(error, "ENOENT")) fullyErased = true;
    else throw error;
  }
  return { deletedFiles, fullyErased };
}

export function createFilesystemAudioObjectStore({ rootDir }) {
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new TypeError("AUDIO_STORAGE_DIR is required for filesystem storage");
  }
  const root = rootDir;
  const pathFor = (objectKey) => join(root, objectKey);

  async function getLegacy(identity, signal) {
    const objectKey = `${identity.tenantId}/${identity.learnerId}/${identity.chunkId}.bin`;
    const objectPath = pathFor(objectKey);
    const metadata = await readJson(`${objectPath.slice(0, -4)}.meta.json`);
    let audioBytes;
    try {
      audioBytes = await readFile(objectPath);
    } catch (error) {
      if (isCode(error, "ENOENT")) throw new AudioObjectNotFoundError();
      throw error;
    }
    throwIfAborted(signal);
    if (
      !metadata ||
      metadata.tenantId !== identity.tenantId ||
      metadata.learnerId !== identity.learnerId ||
      metadata.sessionId !== identity.sessionId ||
      metadata.chunkId !== identity.chunkId ||
      !ALLOWED_RETENTION.has(metadata.audioRetention ?? "discard") ||
      !ALLOWED_SAMPLE_RATES.has(metadata.sampleRate)
    ) {
      throw new AudioObjectIntegrityError();
    }
    const digest = sha256(audioBytes).hex;
    if (
      (metadata.audioSize != null && Number(metadata.audioSize) !== audioBytes.length) ||
      (metadata.audioSha256 != null && !equalDigest(metadata.audioSha256, digest))
    ) {
      throw new AudioObjectIntegrityError();
    }
    const span = nullableSpan(metadata.startMs ?? null, metadata.endMs ?? null);
    const details = await stat(objectPath);
    return {
      schemaVersion: "legacy-filesystem-v0",
      ...identity,
      ...span,
      sampleRate: metadata.sampleRate,
      audioRetention: metadata.audioRetention ?? "discard",
      audioSize: audioBytes.length,
      audioSha256: digest,
      storedAt: metadata.storedAt ?? details.mtime.toISOString(),
      objectKey,
      audioBytes,
    };
  }

  async function get(value, { signal } = {}) {
    throwIfAborted(signal);
    const identity = identityOf(value);
    const objectKey = deriveAudioObjectKey(identity);
    const objectPath = pathFor(objectKey);
    const metadata = await readJson(`${objectPath}.meta.json`);
    if (metadata === null && !(await fileExists(objectPath))) return getLegacy(identity, signal);
    let audioBytes;
    try {
      audioBytes = await readFile(objectPath);
    } catch (error) {
      if (isCode(error, "ENOENT") && metadata === null) throw new AudioObjectNotFoundError();
      throw new AudioObjectIntegrityError();
    }
    throwIfAborted(signal);
    const validated = validateStoredMetadata(metadata, identity, objectKey);
    const actual = sha256(audioBytes).hex;
    if (audioBytes.length !== validated.audioSize || !equalDigest(actual, validated.audioSha256)) {
      throw new AudioObjectIntegrityError();
    }
    return { ...validated, audioBytes };
  }

  return {
    driver: "filesystem",
    async put(value, { signal } = {}) {
      throwIfAborted(signal);
      const document = putDocument(value);
      const { metadata, audioBytes } = document;
      const objectPath = pathFor(metadata.objectKey);
      const metadataPath = `${objectPath}.meta.json`;
      await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 });
      let created = false;
      try {
        await writeFile(objectPath, audioBytes, { flag: "wx", mode: 0o600 });
        created = true;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      throwIfAborted(signal);
      const existingBytes = await readFile(objectPath);
      if (!equalDigest(sha256(existingBytes).hex, metadata.audioSha256)) {
        if (created) await unlink(objectPath).catch(() => {});
        throw new AudioObjectConflictError();
      }
      const existingMetadata = await readJson(metadataPath);
      if (existingMetadata && !sameLogicalObject(existingMetadata, metadata)) {
        if (created) await unlink(objectPath).catch(() => {});
        throw new AudioObjectConflictError();
      }
      const persistedMetadata = existingMetadata ?? metadata;
      if (!existingMetadata) {
        try {
          await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
          const raced = await readJson(metadataPath);
          if (!sameLogicalObject(raced, metadata)) throw new AudioObjectConflictError();
        }
      }
      return {
        objectKey: metadata.objectKey,
        sha256: metadata.audioSha256,
        size: metadata.audioSize,
        storedAt: persistedMetadata.storedAt,
        created,
      };
    },
    get,
    async inventory({ signal } = {}) {
      throwIfAborted(signal);
      const everyFile = await listFilesRecursively(root);
      const entries = new Map();
      const ensure = (objectKey, legacy) => {
        if (!entries.has(objectKey)) {
          entries.set(objectKey, {
            objectKey,
            legacy,
            dataPresent: false,
            metadataPresent: false,
            identity: null,
          });
        }
        return entries.get(objectKey);
      };
      for (const file of everyFile) {
        if (file.startsWith(`${KEY_ROOT}/`) && file.endsWith(".pcm")) {
          ensure(file, false).dataPresent = true;
        } else if (file.startsWith(`${KEY_ROOT}/`) && file.endsWith(".pcm.meta.json")) {
          ensure(file.slice(0, -".meta.json".length), false).metadataPresent = true;
        } else if (!file.startsWith("audit-log/") && file.endsWith(".bin")) {
          ensure(file, true).dataPresent = true;
        } else if (!file.startsWith("audit-log/") && file.endsWith(".meta.json")) {
          ensure(`${file.slice(0, -".meta.json".length)}.bin`, true).metadataPresent = true;
        }
      }
      for (const entry of entries.values()) {
        try {
          if (!entry.legacy) {
            entry.identity = parseAudioObjectKey(entry.objectKey);
          } else {
            const parts = entry.objectKey.split("/");
            if (parts.length !== 3 || !entry.objectKey.endsWith(".bin")) continue;
            const metadata = await readJson(`${pathFor(entry.objectKey).slice(0, -4)}.meta.json`);
            entry.identity = identityOf({
              tenantId: parts[0],
              learnerId: parts[1],
              sessionId: metadata?.sessionId,
              chunkId: parts[2].slice(0, -4),
            });
          }
        } catch {
          entry.identity = null;
        }
      }
      throwIfAborted(signal);
      return [...entries.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    },
    async listAll({ signal } = {}) {
      throwIfAborted(signal);
      const everyFile = await listFilesRecursively(root);
      const objects = everyFile
        .filter((objectKey) => objectKey.startsWith(`${KEY_ROOT}/`) && objectKey.endsWith(".pcm"))
        .map((objectKey) => ({ ...parseAudioObjectKey(objectKey), objectKey }));
      for (const objectKey of everyFile.filter(
        (file) => file.endsWith(".bin") && !file.startsWith("audit-log/"),
      )) {
        const parts = objectKey.split("/");
        if (parts.length !== 3) continue;
        const metadata = await readJson(`${pathFor(objectKey).slice(0, -4)}.meta.json`);
        if (!metadata || typeof metadata.sessionId !== "string") continue;
        try {
          objects.push({
            ...identityOf({
              tenantId: parts[0],
              learnerId: parts[1],
              sessionId: metadata.sessionId,
              chunkId: parts[2].slice(0, -4),
            }),
            objectKey,
            legacy: true,
          });
        } catch {
          // Reconciliation reports malformed legacy objects; ordinary reads never expose them.
        }
      }
      throwIfAborted(signal);
      return objects.sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    },
    async listLearner(value, { signal } = {}) {
      throwIfAborted(signal);
      const tenantId = safeSegment(value?.tenantId, "tenantId");
      const learnerId = safeSegment(value?.learnerId, "learnerId");
      return (await this.listAll({ signal })).filter(
        (item) => item.tenantId === tenantId && item.learnerId === learnerId,
      );
    },
    async listSession(value, options = {}) {
      const session = sessionOf(value);
      const objects = (await this.listLearner(session, options)).filter(
        (item) => item.sessionId === session.sessionId,
      );
      const known = new Set(objects.map((item) => item.objectKey));
      const everyFile = await listFilesRecursively(root);
      for (const metadataKey of everyFile.filter((file) => file.endsWith(".meta.json"))) {
        const metadataBase = metadataKey.slice(0, -".meta.json".length);
        let objectKey = metadataBase;
        let identity;
        let legacy = false;
        try {
          if (metadataBase.startsWith(`${KEY_ROOT}/`) && metadataBase.endsWith(".pcm")) {
            identity = parseAudioObjectKey(objectKey);
          } else {
            const parts = metadataBase.split("/");
            if (parts.length !== 3) continue;
            const metadata = await readJson(pathFor(metadataKey));
            objectKey = `${metadataBase}.bin`;
            identity = identityOf({
              tenantId: parts[0],
              learnerId: parts[1],
              sessionId: metadata?.sessionId,
              chunkId: parts[2],
            });
            legacy = true;
          }
        } catch {
          continue;
        }
        if (known.has(objectKey) || (await fileExists(pathFor(objectKey)))) continue;
        if (
          identity.tenantId === session.tenantId &&
          identity.learnerId === session.learnerId &&
          identity.sessionId === session.sessionId
        ) {
          objects.push({ ...identity, objectKey, legacy, missingData: true });
          known.add(objectKey);
        }
      }
      return objects.sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    },
    async deleteObject(value, { signal } = {}) {
      throwIfAborted(signal);
      const identity = identityOf(value);
      const objectKey = value?.legacy
        ? `${identity.tenantId}/${identity.learnerId}/${identity.chunkId}.bin`
        : deriveAudioObjectKey(identity);
      const objectPath = pathFor(objectKey);
      await unlink(objectPath).catch((error) => {
        if (!isCode(error, "ENOENT")) throw error;
      });
      const metadataPath = objectKey.endsWith(".bin")
        ? `${objectPath.slice(0, -4)}.meta.json`
        : `${objectPath}.meta.json`;
      await unlink(metadataPath).catch((error) => {
        if (!isCode(error, "ENOENT")) throw error;
      });
      return { objectKey };
    },
    async deleteLearner(value, { signal } = {}) {
      throwIfAborted(signal);
      const tenantId = safeSegment(value?.tenantId, "tenantId");
      const learnerId = safeSegment(value?.learnerId, "learnerId");
      const v1Root = deriveAudioLearnerPrefix({ tenantId, learnerId }).slice(0, -1);
      const legacyRoot = `${tenantId}/${learnerId}`;
      const deletedObjectKeys = [];
      const deletedOtherObjectKeys = [];
      let fullyErased = true;

      for (const relativeRoot of [v1Root, legacyRoot]) {
        const erased = await eraseFilesystemTree(root, relativeRoot, signal);
        fullyErased &&= erased.fullyErased;
        for (const file of erased.deletedFiles) {
          const isV1Audio = file.startsWith(`${v1Root}/`) && file.endsWith(".pcm");
          const isLegacyAudio = file.startsWith(`${legacyRoot}/`) && file.endsWith(".bin");
          const isPrivateSidecar =
            file.endsWith(".pcm.meta.json") ||
            (file.startsWith(`${legacyRoot}/`) && file.endsWith(".meta.json"));
          if (isV1Audio || isLegacyAudio) deletedObjectKeys.push(file);
          else if (!isPrivateSidecar) deletedOtherObjectKeys.push(file);
        }
      }

      return {
        deletedObjectKeys: deletedObjectKeys.sort(),
        deletedOtherObjectKeys: deletedOtherObjectKeys.sort(),
        fullyErased,
      };
    },
    async assertReady({ signal } = {}) {
      throwIfAborted(signal);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const details = await stat(root);
      if (!details.isDirectory()) throw new AudioObjectStoreError("filesystem audio root is not a directory");
    },
    async close() {},
  };
}

function s3Metadata(metadata) {
  return {
    "qrai-schema": metadata.schemaVersion,
    "qrai-tenant-id": metadata.tenantId,
    "qrai-learner-id": metadata.learnerId,
    "qrai-session-id": metadata.sessionId,
    "qrai-chunk-id": metadata.chunkId,
    "qrai-start-ms": metadata.startMs == null ? "null" : String(metadata.startMs),
    "qrai-end-ms": metadata.endMs == null ? "null" : String(metadata.endMs),
    "qrai-sample-rate": String(metadata.sampleRate),
    "qrai-retention": metadata.audioRetention,
    "qrai-size": String(metadata.audioSize),
    "qrai-sha256": metadata.audioSha256,
    "qrai-stored-at": metadata.storedAt,
  };
}

function integerMetadata(value, nullable = false) {
  if (nullable && value === "null") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) throw new AudioObjectIntegrityError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AudioObjectIntegrityError();
  return parsed;
}

function documentFromS3Metadata(raw, objectKey) {
  const metadata = raw ?? {};
  const identity = identityOf({
    tenantId: metadata["qrai-tenant-id"],
    learnerId: metadata["qrai-learner-id"],
    sessionId: metadata["qrai-session-id"],
    chunkId: metadata["qrai-chunk-id"],
  });
  return validateStoredMetadata(
    {
      schemaVersion: metadata["qrai-schema"],
      ...identity,
      startMs: integerMetadata(metadata["qrai-start-ms"], true),
      endMs: integerMetadata(metadata["qrai-end-ms"], true),
      sampleRate: integerMetadata(metadata["qrai-sample-rate"]),
      audioRetention: metadata["qrai-retention"],
      audioSize: integerMetadata(metadata["qrai-size"]),
      audioSha256: metadata["qrai-sha256"],
      storedAt: metadata["qrai-stored-at"],
      objectKey,
    },
    identity,
    objectKey,
  );
}

function s3Input(bucket, expectedBucketOwner, extra = {}) {
  return {
    Bucket: bucket,
    ...(expectedBucketOwner ? { ExpectedBucketOwner: expectedBucketOwner } : {}),
    ...extra,
  };
}

export function createS3AudioObjectStore({
  client,
  bucket,
  expectedBucketOwner = null,
  serverSideEncryption = "AES256",
  kmsKeyId = null,
}) {
  if (!client || typeof client.send !== "function") throw new TypeError("S3 client is required");
  if (typeof bucket !== "string" || bucket.trim() === "") throw new TypeError("S3 bucket is required");

  async function headByKey(objectKey, signal) {
    try {
      const result = await client.send(
        new HeadObjectCommand(s3Input(bucket, expectedBucketOwner, {
          Key: objectKey,
          ChecksumMode: "ENABLED",
        })),
        { abortSignal: signal },
      );
      const metadata = documentFromS3Metadata(result.Metadata, objectKey);
      if (
        Number(result.ContentLength) !== metadata.audioSize ||
        (result.ChecksumSHA256 && result.ChecksumSHA256 !== Buffer.from(metadata.audioSha256, "hex").toString("base64"))
      ) {
        throw new AudioObjectIntegrityError();
      }
      return metadata;
    } catch (error) {
      if (isStatus(error, 404) || error?.name === "NotFound" || error?.name === "NoSuchKey") {
        throw new AudioObjectNotFoundError();
      }
      throw error;
    }
  }

  async function listRawPrefix(prefix, signal) {
    const objects = [];
    let continuationToken;
    const seenTokens = new Set();
    do {
      const result = await client.send(
        new ListObjectsV2Command(s3Input(bucket, expectedBucketOwner, {
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        })),
        { abortSignal: signal },
      );
      for (const item of result.Contents ?? []) {
        if (typeof item.Key !== "string" || !item.Key.startsWith(prefix)) {
          throw new AudioObjectIntegrityError();
        }
        objects.push({ objectKey: item.Key, size: Number(item.Size ?? 0) });
      }
      if (!result.IsTruncated) break;
      continuationToken = result.NextContinuationToken;
      if (!continuationToken || seenTokens.has(continuationToken)) {
        throw new AudioObjectStoreError("object storage pagination did not advance");
      }
      seenTokens.add(continuationToken);
    } while (true);
    return objects.sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  }

  async function listPrefix(prefix, signal) {
    return (await listRawPrefix(prefix, signal)).map((item) => ({
      ...parseAudioObjectKey(item.objectKey),
      ...item,
    }));
  }

  async function listLearner(value, { signal } = {}) {
    return listPrefix(deriveAudioLearnerPrefix(value), signal);
  }

  return {
    driver: "s3",
    async put(value, { signal } = {}) {
      const document = putDocument(value);
      const { metadata, audioBytes, checksumBase64 } = document;
      const input = s3Input(bucket, expectedBucketOwner, {
        Key: metadata.objectKey,
        Body: audioBytes,
        ContentLength: audioBytes.length,
        ContentType: "application/octet-stream",
        ChecksumSHA256: checksumBase64,
        IfNoneMatch: "*",
        Metadata: s3Metadata(metadata),
        ...(serverSideEncryption ? { ServerSideEncryption: serverSideEncryption } : {}),
        ...(kmsKeyId ? { SSEKMSKeyId: kmsKeyId } : {}),
      });
      try {
        await client.send(new PutObjectCommand(input), { abortSignal: signal });
        return {
          objectKey: metadata.objectKey,
          sha256: metadata.audioSha256,
          size: metadata.audioSize,
          storedAt: metadata.storedAt,
          created: true,
        };
      } catch (error) {
        if (!isStatus(error, 412)) throw error;
        const stored = await headByKey(metadata.objectKey, signal);
        if (!sameLogicalObject(stored, metadata)) throw new AudioObjectConflictError();
        return {
          objectKey: stored.objectKey,
          sha256: stored.audioSha256,
          size: stored.audioSize,
          storedAt: stored.storedAt,
          created: false,
        };
      }
    },
    async get(value, { signal } = {}) {
      const identity = identityOf(value);
      const objectKey = deriveAudioObjectKey(identity);
      let result;
      try {
        result = await client.send(
          new GetObjectCommand(s3Input(bucket, expectedBucketOwner, {
            Key: objectKey,
            ChecksumMode: "ENABLED",
          })),
          { abortSignal: signal },
        );
      } catch (error) {
        if (isStatus(error, 404) || error?.name === "NoSuchKey") throw new AudioObjectNotFoundError();
        throw error;
      }
      const metadata = documentFromS3Metadata(result.Metadata, objectKey);
      if (!result.Body || typeof result.Body.transformToByteArray !== "function") {
        throw new AudioObjectIntegrityError();
      }
      if (Number(result.ContentLength) !== metadata.audioSize) {
        result.Body.destroy?.(new AudioObjectIntegrityError());
        throw new AudioObjectIntegrityError();
      }
      const audioBytes = Buffer.from(await consumeS3Body(result.Body, signal));
      const actual = sha256(audioBytes);
      if (
        audioBytes.length !== metadata.audioSize ||
        !equalDigest(actual.hex, metadata.audioSha256) ||
        (result.ChecksumSHA256 && result.ChecksumSHA256 !== actual.base64)
      ) {
        throw new AudioObjectIntegrityError();
      }
      return { ...metadata, audioBytes };
    },
    async inventory({ signal } = {}) {
      return (await listPrefix(`${KEY_ROOT}/`, signal)).map((item) => ({
        objectKey: item.objectKey,
        legacy: false,
        dataPresent: true,
        metadataPresent: true,
        identity: {
          tenantId: item.tenantId,
          learnerId: item.learnerId,
          sessionId: item.sessionId,
          chunkId: item.chunkId,
        },
      }));
    },
    async listAll({ signal } = {}) {
      return listPrefix(`${KEY_ROOT}/`, signal);
    },
    listLearner,
    async listSession(value, options = {}) {
      const session = sessionOf(value);
      return (await listLearner(session, options)).filter((item) => item.sessionId === session.sessionId);
    },
    async deleteObject(value, { signal } = {}) {
      const objectKey = deriveAudioObjectKey(identityOf(value));
      const result = await client.send(
        new DeleteObjectsCommand(s3Input(bucket, expectedBucketOwner, {
          Delete: { Objects: [{ Key: objectKey }], Quiet: false },
        })),
        { abortSignal: signal },
      );
      if ((result.Errors ?? []).length > 0) {
        throw new AudioObjectStoreError("object storage deletion was incomplete");
      }
      try {
        await headByKey(objectKey, signal);
      } catch (error) {
        if (error instanceof AudioObjectNotFoundError) return { objectKey };
        throw error;
      }
      throw new AudioObjectStoreError("object storage deletion was incomplete");
    },
    async deleteLearner(value, { signal } = {}) {
      const prefix = deriveAudioLearnerPrefix(value);
      // Erasure lists raw keys under the exact validated learner prefix. Ordinary reads stay strict
      // and parse only schema-valid PCM objects, but deletion must not retain an unknown/temp object
      // merely because a newer writer or interrupted upload used a name this build does not know.
      const objects = await listRawPrefix(prefix, signal);
      const deletedObjectKeys = [];
      const deletedOtherObjectKeys = [];
      for (let index = 0; index < objects.length; index += 1_000) {
        const keys = objects.slice(index, index + 1_000).map((item) => ({ Key: item.objectKey }));
        const result = await client.send(
          new DeleteObjectsCommand(s3Input(bucket, expectedBucketOwner, {
            Delete: { Objects: keys, Quiet: false },
          })),
          { abortSignal: signal },
        );
        if ((result.Errors ?? []).length > 0) {
          throw new AudioObjectStoreError("object storage deletion was incomplete");
        }
        for (const { Key } of keys) {
          try {
            parseAudioObjectKey(Key);
            deletedObjectKeys.push(Key);
          } catch {
            deletedOtherObjectKeys.push(Key);
          }
        }
      }
      const remaining = await listRawPrefix(prefix, signal);
      if (remaining.length > 0) throw new AudioObjectStoreError("object storage deletion was incomplete");
      return {
        deletedObjectKeys,
        deletedOtherObjectKeys,
        fullyErased: true,
      };
    },
    async assertReady({ signal } = {}) {
      await client.send(
        new HeadBucketCommand(s3Input(bucket, expectedBucketOwner)),
        { abortSignal: signal },
      );
    },
    async close() {
      client.destroy?.();
    },
  };
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required for S3 audio storage`);
  return value;
}

function envBoolean(env, name, fallback = false) {
  const value = env[name];
  if (value == null || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new TypeError(`${name} must be 1, 0, true, or false`);
}

export function createAudioObjectStoreFromEnv({ env = process.env, production = false } = {}) {
  let driver = env.AUDIO_STORAGE_DRIVER?.trim();
  if (!driver) {
    if (production) throw new TypeError("AUDIO_STORAGE_DRIVER is required in production");
    driver = "filesystem";
  }
  if (driver === "filesystem") {
    if (production && !envBoolean(env, "AUDIO_STORAGE_FILESYSTEM_ACKNOWLEDGED_DEV_ONLY")) {
      throw new TypeError(
        "filesystem audio storage is development/test only; production must configure AUDIO_STORAGE_DRIVER=s3",
      );
    }
    return createFilesystemAudioObjectStore({
      rootDir: env.AUDIO_STORAGE_DIR ?? join(process.cwd(), "server/data/audio-storage"),
    });
  }
  if (driver !== "s3") throw new TypeError(`unsupported AUDIO_STORAGE_DRIVER=${driver}`);

  const bucket = requiredEnv(env, "AUDIO_STORAGE_S3_BUCKET");
  const region = requiredEnv(env, "AUDIO_STORAGE_S3_REGION");
  const endpoint = env.AUDIO_STORAGE_S3_ENDPOINT?.trim() || undefined;
  const forcePathStyle = envBoolean(env, "AUDIO_STORAGE_S3_FORCE_PATH_STYLE", Boolean(endpoint));
  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    maxAttempts: 3,
  });
  const encryption = env.AUDIO_STORAGE_S3_ENCRYPTION?.trim() || "AES256";
  if (!new Set(["AES256", "aws:kms", "aws:kms:dsse"]).has(encryption)) {
    throw new TypeError("AUDIO_STORAGE_S3_ENCRYPTION is not supported");
  }
  const kmsKeyId = env.AUDIO_STORAGE_S3_KMS_KEY_ID?.trim() || null;
  if ((encryption === "aws:kms" || encryption === "aws:kms:dsse") && !kmsKeyId) {
    throw new TypeError("AUDIO_STORAGE_S3_KMS_KEY_ID is required for KMS audio encryption");
  }
  return createS3AudioObjectStore({
    client,
    bucket,
    expectedBucketOwner: env.AUDIO_STORAGE_S3_EXPECTED_OWNER?.trim() || null,
    serverSideEncryption: encryption,
    kmsKeyId,
  });
}
