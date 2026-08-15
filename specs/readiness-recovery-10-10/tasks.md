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

- 12 August 2026 (**P5.3, P6.1, P2.6 closed; P6.2, P3.2, P0.2 given one named blocker each**):
  six rows worked in one pass — `specs/agent-closable-closure/plan.md` states up front which three
  could honestly close and which three could not.

  **P5.3 — the published dependency map is now executable.** P5.2's table asserts 15 behaviours
  across 5 dependencies and nothing connected any of them to a test. Four of the five already had
  genuine fault coverage; what was missing was any way to KNOW that.
  `tests/observability/dependency-fault-coverage.test.mjs` diffs the table against tests annotating
  themselves `@fault-coverage:`, both directions, with a non-vacuity floor of 5.
  `trace-survives-fault.test.mjs` closes a real gap: the audit write carrying `trace_id` runs only on
  SUCCESS, and the three ML failure paths logged only the label — so a learner's `x-trace-id` was
  recoverable for every request that worked and none that failed. One of those paths logged at
  `warn!`, invisible at the `RUST_LOG=error` the service runs at, leaving no record at all. Fixed in
  both the ML and ASR proxies; negative control strips the interpolation and 5/5 fail.
  `postgres-outage.test.mjs` drops a throwaway database out from under a live pool.

  **CORRECTION to PR #414.** That PR claimed the Rust side had only a happy-path readiness test and
  that the degraded behaviour was "proven in the port and unproven in the original". Wrong.
  `readiness_reports_503_when_postgres_is_unreachable_while_liveness_holds` (integration.rs:4123) has
  existed since 4 August, is mutation-tested both ways, and is recorded in the 4 August entry above.
  The claim came from a grep truncated by `head -8` that stopped at line 257. The new test still adds
  something — a pool with LIVE connections losing its backend, through the real binary, versus
  `connect_lazy` to a port nothing listens on — but it is a complement, and smaller than claimed.
  Corrected in the file header, in a comment on #414, and here.

  **P6.1 — five journeys, defined then walked.** `docs/readiness/JOURNEYS.md` defines what makes a
  journey critical and a severity policy keyed on what the PERSON loses. Four new end-to-end tests
  join the existing privacy one. `teacher-review` stores real bytes through a real ml-inference and
  asserts the teacher receives THOSE bytes — `audio-playback-parity.test.mjs` uses a mock returning
  a fixed string and says so itself. `finding-approval` walks the ADR-0028 transition from the
  learner's side in both directions; without the rejection case, an implementation that promoted on
  every review would pass. Negative control on the redaction fails 3 of 5, including the sev-1.

  **P2.6 — "no work waiting" and "we could not ask" were the same screen.** `TeacherSurface` caught a
  failed queue load, logged it, and rendered "No pending recitations." while the service was
  unreachable — a confident wrong answer the teacher acts on by closing the tab. The root cause was a
  layer down: `fetchConsole` returns its fallback on ANY failure, so the component's `catch` could
  never fire. `fetchConsoleRead` now reports `{data, failed}`; `fetchConsole` delegates to it and is
  otherwise unchanged for its twenty-odd callers. `docs/readiness/DEGRADED_STATES.md` plus
  `degradation-matrix.test.mjs`, which requires every cited test to be one `verify.sh` ACTUALLY RUNS.

  **Rows that did NOT close, each with one named blocker:**
  - **P6.2** — 23 web components, 3 audited; all 23 now are, and the axe automation found a real
    defect (`aria-label` is prohibited on a bare `<div>`, so the progress placeholder announced as
    empty to a screen reader). The row needs VoiceOver, an alternative screen reader, and real-pixel
    zoom/reflow. **Blocker: physical devices.**
  - **P3.2** — `expired` has no meaning here: no approval-expiry column exists anywhere, and
    `model_versions.status` is read by no service. **Blocker: the ADR-0042 ruling.**
  - **P0.2** — ADR-0043 records the architecture that already shipped so it can be challenged, and
    isolates the half nobody chose: retention appears nowhere. **Blocker: owner approval.**

  Guards written this pass that caught their own author: the a11y coverage guard would have
  mis-paired `PrivacyConsent.a11y.test.tsx` (no such component) had it matched on filename; the
  degradation matrix rejected a 30-character `n/a` reason of mine; the withheld-reasons guard was
  VACUOUS on its first run because it scans for marker strings it contains as data — four green
  tests, zero real annotations.

  **Unchanged by all of it: P3.4/P3.5.** Nothing here is evidence the engine is accurate enough to
  teach from, and a green gate must not be read as though it were.

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
  is in the executable route registry, so during a cutover the Node process is what an orchestrator
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

