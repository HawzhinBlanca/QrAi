# Plan: Total Completion to 10/10 Readiness

## Status and operating rule

**Approved-by:** Hawzhin (explicit implementation authorization)  
**Approval date:** 2026-07-19  
**Release authority:** ____________________

Implementation is authorized for tasks that do not require a product, security,
privacy, scholarly, or release-owner choice.  Agents work one task at a time:
research the exact symbols and callers, add a failing test, implement the
smallest correct change, run `bash scripts/verify.sh --release` when its
candidate prerequisites exist, obtain required CI and reviewer proof, then
update the ledger.  A task with an explicit owner decision (for example the
pilot identity model) stops at its decision packet until that choice is made.
Nothing is marked complete based on a self-assessment.

The existing `number-one-release` ledger is historical context only.  This
recovery ledger is the sole readiness record for a new candidate.

## Critical path

```
Truthful evidence → secure functional identity → real learner E2E
       └────────────→ source/domain/privacy gates ───────┐
Localization + accessible product + mobile proof ─────────┼→ pilot → fresh candidate → independent challenge → promotion
Operations, security, resilience, recovery ───────────────┘
```

No phase may certify the product while an earlier release-blocker is open.
Phases may be researched in parallel, but implementation stays narrow and
sequenced by the dependency graph below.

## Phase 0 — reset truth before changing product behavior

1. **Create a release-evidence ADR and schema.** Define candidate identity,
   build provenance, image digests, SBOM, test/smoke artifact hashes, trace,
   environment class, signing identity, retention, and expiry.  Replace the
   current manifest’s `HEAD/HEAD~1` heuristic with exact candidate linkage;
   reject null deployable digests and untracked files.
2. **Make `verify.sh --release` an uncompromising, self-contained gate.** It
   must run the R1–R12 engineering tests against an isolated disposable stack
   or explicitly provisioned release environment—not silently skip database or
   browser proof.  Keep the current developer-speed mode only if its output
   states exactly what it did not prove.
3. **Bind smoke to the candidate.** Aggregate smoke output must include commit,
   image digests, environment, trace, test actor class, script hashes, and
   signed summary.  Smoke must fail closed if these disagree.
4. **Build the challenge harness.** A clean second checkout/CI runner verifies
   the manifest and reruns a selected browser/API/SQL/privacy subset.  It must
   prove stale, modified, missing, expired, and unsigned evidence is rejected.
5. **Reconcile every readiness document.** Mark old claims historical,
   regenerate a single status page from verified evidence, and prohibit prose
   claims that outrun the manifest.  Preserve—not overwrite—the failed
   manifest as an audit record.

**Exit proof:** R1 and R2 are green from two independent runners, and no
document describes the old candidate as current.

## Phase 1 — repair the failed learner browser path without weakening security

1. **Write an identity-mode ADR and threat model before coding.** Decide the
   approved architecture for login-off pilot sessions.  The recommended
   direction is a server-issued, short-lived, tenant-fixed, HttpOnly secure
   session for an explicitly enabled pilot—not browser-supplied tenant/role
   headers.  It must state CSRF/CORS, session rotation/revocation, rate limits,
   audit events, user disclosure, and expiry.
2. **Trace the 401 end to end.** Instrument the browser request (redacted),
   web API wrapper, CORS/preflight, API auth parser, and environment flags.
   Reproduce the failure in an automated browser test before fixing it.
3. **Implement the smallest approved identity boundary.** Ensure the default
   pilot route obtains authorized progress and starts practice.  Make header
   identity impossible in production and explicit/isolated in development and
   CI; do not ship an embedded credential or trust client-selected roles.
4. **Test every affected caller.** Cover all `actor_from_headers` handler
   families, direct API use, cookies/bearer sessions, retry, expiry, logout or
   session clearing, forbidden role escalation, tenant crossover, and
   controlled offline recovery.
5. **Run the real browser journey.** Use a clean browser, normal route—not a
   `?smoke` bypass—to load progress, select a surah, grant/deny microphone,
   record or use declared fixture audio, receive appropriately gated feedback,
   retry a controlled transient failure, review privacy, and return safely.

**Exit proof:** R3/R4 pass in isolated CI and the candidate environment;
security reviewer accepts the ADR/threat model; no learner 401 appears in the
recorded browser trace.

## Phase 2 — make all product promises truthful, beginning with language

1. **Create a localization capability registry.** A locale is selectable only
   when its reviewed bundle, coverage, reading direction, font/rendering,
   source attribution for Quranic text, native-language reviewer, and review
   date are present.  Otherwise hide it or label it unavailable—never present
   English as a completed translation.
2. **Deliver locale packs deliberately.** Extract all user-visible learner,
   teacher, reviewer, error, privacy, and accessibility strings; add reviewed
   Sorani and Arabic packs only after full key parity and review.  Treat Quranic
   verse/translation source licensing and religious terminology separately.
3. **Prove RTL beyond mirroring.** Test `lang`/`dir`, focus order, keyboard
   navigation, truncation, numerals, screen-reader labels, charts, forms, and
   error states at desktop and mobile widths.
