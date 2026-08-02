import assert from "node:assert/strict";
import test from "node:test";

import { DEBUG_CERT_DN, aotAbis, isDebugSigned, parseSignerDn } from "./check-apk.mjs";

/**
 * The parsing in `check-apk.mjs`, without an APK.
 *
 * Both functions decide whether an artifact is publishable, and both fail in the direction that
 * hurts: `aotAbis` missing a real `libapp.so` would reject a good build (annoying), while matching
 * something it should not would pass a debug artifact as a release one (ships). Same for
 * `isDebugSigned` — a miss means a debug-signed APK sails through `--require-release`, which is the
 * exact failure the script exists to prevent.
 */

test("aotAbis finds the AOT image for every ABI", () => {
  const entries = [
    "AndroidManifest.xml",
    "lib/arm64-v8a/libapp.so",
    "lib/arm64-v8a/libflutter.so",
    "lib/armeabi-v7a/libapp.so",
    "lib/x86_64/libapp.so",
    "assets/flutter_assets/AssetManifest.json",
  ];
  assert.deepEqual(aotAbis(entries), ["arm64-v8a", "armeabi-v7a", "x86_64"]);
});

test("aotAbis reports NOTHING for a debug APK", () => {
  // A debug APK carries libflutter.so and a kernel snapshot, but no libapp.so — this is the whole
  // signal that distinguishes the two, so it has to come back empty rather than nearly-empty.
  const entries = [
    "lib/arm64-v8a/libflutter.so",
    "assets/flutter_assets/kernel_blob.bin",
    "classes.dex",
  ];
  assert.deepEqual(aotAbis(entries), []);
});

test("aotAbis is anchored — a lookalike path does not count", () => {
  // Without the anchors, `assets/.../libapp.so.txt` or a nested copy would register as AOT and a
  // debug build would report itself as a release one.
  const entries = [
    "assets/flutter_assets/lib/arm64-v8a/libapp.so",
    "lib/arm64-v8a/libapp.so.bak",
    "lib/arm64-v8a/notlibapp.so",
  ];
  assert.deepEqual(aotAbis(entries), []);
});

test("isDebugSigned recognises Android's stock debug identity", () => {
  assert.equal(isDebugSigned(DEBUG_CERT_DN), true);
  // Measured on this repo before the signing config existed.
  assert.equal(isDebugSigned("C=US, O=Android, CN=Android Debug"), true);
  // Extra RDNs appear depending on the SDK version; still the shared debug key.
  assert.equal(isDebugSigned("C=US, ST=California, O=Android, CN=Android Debug"), true);
});

test("isDebugSigned does NOT flag a real signing identity", () => {
  // The failure that would matter in the other direction: rejecting a genuine release build and
  // blocking a publish that should have gone out.
  assert.equal(isDebugSigned("C=IQ, O=QrAi, CN=QrAi Release"), false);
  assert.equal(isDebugSigned("CN=Hikmah Pilot Erbil, O=QrAi"), false);
  // "Debug" in an org name is not the debug KEY.
  assert.equal(isDebugSigned("C=IQ, O=Debug Studios, CN=QrAi Release"), false);
});

test("parseSignerDn reads BOTH apksigner output formats", () => {
  // These two are verbatim from the two apksigners this project actually runs against, and they
  // disagree. Handling only the first made CI red on a correctly-signed artifact.
  const runnerFormat = [
    "V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug",
    "V2 Signer: certificate SHA-256 digest: 75860d735df094ee3452a3da46cf23db",
  ].join("\n");
  assert.equal(parseSignerDn(runnerFormat), "C=US, O=Android, CN=Android Debug");
  assert.equal(
    parseSignerDn("V3 Signer: certificate DN: C=IQ, O=QrAi, CN=QrAi Release"),
    "C=IQ, O=QrAi, CN=QrAi Release",
  );
});

test("parseSignerDn reads the build-tools 36 output format", () => {
  const output = [
    "Verifies",
    "Verified using v1 scheme (JAR signing): false",
    "Verified using v2 scheme (APK Signature Scheme v2): true",
    "Number of signers: 1",
    "Signer #1 certificate DN: C=US, O=Android, CN=Android Debug",
    "Signer #1 certificate SHA-256 digest: abc123",
  ].join("\n");
  assert.equal(parseSignerDn(output), "C=US, O=Android, CN=Android Debug");
});

test("parseSignerDn returns null rather than throwing when there is no DN", () => {
  // This is the CI failure that cost a round-trip: apksigner exited 0, printed no DN line, and the
  // script threw with none of its output captured — so the log said only "printed no certificate
  // DN" and there was no way to tell whether the APK was unsigned, apksigner was broken, or the
  // format had changed. null is now a reportable state and the raw output is printed alongside it.
  assert.equal(parseSignerDn("DOES NOT VERIFY\nERROR: APK Signature Scheme v2 signature required"), null);
  assert.equal(parseSignerDn(""), null);
  assert.equal(parseSignerDn("Verifies\nNumber of signers: 0"), null);
});
