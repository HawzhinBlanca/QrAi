# The three credential states, as the app actually renders them

**2026-08-02.** `AUD1` gave the app an out-of-band token (`QRAI_DEV_BEARER_TOKEN` → platform secure
storage; **debug builds only** — see the correction below). This is what a learner sees in each state, driven in a browser against `platform-api` on
the real Postgres — not inferred from the code.

The reader is a **public** route and works in all three. Only the authenticated tabs differ.

| build | `GET /v1/learner/progress` | Progress tab renders | retry offered |
|---|---|---|---|
| no token | `401 missing or invalid authorization` | "This device isn't set up for a learner yet. Ask your teacher." | no |
| rejected token | `401 missing or invalid authorization` | same | no |
| valid HS256 token | `200` | mastery 1.00, streak 0, sessions 0, the real next-review date | n/a |

## Why the message reads that way

It used to say **"Please sign in again."** There is no sign-in screen — the owner removed it and it
stays removed — so that sent a learner looking for something that does not exist. A device reaches
this state only when its provisioned token is missing, wrong or expired, and nothing the learner can
do inside the app will fix it. Saying so, and naming who can, is the only honest option.

No retry button, deliberately: `ApiErrorKind.unauthorized` is not `isRetryable`, because pressing it
would fail identically every time.

## Correction, 2026-08-02

The mechanism these runs used was `--dart-define=QRAI_BEARER_TOKEN`, and the code comment claimed
the value was "not read back out of the build". **That was false.** `--dart-define` compiles the
value into the artifact; `strings` on an APK or an extracted IPA finds it, and copying it into the
Keychain at launch does not remove it. A pilot build shipped that way would hand every recipient a
working bearer token.

It is now `QRAI_DEV_BEARER_TOKEN` and a release build refuses it outright
(`shouldProvisionDevToken`, tested). The measurements above still stand — they were taken with debug
builds, which is exactly what the mechanism is now limited to.

**Real provisioning is not implemented and is an owner decision.** Device-bound enrolment, MDM
delivery, or a one-time code redeemed in-app; the last is credential entry and touches the standing
instruction that login stays removed.

## What this does NOT prove

- **Nothing ran on a phone.** These are web builds. `FL9` is open.
- Token *rotation* was not exercised: the app writes the build-time token to secure storage at every
  launch, so a token that expires mid-session is only recoverable by re-provisioning the device.
  Whether a pilot should instead redeem an invitation code in-app is an owner decision (`main.dart`).
