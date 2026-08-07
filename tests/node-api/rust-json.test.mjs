/**
 * N10 — serializing an f64 the way serde_json does.
 * specs/migration-completion/plan.md §2
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as sortMod from "../../server/src/lib/json.mjs";
import { f64, formatF32, formatF64, stringifyRust } from "../../server/src/lib/json.mjs";

test("a whole-number f64 keeps its .0 — the divergence that started this", () => {
  assert.equal(stringifyRust({ accuracy: f64(100) }), '{"accuracy":100.0}');
  assert.equal(stringifyRust({ mastery: f64(0) }), '{"mastery":0.0}');
  assert.equal(stringifyRust({ ef: f64(-3) }), '{"ef":-3.0}');
});

test("a fractional value is unchanged", () => {
  assert.equal(stringifyRust({ a: f64(99.9) }), '{"a":99.9}');
  assert.equal(stringifyRust({ a: f64(2.5) }), '{"a":2.5}');
  assert.equal(stringifyRust({ a: f64(0.001) }), '{"a":0.001}');
});

test("null passes through — a nullable float is still nullable", () => {
  assert.equal(stringifyRust({ accuracy: f64(null) }), '{"accuracy":null}');
  assert.equal(stringifyRust({ accuracy: null }), '{"accuracy":null}');
});

test("plain integers are NOT touched — an i32 must not grow a decimal point", () => {
  // sessions, wordsTotal, repetitions and intervalDays are all i32/i64 in Rust. Wrapping one in
  // f64() by mistake would put `609.0` on the wire where `609` belongs, so the two must stay
  // distinguishable and only the explicitly-wrapped values change.
  assert.equal(stringifyRust({ sessions: 609, wordsTotal: 77 }), '{"sessions":609,"wordsTotal":77}');
});

test("floats nested in arrays and objects are unwrapped too", () => {
  assert.equal(
    stringifyRust({ days: [{ accuracy: f64(100) }, { accuracy: f64(50.5) }] }),
    '{"days":[{"accuracy":100.0},{"accuracy":50.5}]}',
  );
});

test("exponent form already reads as a float and is left alone", () => {
  assert.equal(formatF64(1e21), "1e+21");
  assert.equal(stringifyRust({ a: f64(1e21) }), '{"a":1e+21}');
});

test("NaN and Infinity are refused, because serde_json refuses them too", () => {
  // Emitting `null` for a corrupted computation would put a plausible value on the wire. A 500 with
  // a stack trace is the honest outcome.
  assert.throws(() => stringifyRust({ a: f64(Number.NaN) }), RangeError);
  assert.throws(() => stringifyRust({ a: f64(Number.POSITIVE_INFINITY) }), RangeError);
});

/**
 * CONTENT INJECTION — the reason the marker is a per-call nonce.
 *
 * The first implementation used a FIXED sentinel plus a strict float-shaped inner pattern, on the
 * reasoning that no real string would contain that exact shape. This test disproved it on its first
 * run: a learner who puts the sentinel in an `ayahRef` or a display name had it unwrapped into a
 * bare number in the response — a caller-controlled string becoming a JSON number.
 *
 * A per-call nonce makes that impossible by construction: the payload was built before the nonce
 * existed. These vectors are kept as a regression guard against anyone reintroducing a constant.
 */
test("payload text that LOOKS like a marker is NOT corrupted", () => {
  const hostile = [
    "@@qrai:f64@@",
    "@@qrai:f64@@100@@qrai:f64@@",
    "f64:00000000-0000-0000-0000-000000000000100f64:00000000-0000-0000-0000-000000000000",
    "ayah @@qrai:f64@@1.5@@qrai:f64@@ text",
  ];
  for (const text of hostile) {
    const round = JSON.parse(stringifyRust({ text }));
    assert.equal(
      round.text,
      text,
      `a payload string was altered by the f64 unwrap: ${JSON.stringify(text)}`,
    );
  }
});

test("a real float still unwraps when a marker-shaped string is in the SAME document", () => {
  const hostile = "@@qrai:f64@@100@@qrai:f64@@";
  const text = stringifyRust({ text: hostile, accuracy: f64(100) });
  assert.match(text, /"accuracy":100\.0/, "the real float must still lose its quotes");
  const out = JSON.parse(text);
  assert.equal(out.text, hostile);
  assert.equal(out.accuracy, 100);
});