4. **Make degraded states useful.** Specify and test empty/loading/offline/
   permission/timeout/authorization states with concrete recovery actions;
   they must not collapse core teaching into a generic unavailable screen.

**Exit proof:** R5 green for every offered locale; expert native-language and
Quran-content reviewers sign bounded locale manifests; no unreviewed locale is
advertised as pilot/live.

## Phase 3 — prove Quranic and data integrity, not just code paths

1. **Inventory all learner-visible feedback and every model/data dependency.**
   Give each a source, approved scope, model/version, corpus/evaluation
   provenance, known limitations, owner, and expiry.  Label declared fixtures
   unmistakably in developer/demo contexts and exclude them from real claims.
2. **Strengthen domain gates.** Test that missing/expired/rejected source or
   review state withholds feedback; test that every visible feedback result
   exposes the required provenance and uncertainty.
3. **Lock canonical-data release practice.** Verify checksums, bundle version,
   changelog, licensing, reproducible import, migration, and rollback for any
   Quran-data change.  Never mutate a canonical bundle in place.
4. **Run a real evaluation program.** Use consented, representative, versioned
   data with predeclared metrics, confidence intervals, error slices,
   false-positive/false-negative review, and a held-out set.  Independently
   reproduce results and document what the model must not claim.
5. **Obtain scholarly authority.** A qualified scholar signs the exact feature
   scope, sources, unresolved edge cases, and re-review trigger.  A scholar is
   never asked to approve a generic dashboard or stale result.

**Exit proof:** R6 passes; evaluation and model-card artifacts bind to the
candidate; scholar approval is current, scoped, and independently verifiable.

## Phase 4 — complete privacy, security, and supply-chain assurance

1. **Threat-model the whole system.** Include learner/teacher/reviewer roles,
   no-login pilot session, tenant crossover, audio capture/storage, ML/ASR
   vendors, prompt/tool routes, admin actions, browser threats, mobile, CI,
   secrets, backups, and denial of service.  Convert each material threat to a
   test, mitigation, owner, or explicit accepted risk.
2. **Prove privacy lifecycle end to end.** Test consent, collection minimization,
   no raw-audio/secrets in logs, retention expiry, export completeness,
   deletion propagation/retry, audit evidence, and failure alerts on the real
   storage topology.  Conduct a restore only against safe test data.
3. **Prove tenant isolation continuously.** Expand cross-tenant tests for every
   table/query/worker/export/cache path, restore path, and derived artifact.
   Add mutation tests that demonstrate the suite detects a removed RLS check.
4. **Harden delivery.** Pin/scan dependencies and images, generate SBOM and
   signed provenance, enforce protected reviews, secrets scanning, secure
   headers/TLS/CSP/CORS, rate limits/WAF where deployed, and configuration
   policy checks.  Critical/high findings have no waived release path without
   named risk acceptance and expiry.
5. **Commission independent challenge.** A qualified external security tester
   receives the current candidate scope, performs authenticated/unauthenticated
   testing, and every finding is fixed, accepted by the accountable owner with
   expiry, or blocks release.

**Exit proof:** R7/R8 engineering tests pass; independent security and
privacy/legal approvals are fresh and candidate-linked.

## Phase 5 — earn reliability rather than assert it

1. **Set explicit service objectives and capacity budgets.** Product, SRE, and
   domain owners approve availability, latency, feedback-time, error-rate,
   recovery, data-loss, and support-response targets based on a documented
   pilot load model.  Do not invent target numbers after testing.
2. **Engineer deterministic failure behavior.** For API, realtime gateway,
   ASR/ML, databases, object storage, queues, and browser/mobile reconnects:
   define timeouts, cancellation, bounded retry/backoff, idempotency keys,
   dead-letter/replay policy, circuit breaking, user messaging, and observability.
3. **Load and fault test the candidate.** Test sustained/burst traffic, tenant
   mix, long audio, dependency timeouts, partial database loss, duplicate
   delivery, token/session expiry, network transitions, and reconnect storms.
   Record limits and failure modes rather than averaging them away.
4. **Make operations recoverable.** Ship dashboards tied to traces, alert
   routes with owners, runbooks, SLO/error-budget review, encrypted backup
   verification, timed point-in-time restore, disaster-recovery drill,
   rollback rehearsal, and a tested feature/kill switch.

**Exit proof:** R9 passes against stated budgets; SRE independently signs the
load, chaos, restore, incident, and rollback reports.

## Phase 6 — finish the actual product on real people and devices

1. **Define critical journeys and severity rules.** Learner practice, feedback
   interpretation, teacher review, scholar/source approval, privacy export/
   delete, consent changes, support recovery, and error recovery each get a
   scripted start-to-finish test.  Any severity-1/2 defect blocks pilot exit.
2. **Complete accessibility verification.** Maintain automated coverage, then
   conduct keyboard-only and screen-reader tests (VoiceOver/Safari plus one
   supported alternative), zoom/reflow/contrast testing, RTL assistive-tech
   checks, and a remediation/retest log.
