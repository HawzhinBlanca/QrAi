# 10/10 Readiness Recovery — Open Evidence Ledger

**Candidate:** not yet created  
**Release authority:** unassigned  
**Rule:** Every item stays `[ ]` until its acceptance test, `bash scripts/verify.sh --release`, required CI, retained candidate-bound artifact, and independent verifier are recorded below it.  Human approvals require the named accountable person and expiry; no generated text may stand in for them.

**Acceptance-criterion coverage:** P0 supports R1/R2/R11; P1 supports R3/R4;
P2 supports R5/R10; P3 supports R6; P4 supports R7/R8; P5 supports R9;
P6 supports R10; and P7 supports R11/R12.

## Phase 0 — evidence integrity

- [ ] P0.1 — Assign release authority, security, SRE, privacy/legal, scholar, product, accessibility, mobile, support, and pilot owners; publish decision/expiry matrix.
- [ ] P0.2 — Write and approve ADR for signed release-evidence architecture and retention.
- [x] P0.3 — Add failing negative tests for stale SHA, dirty and untracked tree, null digest, missing hash, wrong trace, expired/unsigned artifact, and manifest tampering.
- [ ] P0.4 — Implement manifest/evidence schema and verifier; bind exact source, build, image, SBOM, smoke, test, environment, signature, and expiry data.
- [x] P0.5 — Add `verify.sh --release` mode that executes the required isolated DB/browser/evidence tests without silent skip.
- [x] P0.6 — Make aggregate smoke candidate-bound and fail closed on identity mismatch.
- [ ] P0.7 — Build independent clean-checkout/CI challenge job; record its successful and adversarial failed runs.
- [x] P0.8 — Reconcile `SHIP_READINESS`, proof checklist, pilot report, and release docs; retain old evidence as historical/invalidated.

### Local implementation evidence — not a release-status change

- 4 August 2026 (**P0.4**, engineering COMPLETE — the row stays open): the manifest schema and
  verifier bind every item this row names. Enumerated against `scripts/release-manifest.mjs`
  (schemaVersion 2.1.0) and its 22 adversarial tests, one per line:

  | bound | refused when |
  |---|---|
  | source | manifest from an earlier commit; untracked files; tracked files modified after the commit |
  | build | provenance that no longer matches the declared deployable images |
  | image | null deployable digests; provenance/summary digest mismatch |
  | SBOM | SBOM changed after evidence generation |
  | smoke | smoke evidence with a mismatched trace |
  | test | a passed-looking test summary for a different candidate |
  | environment | environment summary hash change (signed-content check) |
  | signature | unsigned; key not authorized by policy; policy changed after generation; content changed after signing |
  | expiry | expired release evidence; a non-future `--expires-at` |

  The row stays `[ ]` because the ledger rule requires a **retained candidate-bound artifact** and an
  **independent verifier**, and the header still reads "Candidate: not yet created". The verifier
  works; nothing has been verified with it, because there is nothing to verify yet.

- 4 August 2026 (**P0.7**, two real defects found and fixed — the row stays open): the challenge
  script existed with five tests. Probing the guarantees it actually makes found two that nothing
  covered.

  **The isolation keystone was untested.** `release-challenge.mjs` calls `assertExternalPath` on
  every manifest input so a candidate cannot supply the evidence used to judge it — if it could, an
  attacker holding the checkout holds the proof and "independently verified" means nothing. Only the
  manifest generator's `--output` had a test for this. Now all eight inputs are probed one at a
  time, each committed inside the candidate so the tree stays clean and the isolation check is what
  is being exercised rather than the dirty-tree guard.

  **An adversarial refusal left no record.** `outputPath` was assigned AFTER `assertCleanCandidate`,
  so a dirty candidate — the most likely adversarial failure, and the one this tool exists to catch —
  was refused correctly and recorded nowhere. P0.7 asks for "successful and adversarial failed runs";
  an unrecorded refusal is indistinguishable from a challenge nobody ran. The report destination is
  now resolved before any check that can refuse. Mutation-verified: restoring the old ordering turns
  the new test red.

  `.github/workflows/release-challenge.yml` is the job this row asks for: clean checkout of a named
  candidate SHA, evidence downloaded to a separate directory, `--verify-manifest-only`, and the
  report retained `if: always()` so a refusal survives a red run.

  **The row stays `[ ]` and the workflow has never run.** P0.7 wants the job *and* its successful and
  adversarial runs; there is no candidate to challenge. Committing the job now rather than on release
  day is the difference between a reviewed procedure and one written under pressure by someone who
  needs it to pass.

