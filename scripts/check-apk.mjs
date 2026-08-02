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
import { execFileSync, spawnSync } from "node:child_process";
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
 * Pull the Subject DN out of `apksigner verify --print-certs` output.
 *
 * Returns null when there is no DN to find — an unsigned APK, or an apksigner whose output does not
 * carry the line. Null is a legitimate answer, not an error: an unsigned artifact is a real state a
 * build can be in, and the caller decides whether it matters.
 */
export function parseSignerDn(output) {
  // Two formats, because apksigner versions disagree and BOTH are in play here:
  //   build-tools 36 (macOS dev machine):  "Signer #1 certificate DN: C=US, …"
  //   the GitHub runner's SDK:             "V2 Signer: certificate DN: C=US, …"
  // Matching only the first is what made the android job red on its first run while the build
  // itself was fine — the artifact was correctly signed and the reader could not read it.
  const found = output.match(/(?:Signer #\d+|V\d+ Signer:)\s+certificate DN:\s*(.+)/);
  return found ? found[1].trim() : null;
}

/**
 * The signing certificate's Subject DN, or `{ dn: null, raw }` if it cannot be read.
 *
 * Modern APKs use signature scheme v2/v3, which lives in the APK signing block rather than
 * META-INF — unzipping and reading a .RSA finds nothing (measured). apksigner understands both.
 *
 * It does NOT throw on a non-zero exit. `apksigner verify` exits non-zero for an unsigned or
 * unverifiable APK, and the first version of this script let that (and a missing DN) crash the CI
 * step with no way to tell which had happened — the raw output was never captured, so the failure
 * was undiagnosable from the log. Everything apksigner said now comes back with the answer.
 */
export function signerDn(apk, apksigner = findApksigner()) {
  const result = spawnSync(apksigner, ["verify", "--print-certs", apk], {
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
  if (result.error) return { dn: null, raw: `apksigner could not be run: ${result.error.message}` };
  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { dn: parseSignerDn(raw), raw, status: result.status };
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

  // AOT first, and printed before anything can go wrong reading the signature: it is the assertion
  // this script exists for, and an unreadable signer must not hide it.
  const abis = aotAbis(zipEntries(apk));
  console.log(`apk:        ${apk}`);
  console.log(`AOT (Dart): ${abis.length ? abis.join(", ") : "NONE — this is not a release build"}`);

  const { dn, raw } = signerDn(apk);
  const debugSigned = dn !== null && isDebugSigned(dn);
  console.log(
    `signer:     ${dn ?? "UNKNOWN — apksigner reported no certificate"}` +
      (debugSigned ? "   ← DEBUG KEY, not distributable" : ""),
  );
  if (dn === null) {
    // Everything apksigner said, so a CI failure here is diagnosable from the log alone. The
    // first version of this script threw with none of this and cost a full CI round-trip.
    console.log(`\napksigner output:\n${raw || "(nothing)"}\n`);
  }

  const problems = [];
  // An APK with no libapp.so is a debug artifact wearing a release name. Always a failure: the
  // whole point of building release in CI is to exercise the AOT compiler.
  if (abis.length === 0) {
    problems.push("no lib/*/libapp.so — the Dart was not compiled ahead of time");
  }
  // Only under --require-release. Without it this is a REPORT: CI holds no keystore by design, and
  // an unreadable or absent signature there is expected, not a defect.
  if (requireRelease && debugSigned) {
    problems.push(
      "signed with the Android debug key. Play Console rejects this. " +
        "Create android/key.properties (docs/RELEASE_SIGNING.md) and rebuild.",
    );
  }
  if (requireRelease && dn === null) {
    problems.push(
      "the signing certificate could not be read, so this artifact cannot be confirmed " +
        "distributable. apksigner output is above.",
    );
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(
    dn === null
      ? "\nOK (compile check — signature unread)"
      : debugSigned
        ? "\nOK (compile check — NOT distributable)"
        : "\nOK (distributable)",
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
