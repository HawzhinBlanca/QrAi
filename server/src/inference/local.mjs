import {
  predictAlignment,
  predictTajweed,
  transcribeSession,
} from "./runtime.mjs";

const DEFAULT_METHODS = Object.freeze({
  predictAlignment,
  predictTajweed,
  transcribeSession,
});

export function createInferenceRuntime(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("inference runtime overrides must be an object");
  }
  const audioObjectStore = overrides.audioObjectStore ?? null;
  if (audioObjectStore !== null && (
    typeof audioObjectStore.listSession !== "function" || typeof audioObjectStore.get !== "function"
  )) {
    throw new TypeError("inference runtime audio object store is invalid");
  }
  const runtime = {
    predictAlignment: overrides.predictAlignment ?? DEFAULT_METHODS.predictAlignment,
    predictTajweed: overrides.predictTajweed ?? (audioObjectStore
      ? (body, deadline) => DEFAULT_METHODS.predictTajweed(body, deadline, audioObjectStore)
      : DEFAULT_METHODS.predictTajweed),
    transcribeSession: overrides.transcribeSession ?? (audioObjectStore
      ? (body, deadline) => DEFAULT_METHODS.transcribeSession(body, deadline, audioObjectStore)
      : DEFAULT_METHODS.transcribeSession),
  };
  for (const [name, method] of Object.entries(runtime)) {
    if (typeof method !== "function") {
      throw new TypeError(`inference runtime ${name} must be a function`);
    }
  }
  return Object.freeze(runtime);
}