- 4 August 2026 (P5.3 continued — fault INJECTION for a wedged ML/ASR upstream):

  `lib.rs` had carried this comment since the HTTP client was written: *"A bare `Client::new()` has
  no request timeout, so a stuck/hung ML or ASR upstream (e.g. a GPU/MPS fault mid-inference) would
  block the calling request indefinitely."* The timeout was there. **Nothing ever fired it.** Every
  proxy test uses an upstream that ANSWERS — 200, or an error that becomes a 502 — and an upstream
  that answers is a different failure from one that does not.

  `startMockUpstream` could not express the fault at all: it always wrote a response. It now accepts
  `{ hang: true }`, which records the request and never replies, holding the socket open. That is the
  first actual fault-injection primitive in the harness, and it is what a wedged inference process
  looks like from platform-api.

  **The timeout had to become configurable for the test to be possible.** Hardcoded at 60s, no gate
  could afford it. `UPSTREAM_TIMEOUT_SECS` is also the honest operational answer — 60s was one
  deployment's guess about its own hardware. It parses STRICTLY and refuses to boot on a bad value:
  `unwrap_or(60)` would turn `6O` (capital letter O) into a silent 60, and **zero is rejected
  outright** because reqwest reads a zero Duration as *no timeout* — the one value an operator would
  set to be stricter would in fact restore the unbounded hang.

  `tests/api-parity/upstream-hang.test.mjs` (6 tests): a hung ML upstream, a hung ASR upstream, no
  leak of the internal host in the timeout response, both config guards, and — the reliability
  property the timeout actually protects — that ONE hung request does not wedge the server, asserted
  by hitting `/health` and an unrelated route while the first call is still in flight. A 502 alone
  proves nothing here, because platform-api collapses every upstream failure into 502, so the tests
  assert a TIME WINDOW: too fast means something else failed first, too slow means the configured
  value is being ignored.

  Mutation-tested. Removing `.timeout(...)` does not make the suite fail — it makes it **hang until
  the runner kills it at 25s**, which is the bug stated as plainly as it can be. Replacing the strict
  parse with `unwrap_or(60)` turns exactly the two config guards red and leaves the other four green.

  Still not covered, and still why P5.3 stays open: latency injection short of a full hang, partial
  or truncated upstream responses, and mid-request cancellation.

- 4 August 2026 (P5.3 continued — an ML service that answers 200 with the WRONG SHAPE, and the
  learner-gate hole it exposed):

  The hang case covers an upstream that never answers; `proxy-endpoints.test.mjs` covers one that
  answers with an error status. Neither covers the realistic model-server failure: **200 with
  something unexpected** — a partially migrated response, an ingress error page, a debug build on a
  different schema.

  **This is where it stopped being a reliability question.** `redact_withheld_findings` enforces the
  domain rule server-side (ADR-0028): no learner-facing model output without source, confidence and
  an approval gate. It enforces it by INSPECTING the shape it was handed — and it had two branches
  that forwarded values it could not inspect, **unredacted**:

  ```rust
  let Some(findings) = result.get_mut("findings").and_then(|v| v.as_array_mut()) else { return };
  for finding in findings.iter_mut() {
      let Some(obj) = finding.as_object_mut() else { continue };   // passed straight through
  ```

  A `findings` that is not an array redacted NOTHING; an element that is not an object was forwarded
  verbatim. Both were demonstrated by putting a marker string in an ML response and finding it in
  the learner's payload — not reasoned about, measured. The gate failed OPEN on precisely the input
  it cannot reason about, which is reachable without anyone editing it: a partially migrated model
  server, or an ML service somebody has compromised.

  Fixed fail-closed and consistent with the surrounding design. A non-array `findings` becomes `[]`;
  a non-object element becomes a withheld placeholder, so the array KEEPS its length — both clients
  count it to render "N notes are waiting for a teacher" — while carrying no model text. Both log at
  error level, because a broken upstream should be visible rather than silently normalised.

  The argument that had to be rejected to fix this is "no client would render a bare string anyway".
  That is true today and is not the rule. It is also the exact reasoning ADR-0028 was written to
  overturn — the gate belongs on the server, not in whatever the browser happens to do.

  `tests/api-parity/upstream-malformed.test.mjs` (5): non-JSON ML body → 502 (the ML proxy had no
  such test, though ASR has had one since C2); findings with no gate fields at all; a non-object
  finding; a non-array `findings`; and a 0.999-confidence unreviewed finding, because confidence
  alone must never open the gate and that is the case a model author would most expect to work.
  Mutation-tested: restoring either fail-open branch turns exactly those two tests red and leaves the
  other three green. 26 pre-existing proxy/ML/contract tests still pass.

  **P5.3 still open**: latency injection short of a hang, and mid-request cancellation.

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
- [x] P2.6 — Specify/test actionable unavailable/loading/offline/permission/timeout states for every critical flow.


