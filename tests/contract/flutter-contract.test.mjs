import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOpenapi } from "./lib/openapi.mjs";

/**
 * F-7 — WHEN the API contract changes, THE Dart client SHALL fail its contract test.
 * `specs/migration-completion/impact-map.md`
 *
 * ── Why this is a Node test and not a Dart one ──────────────────────────────────────────────────
 * `scripts/verify.sh` SKIPS every Flutter step when the SDK is absent, which is the state of any
 * runner that has not installed it. A Dart-side contract test would therefore be skipped on exactly
 * the gate that matters — CI — and F-7's evidence would exist only on the machine that wrote it. In
 * `tests/contract/` it runs unconditionally, next to `coverage.test.mjs`, which already pins the
 * same spec against the Rust router.
 *
 * ── What it compares ────────────────────────────────────────────────────────────────────────────
 * `models.dart` is hand-written, and its own header explains why: a model generated from the server
 * cannot disagree with it, and a model that cannot disagree is not a check. The cost of that choice
 * is drift, and this is what pays it — the JSON keys the Dart client actually reads, against the
 * schema that describes them.
 *
 *   1. every key the client reads is a property the contract declares — otherwise a rename on the
 *      server (or a field that never existed) leaves the client parsing nothing, silently;
 *   2. every key read through `_str`/`_int`/`_num` — the helpers that THROW rather than substitute —
 *      is listed in the schema's `required`. A response the contract calls valid must not crash the
 *      client, and that asymmetry is invisible from either side alone.
 *
 * The reverse direction (a contract property the client ignores) is deliberately NOT asserted: a
 * client is entitled to skip fields it has no use for, and asserting it would fail on every server
 * addition. `RealtimeSessionTicket.auditEventId` is exactly that case and is fine.
 *
 * Hermetic: no database, no service, no network, no Flutter SDK.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const spec = loadOpenapi(join(repoRoot, "specs/flutter-client/openapi.yaml"));
const src = readFileSync(join(repoRoot, "apps/flutter/lib/src/api/models.dart"), "utf8");

/** Dart class → the `components.schemas` entry it parses. The names differ; that is not drift. */
const MODELS = {
  SurahSummary: "Surah",
  Word: "Word",
  Ayah: "Ayah",
  SurahDetail: "SurahAyahs",
  LearnerProgress: "LearnerProgress",
  RealtimeTicket: "RealtimeSessionTicket",
  RecitationSession: "RecitationSession",
  QuranRef: "QuranRef",
  // Write-only: sent when a session is created, never parsed back. Checked through `toJson` below.
  Consent: "Consent",
};

/**
 * Models with no schema, and the reason. Listing them is the point: a model that quietly had no
 * contract would be indistinguishable from one this test forgot.
 */
const UNCONTRACTED = {
  TajweedFinding:
    "comes from POST /v1/ml/tajweed-findings:predict, one of the three `x-unvalidated` proxy " +
    "operations. The shape belongs to the ML upstream and the contract says so rather than " +
    "inventing one — see specs/contract-coverage-closure. This model now HAS a production caller " +
    "(practice_screen renders it), so the absence of a response schema is load-bearing: what " +
    "stands in for one is that reviewStatus, confidence and sources are REQUIRED reads, so an " +
    "upstream shape change fails to parse loudly instead of rendering an ungated judgement. " +
    "The learner-visibility gate is covered by apps/flutter/test/tajweed_gate_test.dart and " +
    "pinned to the web client's by tests/contract/tajweed-gate-parity.test.mjs.",
  SourceReference:
    "the `sources` elements of the same `x-unvalidated` response, so it has no schema for the " +
    "same reason. Its fields are required reads for the same reason too: a half-built source " +
    "would render as provenance that is not there.",
};

