# SHIP GAP — what stands between QrAi and a defensible release

**Compiled:** 2026-08-16 at `3256c2b`, by Claude (Anthropic), from a 17-agent survey of all 51
readiness rows plus first-hand verification of the load-bearing claims.

> **Status of every claim below is explicit.** A row marked **VERIFIED** was re-checked by hand at
> the commit above, with the command or `file:line` given. A row marked **REPORTED** came from the
> survey and has *not* been independently confirmed — treat it as a lead, not a fact.
>
> This document **closes no ledger rows** and is not evidence for any. It exists because the
> readiness ledger's narrative — "the remaining work is blocked on human signatures" — is
> substantially wrong, and acting on that narrative would waste the pilot.

## The bottom line

The engineering is *not* finished. The release-evidence chain that all of Phase 0 exists to build
cannot presently produce a candidate: its only image-digest producer emits a shape its consumer
rejects, nothing invokes the manifest generator, and the acceptance command every row's closure is
predicated on has never been executed. Separately, the ledger's own write path can mark rows done
without meeting the rule it records, and a fabricated model evaluation ships in the seed data.

None of that needs a human decision. It needs building.

---

## Part 1 — VERIFIED first-hand

### 1.1 `verify.sh --release` has never been executed, anywhere

The ledger RULE names `bash scripts/verify.sh --release` as the acceptance command for every row.

| check | result |
|---|---|
| `grep -n "verify.sh" .github/workflows/ci.yml` | `:258` runs `bash scripts/verify.sh` — **plain, not `--release`** |
| any other invocation | only `scripts/release-challenge.mjs:253`, inside `--run-release`, which has never run |

Every other reference (`release-challenge.yml:89`, `release-evidence-summary.mjs:118`,
`release-manifest.test.mjs:587`) is a *mention in a string or comment*, not an invocation.

**The command on which the entire ledger depends is untested and unexercised.**

### 1.2 The image-digest contract is broken between its only producer and its only consumer

```
scripts/release-images.mjs:99      digests[tag] = id           →  "qrai/platform-api:9f3c1ab"
scripts/release-manifest.mjs:182   imageDigests[service]       →  requires "platform-api"
```

`assertImageDigests` iterates `deployableServices` and demands a bare service name. The producer
keys by full tag. `--generate` would refuse real producer output on the first attempt.

Second defect in the same line: `docker image inspect --format {{.Id}}` (`release-images.mjs:98`)
returns the **local image config ID**, not a repository content digest. It is not a value a
registry can be asked to reproduce, which is what a rollback target needs.

### 1.3 Nothing invokes `release-manifest.mjs --generate`

`grep -rn "release-manifest.mjs"` across the tree returns only `specs/**` and `docs/**` prose plus
the script and its own test. No workflow, no script, no package.json entry. **The bundle assembler
does not exist**, so the eight files `release-challenge.yml:97-104` expects have no producer.

### 1.4 `scripts/update-ledger.sh` can mark a readiness row done without meeting the rule

```sh
if bash scripts/verify.sh; then                                  # :18  — NOT --release
  for f in specs/*/tasks.md; do                                  # :19  — EVERY ledger
    sed "s/- \[ \] ${task} /- [x] ${task} /" "$f" > "$tmp"       # :22
```

The readiness ledger requires `--release`, required CI, a retained candidate-bound artifact and an
independent verifier. This path requires a plain local `verify.sh`. It also sprays its `sed` across
every `specs/*/tasks.md`, so one task id can flip same-named rows in unrelated ledgers.

**No row owns this file.** The document governing release readiness has a write path with weaker
guarantees than the rules it records.

### 1.5 A fabricated model evaluation ships in the seed data

```sql
-- infra/sql/0006_seed_internal.sql
:25   ('model-v0.3', 'alignment', '0.3', 'eval-passed'),
:126  ('eval-v0.3', ..., 'model-v0.3', 'fatihah-juz-amma-smoke-v1', '{}',
       0.93, 0.86, 0.05, 0.92, 0, true)
```

One `eval_runs` row with an **empty `metrics` jsonb**, a `dataset_version` naming a *smoke fixture*
rather than a corpus, and six hand-typed scalars that clear `modelEvalPassesReleaseGate`
(`packages/contracts/src/index.ts:488`). `infra/sql/0027_unevidenced_model_claim.sql` downgraded
only `tajweed-v0.1`. `docker-compose.yml:30` mounts this into every fresh database.

P3.5 covers *running* a real evaluation. Nothing covers *removing the fake one*, and
`check-model-eval-claims.mjs` — the guard written to catch exactly this — certifies it as evidenced.

---

## Part 2 — Corrections

### 2.1 The survey overstated the evidence chain

