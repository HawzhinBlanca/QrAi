# Migration completion — Tasks

Scope approved 2026-08-01: **Q1 = F-A**, **Q2 = N7–N17 (all 36 routes)**, **Q3 = local
digest-pinned image tags**. See [`plan.md`](plan.md) §8 and [`research.md`](research.md).

**Task-ID prefixes `N7…N17`, `FL*`, `AR1`.** `scripts/update-ledger.sh` matches `- \[ \] <task> `
across **every** `specs/*/tasks.md`, so a collision would flip another spec's row. Checked against
the full existing set (`C*`, `CU1…CU4`, `F1…F5`, `FK*`, `G*`, `K*`, `MIG*`, `N1…N6`, `NB*`, `OC*`,
`P0.1…P7.6`, `PAR*`, `PJ*`, `S*`, `T*`): `N7`+, `FL*` and `AR1` collide with nothing.

**Ported ≠ enabled.** `NODE_API_PORTED ?? ""` stays empty for every task below, so `traffic-share`
remains UNMET and no production traffic moves. Enabling is a separate decision after a cutover drill.

**FL9 (iOS device + simulator) stays OPEN by construction** — no Xcode on this machine
(`research.md §1`). A green-looking substitute is not a result; `MIG5` and `CU2` set that precedent.

---

## Track N — route-by-route port

Every wave follows the same five steps (`plan.md §2`), and step 4 is not optional:

1. A/B parity case written **first**, against Rust, passing while still proxied.
2. Port using `withTenant` + `requireAnyRole`/`requireSelfOrAny`. No raw client.
3. Re-run the A/B ported: identical status, body bytes, headers.
4. **Mutate the port and watch the A/B go red.** A green that cannot go red is not evidence.
5. `bash scripts/verify.sh`, then `scripts/update-ledger.sh`.

- [x] N7 — Route table — 38 `if` blocks → one table + per-domain route modules; `PORTABLE` still parseable by `cutover-readiness.mjs`.
- [x] N8 — Infra routes — `/health`, `/ready`, `/metrics` (Prometheus text format, dev-open gate).
- [x] N9 — Quran routes — 3 read-only routes; canonical text byte-identical, digest-anchored, never normalized.
- [x] N10 — Progress writes — `POST /v1/learner/progress` + weekly; SM-2 arithmetic pinned to Rust.
- [x] N11 — Agent/audit/eval READS — `GET` agent-runs, audit-events, eval-runs; jsonb key order, f32 narrowing.
- [ ] N18 — `POST /v1/agent-runs` — split out of N11: it carries the learner-facing AI gate (a
      server-side re-derivation of `canShowLearnerFacingAiOutput`) and is the ONLY place an agent
      run's status is set. Three reads and one security-critical write do not belong in one slice.
- [ ] N12 — Auth — `token`, `register`, `login`; bcrypt cost 12 + HS256 cross-language vectors.
- [ ] N13 — Pilot sessions — `bootstrap`, `logout`, `invitations`; `__Host-` cookie attrs, idle roll.
- [ ] N14 — Recitation — 6 operations; the 805-line handler, FK 404s, gateway-verified tickets.
- [ ] N15 — Review gates — 5 operations; AI feedback withheld absent source + confidence + approval.
- [ ] N16 — ML/ASR proxies — 4 operations; server-side key injection, 16 MB limit.
- [ ] N17 — Privacy — `export`, `delete`; erasure verified by querying storage, not by a 200.

## Track F — Flutter client

### FL1 RESULT: SDK installed and working. Both device toolchains still blocked.

Evidence: [`evidence/fl1-flutter-doctor.log`](evidence/fl1-flutter-doctor.log), captured verbatim.

| category | verdict |
|---|---|
| **Flutter 3.44.8 / Dart 3.12.2** | ✅ `~/flutter`, user-space, no admin rights used |
| **Chrome (web)** | ✅ available as a run target |
| **macOS desktop** | ✅ available as a run target |
| **Android toolchain** | ❌ SDK 33.0.2 present, but `cmdline-tools` missing and licences unaccepted |
| **Xcode** | ❌ "installation is incomplete" — CLT only. CocoaPods present but non-functional |

So `dart analyze`, `flutter test`, and running the app on **macOS/Chrome** are all reachable here;
**building for iOS or Android is not**. `flutter doctor` says so in its own words, which is why the
log is committed rather than summarized. **FL9 stays open.**

- [x] FL1 — Toolchain — Flutter SDK in user space; `flutter doctor` captured verbatim, gaps recorded.
- [x] FL2 — Package + contract — `apps/flutter` skeleton, Dart models + typed client from `openapi.yaml`.
- [ ] FL3 — Secure auth — bearer tokens in Keychain/Keystore; never prefs, logs, or disk.
- [ ] FL4 — Mushaf reader — Uthmani rendering, RTL, canonical bytes preserved end to end.
- [ ] FL5 — Consent-gated capture — no audio stream constructed before consent is granted.
- [ ] FL6 — Feedback surfaces — tajweed + progress; nothing rendered without source/confidence/approval.
- [ ] FL7 — Privacy + i18n + a11y — export/delete, locale switching, semantics labels, contrast.
- [ ] FL8 — Offline/error states — no stale data presented as live.
- [ ] FL9 — 🔓 Device matrix — **OPEN: needs Xcode + hardware this machine does not have.**

## Track A — cutover artifact

- [ ] AR1 — Rollback artifact — ADR-0022 Accepted (local digest-pinned tags) + a workflow that builds, pins and retains images.

---

## Progress log

*(appended as tasks land; each entry states what was proven, not what was written)*