/** The body of one `fromJson`, from the factory to the field declarations that follow it. */
function fromJsonBody(className) {
  const start = src.indexOf(`factory ${className}.fromJson(`);
  assert.notEqual(start, -1, `${className} has no fromJson in models.dart`);
  const rest = src.slice(start);
  const end = rest.indexOf("\n\n  final ");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * One class's source, from its declaration to the `}` that closes it in column 0.
 *
 * The bound is the point: an unbounded `class X {[\s\S]*?toJson` matches the NEXT class's toJson,
 * which reported every read-only model as also being written. Six false failures at once, which is
 * the lucky version — the same bug in the other direction is six silent passes.
 */
function classBody(className) {
  const start = src.indexOf(`class ${className} {`);
  assert.notEqual(start, -1, `models.dart has no class ${className}`);
  const rest = src.slice(start);
  const end = rest.indexOf("\n}\n");
  return end === -1 ? rest : rest.slice(0, end);
}

const reads = (className) => src.includes(`factory ${className}.fromJson(`);
const writes = (className) => classBody(className).includes("toJson()");

/** The keys a model SENDS, from its `toJson` map literal. */
function toJsonKeys(className) {
  const map = /toJson\(\) => <String, Object\?>\{([\s\S]*?)\n      \};/.exec(classBody(className));
  assert.ok(map, `${className}.toJson does not look like a map literal`);
  return matchAll(map[1], /'([^']+)':/g);
}

const matchAll = (body, re) => [...body.matchAll(re)].map((m) => m[1]);

