# Research: 10/10 Readiness Recovery

## Decision

QrAi is **not** currently eligible for a “number-one” or launch-ready claim.
The engineering gate is strong, but the evidence chain and a core browser
journey are broken at the current candidate.  This recovery program replaces
the invalidated release claim with a clean, independently challengeable one.

“10/10” is a target operating standard, not a self-awarded label.  It means
every release-critical claim below has current, immutable, reproducible proof;
all known safety/domain constraints remain enforced; and named humans sign the
decisions that software cannot make.

## Observed baseline — 18 July 2026

| Area | What was directly observed | Consequence |
| --- | --- | --- |
| Engineering gate | `bash scripts/verify.sh` completed successfully, including 67 live-Postgres integration tests. | Strong local regression evidence, not a release certificate. |
| Release manifest | `release-manifest.mjs --verify` rejects the manifest: its candidate SHA is `849e2f2…`, while current HEAD is `517a50c…`; all image digests are null. | The completed number-one ledger cannot support the current candidate. |
| Full-stack proof | The newest retained aggregate smoke result predates current HEAD and is not cryptographically bound to it. | Runtime readiness is unproven for the code that would ship. |
| Learner browser path | The audited browser rendered “Practice is temporarily unavailable”; its console recorded `Progress API 401`. | The primary learner journey is currently failed in a real browser environment. |
| Locale promise | `ckb` is selectable and RTL mirrors, but `apps/web/src/locales` contains only English resources and visible copy remains English. | Kurdish cannot honestly be called localized/pilot-ready. |
| Product evidence | Privacy settings looked coherent in the audited browser, but the end-to-end learner flow could not complete; native mobile and assistive-tech proof are incomplete. | Product quality is partly promising, not complete. |
| Human authority | Scholar/source approval, privacy/legal review, production operations, and real learner outcomes cannot be established by a code test. | These remain named external release gates. |

## Release truth model

Every release claim must identify all of the following:

1. immutable source commit and signed build provenance;
2. exact artifact/container digests and SBOM;
3. environment, configuration class, and test actor/tenant (never secrets);
4. retained test/smoke/evaluation artifact, trace ID, and timestamp;
5. an independent verifier or accountable human approver;
6. expiry/refresh rule for evidence that becomes stale.

No checkbox, document assertion, generated fixture, developer-local result, or
prior commit qualifies as proof by itself.

## Binding constraints

- Canonical Quran data changes only through a new versioned, checksum-validated
  bundle.
- Learner feedback must carry source and the review/approval gate; no invented
  model output or evaluation result may be presented as real.
- Tenant-owned data remains protected by Postgres RLS; cross-tenant tests are
  release-critical.
- Audio is never logged; retention, export, deletion, consent, and external
  ASR handling follow the contracts.
- General-user login remains off unless the owner explicitly enables production
  login.  Any no-login pilot path must be explicitly environment-scoped and
  cannot weaken production identity enforcement.

## Relevant surfaces and likely affected symbols

- Evidence: `scripts/release-manifest.mjs`, `scripts/verify.sh`,
  `scripts/smoke-all.mjs`, `scripts/smoke-*.mjs`, CI workflows, and retained
  proof docs.
- Browser journey: `apps/web/src/App.tsx`,
  `apps/web/src/data/platform.ts`, learner flow components, and
  `services/platform-api/src/auth.rs`.
- Localization: `apps/web/src/i18n*`, `apps/web/src/locales/*`,
  `TopBar.tsx`, language metadata and all learner/teacher surfaces.
- Domain and data: `packages/contracts`, `packages/quran-data`, platform API
  handlers/integration tests, inference services, scholar/source artifacts,
  and `infra/sql/0003_tenant_rls.sql`.
- Operations: Dockerfiles/compose, deployment/IaC, observability, backups,
  incident runbooks, security workflows, mobile builds, and pilot operations.

## Non-substitutable gates

Qualified scholar approval, independent security assessment, legal/privacy
approval, production infrastructure access, app-store approval, and actual
pilot learner outcomes require the accountable people and systems named in the
plan. Automated checks can validate the evidence format, signatures, expiry,
and linkage—but never fabricate those approvals.

## P1.1 retained browser baseline — 19 July 2026

A fresh Chrome context loaded the normal learner route with
`VITE_REQUIRE_LOGIN=0`; no `?smoke` parameter, pre-seeded credentials, or
browser storage was used.  The controlled API returned `401` only for
learner-authenticated routes and allowed public Quran reads.  The retained
summary observed this exact progress request:

- `GET /v1/learner/progress` with `x-tenant-id=hikmah-pilot-erbil`,
  `x-user-id=learner-1`, and `x-user-role=learner`;
- no `Authorization` header;
- browser console: `Failed to fetch learner progress: Error: Progress API 401`;
- visible learner outcome: `Practice is temporarily unavailable`.

Evidence is outside the checkout at
`/var/folders/7d/jcmsj249459d99kpf572jywr0000gn/T/qrai-p1-default-401-playwright-oGPMuq/`:
`summary.json` SHA-256
`ab5caa9e15dc7a2cb6709590438f72fb43f189219cd3d884af4e51973d2333f3`,
and `default-route.png` SHA-256
`95e8e7bdccd2fb6553ce09a344ce52aca25c521db38eed89c0f24f8a38616ef0`.

