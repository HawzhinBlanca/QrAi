# Plan — execute every remaining task toward real 10/10

**Status:** PROPOSED — implementation blocked
**Approved-by:** ____________________
**Approval date:** ____________________
**Approved target branch:** ____________________

Read `research.md`, `spec.md`, `impact-map.md`, `ledger-reconciliation.md`, `tasks.md`, and
`MASTER_AGENT_PROMPT.md`. Per `AGENTS.md`, no implementation starts until a human fills the approval
line above. This plan never authorizes deployment, data collection, external publication, or a human
signature by itself.

## 1. Decisions this plan recommends

1. Continue in this repository and converge the approved consolidation branch; do not start a rewrite.
2. Create one candidate descended from both `origin/codex/lean-flutter-node-consolidation` and
   `origin/main`, preserving all recent safety fixes. Use a reviewable merge, not history rewriting.
3. Treat 76 entries as active source-ledger obligations. Consolidate duplicate implementation work,
   but keep a one-to-one reconciliation record so no source ID disappears.
4. Treat old number-one/superpowers/proof checklists as historical or regression context only.
5. Flutter becomes the sole product client after parity; one Node package owns API/realtime/worker;
   Python ASR remains only until a measured replacement wins; Postgres and private object storage remain.
6. Retire public register/login under accepted ADR-0038; do not implement proposed bcrypt ADR-0025.
7. Execute ADR-0022’s accepted digest-pinned rollback design; DR T4 is operationally open, not
   decision-blocked.
8. Ship native-reviewed Sorani and Kurmanji core parity. Badini is a separate capability and evidence
   slice. Never describe a bounded translation as the complete Quran.
9. Keep acoustic Tajweed and theological generation disabled/abstaining until their independent gates
   pass. Word-position/Hifz feedback and human review may ship earlier if separately proven.
10. Do not call the result 10/10 or #1 until independent reliability and learning-outcome evidence passes.

Any rejected decision must be edited here before approval and, where architectural, recorded in an ADR.

## 2. Source-of-truth hierarchy

1. `AGENTS.md`, `scripts/verify.sh`, and `specs/constitution.md`.
2. This approved execution pack for ordering and duplicate reconciliation.
3. `specs/lean-flutter-node-consolidation/tasks.md` for W1–W7 engineering obligations.
4. live-main `specs/readiness-recovery-10-10/tasks.md` for current release obligations.
5. `specs/dr-rehearsal/tasks.md` and `specs/migration-completion/tasks.md` for their remaining rows.
6. Historical plans/checklists only as regression or audit evidence; never as completion authority.

If two sources conflict, stop, record the conflict, and resolve the higher-risk interpretation through
the owner. Never silently choose the easier checkbox.

## 3. Dependency order

```text
E0 one candidate + truthful evidence + named owners
 ├─→ E1 threat/identity/content/research decisions
 ├─→ E2 transitional HTTP/realtime/rollback proof
 ├─→ E3 corpus + model data/evaluation/calibration
 └─→ E4 Kurdish Flutter product + teacher/scholar loop
              E2 + E3 + E4
                    ↓
E5 security/privacy/accessibility/device + operations/DR
                    ↓
E6 final topology + immutable candidate + canary + signoffs
                    ↓
E7 dogfood → external pilot → independent challenge → go/no-go
                    ↓
E8 retire duplicate stacks → clean-clone final gate
                    ↓
E9 independent outcome studies + head-to-head #1 decision
```

Research, recruiting, legal review, and device-lab preparation may run in parallel. Code-changing tasks
still land one at a time against a current branch so their proof and rollback remain attributable.

## 4. Implementation waves

### E0 — establish one truthful control plane

- Reconcile the branch with both remote tips without losing user changes or recent main safety fixes.
- Generate the active-ledger reconciliation and add a guard that fails on unmapped/duplicated active IDs.
- Name decision owners and expiry rules; approve evidence architecture and the remaining Flutter/content/
  research/privacy decisions.
- Finish the candidate manifest/verifier and independent clean-checkout challenge path before using
  evidence to authorize removals.

**Exit:** EX-1/EX-2 engineering proof is green; one clean candidate exists; human owner matrix is signed.

### E1 — close policy and safety decisions before feature work

- Approve full-system threat model, child/voice data policy, locale/source/licence policy, research ethics,
  theological scope, and SLO/RTO/RPO proposals.
- Reconcile ADR-0038/ADR-0025 and ADR-0022 with the stale migration/DR rows.

**Exit:** no implementation-critical decision is being made accidentally through code.

### E2 — prove transitional Node HTTP/realtime and rollback

- Close the already-passed audio erasure drill only after the exact current gate and CI pass.
- Run the real W2.18 HTTP canary, W3 production realtime image suite, independent realtime canary, and
  digest-pinned rollback; replace every `UNMEASURED` runbook field with retained evidence.

**Exit:** transitional Node traffic can be stopped and reversed without tenant/privacy/data loss.

### E3 — sacred content and measured model evidence

