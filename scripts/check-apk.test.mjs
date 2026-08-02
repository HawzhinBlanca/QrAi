import assert from "node:assert/strict";
import test from "node:test";

import { DEBUG_CERT_DN, aotAbis, isDebugSigned } from "./check-apk.mjs";

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