This is a controlled reproduction, not candidate or deployment evidence.  It
proves the web request and learner outcome; the existing secure API auth tests
separately prove that header identity is rejected when `ALLOW_HEADER_AUTH` is
disabled.  P1.2 must choose the server-scoped pilot identity model before P1.4
changes either boundary.

## Verification determinism repair — 19 July 2026

The full local gate reached the live-Postgres integration suite and failed
`list_tajweed_findings_returns_the_seeded_finding_not_an_empty_list`. This was
not caused by the locale work. `list_tajweed_findings` intentionally orders by
confidence and caps its response at 200. The developer database persists
fixtures across runs; the test seeded an ordinary confidence-0.8 finding, which
could legitimately sit below 200 older equal-confidence test rows. The failure
output confirmed that the endpoint returned a populated capped list but omitted
the exact new fixture.

The repair preserves the test's purpose rather than weakening it: the test now
raises only its own fixture to confidence 1 before making the request, then
still asserts that exact ID is returned. A focused ignored integration run
passed. This does not decide the product's pagination policy or make a large
teacher queue ready; it only prevents historical local test residue from
invalidating an otherwise precise integration assertion.

## P3 learner Tajweed gate — 19 July 2026

The platform contract already defines `canShowLearnerFacingAiOutput`: a
finding must be teacher-reviewed or scholar-approved, have confidence at least
0.82, and carry one or more sources. The learner `TajweedPanel`, however,
previously rendered every returned finding and only added a provisional badge.
That contradicted the project rule that learner-facing AI feedback must pass a
review/approval gate.

`apps/web/src/lib/tajweedReview.ts` now filters the learner view through the
shared contract gate. `TajweedPanel.tsx` displays an explicit awaiting-review
state when all findings are withheld, and shows each source title and citation
for the eligible findings it renders. Its review queue is separate from the
learner panel and deliberately continues to expose unreviewed findings to
teachers.

Failing-first component tests covered both sides: a sourced `ai-suggested`
finding is absent from the learner surface, while a teacher-reviewed, confident,
sourced finding is rendered with its citation. Unit coverage additionally
checks `teacher-review-required`, missing sources, and the scholar-approved
case. `bash scripts/verify.sh` passed afterwards: 107 web tests and all 67
live-Postgres platform integration tests passed. This is local implementation
proof only; it neither establishes the correctness of every source nor grants
scholar approval for model output.

## P3 Sorani translation provenance correction — 19 July 2026

The source assets under `ckb-burhan-muhammad/` contain 39 surah files, 856
translated ayahs, and one explicitly recorded omission. The adjacent legacy
`manifest.json` was produced during an earlier partial import and instead lists
27 surahs / 516 translated ayahs / zero omissions. It is not read by the
application, but leaving it as implied provenance would make a release claim
unreliable.

The original licensed text and legacy manifest remain untouched. The new
`translation-bundles.ts` record is versioned
`2026-07-19-provenance-v2`; it identifies the source asset, records the
observed counts, and pins a SHA-256 aggregate over every file name and raw-file
hash. `translations-provenance.test.ts` recalculates those values, so any
future byte or inventory drift fails rather than silently changing the bundle.
The importer now requires a new version directory and refuses overwrite, so a
refresh produces a distinct candidate instead of mutating an existing asset.

This is provenance/integrity hardening, not source validation. The official
QuranEnc version string, continuing-update evidence, translation completeness,
and qualified scholar approval remain external release gates. The bounded
Sorani verse asset still must not be represented as a complete localized
interface or complete Quran translation.

## P5 gateway lock isolation — 19 July 2026

`RealtimeGateway::start_session` and `end_session` previously retained the
in-process `RwLock` write guard while awaiting best-effort Redis session
tracking. Redis has a two-second connection/response timeout; during a stalled
handshake, that lock made ordinary chunk sends and session lookups wait behind
an observability/reconciliation dependency.

The mutation now finishes and drops the lock before Redis work begins. Two
deterministic Tokio tests use a TCP listener that accepts a Redis connection
but never completes its handshake. One proves a new session remains able to
accept a chunk during start tracking; the other proves a removed session is
looked up as absent during end tracking. Both failed before the refactor and
pass after it. This improves local service isolation only; it is not load,
chaos, deployment, or SRE approval evidence.

## P4 agent-run erasure gap — 19 July 2026

The current `agent_runs` schema has only `tenant_id`, `goal`, and `trace`; it
has no structured learner key. `create_privacy_job` deletes learner progress,
session-derived rows, consent, and tickets, but cannot safely delete an agent
run that may contain a learner identifier in free text or JSON. The checkout
also contains no `0018_agent_run_learner_id.sql` migration despite stale docs
that described it as pending elsewhere.

Do not repair this by guessing from `goal` text. The correct path is an
immutable migration that adds a nullable, tenant-scoped `learner_id`, updates
agent-run writers and API schemas, includes the field in export/delete, and
proves same-tenant preservation plus cross-tenant isolation. Adding the
migration also requires the owner-controlled CI migration-list action. This
is an open privacy release blocker, now documented as such.