/** Keys read through a helper that throws on absence — i.e. the client REQUIRES them. */
const requiredKeys = (body) => new Set(matchAll(body, /_(?:str|int|num)\(json, '([^']+)'\)/g));
/** Every key read at all, including the guarded `json['x']` form. */
const allKeys = (body) =>
  new Set([...requiredKeys(body), ...matchAll(body, /json\['([^']+)'\]/g)]);

for (const [dartClass, schemaName] of Object.entries(MODELS)) {
  test(`${dartClass} is read, written, or both — an unused model is not a contract`, () => {
    assert.ok(
      reads(dartClass) || writes(dartClass),
      `${dartClass} neither parses nor serializes; it describes nothing on the wire`,
    );
  });

  if (writes(dartClass)) {
    test(`${dartClass} sends every field ${schemaName} requires`, () => {
      // The direction that matters for a request model: a missing required field is a 422 at
      // runtime and invisible to any check that only looks at responses. This is the generalised
      // form of audit finding #2.
      const schema = spec.components.schemas[schemaName];
      const keys = toJsonKeys(dartClass);
      const missing = (schema.required ?? []).filter((k) => !keys.includes(k));
      assert.deepEqual(missing, [], `${dartClass}.toJson omits ${JSON.stringify(missing)}`);

      const declared = new Set(Object.keys(schema.properties ?? {}));
      const unknown = keys.filter((k) => !declared.has(k));
      assert.deepEqual(unknown, [], `${dartClass}.toJson sends ${JSON.stringify(unknown)}`);
    });
  }

  if (!reads(dartClass)) continue;

  test(`${dartClass} reads only properties ${schemaName} declares`, () => {
    const schema = spec.components.schemas[schemaName];
    assert.ok(schema, `openapi.yaml has no schema ${schemaName}`);
    const declared = new Set(Object.keys(schema.properties ?? {}));
    const unknown = [...allKeys(fromJsonBody(dartClass))].filter((k) => !declared.has(k));
    assert.deepEqual(
      unknown,
      [],
      `${dartClass} reads ${JSON.stringify(unknown)}, which ${schemaName} does not declare. ` +
        `Either the server stopped sending it, or the client is parsing a field that never existed.`,
    );
  });

  test(`every key ${dartClass} requires is required by ${schemaName}`, () => {
    const schema = spec.components.schemas[schemaName];
    const required = new Set(schema.required ?? []);
    const optionalButRequired = [...requiredKeys(fromJsonBody(dartClass))].filter(
      (k) => !required.has(k),
    );
    assert.deepEqual(
      optionalButRequired,
      [],
      `${dartClass} throws when ${JSON.stringify(optionalButRequired)} is absent, but ${schemaName} ` +
        `lists them as optional. A response the contract calls valid would crash the client.`,
    );
  });

  test(`nothing ${dartClass} requires is nullable in ${schemaName}`, () => {
    // `required` and non-nullable are separate promises, and only both together mean "the client
    // can read this". A `type: [string, "null"]` on a required property still describes a response
    // that `_str` rejects — the same crash, one level down, and invisible to the check above.
    const props = spec.components.schemas[schemaName].properties ?? {};
    const nullable = [...requiredKeys(fromJsonBody(dartClass))].filter((k) => {
      const t = props[k]?.type;
      return Array.isArray(t) ? t.includes("null") : t === "null";
    });
    assert.deepEqual(
      nullable,
      [],
      `${schemaName} allows null for ${JSON.stringify(nullable)}, which ${dartClass} reads through a ` +
        `helper that throws on null.`,
    );
  });
}

// ── request bodies ──────────────────────────────────────────────────────────────────────────────
// The response half above would never have caught audit finding #2: the client posted `{}` to two
// routes whose handler requires `learnerId`, so both privacy actions returned 422 and neither had a
// model to disagree about. A contract test that only checks what comes BACK checks half the wire.

const client = readFileSync(join(repoRoot, "apps/flutter/lib/src/api/api_client.dart"), "utf8");
const flutterRootForLeakScan = join(repoRoot, "apps/flutter");

/** Every `_post('/path', <String, Object?>{ 'k': … })` in the client, as {path, keys}. */
function postedBodies() {
  const calls = [];
  for (const m of client.matchAll(/_post(?:Object)?\('([^']+)',\s*<String, Object\?>\{([^}]*)\}/g)) {
    calls.push({ path: m[1].split("?")[0], keys: matchAll(m[2], /'([^']+)':/g) });
  }
  return calls;
}

test("the client posts to paths the contract knows", () => {
  const posts = postedBodies();
  assert.ok(posts.length >= 3, `only found ${posts.length} POST bodies; the regex has drifted`);
  const unknown = posts.map((p) => p.path).filter((p) => !spec.paths[p]?.post);
  assert.deepEqual(unknown, [], `the client POSTs to ${JSON.stringify(unknown)}, uncontracted`);
});

for (const { path, keys } of postedBodies()) {
  test(`the body the client posts to ${path} satisfies its requestBody`, () => {
    const schema =
      spec.paths[path].post.requestBody?.content?.["application/json"]?.schema ?? {};
    const resolved = schema.$ref
      ? spec.components.schemas[schema.$ref.split("/").pop()]
      : schema;
    const required = resolved.required ?? [];
    const declared = new Set(Object.keys(resolved.properties ?? {}));

    const missing = required.filter((k) => !keys.includes(k));
    assert.deepEqual(
      missing,
      [],
      `the client omits ${JSON.stringify(missing)}, which ${path} requires — that request is a 422.`,
    );
    const unknown = keys.filter((k) => !declared.has(k));
    assert.deepEqual(unknown, [], `the client sends ${JSON.stringify(unknown)}, undeclared on ${path}`);
  });
}

// ── no exception text on a learner's screen ─────────────────────────────────────────────────────
// Three times now the same shape has shipped: an exception interpolated into a string a learner
// reads. `privacy_screen.dart` showed `ApiException(ApiErrorKind.server, 502): audio erasure
// service unavailable`; `practice_screen.dart` showed a SocketException with `errno`, an internal
// address and port, and the full URI. Each was fixed where it was found and the sibling was missed.
//
// So the rule is pinned instead of remembered. Every learner-facing string goes through
// `messageFor`, which maps an `ApiErrorKind` to words a person can act on. `api_client.dart` is the
// one file allowed to interpolate — it AUTHORS the message that the rest of the app must not show.
//
// A regression pin for a known shape, not a general proof: a new way to spell the same mistake
// would slip past. The behavioural cases in `apps/flutter/test/` are the load-bearing ones.

test("no learner-facing string interpolates an exception", () => {
  const offenders = [];
  const files = globSync("**/*.dart", { cwd: join(flutterRootForLeakScan, "lib/src") }).sort();
  assert.ok(files.length > 5, "the glob found nothing; this test would pass vacuously");

  for (const rel of files) {
    const src = readFileSync(join(flutterRootForLeakScan, "lib/src", rel), "utf8");
    // Scoped to files that can actually render. `models.dart` and `api_client.dart` AUTHOR
    // exception messages — `'expected objects in $what, got ${e.runtimeType}'` is a
    // FormatException's own text, not something a learner sees — and neither imports Flutter, so
    // neither can put anything on a screen. Deriving the exemption from that fact rather than from
    // a filename list means a new non-UI helper is covered without being remembered.
    if (!src.includes("package:flutter/")) continue;
    // `$e`, `${e}`, `${e.message}`, `${error}` … inside a quoted string.
    for (const m of src.matchAll(/'[^'\n]*\$\{?(e|err|error|ex)(\.message)?\}?[^'\n]*'/g)) {
      offenders.push(`${rel}: ${m[0].trim().slice(0, 70)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these put exception text where a learner can read it:\n  ${offenders.join("\n  ")}\n` +
      `Use messageFor(e) — see privacy_screen.dart and practice_screen.dart.`,
  );
});

// ── platform permission declarations ────────────────────────────────────────────────────────────
// Same family as everything above — what the client DECLARES against what it actually does — so it
// lives here rather than in a file of its own. `flutter create` does not add these, and a future
// regeneration would silently drop them: the app would then build, launch, pass every widget test,
// and capture nothing on a device. That failure has no error message, which is why it needs a test.

const flutterRoot = join(repoRoot, "apps/flutter");

for (const [what, file, needle] of [
  ["Android records audio", "android/app/src/main/AndroidManifest.xml", "android.permission.RECORD_AUDIO"],
  ["Android reaches the gateway", "android/app/src/main/AndroidManifest.xml", "android.permission.INTERNET"],
  ["iOS explains the microphone", "ios/Runner/Info.plist", "NSMicrophoneUsageDescription"],
  ["macOS explains the microphone", "macos/Runner/Info.plist", "NSMicrophoneUsageDescription"],
  ["macOS debug is entitled to audio", "macos/Runner/DebugProfile.entitlements", "com.apple.security.device.audio-input"],
  ["macOS release is entitled to audio", "macos/Runner/Release.entitlements", "com.apple.security.device.audio-input"],
  ["macOS release may reach the network", "macos/Runner/Release.entitlements", "com.apple.security.network.client"],
]) {
  test(`${what} — ${file} declares ${needle}`, () => {
    assert.match(readFileSync(join(flutterRoot, file), "utf8"), new RegExp(needle.replaceAll(".", "\\.")));
  });
}

test("the iOS microphone prompt says what the recording is for", () => {
  // A usage string is mandatory to ship; a MEANINGFUL one is what a parent needs. Apple rejects an
  // empty value, not a useless one, so the length floor is ours.
  const plist = readFileSync(join(flutterRoot, "ios/Runner/Info.plist"), "utf8");
  const value = /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  assert.ok(value, "no usage description found");
  assert.ok(
    value[1].length > 60 && /consent/i.test(value[1]),
    `the prompt must say why and mention consent, got ${JSON.stringify(value[1])}`,
  );
});

test("every model in models.dart is either contracted or listed as uncontracted", () => {
  const classes = matchAll(src, /^class (\w+)/gm);
  const accounted = new Set([...Object.keys(MODELS), ...Object.keys(UNCONTRACTED)]);
  const orphans = classes.filter((c) => !accounted.has(c));
  assert.deepEqual(
    orphans,
    [],
    `${JSON.stringify(orphans)} in models.dart map to no schema and are not listed in ` +
      `UNCONTRACTED. Add the mapping, or say why there is no contract — do not leave it ambiguous.`,
  );
});
