# Release signing

What stands between a build that compiles and a build a store will accept.

## Android

### Current state

`flutter build apk --release` produces a working, AOT-compiled APK signed with **Android's stock
debug key**:

```
signer:     C=US, O=Android, CN=Android Debug   ← DEBUG KEY, not distributable
```

Play Console rejects debug-signed uploads. Nothing else about the build is wrong — this is one
missing file, not a code problem.

### What you need to do

The keystore is a credential, so it is yours to create and hold. It is deliberately not generated,
stored, or committed by any tooling in this repo.

```bash
keytool -genkey -v -keystore ~/qrai-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias qrai
```

Then create `apps/flutter/android/key.properties` — **gitignored**, never committed:

```properties
storePassword=<the store password you chose>
keyPassword=<the key password you chose>
keyAlias=qrai
storeFile=/absolute/path/to/qrai-release.jks
```

`build.gradle.kts` picks it up automatically. Rebuild and confirm:

```bash
node scripts/check-apk.mjs apps/flutter/build/app/outputs/flutter-apk/app-release.apk --require-release
```

### Guard this keystore

It is the app's identity. Anyone holding it can publish an update to `com.qrai.qrai` that Play
accepts as genuine, and **it cannot be rotated for an already-published app** — losing it means
publishing under a new package name and every installed user having to reinstall by hand.

- Back it up somewhere that is not this machine and not this repo.
- `*.jks`, `*.keystore` and `key.properties` are in `.gitignore`; `scripts/verify.sh`'s secret guard
  is the second line.
- For CI publishing, base64 the keystore into an encrypted Actions secret and write
  `key.properties` at job time. Do not check either into the repo.

## iOS

`ios/Runner/PrivacyInfo.xcprivacy` is present and declares the required-reason APIs the app uses.
Beyond that, submission needs an Apple Developer account, a distribution certificate and a
provisioning profile — all credentials, all yours.

**Nothing about the iOS build has ever been verified in this repo.** There is no Xcode on the
development machine (`xcodebuild` resolves to Command Line Tools only, `xcrun simctl` lists zero
devices), so the iOS target has never been compiled, let alone run. Treat every iOS claim here as
unproven until a build exists.

## What CI does and does not prove

`.github/workflows/ci.yml`'s `android` job builds a release APK and runs `check-apk.mjs` **without**
`--require-release`. It proves the Dart AOT compiler runs and the artifact is well-formed. It does
not produce a distributable build, by design: CI has no keystore.

When you wire up publishing, that is where `--require-release` belongs.
