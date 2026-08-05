// The boot refusal that keeps children's recordings from silently landing on local disk.
//
// `server.mjs:48` states the rule: `AUDIO_STORAGE_DRIVER` exists so a future S3/MinIO backend has
// somewhere to hang off, but until one is implemented "requesting it must fail loudly at startup —
// silently falling back to the filesystem while an operator believes audio is going to S3 would be
// a silent privacy/compliance gap, not a graceful degradation."
//
// `AUDIO_STORAGE_DRIVER` appeared NOWHERE else in the repository: no test, no CI config, no
// deployment manifest. Delete the `if`, or flip `!==` to `===`, and an operator who configured S3
// gets every learner's audio written to the container's filesystem while believing otherwise —
// and nothing anywhere says so.
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
    return { module: await import(`./server.mjs?case=${cacheKey}`), error: null };
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

test("an unimplemented storage driver refuses to boot", async () => {
  const { error } = await importServerWith(
    { AUDIO_STORAGE_DRIVER: "s3", AUDIO_STORAGE_DIR: unusedStorageDir() },
    "s3",
  );
  assert.ok(error, "requesting s3 storage booted anyway, on the local filesystem");
  // The message has to name the variable and the value, or an operator reading a crash loop cannot
  // tell this deliberate refusal apart from a genuine failure.
  assert.match(error.message, /AUDIO_STORAGE_DRIVER=s3/);
  assert.match(error.message, /not implemented/);
});

test("the refusal happens BEFORE any storage directory is created", async () => {
  // The guard sits above `mkdirSync(AUDIO_STORAGE_DIR)`. Moving it below would still throw, so
  // every assertion above would pass — while a refused boot left an empty audio-storage tree behind,
  // which is exactly the shape an operator would read as "the driver worked".
  const dir = unusedStorageDir();
  const { error } = await importServerWith(
    { AUDIO_STORAGE_DRIVER: "minio", AUDIO_STORAGE_DIR: dir },
    "minio",
  );
  assert.ok(error, "an unimplemented driver booted");
  assert.equal(existsSync(dir), false, "a refused boot created the storage directory anyway");
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
