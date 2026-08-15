import { sweepExpiredAudio } from "./runtime.mjs";

function positiveWhole(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function boundedCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new TypeError(`retention ${name} is invalid`);
  }
  return value;
}

function validateResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("retention sweep result must be an object");
  }
  return Object.freeze({
    scannedCount: boundedCount(result.scannedCount, "scannedCount"),
    deletedCount: boundedCount(result.deletedCount, "deletedCount"),
    unreadableCount: boundedCount(result.unreadableCount, "unreadableCount"),
  });
}

export function createAudioRetentionWorker({
  audioObjectStore,
  intervalMs = 60 * 60 * 1_000,
  sweep = sweepExpiredAudio,
  log = () => {},
}) {
  if (!audioObjectStore || typeof audioObjectStore !== "object") {
    throw new TypeError("audio retention requires an object store");
  }
  positiveWhole(intervalMs, "intervalMs");
  if (typeof sweep !== "function") throw new TypeError("sweep must be a function");
  if (typeof log !== "function") throw new TypeError("log must be a function");

  let started = false;
  let stopped = false;
  let timer = null;
  let active = null;
  let controller = null;
  let latest = null;

  function schedule() {
    if (!started || stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      runNow()
        .then((result) => log(
          `audio retention sweep completed scanned=${result.scannedCount} deleted=${result.deletedCount} unreadable=${result.unreadableCount}`,
        ))
        .catch(() => log("audio retention sweep failed"))
        .finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }

  function runNow() {
    if (!started || stopped) return Promise.reject(new Error("audio retention worker is not running"));
    if (active) return active;
    controller = new AbortController();
    const current = Promise.resolve()
      .then(() => sweep({ store: audioObjectStore, signal: controller.signal }))
      .then(validateResult)
      .then((result) => {
        latest = result;
        return result;
      })
      .finally(() => {
        if (active === current) {
          active = null;
          controller = null;
        }
      });
    active = current;
    return current;
  }

  async function start() {
    if (started) return;
    started = true;
    schedule();
  }

  async function stop({ timeoutMs }) {
    positiveWhole(timeoutMs, "timeoutMs");
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort(new Error("audio retention worker stopping"));
    if (!active) return true;
    let timeout;
    const deadline = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref?.();
    });
    const settled = active.then(() => true, () => true);
    const completed = await Promise.race([settled, deadline]);
    clearTimeout(timeout);
    return completed;
  }

  return Object.freeze({
    start,
    runNow,
    stop,
    get isRunning() { return active !== null; },
    get lastResult() { return latest; },
  });
}
