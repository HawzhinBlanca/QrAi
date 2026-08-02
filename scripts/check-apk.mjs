#!/usr/bin/env node
/**
 * Inspect a built Android APK and say what it actually is.
 *
 *   node scripts/check-apk.mjs <apk>                     # report; fail only on a broken artifact
 *   node scripts/check-apk.mjs <apk> --require-release   # additionally: must be distributable
 *
 * Two things a build log will not tell you:
 *
 * 1. **Did the Dart actually compile ahead of time?** A debug APK bundles a kernel snapshot and
 *    JITs it; only a release build produces `libapp.so`. "Built app-release.apk" is printed either
 *    way if the build type is misconfigured, so the artifact is the only honest answer.
 *
 * 2. **Who signed it?** `flutter build apk --release` happily signs with Android's stock DEBUG key
 *    when no keystore is configured — measured on this repo: `C=US, O=Android, CN=Android Debug`.
 *    The APK looks completely normal until Play Console rejects the upload.
 *
 * `--require-release` is what a publish pipeline runs. Without it this only reports the signer,
 * because CI has no keystore by design and a hard failure there would just be noise.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Entries inside the APK, from `unzip -l`. */
export function zipEntries(apk) {
  const listing = execFileSync("unzip", ["-l", apk], { encoding: "utf8", maxBuffer: 64 << 20 });
  return listing
    .split("\n")
    .map((l) => l.trim().split(/\s+/).slice(3).join(" "))
    .filter(Boolean);
}

/** ABI directories carrying an AOT-compiled Dart image. */
export function aotAbis(entries) {
  return entries
    .map((e) => e.match(/^lib\/([^/]+)\/libapp\.so$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * The Subject DN of the signing certificate.
 *
 * Modern APKs use signature scheme v2/v3, which lives in the APK signing block rather than
 * META-INF — so unzipping and reading a .RSA finds nothing (measured). apksigner is the tool that
 * understands both.
 */
export function signerDn(apk, apksigner = findApksigner()) {
  const out = execFileSync(apksigner, ["verify", "--print-certs", apk], {
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
  const found = out.match(/Signer #1 certificate DN:\s*(.+)/);
  if (!found) throw new Error(`apksigner printed no certificate DN for ${apk}`);
  return found[1].trim();
}

/** Android's stock debug identity. Every SDK install generates the same DN. */
export const DEBUG_CERT_DN = "C=US, O=Android, CN=Android Debug";

export function isDebugSigned(dn) {
  // Substring, not equality: the DN can carry extra RDNs depending on the SDK version, and the
  // part that matters is that it is the shared debug identity rather than a real one.
  return dn.includes("CN=Android Debug");
}

function findApksigner() {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.HOME ?? "", "Library/Android/sdk");
  const buildTools = join(home, "build-tools");
  if (!existsSync(buildTools)) {
    throw new Error(
      `no Android build-tools under ${buildTools}. Set ANDROID_HOME, or install the SDK — ` +
        `the signer cannot be read without apksigner.`,
    );
  }
  // Highest version present: apksigner is backward compatible, and pinning a version here would
  // break on every SDK bump for no benefit.
  const version = readdirSync(buildTools).sort().at(-1);
  return join(buildTools, version, "apksigner");
}

function main(argv) {
  const apk = argv.find((a) => !a.startsWith("--"));
  const requireRelease = argv.includes("--require-release");
  if (!apk) {
    console.error("usage: check-apk.mjs <apk> [--require-release]");
    process.exit(2);
  }
  if (!existsSync(apk)) {
    console.error(`no such APK: ${apk}`);
    process.exit(2);
  }

  const entries = zipEntries(apk);
  const abis = aotAbis(entries);
  const dn = signerDn(apk);
  const debugSigned = isDebugSigned(dn);

  console.log(`apk:        ${apk}`);
  console.log(`AOT (Dart): ${abis.length ? abis.join(", ") : "NONE — this is not a release build"}`);
  console.log(`signer:     ${dn}${debugSigned ? "   ← DEBUG KEY, not distributable" : ""}`);

  const problems = [];
  // An APK with no libapp.so is a debug artifact wearing a release name. Always a failure: the
  // whole point of building release in CI is to exercise the AOT compiler.
  if (abis.length === 0) {
    problems.push("no lib/*/libapp.so — the Dart was not compiled ahead of time");
  }
  if (requireRelease && debugSigned) {
    problems.push(
      "signed with the Android debug key. Play Console rejects this. " +
        "Create android/key.properties (docs/RELEASE_SIGNING.md) and rebuild.",
    );
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(debugSigned ? "\nOK (compile check — NOT distributable)" : "\nOK (distributable)");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
