# Plan — completing the Flutter client and the Node backend migration

Status: **APPROVED 2026-08-01** — see §8. Per `AGENTS.md` §Workflow step 2, implementation began
only after the approval line below was filled in.

Read `research.md` first. The two tracks have **different feasibility**, and that asymmetry — not
scope preference — is what shapes this plan.

---

## 1. The decision that gates Track F

`research.md §1`, measured today: **no Flutter, no Dart, no Xcode, no simulators, no devices.**

Consequences that no amount of engineering removes:

| requested proof | can I produce it here? |
|---|---|
| Dart source + `dart analyze` clean | ✅ after a user-space SDK install (no admin) |
| `flutter test` — unit, widget, golden | ✅ headless, no Xcode, no Android Studio |
| API-contract tests against the real Rust API | ✅ Dart client vs live `platform-api` |
| Android debug build + emulator run | ⚠️ likely — needs `cmdline-tools` + JDK 17/21 + a system image |
| **iOS build / simulator screenshot** | ❌ **needs Xcode: ~17 GB, Apple ID, admin password** |
| **Physical device, either platform** | ❌ **no devices attached** |

I will not write a client I cannot compile. Uncompiled Dart is not a deliverable — it is the false
green `OC2`, `MIG1` and `CU2` were each built to refuse.

### Track F options — pick one

**F-A — Install the Flutter SDK to user space, build the app, prove what is provable *(recommended)*.**
Download the SDK tarball to `~/flutter` (no admin). Build the complete client. Gate it on
`dart analyze` + `flutter test` + contract tests against the running Rust API, and attempt the
Android emulator. **Ship the iOS half as an explicitly open row** until Xcode exists.
*Honest outcome: a real, compiling, tested Flutter app; iOS device proof deferred to the owner.*

**F-B — Contract and models only.** Extend the existing `OC` track: generate/hand-write Dart models
+ a typed API client from `openapi.yaml`, tested with `dart test`. No screens, no audio, no device.
*Smaller, fully provable, but not "a complete Flutter mobile client."*

**F-C — Write the app source without a toolchain.** Explicitly recommended **against**. Thousands of
lines of never-parsed Dart, no test can run, every claim unverifiable.

**F-D — Defer Track F entirely** until Xcode + devices exist, and spend this cycle on Track N.

> **Owner action that unblocks the iOS half under any option:** install Xcode from the App Store and
> run `sudo xcode-select -s /Applications/Xcode.app`. Both steps need credentials I must not handle.

---

## 2. Track N — route-by-route, in waves

36 of 38 operations remain. The order is chosen so that **each wave is independently shippable,
independently reversible, and increases risk monotonically** — nothing touching privacy or the
review gates moves until the primitives have been exercised on easier routes.

| wave | operations | new risk introduced |
|---|---|---|
| **N7** route table | — | refactor only: replace 38 `if (ported.has(…))` blocks with one table |
| **N8** `/health` `/ready` `/metrics` | 3 | Prometheus text format; the dev-open metrics gate |
| **N9** `/v1/quran/*` | 3 | **canonical text — byte-identical, never normalized** |
| **N10** `/v1/learner/progress` POST + weekly | 2 | writes; SM-2 scheduling arithmetic |
| **N11** `/v1/agent-runs`, `/v1/audit-events`, `/v1/eval-runs/{v}` | 4 | jsonb round-trip; audit append-only |
| **N12** auth: `token`, `register`, `login` | 3 | **bcrypt cost 12**, HS256 claims, timing |
| **N13** pilot: `bootstrap`, `logout`, `invitations` | 3 | `__Host-` cookie attrs, CSRF, idle/absolute expiry |
| **N14** recitation ×6 | 6 | largest handler (805 lines); FK 404s; model-version provenance |
| **N15** review gates ×5 | 5 | **AI feedback needs source + confidence + approval** |
| **N16** ML/ASR proxies ×4 | 4 | server-side key injection, 16 MB limit, streaming |
| **N17** privacy: `export`, `delete` | 2 | **erasure crosses into ML storage; irreversible** |

### The rule for every wave, without exception

```
1. Write the A/B parity case FIRST, against Rust, and watch it pass unported (proxied).
2. Port the handler using withTenant + requireAnyRole/requireSelfOrAny. No raw client. Ever.
3. Re-run the A/B with the route ported. Byte-identical body, status, and headers, or it is not done.
4. Prove the oracle has teeth: mutate the port, watch the A/B go red. A green that cannot go red
   is not evidence.
5. bash scripts/verify.sh. Only then does the ledger row flip, and only via update-ledger.sh.
```

Step 4 is not ceremony. `N5`'s first attempt passed **every pre-existing test in the repo** while
failing 7 of 9 checks in the oracle written for it — wrong role lists, consent from the wrong
source, and neither of the two rows it must persist.

### N7 in detail — the one structural change

`server.mjs` today hardcodes each ported route in its own `if` block. At 38 routes that is 38 blocks
and a `PORTABLE` array that `scripts/cutover-readiness.mjs` parses **by regex**. The port needs a
single table:

```js
export const ROUTES = [
  { key: "GET /v1/learner/progress", method: "get", path: "/v1/learner/progress", handler: getProgress },
  …
];
export const PORTABLE = ROUTES.map((r) => r.key);   // ← regex in cutover-readiness.mjs must still match
```