3. **Prove native mobile rather than infer it from web.** Build signed
   reproducible iOS/Android candidates; test the approved physical-device/OS/
   network matrix for microphone, permissions, interruptions, backgrounding,
   offline/reconnect, privacy, deep links, and crash-free sessions.
4. **Run structured usability and learning-safety review.** Recruit consented
   target users, pre-register tasks/success criteria, capture no sensitive
   audio unnecessarily, distinguish usability from learning efficacy, and
   resolve critical confusion—especially confidence/feedback interpretation.

**Exit proof:** R10 passes; device, accessibility, and usability reports
contain reproducible evidence and signed disposition for each issue.

## Phase 7 — controlled pilot, adversarial release review, and promotion

1. **Prepare the pilot operating system.** Define cohort/consent eligibility,
   support channel, incident commander, monitoring dashboard, ethical stop
   rules, kill switch, rollback, data boundaries, source/model scope, and
   daily review cadence.  Get privacy, scholar, product, and support approval.
2. **Dogfood before external pilot.** Use internal authorized testers to execute
   the R3–R12 journeys, triage each issue with severity/owner/ETA, and rerun
   the exact affected proof after every correction.
3. **Run the bounded external pilot.** Measure predeclared reliability, safety,
   privacy, accessibility, user comprehension, and support signals.  Never use
   testimonials or activity counts as a substitute for the exit criteria.
4. **Perform a release challenge.** A reviewer who did not implement the work
   starts from a clean checkout, validates manifest signatures/digests, reruns
   selected adversarial tests, checks the deployed candidate, attempts the
   documented rollback, and writes a signed verdict.
5. **Hold formal go/no-go.** Promotion is allowed only with green R1–R12,
   current approvals, zero unaccepted blockers, live rollback evidence, and
   owner signatures.  Otherwise publish a truthful “not ready” decision with
   the remaining ledger, not a softened score.

**Exit proof:** R11/R12 and all release authorities are green and current for
the exact candidate.  Only then may the owner call it launch-ready.

## Proof standard required from every developer agent

For each task, submit: exact acceptance criterion; failing-first test and
caller impact; smallest diff; `verify.sh --release` and CI IDs; artifact paths,
hashes, trace, commit, environment class; negative/adversarial test; rollback
effect; independent reviewer; and all remaining uncertainty.  “Works locally”,
screenshots alone, a green unit test, or a completed checkbox are rejected.

## Implementation record

- **2026-07-19 — P0.3 verified.** `scripts/release-manifest.test.mjs` now
  proves that stale commits, modified/untracked files, missing hashes, null
  image digests, bad traces, expiry, missing signatures, tampering, and
  symlinked output paths fail closed. `bash scripts/verify.sh` passed with the
  live-Postgres integration suite; the ledger was updated through
  `scripts/update-ledger.sh`.
- **2026-07-19 — P0.4 foundation in progress.** The manifest now accepts only
  external, candidate-matching build, SPDX SBOM, smoke, test, environment, and
  trusted-signer-policy materials, hashes each one into its Ed25519-signed
  payload, and rejects material/policy mismatch. It is not a release pipeline
  yet: P0.5/P0.6 must produce those materials from real release commands, CI
  must pin the trusted policy, and an independent candidate challenge remains
  required.
- **2026-07-19 — P0.4 build provenance strengthened.** A build-evidence
  producer writes external build summary and provenance files only from a clean
  candidate. The manifest now requires and hashes that provenance, and rejects
  any mismatch in candidate, builder/invocation identity, or deployable image
  digests. This establishes the local contract, not a release certificate:
  protected CI must still supply registry-backed digests, SBOM, and a trusted
  signing policy before a positive candidate can exist.
- **2026-07-19 — P0.5 foundation in progress.** `verify.sh --release` now
  requires an explicit disposable release database and external smoke, test,
  and environment evidence locations. It rejects a dirty candidate before
  running, executes the live-Postgres suite and full-stack smoke, then writes
  candidate-bound test/environment evidence only after the gate passes. Its
  boundary tests and the normal verification gate pass; P0.5 remains open
  until a clean, isolated release candidate has completed the real command.
- **2026-07-19 — P0.6 foundation in progress.** Aggregate smoke now rejects a
  requested SHA before any database work, records its exact source SHA, trace,
  environment, actor class, deployable image digests, and hashes of the smoke
  scripts in its versioned summary. Release mode requires complete image
  digests and drives smoke against the explicitly supplied database rather than
  the developer default. Unit and adversarial mismatch tests plus the ordinary
  verification gate pass. P0.6 remains open until clean-candidate release
  smoke yields a retained external summary and independent verification.
- **2026-07-19 — P0.8 truthfulness foundation in progress.** The prior proof
  checklist and ship-readiness runbook now label their retained smoke and
  engineering conclusions as historical rather than current-candidate proof.
  The reconciliation remains open until every release-facing document, pilot
  report, and evidence source is generated from the verified candidate bundle.