### Local implementation evidence — not a release-status change

- 6 August 2026 (**P2.2**, engineering COMPLETE — the row stays open):
  `apps/web/src/locales/capability.json` states, per locale, what it claims, who stands behind it,
  and when that expires. Four tests in `tests/i18n/locale-parity.test.mjs` hold it to the locale
  files, and the row's three named artefacts map one to one:

  | the row asks for | what exists |
  |---|---|
  | capability manifest | every locale in `SUPPORTED_LANGUAGE_CODES` has a row; the manifest may not describe a language the app does not offer, nor omit one it does |
  | reviewer / expiry | `reviewer` and `reviewExpires` per locale; a status of `complete` or `partial` with no reviewer is REFUSED |
  | key-parity test | declared key counts must equal the real counts, in BOTH directions — a locale that gains strings without updating its row fails too |
  | no-fallback test | the DEFAULT language is read out of `i18n/index.ts` and its coverage asserted against the manifest |

  What it FOUND, which is why the row matters: `ckb.json` is `{}`, `i18n/index.ts` sets
  `lng: "ckb"`, and `fallbackLng` is `en` — so a Kurdish-first product presents an entirely English
  interface by default, and eight further locales are selectable with nothing behind them. The
  pre-existing locale rules could not see it: every one of them is "for each key, assert X", and an
  empty locale satisfies all of them vacuously.

  The default-language test deliberately does not FAIL on that. Changing the app's default language
  is a product decision (**P2.3**), and a permanently-red gate teaches people to ignore it. It
  prints the condition on every run instead:

      note: the default language "ckb" is a placeholder — every string a user sees is en via fallback

  The row stays `[ ]` because the ledger rule requires `verify.sh --release`, a retained
  candidate-bound artifact, and an independent verifier — and because **P2.4** (writing and
  independently reviewing the Sorani strings) is the work this manifest makes legible, not work it
  does.

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


- 6 August 2026 (**P3.2**, engineering PARTIAL — the row stays open): the row names four kinds of
  data — "missing, rejected, expired, or fixture". Two now have gates.

  **fixture.** `ML_USE_GOLDEN_FIXTURES=1` makes ml-inference answer from `golden-evals.json`
  instead of analysing anything: the alignment branch emits `heardText: w.canonicalText,
  status: "matched"` — a flawless recitation nobody performed — and the tajweed findings it returns
  are PERSISTED with `analysis_basis = 'canonical-text'`, indistinguishable from analysis of a real
  session. The flag set once contaminates the corpus permanently. It now requires
  `ML_ACKNOWLEDGE_FIXTURE_OUTPUT=1` and the service refuses to start without it.

  **rejected.** The shared gate corpus covered five of the six review statuses the
  `tajweed_findings` CHECK constraint allows. The missing one was `blocked` — what
  `TeacherDecision::Rejected` produces. Every implementation of `canShowLearnerFacingAiOutput` was
  verified against a table that had never been shown a teacher saying no. A denylist enumerating the
  five old statuses passes 30 of 31 assertions; the case added here is the one that catches it.
  `tests/contract/enum-db-parity.test.mjs` now asserts corpus completeness against `pg_constraint`,
  so a status added to the database without a case turns the gate red.

  **missing** is covered in part — `create_teacher_review` refuses to accept an unsourced finding,
  and the corpus has a no-sources case. **expired** has no gate and no schema: nothing in
  `tajweed_findings`, `teacher_reviews` or `scholar_approvals` expires. Adding an expiry concept is
  a design decision (who sets it, how long), not an engineering gap to close unilaterally.

  Related, though not named by this row: `audioStatus` on `/v1/tajweed-findings` now tells a
  reviewer whether the recitation can be heard — `available` / `discarded` / `not-captured` /
  `unknown` — where previously all 2772 findings belonged to discard-consent sessions and the queue
  looked identical to one where the audio was simply unplayed.

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
- [x] P5.3 — Add deterministic unit/integration fault tests and observability/tracing assertions.
- [ ] P5.4 — Execute documented load, burst, long-audio, reconnect, timeout, duplicate-delivery, partial-loss, and recovery tests against the candidate.
- [ ] P5.5 — Prove alerts, dashboards, owner routes, runbooks, feature/kill switch, deploy and rollback.
- [ ] P5.6 — Perform encrypted backup verification and timed point-in-time restore/disaster-recovery drill.
- [ ] P5.7 — SRE independently signs load/chaos/restore/incident/rollback evidence.

## Phase 6 — product accessibility, mobile, and user safety

- [x] P6.1 — Define critical journeys and severity/blocker policy; create end-to-end tests for learner, teacher, reviewer, approval, and privacy paths.
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
