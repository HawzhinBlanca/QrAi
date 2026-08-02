import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `PrivacyInfo.xcprivacy` must exist AND be bundled into the app.
 *
 * App Store Connect rejects an upload that uses a required-reason API without a privacy manifest.
 * The failure mode this file exists for is subtler than a missing file: a manifest that sits in the
 * repo but is not a member of the Runner target's Resources build phase is **not copied into the
 * .app**, so Apple never sees it and the rejection is identical — while every file in the tree
 * looks right.
 *
 * ── Why a text check ─────────────────────────────────────────────────────────────────────────
 * There is no Xcode on this project's development machine (`xcodebuild` resolves to Command Line
 * Tools; `xcrun simctl` lists zero devices), so the iOS target has never been compiled and no build
 * can confirm any of this. Reading the project file is the strongest check available here. On macOS
 * it additionally lints the two files as plists, which catches the corruption that a hand-edited
 * pbxproj is actually prone to.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ios = join(here, "..", "..", "apps", "flutter", "ios");
const MANIFEST = join(ios, "Runner", "PrivacyInfo.xcprivacy");
const PBXPROJ = join(ios, "Runner.xcodeproj", "project.pbxproj");

/** The Runner APP target's Resources phase. RunnerTests has its own (331C807F…) and is not it. */
const APP_RESOURCES_PHASE = "97C146EC1CF9000F007C117D";

const onMacOS = process.platform === "darwin";

test("the privacy manifest exists", () => {
  assert.ok(existsSync(MANIFEST), `${MANIFEST} is missing; App Store Connect will reject the upload`);
});

test("it declares no tracking and at least one required-reason API", () => {
  const xml = readFileSync(MANIFEST, "utf8");
  for (const key of [
    "NSPrivacyTracking",
    "NSPrivacyTrackingDomains",
    "NSPrivacyCollectedDataTypes",
    "NSPrivacyAccessedAPITypes",
  ]) {
    assert.ok(xml.includes(key), `the manifest omits ${key}; Apple expects all four keys`);
  }
  // The app records a learner's recitation. A manifest that forgot to say so would be a false
  // statement to Apple, not merely an incomplete one.
  assert.ok(
    xml.includes("NSPrivacyCollectedDataTypeAudioData"),
    "the app records audio but the manifest does not declare audio data collection",
  );
});

test("it is BUNDLED into the app, not merely present in the repo", () => {
  const project = readFileSync(PBXPROJ, "utf8");

  const buildFile = project.match(
    /([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile/,
  );
  assert.ok(buildFile, "no PBXBuildFile for PrivacyInfo.xcprivacy — it is not in any build phase");

  const phase = project.match(
    new RegExp(`${APP_RESOURCES_PHASE}[^=]*= \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`),
  );
  assert.ok(phase, "the Runner target's Resources build phase is gone or was renumbered");
  assert.ok(
    phase[1].includes(buildFile[1]),
    "PrivacyInfo.xcprivacy is not in the Runner APP target's Resources phase, so it will not be " +
      "copied into the .app. Apple never sees it and rejects the upload exactly as if it were absent.",
  );
});

test("both files still parse as plists", { skip: !onMacOS && "plutil is macOS-only" }, () => {
  // A hand-edited pbxproj is the realistic way this breaks, and a corrupt one fails at `flutter
  // build ipa` — which nobody here can run.
  for (const file of [MANIFEST, PBXPROJ]) {
    execFileSync("plutil", ["-lint", file], { stdio: "pipe" });
  }
});

// ── App icons ────────────────────────────────────────────────────────────────────────────────────
// Both failures below are silent: the build succeeds, the app installs, and you find out from a
// rejection email or from the stock Flutter logo sitting on a learner's home screen.

const APPICONSET = join(ios, "Runner", "Assets.xcassets", "AppIcon.appiconset");

/** width, height and whether the PNG declares an alpha channel — read from the IHDR chunk. */
function pngHeader(file) {
  const buf = readFileSync(file);
  // 8-byte signature, then IHDR: length(4) type(4) width(4) height(4) bitDepth(1) colourType(1)
  assert.equal(buf.readUInt32BE(12), 0x49484452, `${file} is not a PNG`);
  const colourType = buf.readUInt8(25);
  // Colour types 4 (grey+alpha) and 6 (RGBA) carry an alpha channel.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), hasAlpha: colourType === 4 || colourType === 6 };
}

test("every iOS icon exists at the size Contents.json declares", () => {
  const manifest = JSON.parse(readFileSync(join(APPICONSET, "Contents.json"), "utf8"));
  const wrong = [];
  for (const image of manifest.images) {
    if (!image.filename) continue;
    const expected = Math.round(parseFloat(image.size) * parseFloat(image.scale));
    const { width, height } = pngHeader(join(APPICONSET, image.filename));
    if (width !== expected || height !== expected) {
      wrong.push(`${image.filename}: declared ${expected}x${expected}, actually ${width}x${height}`);
    }
  }
  assert.deepEqual(wrong, [], `iOS rejects an icon set whose files disagree with Contents.json:\n  ${wrong.join("\n  ")}`);
});

test("no iOS icon has an alpha channel", () => {
  // App Store Connect rejects icons with transparency outright — "Invalid Image - the icon
  // cannot contain an alpha channel". `scripts/generate-app-icons.sh` flattens them.
  const withAlpha = readdirSync(APPICONSET)
    .filter((f) => f.endsWith(".png"))
    .filter((f) => pngHeader(join(APPICONSET, f)).hasAlpha);
  assert.deepEqual(withAlpha, [], `these carry alpha and will be rejected: ${withAlpha.join(", ")}`);
});

test("the icons are not still Flutter's stock placeholder", () => {
  // Shipping the default blue Flutter logo is the kind of thing nobody notices until a learner
  // has it on their home screen. Both platforms are generated from the same brand SVG, so if
  // either one reverts to the template the two stop matching.
  const svg = readFileSync(join(here, "..", "..", "apps", "flutter", "assets", "icon", "qrai-icon.svg"), "utf8");
  assert.ok(svg.includes("&#1602;"), "the icon source no longer draws the brand mark's ق");

  for (const [dir, file] of [
    [APPICONSET, "Icon-App-1024x1024@1x.png"],
    [join(ios, "..", "android", "app", "src", "main", "res", "mipmap-xxxhdpi"), "ic_launcher.png"],
  ]) {
    const { width, hasAlpha } = pngHeader(join(dir, file));
    assert.ok(width > 0 && !Number.isNaN(width), `${file} is unreadable`);
    // The stock Flutter launcher icons ship WITH alpha; ours are flattened. Weak on its own,
    // which is why it sits alongside the SVG check above.
    assert.equal(hasAlpha, false, `${file} looks like the stock template (alpha present)`);
  }
});
