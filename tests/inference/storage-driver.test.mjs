// Store composition must fail closed: S3 is real, incomplete/unknown configurations never fall
// back to local disk, and filesystem remains an explicit development adapter. Import itself is
// side-effect free; the process owner explicitly composes the store before it listens.
//
// Hermetic: importing server.mjs binds no port (its side effects are gated on `isMain`). Distinct
// query strings give each case its own module instance, because the guard runs at module scope and
// a cached import would only ever execute it once.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** A path that does not exist yet, so "was it created?" is answerable. */
const unusedStorageDir = () => join(mkdtempSync(join(tmpdir(), "ml-driver-test-")), "audio-storage");

async function importServerWith(env, cacheKey) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const module = await import(`../../server/src/inference/runtime.mjs?case=${cacheKey}`);
    const store = module.defaultAudioObjectStore();
    await store.close();
    return { module, error: null };
  } catch (error) {
    return { module: null, error };
  } finally {
    // Restore rather than delete: other tests in this process read AUDIO_STORAGE_DIR.
    for (const key of Object.keys(env)) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
}

test("an incomplete S3 configuration refuses composition instead of falling back", async () => {
  const { error } = await importServerWith(
    { AUDIO_STORAGE_DRIVER: "s3", AUDIO_STORAGE_DIR: unusedStorageDir() },
    "s3",
  );
  assert.ok(error, "incomplete S3 configuration composed anyway");
  assert.match(error.message, /AUDIO_STORAGE_S3_BUCKET/);
});

test("an unknown driver refuses before any storage directory is created", async () => {
  const dir = unusedStorageDir();
  const { error } = await importServerWith(
    { AUDIO_STORAGE_DRIVER: "minio", AUDIO_STORAGE_DIR: dir },
    "minio",
  );
  assert.ok(error, "an unimplemented driver composed");
  assert.equal(existsSync(dir), false, "a refused boot created the storage directory anyway");
});

test("a complete S3 configuration composes without touching the filesystem", async () => {
  const dir = unusedStorageDir();
  const { error } = await importServerWith(
    {
      AUDIO_STORAGE_DRIVER: "s3",
      AUDIO_STORAGE_S3_BUCKET: "private-audio-test",
      AUDIO_STORAGE_S3_REGION: "us-east-1",
      AUDIO_STORAGE_DIR: dir,
    },
    "s3-complete",
  );
  assert.equal(error, null, `complete S3 configuration refused: ${error?.message}`);
  assert.equal(existsSync(dir), false, "S3 composition touched local storage");
  assert.equal(existsSync(join(dir, "audio", "v1")), false, "S3 configuration wrote audio locally");
});

test("the default and the explicit filesystem driver both boot", async () => {
  // The control. Without it every assertion above is satisfied by a guard that refuses EVERYTHING,
  // which would take the ML service down entirely rather than protect anything.
  const byDefault = await importServerWith({ AUDIO_STORAGE_DIR: unusedStorageDir() }, "default");
  assert.equal(byDefault.error, null, `the default driver refused to boot: ${byDefault.error?.message}`);

  const explicit = await importServerWith(
    { AUDIO_STORAGE_DRIVER: "filesystem", AUDIO_STORAGE_DIR: unusedStorageDir() },
    "explicit-fs",
  );
  assert.equal(explicit.error, null, `an explicit filesystem driver refused: ${explicit.error?.message}`);
});