Handlers move to `services/node-api/routes/<domain>.mjs`, one file per Rust handler module. This is
the *only* refactor in the plan; every other wave adds handlers and cases.

> ⚠️ `cutover-readiness.mjs:33` matches `/export const PORTABLE = \[([^\]]*)\]/s`. A computed
> `PORTABLE` breaks that regex silently — the check would report 0 portable and still exit 0. N7's
> acceptance therefore includes `cutover-readiness.mjs` reporting the new count, asserted by a test.

### What "enabled" means, and what it does not

Porting a route makes it **portable**. `NODE_API_PORTED ?? ""` keeps the default empty, so **no
production traffic moves** until a separate, explicit decision. `traffic-share` stays UNMET on
purpose until then. Waves N8–N17 do not constitute a cutover and must not be described as one.

---

## 3. Track C — cutover machinery (only after N17)

- **C-a** `rollback-artifact` + `adr-0022-accepted`: **one owner decision** — local image tags vs a
  registry. Blocked on the owner; ADR-0022 is `Proposed`.
- **C-b** `operational-proof` (`P5.5`, `P5.6`): kill switch, rollback, DR drill. Needs a deployment
  that does not exist.
- **C-c** `security-sign-off` (`P1.7`, `P4.1`): a person's signature. `summarise()` has no `ready`
  field so no script can ever claim it. **Not automatable, by design.**
- **C-d** traffic switching: percentage routing + an instant revert, provable in a drill.

**C-a…C-c are not engineering tasks.** They are one decision, one deployment, and one signature.

---

## 4. Non-goals

- Replacing the React web app. Explicitly out of scope; `apps/web` must not regress.
- Removing `apps/mobile` (React Native). A Flutter client does not retire it without its own decision.
- Deleting the Rust services. The strangler keeps Rust authoritative until a proven cutover.
- Committing the 11 other-session files (`research.md §7`). Not mine.
- Kurdish translation. 0 of 384 strings reviewed; needs a Sorani speaker with religious literacy.
- Whisper model selection (`docker-compose.yml:186` pins generic `base`). A model decision.

---

## 5. Risks

| risk | mitigation |
|---|---|
| **A JS port of a security control fails open** (`research.md §2`) | `withTenant` is the only DB path; `RLS_PROBE_ROLE` runs the suite as `quran_ai_app`; N3's 8 stale-tenant tests extend per wave |
| Wire drift invisible to tests | byte-level A/B per route + `verify-parity-teeth.sh`; mutation step is mandatory |
| bcrypt/JWT mismatch silently accepts bad credentials | cross-language vectors like `ticket-vectors.json`, generated **from Rust** |
| Canonical Quran text normalized in transit | byte + digest assertions on `/v1/quran/*`; `canonical-gates.json` already carries the anchors |
| Privacy delete diverges → data survives erasure | N17 last; erasure asserted by querying ML storage directly, not by trusting a 200 |
| Flutter work produces unverifiable artifacts | F-A gates on `dart analyze` + `flutter test`; iOS row stays **open**, never "done" |
| Scope this large stalls mid-way | every wave is a shippable, revertible unit; stopping after any wave leaves the repo green |

---

## 6. What this plan does NOT establish

- That the Node backend is production-ready. It is not, and will not be, until a cutover drill
  proves rollback and a security reviewer signs.
- That a Flutter client works on any device. Under F-A it will be *compiled and headlessly tested*.
  That is not device proof and will not be reported as such.
- That the migration is a good idea (`research.md §8`). The direction is reaffirmed; the note stands.

---

## 7. Questions for the approver

**Q1 — Track F scope.** F-A (install SDK, build the app, prove what's provable, iOS row stays
open) · F-B (contract + models only) · F-C (unverified source — not recommended) · F-D (defer).

**Q2 — Track N depth this cycle.** All of N7–N17 · through N11 (low-risk waves, stop before auth) ·
through N14 · N7 only (the route table, so later waves are cheap).

**Q3 — ADR-0022.** Local digest-pinned image tags, or a real registry? This one answer closes two
of the five UNMET readiness checks and is the only cutover blocker I cannot move.

---

## 8. Approval

```
Approved-by: repository owner (in-session, 2026-08-01)
Date: 2026-08-01
Scope: Q1 = F-A   Q2 = N7–N17 (all 36 routes)   Q3 = local digest-pinned image tags
```

**Q1 = F-A.** Install the Flutter SDK to user space, build the client, gate it on `dart analyze` +
`flutter test` + contract tests against the live Rust API, attempt the Android emulator. **F-9 (iOS
device/simulator) stays OPEN** — it needs Xcode, which needs the owner's Apple ID and password.

**Q2 = N7–N17.** All 36 remaining operations. Ported ≠ enabled: `NODE_API_PORTED` stays empty, so
`traffic-share` remains UNMET and no production traffic moves without a separate decision.

**Q3 = local digest-pinned image tags.** ADR-0022 moves to Accepted with that decision recorded; a
workflow builds and digest-pins images locally and retains the last N for rollback. No registry, no
credentials. This closes `rollback-artifact` and `adr-0022-accepted` — 2 of the 5 UNMET checks.
`operational-proof` still needs a deployment and `security-sign-off` still needs a signature.