It claims `release-evidence-summary.mjs:117` hardcoding `status: "passed"` means the chain "attests
nothing". Checked: that write happens at `verify.sh:371`, **after** the
`if [[ "$fail" -ne 0 ]]; then exit 1; fi` guard at `:365`. Within `verify.sh` the literal is
structurally sound — the line is unreachable on failure.

The real, narrower hole: the script can be invoked **directly**, outside `verify.sh`, and will
write `passed` for anyone. That is a contract with no enforcement, not a fabrication.

### 2.2 I was wrong about eval-run provenance

Earlier on 2026-08-16 I reported this axis **clean**, noting `metrics` was `{}` but calling it
"unused, not divergent". Wrong, and in the direction that matters: those scalars are hand-typed
seed data certifying an alignment model against a smoke fixture, and 0027's own reasoning was
applied to the other model and not this one. See 1.5.

---

## Part 3 — Engineering outstanding (no human decision required)

Ordered by value. **REPORTED** items need confirmation before work starts.

### E0 — make the evidence chain able to produce a candidate

1. **VERIFIED** Fix the digest contract (1.2), both the key shape and config-ID-vs-digest.
2. **VERIFIED** Write `scripts/release-bundle.mjs` + a release-candidate workflow chaining
   `verify.sh --release` → `generate-sbom.mjs` → `release-images.mjs` →
   `release-build-evidence.mjs` → `release-evidence-summary.mjs` → `release-manifest.mjs --generate`.
3. **VERIFIED** `scripts/release-pipeline.test.mjs` — feed **real producers** into `--generate`.
   `release-manifest.test.mjs:56-133` hand-writes all seven inputs, so no producer has ever been fed
   to the consumer. **Needs no Docker** (stub `sha256:` digests, throwaway repo and key, the pattern
   already at `release-manifest.test.mjs:56`). Would have caught 1.2 and the SBOM gap on first run.
4. **REPORTED** Smoke-summary filename mismatch: `smoke-all.mjs:342` writes `summary.json`;
   `release-challenge.yml:101` passes `smoke-summary.json`.
5. **REPORTED** Freshness: `--expires-at 3000-01-01` passes; no `completedAt` is compared to the
   candidate commit's timestamp.
6. **REPORTED** Non-vacuity on smoke: a results array of all `started`/`already-running` is accepted.
7. **REPORTED** Environment facts are stamped from the signer's machine, not the test runner's.
8. **VERIFIED** `release-build-evidence.mjs` has zero callers.

### E1 — the ledger's own bookkeeping

9. **VERIFIED** Harden `update-ledger.sh` (1.4): refuse the readiness ledger without a complete
   evidence block; refuse a task id matching rows in more than one ledger; add
   `scripts/update-ledger.test.sh` wired into `verify.sh`.
10. **REPORTED** `tests/contract/ledger-evidence.test.mjs` — the ledger's mandatory 11-field
    evidence format is used by **zero** of its 20 closed rows.

### E2 — shipped code and data that assert falsehoods

11. **VERIFIED** `infra/sql/0029_unevidenced_alignment_claim.sql` applying 0027's reasoning to
    `model-v0.3`; extend `check-model-eval-claims.mjs` to refuse an empty `metrics` or a
    `dataset_version` that resolves to no sealed manifest.
12. **REPORTED** Seeded `finding-seed-1` is `teacher-reviewed`, confidence `0.84`, one source whose
    signature block is `_PENDING_` — it **clears** `canShowLearnerFacingAiOutput`, and its rule
    string is not one the engine can emit.
13. **REPORTED** `source_refs` is `jsonb not null default '[]'` with no CHECK, so an unsourced
    finding can exist in a learner-visible status.
14. **REPORTED** Every finding cites `TAJWEED_SOURCE`, a constant defined in the file that emits it —
    the gate's `sources.length > 0` is satisfied by the engine citing itself.
15. **REPORTED** Four deviations from the owner-approved P1 identity packet, none gated: invite
    secret in the query string rather than the fragment; 8h/24h session lifetimes against an
    approved 30min/8h; a 122-bit UUIDv4 where 256 bits were specified; no invitation revocation.

### E3 — security boundary (findings an assessor would raise anyway)

16. **REPORTED** `ALLOW_HEADER_AUTH` — the switch that collapses the identity boundary — has no
    boot-time refusal and appears in no insecure-defaults list.
17. **REPORTED** `ensure_secure_config()` has five `panic!` branches and no test exercises any.
18. **REPORTED** A revoked or expired pilot cookie falls through to the header-auth branch.
19. **REPORTED** `POST /v1/auth/register` lets an unauthenticated caller create a learner in **any
    named tenant**; ADR-0020's own mitigation `ALLOW_OPEN_REGISTRATION` appears nowhere in code.