- Independently reconcile the canonical corpus and complete the deterministic provenance/withholding tests.
- Approve the Kurdish-learner evaluation protocol; collect and adjudicate natural errors under consent.
- Benchmark/pin candidates, calibrate the operating point, reproduce results, publish limitations/model
  cards, and obtain scholar scope approval.
- Evaluate long-audio/capacity and Node/ONNX/on-device alternatives on the identical frozen corpus; retain
  Python unless a replacement passes every threshold.

**Exit:** QR-1/AI-1/AI-2 are green; unsupported acoustic findings remain disabled.

### E4 — complete the Kurdish-first Flutter product

- Generate the strict Dart boundary; implement reviewed locale capability manifests and native Sorani/
  Kurmanji core packs; keep Badini independently scoped.
- Finish reader/audio/practice/progress/inbox/enrollment/recorder, teacher and scholar journeys.
- Add child-safe controls, curriculum/mastery/spaced retrieval, offline/recovery, and honest uncertainty.
- Produce signed device builds, physical network/microphone evidence, accessibility and comprehension studies.

**Exit:** KU-1/FL-1/AC-1 pass on real devices with signed human evidence.

### E5 — independent security, privacy, reliability, and recovery

- Complete production tenant/object-store isolation, dependency/image/config/TLS/CSP/CORS policy gates,
  child-safety red team, external pentest, and privacy/legal notice approval.
- Execute final candidate load/burst/soak/long-audio/reconnect/loss tests, alerts/runbooks/kill switch,
  encrypted backup, PITR, DR and rollback; obtain SRE approval.

**Exit:** PS-1/OP-1 pass; zero unresolved Critical/High finding; accepted SLO/RTO/RPO evidence exists.

### E6 — build and canary the final topology

- Retarget commands, Compose, CI, proxy, SBOM, monitoring and runbooks to Flutter + Node + selected inference.
- Bind all artifacts and model/data/evaluator identities in one immutable manifest.
- Prove deep readiness, safe-read shadowing, bounded canary stop rules, rollback, and every candidate-bound
  human signature.

**Exit:** protected `verify.sh --release` is green for the exact deployed candidate.

### E7 — controlled pilot and release decision

- Approve the pilot protocol, dogfood, fix/retest every finding, then run a bounded external pilot.
- Generate fresh evidence, have a non-implementer challenge it from clean checkout and rehearse rollback,
  then hold a formal go/no-go.

**Exit:** LC-1 passes and release authority signs; otherwise publish a truthful no-go.

### E8 — retire duplicate components only after observation

- In dependency order retire Expo, unselected Tajweed runtime, agent/public-auth routes, React/nginx,
  Rust HTTP, Rust realtime/shared ticket, then Cargo/transitional directories.
- Preserve behavior as permanent contract/effect fixtures, write migration summary/living docs, retire
  obsolete specs, and run the clean-clone canonical/release gates.

**Exit:** CL-1 passes and Git history—not a `legacy/` folder—is the archive.

### E9 — earn the 10/10/#1 claim

- Run sustained reliability measurement, two preregistered independent learning studies, dialect/subgroup
  analyses, and a same-protocol head-to-head against the strongest alternatives.
- Publish results, limitations, model/data cards, correction log, and claim-expiry rules.

**Exit:** LR-1 passes. Until then market only the evidence-backed narrower capability.

## 5. Mandatory loop for every agent task

1. Select the first unblocked row in `tasks.md`; never cherry-pick a later easy row.
2. Read `AGENTS.md`, this pack, the mapped source-ledger rows, and current git/CI state.
3. Activate Serena on `/Users/hawzhin/QrAi`; find each symbol and all callers; update `impact-map.md` if
   reality differs. If Serena cannot target QrAi, stop before code.
4. Add the named failing test first; show that the failure represents the criterion, not environment noise.
5. Implement the smallest correct change; no drive-by refactor, no weakened assertion, no new dependency
   without ADR, no sacred-byte mutation/normalization, no fabricated fixture presented as real.
6. Run focused tests, then `bash scripts/verify.sh`; release tasks also need protected
   `bash scripts/verify.sh --release`, required CI, and candidate-bound evidence.
7. Update a source ledger only through `scripts/update-ledger.sh`, only after every named proof is green.
8. Record commit/test/CI/evidence hashes, residual risk, rollback, and the next unblocked task.
9. Stop for any owner/independent approval, credential, production access, ethics, recruitment, scholar,
   legal, security, device, pilot, or release decision. Never synthesize a signature.

## 6. Test mapping

The test column in `spec.md` is binding. `tasks.md` names the focused proof for each atomic task;
`impact-map.md` names affected callers and regression families. A task cannot substitute screenshots,
mock metrics, a green unit test, or prose for its required end-to-end/release/human evidence.

## 7. Approval gate

**HUMAN GATE:** fill `Approved-by`, date, and target branch at the top. Until then, the permitted work is
read-only research and planning documents only. Do not run implementation agents from the master prompt.