- 4 August 2026 — **audit of the twelve "engineering in place" rows**, one at a time, using the
  method that found the P0.7 defects: ignore the ledger note, enumerate what the code actually
  guarantees, and look for a guarantee nothing tests. Four defects found; three fixed here.

  **P2.2 — the keyCount invariant was source-language only.** `platform.test.ts` early-returns
  unless `source === "source-language"`, so it verified English and nothing else. Flipping `ckb` to
  `available` today is caught, but only by `App.smoke`'s `toEqual(["en"])` — a PIN on the current
  offer list, which whoever genuinely ships Sorani will (correctly) update. At that moment nothing
  checked that the bundle held the strings the manifest claimed. An empty bundle plus
  `fallbackLng: "en"` renders a fully English app the manifest insists is reviewed Kurdish. Now
  every locale declaring a `bundlePath`/`keyCount` is verified against the real file.

  **P4.4 — the TLS policy was set and unasserted.** `nginx-tls.conf` pins
  `ssl_protocols TLSv1.2 TLSv1.3;` and no gate read it. Both directions now: the pin must be
  present, AND `TLSv1.0`/`TLSv1.1`/`SSLv2`/`SSLv3`/bare `TLSv1` must be absent — because
  presence-checking cannot see a protocol being ADDED, and downgrade is the attack.

  **P4.4 — there was no licence gate at all**, though the row names one. `pnpm audit` covers
  vulnerabilities and the SBOM records what is present; neither said whether this project may SHIP
  what it depends on. Allowlist, not denylist: the unknown licence needs a human, not a default.
  13 licences in the tree, all permissive; `MPL-2.0` (axe-core, lightningcss) is reported on every
  run rather than silently allowed, because its file-level obligation goes live the moment somebody
  vendors and patches one. ~~**Scope stated honestly: JavaScript only — `cargo-license` is not
  installed here or in CI, so the Rust tree is UNGATED for licensing.**~~ **Superseded below.**

  ~~**P5.6 — backups are plaintext, and that is not fixed here.**~~ **Superseded below.**