---

## Part 4 — Human-only work, by role

| Role | Must do | Unblocks |
|---|---|---|
| 🧑 **Release authority / owner** | Name ten accountable people (`OPERATIONS.md:11-22`, all `_PENDING_`) | **P0.1 — the declared dependency of 32 of 51 rows** |
| 🧑 Owner | Rule on evidence retention (ADR-0043, Proposed) | P0.2 |
| 🧑 Owner | Ratify the per-locale ship/hide choice the code has already made | P2.3 |
| 🧑 Owner | Approve the pilot protocol; hold the go/no-go | P7.1, P7.6 |
| 🧑 **Security assessor** | Challenge the deployed identity boundary; approve the threat model; run the assessment | P1.7, P4.1, P4.5 |
| 🧑 **Scholar** (ijazah) | Rule on source/model scope for the nine tajweed rules | P3.6 → gates P3.4 and 113 religious keys |
| 🧑 **Sorani + Arabic reviewers** | Approve 389 interface strings per locale — **0 today** | P2.4 — longest non-pilot lead time |
| 🧑 **SRE** | Ratify SLOs/RTO/RPO; attest load, chaos, restore | P5.1 → P5.4/5.5/5.6; P5.7 |
| 🧑 **Legal / DPO** | User notice; ADR-0045 (does "delete my data" mean the account?); minors' consent | P4.6, P4.3 residual, P3.4 |
| 🧑 **Accessibility auditor** | VoiceOver + a second screen reader — **only 2 of 7 dimensions** | P6.2 (partial) |
| 🧑 **Participants** | Reciters, annotators, dogfooders, usability subjects, pilot learners | P3.4/3.5, P6.5, P7.2, P7.3 |
| 🧑 **Independent challenger** | Verify a candidate from a clean checkout and sign a verdict | P7.5 |

---

## Part 5 — Physical prerequisites

| Prerequisite | Blocks | Note |
|---|---|---|
| Ed25519 release signing key, held by the release authority | P0.4, P0.7, P7.4, P7.5 | Rehearsals can use a throwaway key |
| Android keystore + Apple distribution cert | P6.3 | An unsigned iOS *compile* needs neither and has never been attempted |
| Docker registry egress | real digests, image scanning | **Works in CI**; denied in the agent environment. Does not block E0.3 |
| A deployed staging environment | P1.7, P5.5, P5.6, P7.3–P7.5 | `verify.sh:287` already spawns the real binary over HTTP |
| Physical handsets | P6.4, 2 of 7 P6.2 dimensions | An emulator must never be recorded as a device |

---

## Part 6 — Critical path

1. **E0 + E1 engineering.** Releases no rows directly. Nothing downstream is trustworthy without it:
   today a candidate could be generated, signed, verified and challenged, and would attest only that
   a tree was clean.
2. **P0.1 — ten named owners.** The single highest-leverage act in the programme. Costs an
   afternoon; converts a large fraction of this ledger from *impossible* to *scheduled*.
3. P5.1 (SLOs) → P5.4/5.5/5.6 → P5.7 · P3.4 (protocol) → recordings → P3.5 → P3.6 · P2.4 (locales)
4. P7.2 dogfood → P7.3 pilot → P7.4/7.5 → **P7.6 go/no-go**

---

## Part 7 — Ship blockers no row covers

1. **Ledger-mechanism integrity** (1.4).
2. **Seed-data truthfulness** (1.5).
3. **Migrations are never applied to a populated database.** CI applies 0001–0028 to an empty one
   (`ci.yml:151-172`). A pilot deployment takes the populated path from day two onward. No
   forward-only test, no data-preserving upgrade rehearsal.
4. **REPORTED** `ml-inference → asr-inference` is absent from the P5.2 dependency map, so its
   missing request timeout was never surfaced. A wedged ASR hangs finalize for every learner.
5. **REPORTED** `MAINTENANCE_MODE` is read once at construction — "engage the kill switch" resolves
   to a redeploy, under incident conditions.
6. **REPORTED** `apps/mobile` is a second shipping client named by no row: no locale story, no
   consent story, no degraded-state coverage.
7. **REPORTED** `ASR_SERVICE_URL` can point anywhere, while `DATA_INVENTORY.md` promises no
   third-party processor. For a pilot recording children, that is a legal exposure with no gate.
8. **REPORTED** Secret rotation has no procedure, no drill and no row.
9. **REPORTED** `modelEvalPassesReleaseGate` gates on four metrics the approved evaluation protocol
   predeclares none of.
