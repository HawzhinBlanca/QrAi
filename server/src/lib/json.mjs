/**
 * Serializing a Rust `f64` the way `serde_json` does.
 * specs/migration-completion/plan.md §2 (N10)
 *
 * ── The finding ─────────────────────────────────────────────────────────────────────────────────
 * `serde_json` keeps the f64-ness of a float. A whole-number f64 serializes as `100.0`.
 * `JSON.stringify(100)` emits `100` — JavaScript has one number type and no way to say "this is a
 * float". Both parse to the same value in a JS client, so nothing looks broken; the BYTES differ,
 * and byte equality is what a differ, a fixture digest, or a strict client checks.
 *
 * Caught by the N10 A/B on `GET /v1/learner/progress/weekly`, where `accuracy` is 100.0 for any
 * learner with a perfect day. It applies to every f64 the API returns: `accuracy`, `mastery`,
 * `easinessFactor`, and the `confidence` on a finding.
 *
 * ── Why a sentinel, and why it is generated PER CALL ────────────────────────────────────────────
 * `JSON.stringify` has no hook that emits a raw token: a `replacer` returns VALUES, and `toJSON`
 * returns a value that then gets serialized normally. So a float is marked, stringified as a
 * string, and unwrapped by one pass afterwards.
 *
 * The first version used a FIXED sentinel and a strict float-shaped inner pattern, on the reasoning
 * that no real string would contain that exact shape. The safety test in
 * `tests/node-api/rust-json.test.mjs` disproved it immediately: a learner who puts
 * `@@qrai:f64@@100@@qrai:f64@@` in an `ayahRef` or a display name gets it unwrapped into a bare
 * `100` — a caller-controlled string turning into a number, in a response, on a route that echoes
 * user input back. That is content injection, and "improbable" is not a mitigation.
 *
 * The sentinel is therefore a fresh random token per `stringifyRust` call. Input is fixed before
 * the token exists, so no payload can contain it — that is a property of the construction, not an
 * estimate of how unlikely a collision is.
 */
import { randomBytes } from "node:crypto";

/**
 * Format a number the way `serde_json` formats an `f64`.
 *
 * The only difference from `String(n)` is the `.0` on a whole number — Rust's float formatter and
 * JS's number formatter agree on everything else, including exponent form and the shortest
 * round-trip representation.
 */
export function formatF64(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    // serde_json cannot represent NaN or Infinity either — it errors. Failing here turns a
    // corrupted computation into a 500 with a stack trace instead of `null` on the wire.
    throw new RangeError(`f64 must be finite, got ${n}`);
  }
  const s = String(n);
  // `1e21` and larger stringify in exponent form, which already reads as a float.
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/**
 * Format a number the way `serde_json` formats an `f32`.
 *
 * `EvalRun`'s metrics are `f32` (types.rs:273), read from Postgres as `float8` and narrowed with
 * `as f32`. Rust then prints the SHORTEST decimal string that round-trips to that single-precision
 * value — `0.82345679`, where the f64 the database handed over would print as
 * `0.8234567890123`. JavaScript has one float type, so both the narrowing and the shortening have
 * to be done explicitly or every metric on this route is a few digits too long.
 *
 * `Math.fround` does the narrowing. The shortening is a search: the shortest precision whose
 * round-trip lands on the same f32. Nine digits always suffice for a float32.
 */
export function formatF32(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new RangeError(`f32 must be finite, got ${n}`);
  }
  const narrowed = Math.fround(n);
  if (Number.isInteger(narrowed) && Math.abs(narrowed) < 1e16) return `${narrowed}.0`;
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = narrowed.toPrecision(precision);
    if (Math.fround(Number(candidate)) === narrowed) return String(Number(candidate));
  }
  return String(narrowed);
}

/** Mark a value as a Rust `f64`. `null` passes through — a nullable float is still nullable. */
export function f64(n) {
  return n === null || n === undefined ? null : new RustF64(n);
}

/** Mark a value as a Rust `f32`. See `formatF32` for why this is not the same as `f64`. */
export function f32(n) {
  return n === null || n === undefined ? null : new RustF64(n, formatF32);
}

/**
 * The marker. `toJSON` reads the nonce from a module-scoped slot set by `stringifyRust`, because
 * `JSON.stringify` gives `toJSON` no way to receive one. Single-threaded and synchronous — nothing
 * can interleave between setting the nonce and finishing the stringify.
 */
let activeNonce = null;

class RustF64 {
  constructor(value, format = formatF64) {
    this.value = value;
    this.format = format;
  }

  toJSON() {
    if (activeNonce === null) {
      // Reached only if someone JSON.stringify's a body directly instead of going through
      // stringifyRust — which would emit the raw marker onto the wire. Fail instead.
      throw new Error("f64() values must be serialized with stringifyRust(), not JSON.stringify()");
    }
    return `${activeNonce}${this.format(this.value)}${activeNonce}`;
  }
}

/**
 * Recursively sort object keys, the way a `jsonb` column does after a round trip through Rust.
 *
 * A handler that surfaces a jsonb column reads it into a `serde_json::Value`. Without the
 * `preserve_order` feature that `Value::Object` is a **BTreeMap**, so re-serializing it emits the
 * keys ALPHABETICALLY — regardless of the order Postgres stored them in. The `postgres` driver in
 * Node parses the same column into a plain object that preserves the stored order, so the two
 * implementations disagree on the bytes of any jsonb value with more than one key.
 *
 * Caught by the N11 A/B on `agent_runs.source_refs`, where Rust emits
 * `{"citation":…,"id":…,"title":…,"url":…}` and the driver's order was `{"id","url","title",
 * "citation"}`. Same data, different bytes, and the difference is invisible in both source files.
 *
 * Arrays keep their order — only object KEYS are sorted, which is what a BTreeMap does.
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  // A Date or a Buffer from the driver is an object but not a JSON map; leave it alone.
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

/** `JSON.stringify`, but values wrapped in `f64()` keep their trailing `.0`. */
export function stringifyRust(value) {
  // Hex, not a raw UUID and emphatically not a control character: JSON.stringify ESCAPES a
  // control char (U+0001 becomes the six characters \u0001), so a nonce containing one can
  // never match the raw-nonce regex below. That exact bug shipped in the first draft of this
  // function and the unit test caught it — the marker leaked onto the wire intact.
  const nonce = `f64x${randomBytes(16).toString("hex")}x`;
  activeNonce = nonce;
  let text;
  try {
    text = JSON.stringify(value);
  } finally {
    activeNonce = null;
  }
  // The nonce did not exist when the payload was constructed, so no payload string can contain it.
  // The inner group stays strict anyway: a bug that emits a malformed marker should leave a visible
  // artefact rather than silently producing something that parses.
  const unwrap = new RegExp(
    `"${escapeRegExp(nonce)}(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)${escapeRegExp(nonce)}"`,
    "g",
  );
  return text.replaceAll(unwrap, "$1");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
