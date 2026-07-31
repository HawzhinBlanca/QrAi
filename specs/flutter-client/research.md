# Research — Phase 8: the Flutter client

Measured against `9f7e772` (Phase 7 merged).

---

## 1. What exists today

```bash
find apps/web/src -name '*.ts*' | xargs wc -l | tail -1        # 10773
find apps/mobile -name '*.ts*' | grep -v node_modules | xargs wc -l | tail -1  # 661
find . -name '*.dart' -o -name pubspec.yaml | grep -v node_modules            # (none)
```

| | lines |
|---|---|
| `apps/web` (React, 33 components) | **10,773** |
| `apps/mobile` (Expo) | **661** — a stub |
| Dart / Flutter | **0** |

So "the Flutter client" is not a port of a mobile app; it is a **new client**, and the thing it would
replace is a 661-line stub. `migration/plan.md §3.4` already recommends **keeping React for web**, so
Phase 8 is "build a mobile client", not "replace the web client".

## 2. 🔴 The strongest argument for Flutter was already withdrawn — by this plan

`migration/plan.md §3.1` rejects QCF/KFGQPC page fonts for v1: no SPDX-identifiable licence,
no-modification terms that forbid the required subsetting, and PUA codepoints that break screen
readers, copy/paste and search. It then says so itself:

> "This also **weakens the strongest argument for Flutter**."

Its prescribed fallback is **"HarfBuzz-backed shaping with a properly licensed Uthmani font."**

**That is what the web client already does.** `apps/web/src/main.tsx:2-3` imports `@fontsource/amiri`,
and the built bundle ships the Arabic subsets, not just Latin (verified — `amiri-arabic-400-normal`
and `-700-` in both `.woff` and `.woff2`). Amiri is OFL-licensed Uthmani-style naskh, and the browser
shapes it with HarfBuzz.

So on mushaf rendering specifically, Flutter's expected gain over the current client is **not
established**. It may still win on control (line-breaking, per-word hit targets, offline
determinism), but that is a hypothesis to test, not a reason already in hand.

## 3. 🔴 There is no client-side oracle, at all

Phases 5–7 built API-level oracles: 26 golden fixture steps, 56 parity tests, cross-language ticket
vectors. **Not one of them can check a client.** They assert what the server returns; nothing asserts
what a screen renders, what a mic captures, or what a learner can reach.

Phase 7 learned this the expensive way: the one route with no executable check was the one ported
wrong in four ways while every existing test stayed green. A whole client has **no** executable
check. That is the same hazard, over 10,773 lines of behaviour instead of one route.

`migration/plan.md` Part 4 is the answer it already prescribes — OpenAPI 3.1 as the single contract,
`openapi-typescript` for TS, `ajv` for runtime validation, `quicktype` for Dart models, and golden
vectors read by `dart test`. Part 4 says of that corpus: *"do this even if the migration is
cancelled."*

## 4. 🔴 381 strings, and zero of them are Kurdish

```bash
node -e "…count leaf strings in apps/web/src/locales/en.json"   # 381
```

`apps/web/src/i18n/index.ts:22-25`:

```ts
en:  { translation: en },
ckb: EMPTY_TRANSLATION,
ar:  EMPTY_TRANSLATION,
tr:  EMPTY_TRANSLATION,
```

The app whose stated goal is to be number one **for Kurdish** has **no Kurdish user-facing text**.
`fallbackLng: "en"` makes every key resolve to English, so a Kurdish learner sees an English app.

This is identical in React and in Flutter. **A rewrite adds zero Kurdish words.** It is the product's
largest user-facing gap and Phase 8 does not touch it — which is worth stating plainly once, not as
an argument against the phase but as a fact about what the phase is and is not.

## 5. Auth: §3.3 is backend security work, on a surface that is currently off

`__Host-` cookies require a browser origin; a Flutter app is not one. None of the P1.6 pilot flow
ports — not the cookie, not the Origin allowlist, not the CSRF digest. Mobile needs bearer tokens
plus Keychain/Keystore storage, which re-opens `P4.1` (threat model) and `P1.7` (identity boundary).

And the login surface is **disabled by owner instruction** and stays disabled until they say
otherwise. So this work would harden an entry point that currently does not exist.

## 6. 🔴 The toolchain to do any of this is absent from this machine

```bash
which flutter dart fvm      # all: not found
xcode-select -p             # /Library/Developer/CommandLineTools
ls /Applications/Xcode.app  # ABSENT
xcrun simctl list runtimes  # error: unable to find utility "simctl"
```

- **No Flutter, no Dart, no fvm.**
- **No Xcode** — only Command Line Tools. There is therefore **no iOS Simulator**, so no
  `flutter run`, no simulator screenshots, and no way to exercise `record`/`just_audio`/`audio_session`.
- **No physical devices.** Phase 8's stated gate is *"parity checklist; physical-device matrix"*,
  and the device half cannot be produced here at all.

What *is* possible without Xcode: the Flutter SDK is a user-space tarball, and `dart test` runs pure
Dart with no platform toolchain. So the **contract layer** (§3) is reachable; the **app** is not.

## 7. What Phase 8 would actually consume

`migration/plan.md` Part 6 budgets **12–20 weeks** for: mushaf, audio, bearer auth, i18n, a11y — for
a product with zero users, whose Kurdish UI does not exist, on a mobile surface currently served by a
661-line stub, using a framework whose headline advantage for this domain has already been ruled out
by the same document.