10. **VERIFIED** **No test in the release-script suite ever executes a `main()`.** Every one of
    `release-images.mjs`, `release-evidence-summary.mjs`, `release-build-evidence.mjs` and
    `generate-sbom.mjs` is covered only through its exported pure functions. Found the hard way
    while fixing the digest seam (#445): a botched edit left `release-images.mjs` `main()`
    assigning to an undefined `digests`, and the **entire suite still passed**. Every release
    producer can be syntactically valid, fully unit-tested, and broken at the only entry point ever
    used in anger. A smoke invocation of each `main()` — even one that exits early on a missing
    prerequisite — would close it.

11. **VERIFIED** **The cutover gate `response-schemas-validated` cannot be satisfied by engineering
    work.** `scripts/cutover-readiness.mjs:117` flips it only at `unvalidated === 0`. The three
    operations still marked `x-unvalidated` are the ML/ASR proxies, and
    `specs/flutter-client/openapi.yaml:22-26` states — correctly — that they are *"NOT going to zero
    without giving those routes a real contract, which is a product change."*

    Verified rather than taken on the comment's word: `proxy_asr_transcribe` and
    `proxy_asr_force_align` (`services/platform-api/src/handlers/ml_proxy.rs:561,580`) take
    `JsonBody<serde_json::Value>` and return `Json<serde_json::Value>`. platform-api never reads a
    field, so pinning a response shape would fabricate a contract it neither owns nor enforces.
    Marking them is the right call.

    So two carefully-reasoned documents here deadlock each other: one requires zero, the other
    explains why zero is unreachable without a product decision nobody has scheduled. Anyone working
    the cutover checklist top-to-bottom spends the effort before discovering it. The gate is not
    wrong to want validated schemas — it is wrong to treat "correctly marked as unvalidatable" and
    "not yet validated" as the same state.

    Resolving it is a **product decision, not a fix**: either give the ML/ASR proxies a real
    contract, or let the check distinguish the two states and record which routes are permanently
    exempt and why. Neither belongs to a script, or to an agent.

    One separable sub-finding: `POST /v1/ml/tajweed-findings:predict` is arguably **mis-marked**. It
    stopped being a passthrough when `persist_tajweed_findings` began reading it by field name
    (ADR-0027 item 4) — a `wordId` → `word_id` rename in `services/ml-inference/tajweed.js` persists
    nothing, silently, forever, with every suite on both sides still green.
    `tests/contract/ml-findings-shape.test.mjs` already pins the fields platform-api depends on, so
    the contract could assert that subset honestly. It moves the count 3 → 2, flips no gate, and is
    still a contract decision this repository deliberately deferred.

12. **VERIFIED** **The cutover readiness tool measures the backend that is not being built.**
    `scripts/cutover-readiness.mjs:215` computes `traffic-share` from
    `read("services/node-api/server.mjs")`. ADR-0044 (Accepted, 2026-08-12) froze that service:
    `server/` on PR #388 is the Node backend being built, and it already contains node-api's routes
    plus `jobs/`, `storage/`, `realtime/`, `inference/`.

    So the headline cutover number — *"Node serves 0 of 42 routes by default (37 portable)"* —
    describes a service that has been retired in place. Worse, it is **pinned at zero by
    construction**: `tests/contract/node-api-frozen.test.mjs` asserts `portableKeys: 37` and fails
    any addition with *"growth is not"* — so the one gate standing between this repository and
    deleting a backend can never move, no matter how much porting is done, because the porting is
    supposed to happen in a tree this tool does not read.

    Found the hard way, which is why it is VERIFIED: I ported
    `GET /v1/recitation-sessions/{id}/tajweed-findings` into `services/node-api` — handler, route
    registration, `PORTABLE` entry, 156/156 on `tests/node-api` — and `verify.sh` refused it on the
    freeze guard. The guard worked exactly as designed. The reverted change is not the finding; the
    finding is that `cutover-readiness.mjs` still points at the frozen tree and reports its
    permanent zero as though it were progress waiting to be made.

    Related to item 11 in kind: both are gates that read as actionable and are not. This one is the
    more misleading of the two, because a deadlocked gate at least stops you, whereas this one
    invites the work and then rejects it at the guard.

    Fixing it is mechanical *if* ADR-0044's direction stands: point `checkTrafficShare` at
    `server/src/main.mjs`. That cannot be done from `main` — `server/` exists only on PR #388 — so
    the tool cannot become accurate until that branch lands. Recorded rather than patched, because
    a check reading a path that does not exist on its own branch is not an improvement.

---

## How to use this document

Start at Part 3. Everything there can be built now, by anyone, without waiting for a signature —
and until E0 is done, no signature anybody gives is attached to a candidate that can be reproduced.

Then get Part 4's first row: **ten names.**