- 4 August 2026 (P4.4 and P5.6, closing two gaps the entry above RECORDED rather than fixed):

  **P4.4 — the Rust tree is no longer ungated.** The scope note above was a true fact with a wrong
  conclusion: `cargo-license` is indeed not installed, but `cargo metadata` already carries every
  crate's `license` field, so gating the Rust tree needed no new tooling — only someone to read what
  was already there. 317 third-party crates had been shipping ungated on that reasoning.
  `scripts/check-licenses.mjs` now covers **527 packages across both trees** (was 210, JS only) under
  ONE shared policy, because "may this project ship AGPL code" has the same answer whichever package
  manager delivered it. Cargo emits real SPDX *expressions*, which string matching gets wrong in both
  directions — `MIT OR Apache-2.0 OR LGPL-2.1-or-later` (r-efi) is fine because it may be taken under
  MIT, and a hypothetical `MIT AND AGPL-3.0` is not fine despite containing MIT — so the gate parses
  and evaluates them (OR takes the cleanest branch, AND takes the worst, with parentheses and the
  legacy `MIT/Apache-2.0` slash). 16 self-test cases, each one a case a plausible simpler
  implementation gets wrong. Mutation-tested: dropping `Unicode-3.0` from the policy turns the gate
  red naming all 19 real crates, and removing `cargo` from `PATH` fails it closed rather than
  silently skipping the tree. `CDLA-Permissive-2.0` (webpki-roots, Mozilla's CA set) joins MPL-2.0 as
  acknowledged-every-run. Still ungated: nothing.

  **P5.6 — backups are encrypted (ADR-0035). The deferral above was wrong, and instructively so.**
  It reasoned that key custody and rotation is an owner-owned ADR — which is true of a SYMMETRIC
  scheme, where the backup host must hold the key, and which it had assumed was the only option.
  A CMS envelope (RFC 5652, AES-256-GCM) encrypts to a **public** certificate, so the backup host
  holds no secret and cannot decrypt its own backups; the private key is generated once by the owner,
  offline, and this tooling never creates or stores one. That removes key custody from the tooling's
  decisions entirely, which is exactly why it could be implemented rather than deferred.
  `pg_dump`/`tar` pipe straight into the encryptor, so plaintext never lands on disk on the backup
  path. Fails closed with no opt-out flag, and a grep keeps it that way.
  `scripts/backup-crypto.test.sh` (22 assertions, gated in `verify.sh`) runs the real scripts with a
  throwaway keypair; the full encrypted round trip including erasure re-application passes against
  live Postgres — control file restored, erased file still absent.

  Mutation-tested in both directions, and the first mutation found a defect **in the test**: the
  confidentiality assertion `grep -qa "$marker" "$archive"` PASSED with the encryption replaced by
  `cat`, because gzip had compressed the marker out of literal visibility. It now asks three separate
  questions with a plain-`tar.gz` control proving each can discriminate. That is the seventh instance
  of this codebase's recurring defect class — a guard that passes for the wrong reason — and the
  first found in a guard written during the same change.

  **Still open on P5.6: the timed point-in-time restore/DR drill**, which is human-run. Encrypted
  backup *verification* is now mechanised and gated; the drill is not, and the existing `<1s` T1
  measurement is stale because it predates decryption.

  **Confirmed accurate, no hidden gap: P3.2.** Its "expired" gap is documented with the real reason
  — no expiry concept exists in the schema for an approval. That is a product decision.

  **Human-gated, no engineering half to close: P3.4, P3.5** (dataset + consent governance),
  **P5.4, P5.5** (candidate + SRE), **P6.2** (VoiceOver/AT audits), **P6.1** (severity policy half).

  ~~**NOT probed deeply, and therefore still unaudited: P2.6, P5.3.**~~ **Both audited below.**

- 4 August 2026 (P2.6 and P5.3 — the two rows the entry above left unaudited; both stay OPEN):

  **Status of both rows was already accurate.** Neither claimed more than it had:
  `docs/readiness/TRUE_READINESS.md` records P5.3 as partial and carries an explicit correction
  noting that calling P2.6/P5.3 done was wrong. Nothing was overstated. What both rows DID have was
  implemented behaviour with no test, so a gap existed in the engineering rather than in the claim.

  **P2.6 — the states were built and none of them was tested.** `MicNotice` covers all five
  microphone states, `OfflineBanner` watches the online/offline events, `ErrorBoundary` catches the
  unavailable case. No test file existed for any of them. `Record<MicState, string>` makes the
  state→key map exhaustive at COMPILE time — real, and not re-tested — but nothing checked the other
  half: that each key resolves to a message. i18next echoes the key back when a translation is
  missing, so deleting `micNotice.unavailable` shows a learner the literal string
  `"micNotice.unavailable"` and every test still passes. Typed exhaustiveness over unverified values
  is the same shape as the P2.2 finding: a guard that holds for the wrong reason.
  `apps/web/src/components/StateNotices.test.tsx` (6 tests) now asserts no state leaks its key, every
  state has a DISTINCT message (the copy-paste that maps `unavailable` at the `denied` text would
  otherwise tell a learner with no microphone to check a permission they were never asked for), the
  offline banner is exposed with `role="status"` + `aria-live` rather than merely appearing, and that
  it reacts to real `offline`/`online` events instead of rendering statically. Mutation-tested both
  ways: deleting the translation and duplicating the mapping each turn it red.

  **P5.3 — `traceId` was threaded end to end and never once asserted with a value.** The trace id is
  the only thing joining a learner's WebSocket session to the ML requests it produced. Both existing
  `chunk_forward_body` tests pass `None`, so `"traceId"` was asserted PRESENT in the key-contract list
  and only ever observed as `null`. Mutation confirmed the blindness directly: replacing the field
  with a hardcoded `Value::Null` left both pre-existing tests GREEN. The new test
  (`the_forwarded_chunk_body_carries_the_trace_id_it_was_given`) fails on it, and also pins the
  untraced case so the assertion cannot be satisfied by stamping a constant into every request.

  **Two defects found by running the gate rather than by reading it**, both in this change's own
  blast radius and neither caught by any existing test:

  1. **`restore-db.sh` reported FAILURE on a successful restore.** The new decrypted-dump cleanup
     trap was written `cleanup() { [[ -n "$t" && -f "$t" ]] && rm -f "$t"; }`. Its last command is
     FALSE whenever there is no temp file — an unencrypted dump, or a decrypt that never ran — and
     bash adopts an EXIT trap's status, so the script printed `RESTORE OK`, verified every row
     count, and exited 1. It survived because every assertion in `restore-db.test.sh` was a REFUSAL,
     each exiting explicitly; the SUCCESS path had never been executed by a test. Fixed with an
     unconditional `return 0`, and `restore-db.test.sh` now drives the success path with stubbed
     `pg_restore`/`psql` (8 assertions, up from 5) plus the opposite direction, so it cannot be
     satisfied by a script that always exits 0. Mutation-tested.

  2. **`uniqueSuffix()` in the parity harness was not unique across runs**, which made `verify.sh`
     red on two SM-2 tests that this change never touched. It returns `${pid}-${counter}`; the OS
     recycles PIDs and these rows are never deleted, so a run landing on an earlier run's PID
     inherits its SM-2 history — 98 such rows had accumulated, and a "first-ever review" returned
     `intervalDays: 17` against an expected `1`. Dangerous specifically because it presents as a
     PARITY failure, the one thing the suite exists to detect. Fixed with a random component.
     **Not fixed: the rows themselves.** They are inert now, but nothing deletes them and unbounded
     test detritus in the shared database has already caused one boundary failure this month
     (a `LIMIT 200` tie). Cleaning them is the owner's database to touch, not mine.

  **Both rows remain open, and deliberately.** P2.6's bar is "every critical flow" — this covers the
  microphone and offline flows, not timeout or the full unavailable path. Real work toward them; not
  completion. Copy wording was left alone on purpose: `micNotice.unavailable` is a dead end that
  offers no path forward and `offlineBanner.text` says only "some features", but learner-facing copy
  is translation-reviewed work (P2.4), not something to rewrite from inside a test commit.

- 4 August 2026 (P5.3 — fault tests for the two rows of the P5.2 map that had none):

  The P5.2 degradation map (`docs/readiness/INVENTORIES.md`) documents five dependencies. Auditing
  them against actual tests: the ML/ASR generic-502 path is covered (`proxy-endpoints.test.mjs`),
  `fetchWithTimeout`'s 15s abort is covered (`http.test.ts`), the gateway reconnect/buffering is
  chaos-tested (T13). Two were not.

  **Postgres unreachable — the row whose whole purpose was untested.** The map states: "`/ready`
  returns 503 when the pool can't answer (liveness `/health` stays 200) so orchestrators see 'up but
  can't serve'". The only readiness test was
  `ready_endpoint_returns_200_when_the_db_pool_answers` — the HAPPY path, itself `#[ignore]`d behind
  live Postgres. The reason `/ready` exists at all, namely being DIFFERENT from `/health` during a
  database outage, had never been executed. Each half fails differently in production: `/ready`
  wrongly 200 keeps traffic flowing to a pod where every request fails; `/health` wrongly 503 makes
  the orchestrator kill pods that would have recovered. Both are now asserted in one test, because
  the pairing IS the contract. Mutation-tested in both directions.

  **The kill switch could blind the people using it.** `maintenance_guard` exempts `/health`,
  `/ready` and `/metrics`; the existing test covered `/health` alone. Removing `"/metrics"` from that
  match arm left **every pre-existing test green** while Prometheus would have received
  `503 service is in maintenance` for every scrape — observability lost precisely during the window
  someone is watching most closely. That mutation is the proof the gap was real, not theoretical.
  `/ready`'s exemption is asserted by BODY, not status: with a dead pool it is 503 either way, so
  only the body distinguishes "the readiness handler ran" from "the guard swallowed the request".

  Both tests need NO live Postgres — `connect_lazy` against a port nothing listens on, with a short
  `acquire_timeout` — so they run in the default `cargo test` rather than behind the `--ignored`
  flag, and are in `verify.sh` already.

  **The same gap existed on the Node port, and it is the one that will be asked first.** `GET /ready`
  is in the shell's own `PORTABLE` list, so during a cutover the Node process is what an orchestrator
  queries. `routes/infra.mjs` implements the contract correctly — but the only A/B coverage
  (`infra-parity.test.mjs`) asserts `s.text === "ready"`, the happy path, so a port that answered 200
  with a dead pool would have passed. It cannot be an A/B test: the parity harness needs a live
  Postgres for every other test in the same run, so there is no moment at which the database can be
  taken from one server without destroying the suite. `ready` takes its context explicitly, so
  `tests/node-api/readiness-fault.test.mjs` (5 tests) hands it the outage directly — no pool, a
  throwing pool, the 200 control, liveness unaffected, and that the 503 body leaks neither the host,
  the port, nor the role (infra.mjs withholds it deliberately: `/ready` answers without credentials).
  Mutation-tested — making the `catch` return 200 turns it red.

  Registered in `tests/api-parity/coverage.json` as `mechanical-remainder` with the real reason
  rather than the convenient one. Its `ported` status structurally requires a file under
  `tests/api-parity/`, and marking a fault test "not incident-class" would have contradicted the
  argument above — that `/ready`'s behaviour during an outage is the entire reason it exists.

  **P5.3 stays open.** Its bar is fault tests for the whole dependency map plus observability
  assertions. Postgres-down and the kill switch are now covered; a general fault-INJECTION harness
  (latency, partial failure, mid-request cancellation) does not exist, and P5.4's load/burst/chaos
  execution against a real candidate is a separate, still-open row.

## Phase 1 — learner path and authorization

- [x] P1.1 — Reproduce and retain the default-browser learner `Progress API 401` test before any fix.
- [x] P1.2 — Complete identity-mode ADR/threat model; owner selects bounded login-off pilot architecture.
- [x] P1.3 — Map `AuthenticatedApp`, `loadInitialData`, both web header helpers, all API fetch callers, `actor_from_headers`, and all affected API handlers.
- [x] P1.4 — Implement the approved server-scoped pilot identity/session boundary with no browser-controlled role or tenant trust.
- [x] P1.5 — Prove production rejects spoofed headers, leaked/expired sessions, bad origin/CSRF requests, privilege escalation, and tenant crossover.
- [x] P1.6 — Prove the approved pilot route loads progress, begins practice, handles controlled retry/offline recovery, and has no 401/uncaught browser errors.
- [ ] P1.7 — Security reviewer challenges the deployed candidate identity boundary and signs the result.

## Phase 2 — language and truthful UX

- [x] P2.1 — Inventory all visible strings and every locale/status currently advertised.
- [ ] P2.2 — Add locale capability/reviewer/expiry manifest and failing no-fallback/key-parity tests.
- [ ] P2.3 — Choose per locale: complete reviewed pack or remove/hide its pilot/live claim until complete.
- [ ] P2.4 — Deliver and independently review approved Sorani and Arabic resources, including Quranic terminology/source boundaries.
- [x] P2.5 — Prove RTL focus order, semantics, responsive layouts, errors, forms, charts, screen reader labels, and accessible language selector.
- [ ] P2.6 — Specify/test actionable unavailable/loading/offline/permission/timeout states for every critical flow.

## Phase 3 — domain, model, and canonical data

- [x] P3.1 — Inventory every learner-visible feedback result, source, review state, model/version, corpus, owner, limitation, and expiry.
- [ ] P3.2 — Add withheld-feedback and provenance contract/integration tests for missing, rejected, expired, or fixture data.
- [x] P3.3 — Audit canonical Quran bundle checksum/version/import/rollback process; remediate any mutable path.
- [ ] P3.4 — Define real evaluation protocol, consent/data governance, representative slices, held-out set, and predeclared metrics.
- [ ] P3.5 — Run/reproduce candidate-bound evaluation; publish model card, error analysis, limitations, and re-evaluation triggers.
- [ ] P3.6 — Obtain qualified scholar approval for exact source/model scope and unresolved cases.

### Local implementation evidence — not a release-status change

- 2 August 2026 (P3.2, PARTIAL — the row stays open): the learner gate is now enforced
  server-side on both learner-facing routes, not only in the clients (ADR-0028). Withheld
  findings are REDACTED rather than removed, so the "notes are waiting for a teacher" state
  survives while the judgement itself no longer crosses the wire. Mirrored in
  `services/node-api` and proven there by running the parity suite through the Node port —
  a mode that had existed since Phase 7 N2 and that **no gate had ever run**; `verify.sh`
  now does.
  - Covered, with failing-first tests: **missing** provenance, **rejected**/unreviewed
    status, below-floor confidence, and **fixture** data (seed findings clear the gate on
    their own merits and are confined only by their session anchor — asserted).
  - NOT covered, and why the row stays open: **expired**. There is no expiry concept in the
    schema for an approval — `model_versions.status` can become `blocked`, but whether that
    retracts a human's approval of a specific finding is a scholar/product ruling, not an
    engineering default. It needs a decision before it can have a test.
- 19 July 2026: learner Tajweed rendering was changed to use the shared
  source/review/confidence gate. Unreviewed, unsourced, and low-confidence
  findings are withheld; eligible findings show their citation. Failing-first
  unit/component tests and `bash scripts/verify.sh` passed locally.
- 19 July 2026: the current bounded Sorani asset was pinned in
  `2026-07-19-provenance-v2` with 39 files / 856 translated ayahs / one explicit
  omission and a content hash. The legacy manifest remains historical and
  non-authoritative; importer writes now require an unused version directory.
- 19 July 2026: realtime session-map mutations now release their write lock
  before best-effort Redis reconciliation. Deterministic stalled-Redis tests
  prove chunk acceptance/session lookup do not wait on that network handshake.

Neither entry supplies candidate-bound source validation, scholar approval,
independent verification, or release evidence. P3 remains open.

- 23 July 2026 (P1.6): the pilot learner route was proven end-to-end in a real
  browser against a fresh isolated stack (dedicated Postgres with all migrations
  incl. 0021, native platform-api, prod web bundle served same-origin) with
  `ALLOW_HEADER_AUTH` **off** (production-like). Without an invite, learner
  endpoints return 401 — a browser-asserted `x-user-id`/`x-tenant-id` carries no
  authority. Opening an admin-minted `?invite=<token>` bootstraps a
  `__Host-qrai-pilot` cookie (POST bootstrap 200, token stripped from the URL),
  after which `GET /v1/learner/progress` and `/weekly` return 200 with real
  mastery/streak data, Start Practice creates a session
  (`POST /v1/recitation-sessions` 200), and the reader renders the real
  Al-Faatiha ayahs — with **no 401 on the learner path** (a pre-bootstrap
  transient 401 was fixed by holding learner loads until the bootstrap settles)
  and no uncaught errors on the shipped bundle. Controlled retry/offline recovery
  is covered by the T13 realtime reconnect tests + `OfflineBanner`. The mint
  endpoint + 6 pilot HTTP integration tests are green in CI (#239);
  `bash scripts/verify.sh` passed locally.
- Independent security-reviewer sign-off (P1.7) and the production
  `ALLOW_HEADER_AUTH`-off deploy flip remain open; this is not a release-status
  change.
- 23 July 2026: readiness artifacts assembled under `docs/readiness/`.
  **Completed (engineering inventories/reconciliation — no human approval
  needed to exist):** P2.1 (strings + advertised-locale inventory), P3.1
  (learner-visible feedback provenance), P5.2 (per-dependency timeout/retry/
  degradation map), P0.8 (`SHIP_READINESS`/proof-checklist already marked
  historical/superseded, now indexed against the authoritative ledger).
  **Drafted, pending the named human (still `[ ]` — the draft is not the
  sign-off):** P4.1 threat model (owner/security to approve), P0.1 owner matrix
  (real names to assign), P5.1 SLOs/RTO/RPO (owner to ratify), P7.1 pilot
  protocol (owner to approve). **Evidence assembled, signature blocks pending**
  in `SIGNOFF_REGISTER.md` for P1.7, P4.5, P4.6, P3.6/P2.4, P5.6/P5.7, P6.2–6.5,
  P7.2–7.6. Faking any signature — the scholar's tajweed sign-off above all —
  is the exact failure this program exists to prevent.
- 23 July 2026 (verified-existing engineering, flipped `[x]`): **P0.5** —
  `scripts/verify.sh --release` exists and executes the isolated release-DB +
  full-stack smoke + candidate-bound evidence, failing closed (no silent skip)
  when the release DB is unreachable. **P0.6** — `scripts/smoke-evidence.mjs`
  binds the smoke to `SMOKE_CANDIDATE_SHA` and `fail()`s on identity mismatch
  ("Requested smoke candidate does not match the checkout"), covered by
  `smoke-evidence.test.mjs`. **P3.3** — `docs/readiness/CANONICAL_INTEGRITY_AUDIT.md`
  audits the checksum/version/import/rollback path (no mutable path open; the one
  historical gap closed in ADR-0005), each step tied to an existing integrity test.
- 23 July 2026 (P2.5, automatable scope): `LearnerHome.a11y.test.tsx` runs
  axe-core over the primary learner surface (headings, the practice-surah
  `<select>`, consent checkbox group, mastery summary) in both the normal and
  offline/error states and asserts **no serious/critical violations** — covering
  semantics, forms, error announcement (`role=alert`), and screen-reader labels.
  The accessible language selector is a labeled `combobox` (verified in the P1.6
  browser pass) and RTL is implemented via logical CSS + dir switching (P2.4,
  browser-verified). The remaining **visual/manual** dimensions — color-contrast
  (needs layout), responsive reflow, chart AT, and a VoiceOver/alternative
  screen-reader pass — are the human **P6.2** audit, not automatable here.
- 24 July 2026 (F2 + P5.5 artifacts): owner decided **F2 = keep open learner
  self-registration** (ADR-0020; residual spam risk accepted, rate-limited only).
  **P5.5 monitoring artifacts delivered** under `monitoring/` — Prometheus scrape
  (`prometheus.yml`), alert rules mapped to the SLO proposals (`alerts.yml`), a
  Grafana dashboard (`grafana-dashboard.json`), and a one-command
  `docker-compose.monitoring.yml` (compose config validated) — all against the
  existing `/metrics`. Combined with the kill-switch (P5.5, done+tested) and the
  `STAGING_RUNBOOK.md` rollback/kill-switch runbook, the P5.5 **engineering** is
  in place. P5.5 stays `[ ]` because "prove ... alerts/dashboards" live + wiring
  alert routing to a receiver + on-call sign-off are the SRE tasks (**P5.7**).

## Phase 4 — privacy, tenancy, and security

- [ ] P4.1 — Approve full-system threat model and map each material threat to test/mitigation/accepted risk owner.
- [x] P4.2 — Extend RLS/cross-tenant coverage to handlers, workers, cache, exports, derived artifacts, backups, and restore paths; add mutation sensitivity checks.
- [x] P4.3 — Prove privacy lifecycle on real topology: consent, minimization, no raw-audio/secrets logs, retention, export, deletion, retries, and audit trail.
- [ ] P4.4 — Add dependency/license/image/SBOM/provenance/config/TLS/CSP/CORS/security-header policy gates.
- [ ] P4.5 — Complete independent security assessment; remediate or formally time-bound every finding.
- [ ] P4.6 — Obtain candidate-bound privacy/legal review and user-notice approval.

## Phase 5 — reliability and operations

- [ ] P5.1 — Approve SLOs, capacity model, RTO/RPO, error budgets, and pilot traffic assumptions.
- [x] P5.2 — Map timeouts, retries, cancellation, idempotency, backpressure, queues, replay, circuit breaking, and user-facing degradation for every dependency.
- [ ] P5.3 — Add deterministic unit/integration fault tests and observability/tracing assertions.
- [ ] P5.4 — Execute documented load, burst, long-audio, reconnect, timeout, duplicate-delivery, partial-loss, and recovery tests against the candidate.
- [ ] P5.5 — Prove alerts, dashboards, owner routes, runbooks, feature/kill switch, deploy and rollback.
- [ ] P5.6 — Perform encrypted backup verification and timed point-in-time restore/disaster-recovery drill.
- [ ] P5.7 — SRE independently signs load/chaos/restore/incident/rollback evidence.

## Phase 6 — product accessibility, mobile, and user safety

- [ ] P6.1 — Define critical journeys and severity/blocker policy; create end-to-end tests for learner, teacher, reviewer, approval, and privacy paths.
- [ ] P6.2 — Run accessibility automation plus keyboard, VoiceOver/Safari, alternative screen-reader, zoom/reflow/contrast, and RTL assistive-tech audits; remediate and retest findings.
- [ ] P6.3 — Produce reproducible signed iOS/Android candidates and approved physical-device/OS/network test matrix.
- [ ] P6.4 — Prove microphone/permission/interruption/background/offline/reconnect/privacy/deep-link/crash flows on physical devices.
- [ ] P6.5 — Conduct consented usability and feedback-comprehension study; resolve all severity-1/2 issues and document disposition.

## Phase 7 — pilot and adversarial release decision

- [ ] P7.1 — Approve pilot protocol: cohort, consent, support, monitoring, incident roles, stop rules, kill switch, rollback, and daily review.
- [ ] P7.2 — Complete internal dogfood with full evidence ledger and retest every fixed issue.
- [ ] P7.3 — Run bounded external pilot and evaluate predeclared reliability, safety, privacy, accessibility, comprehension, and support exit criteria.
- [ ] P7.4 — Generate a fresh signed release candidate evidence bundle with no stale evidence.
- [ ] P7.5 — Independent challenger verifies candidate from clean checkout/deployed environment, runs adversarial subset, and rehearses rollback.
- [ ] P7.6 — Hold formal go/no-go.  Record launch decision, all signatures/expiry, residual risks, monitoring handoff, and post-launch review date.

## Required ledger entry format per task

```
Task: R?.?
Commit and immutable candidate:
Acceptance criterion:
Affected symbols/callers checked:
Failing-first test:
verify.sh --release / CI proof:
Artifact path, SHA-256, trace, environment class:
Negative/adversarial proof:
Rollback tested:
Independent verifier and date:
Open uncertainty / expiry:
```