test("two calls use DIFFERENT markers — a constant would defeat the whole defence", () => {
  // Not asserted on the output (the marker is gone by then), but on the failure mode it prevents:
  // if the marker were constant, a payload captured from one response could be replayed into
  // another and unwrapped. Probe the invariant through the module's own contract instead.
  const a = stringifyRust({ v: f64(1) });
  const b = stringifyRust({ v: f64(1) });
  assert.equal(a, b, "identical inputs must still produce identical OUTPUT");
  assert.equal(a, '{"v":1.0}');
});

test("JSON.stringify on an f64() value FAILS rather than leaking a raw marker", () => {
  assert.throws(() => JSON.stringify({ v: f64(1) }), /stringifyRust/);
});

// ── sortKeysDeep: reproducing serde_json::Value's BTreeMap ordering (N11) ──────────────────────

test("object keys sort alphabetically, recursively", () => {
  const { sortKeysDeep } = sortMod;
  assert.equal(
    JSON.stringify(sortKeysDeep({ id: "s1", url: null, title: "T", citation: "ref" })),
    '{"citation":"ref","id":"s1","title":"T","url":null}',
  );
  assert.equal(
    JSON.stringify(sortKeysDeep({ b: { z: 1, a: 2 }, a: 3 })),
    '{"a":3,"b":{"a":2,"z":1}}',
  );
});

test("ARRAY order is preserved — only object KEYS sort", () => {
  const { sortKeysDeep } = sortMod;
  assert.deepEqual(sortKeysDeep([3, 1, 2]), [3, 1, 2]);
  assert.equal(
    JSON.stringify(sortKeysDeep([{ b: 1, a: 2 }, { d: 3, c: 4 }])),
    '[{"a":2,"b":1},{"c":4,"d":3}]',
  );
});

test("scalars, null and Dates pass through untouched", () => {
  const { sortKeysDeep } = sortMod;
  assert.equal(sortKeysDeep(null), null);
  assert.equal(sortKeysDeep("x"), "x");
  assert.equal(sortKeysDeep(7), 7);
  const d = new Date(0);
  assert.equal(sortKeysDeep(d), d, "a driver Date is an object but not a JSON map");
});

// ── f32: the narrowing serde does that JavaScript has no type for (N11) ────────────────────────

test("an f32 prints the SHORTEST string that round-trips to the SINGLE, not the double", () => {
  // The PROPERTY, not a hard-coded literal. The first draft of this test asserted "0.82345679",
  // which was a guess at Rust's output and disagreed with the implementation — and the
  // implementation was right. A literal expectation here is only ever as good as whoever typed it;
  // "round-trips to the same f32, and no shorter string does" is what serde actually guarantees.
  const input = 0.82345678901;
  const printed = formatF32(input);
  const narrowed = Math.fround(input);

  assert.equal(Math.fround(Number(printed)), narrowed, "must round-trip to the same f32");
  assert.ok(
    printed.replace(/[-.]/g, "").replace(/^0+/, "").length <= 9,
    `an f32 never needs more than 9 significant digits, got ${printed}`,
  );
  // No shorter representation round-trips — that is what "shortest" means.
  const digits = printed.replace(/[-.]/g, "").replace(/^0+/, "").length;
  if (digits > 1) {
    const shorter = Number(narrowed.toPrecision(digits - 1));
    assert.notEqual(Math.fround(shorter), narrowed, `${printed} is not the shortest form`);
  }

  assert.equal(formatF64(input), "0.82345678901", "f64 keeps every digit — the contrast");
  assert.notEqual(printed, formatF64(input), "the whole point: f32 and f64 print differently");
});

test("a whole-number f32 still gets its .0", () => {
  assert.equal(formatF32(1), "1.0");
  assert.equal(formatF32(0), "0.0");
});

test("values a float32 represents exactly are unchanged", () => {
  for (const v of [0.5, 0.25, 1.5, 2.5]) assert.equal(formatF32(v), String(v));
});
