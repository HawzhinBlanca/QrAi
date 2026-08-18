# Merging PR #388 (`codex/lean-flutter-node-consolidation`) into `main`

**Written:** 2026-08-17, from a real trial merge of `origin/main` into a copy of
`codex/lean-flutter-node-consolidation` at `aee5927`. Every claim below was produced by running the
merge and reading both sides, not by inspecting the diff stat.

> **Status: the merge is NOT done.** Eight of twelve conflicts were analysed to a resolution I am
> confident in and two were carried out in code; four enforcement-critical files were left
> untouched. `verify.sh` was never run against a merged tree, so **nothing here is evidence that the
> merge works** — it is a map for whoever does it.
>
> PR #388's branch was not modified, rebased, force-pushed or commented on.

---

## 0. Read this first — the trap

Merging these two branches cleanly produces **code that violates a database constraint at runtime**,
and neither branch is wrong on its own.

| | |
|---|---|
| `main`'s `0028_tajweed_fixture_basis.sql` | sets the CHECK to `('canonical-text', 'acoustic', 'fixture')` |
| #388's `0030_tajweed_instruction_performance_boundary.sql` | recreates it as `('text-rule', 'acoustic')` |

`0030` sorts **after** `0028`, so in a merged tree the `'fixture'` value is added and then silently
removed. The ported code in §2 writes `analysis_basis = 'fixture'`, so the tajweed persist path
raises a constraint violation — and only when findings are actually stored, not at boot, not in any
test that does not write a fixture-derived finding.

This is invisible in both branches separately. It appears only in the merge. **Resolve it as §3
describes before running anything.**

---

## 1. What the merge actually looks like

```
git checkout -b integration/lean-consolidation-on-main <pr388-head>
git merge origin/main
```

Twelve conflicts. #388 was 13 commits behind `main` when this was written; that number is the cost
driver, and every subsequent merge to `main` raises it.

A **merge** is recommended over a literal rebase: #388 carries 115 commits, so a rebase replays the
same conflicts repeatedly for an identical final tree.

Auto-merged without incident, worth knowing because they are load-bearing:
`scripts/release-manifest.mjs`, `scripts/release-manifest.test.mjs` (the freshness bounds from #452
survive alongside #388's `DEPLOYABLE_IMAGE_KEYS` refactor), `services/platform-api/src/main.rs`,
`specs/readiness-recovery-10-10/tasks.md`.

---

## 2. The two `modify/delete` conflicts — DONE, and the reason they matter

```
DU services/ml-inference/server.mjs
DU services/node-api/routes/ml-proxy.mjs
```

Both are deleted by #388 (it retires `ml-inference` and `node-api` into `server/`) and both were
modified on `main` by **#440 — "fixture-derived findings were stored as real analysis" (P3.2)**.
#388 predates #440, so its `server/` tree does not contain the fix. **Accepting the deletions
without porting silently drops a shipped defect fix**, and the symptom is that fixture output is
stored as ordinary analysis of a child's recitation, permanently — unsetting the flag does not
un-write the rows.

#388 does have a related mitigation — a boot guard requiring `ML_ACKNOWLEDGE_FIXTURE_OUTPUT=1` when
`ML_USE_GOLDEN_FIXTURES=1`. **It is not a substitute.** That guard refuses to start; #440 labels the
payload so a stored row stays distinguishable afterwards. Keep both.

### 2.1 `server/src/inference/runtime.mjs`

Add to **both** return payloads — the alignment response (the one carrying `sourceChecksum`) and the
tajweed response (the one carrying `annotations`), each immediately after `fixtureCaseId`:

```js
provenance: fixtureCase && USE_GOLDEN_FIXTURES ? "fixture" : "computed",
```

`fixtureCaseId` looks like it already says this and does not: it is set whenever the requested
passage *matches* a golden case, which is true on the real path too. Measured on `main` against the
running service, both modes returned `fixtureCaseId: "fatihah-1-1-7-smoke"` and an identical set of
top-level keys, while one held 29 alignments derived from what the learner produced and the other
held 8 `matched` words with `heardText === canonicalText`.

### 2.2 `server/src/routes/ml-proxy.mjs`

In `persistTajweedFindingsInTransaction`, after `const findings = ...`:

```js
const analysisBasis = result?.provenance === "fixture" ? "fixture" : "acoustic";
```

and in the `INSERT INTO tajweed_findings` VALUES list, replace the `'acoustic'` literal with
`${analysisBasis}`.

**Downgrade-only, deliberately** — the only value an upstream can select is the weaker `'fixture'`
claim. `'acoustic'` stays a value nothing external can ask for, so a compromised or misconfigured
inference service can label its output as less trustworthy but never as more. This mirrors the rule
`main` applies in `ml_proxy.rs`; note #388 persists `'acoustic'` where `main` persisted
`'canonical-text'`, so the fallback differs from `main`'s by design.

---

## 3. Migrations — renumber, do not drop in

#388's migrations run to **0038** and live in `infra/migrations/` (renamed from `infra/sql/`), under
a manifest with per-file sha256. Git reports both of `main`'s as `UA` at the new path; neither may be
kept as-is.

| `main` file | disposition |
|---|---|
| `0028_tajweed_fixture_basis.sql` | **rewrite as `0039`.** Adding `'fixture'` at id 0028 is undone by #388's `0030` (§0). The new migration must set the CHECK to the post-0030 set — `('text-rule', 'acoustic', 'fixture')` — because `0030` reclassifies `canonical-text` → `text-rule` and `'canonical-text'` must NOT be reintroduced. |
| `0029_unevidenced_alignment_claim.sql` | **superseded — drop.** #388's `0032_demote_untrusted_model_claims.sql` downgrades *every* `eval-passed`/`released` model version to `draft`; `main`'s 0029 downgraded `model-v0.3` alone. The broader statement subsumes it. Confirm `scripts/check-model-eval-claims.mjs` still passes after the merge (§4) rather than assuming it. |

Both actions require a `manifest.json` entry with the file's sha256 — `server/scripts/migrate.mjs`
enforces **exact set equality between manifest and disk in both directions** plus a per-file
checksum, and refuses to run otherwise. Adding a `.sql` without a manifest entry fails the migration
step, which is the correct behaviour and worth knowing before it surprises you.

---

## 4. The four left untouched

These are the enforcement surface. They were deliberately not resolved: rushing them is how a gate
gets weakened without anybody noticing, which is the failure this repository is built to prevent.

| file | what to watch for |
|---|---|
| `scripts/verify.sh` | #388 rewrites the test lists. Three suites present on `main` are absent from #388's copy — `boot-refuses-header-auth` (#446), `release-bundle` (#451), `update-ledger.test` (#450). **All three are staleness, not deletion**: they are absent at the merge-base too. The merged file must run them. |
| `.github/workflows/ci.yml` | #388 removes the `Assert no missing SQL migrations in CI list` step and the hardcoded apply-list, replacing both with `server/scripts/migrate.mjs`. **Verified: strictly stronger** — set equality both ways plus checksums plus strictly-increasing ids, where the old check compared lists only. Take #388's side. |
| `services/platform-api/src/handlers/ml_proxy.rs` | `main` side carries #440's downgrade-only `analysis_basis`. Preserve it, and keep it consistent with §2.2. |
| `scripts/check-model-eval-claims.mjs`, `scripts/release-images.mjs`, `scripts/update-ledger.sh`, `apps/web/src/lib/api.ts`, `apps/web/src/components/TopBar.tsx` | ordinary content conflicts; `update-ledger.sh` must retain the three refusals from #450, and `release-images.mjs` the `digestMap` contract from #445. |

`tests/contract/node-api-frozen.test.mjs` disappears from the merged tree. **That is correct** —
#388 deletes `services/node-api` outright (24 files, 4,956 lines), and a freeze guard on a deleted
tree has no subject. This is ADR-0044 completing, not a guard being dropped.

---

## 5. Order of operations

1. Branch from #388's head; merge `origin/main` (do not force-push #388).
2. Apply §2 — port #440 into `server/` **before** resolving the deletions.
3. Apply §3 — write `0039`, drop `0029`, update `manifest.json` with checksums.
4. Resolve §4, keeping every guard on the stronger side.
5. `node server/scripts/migrate.mjs` against a throwaway database — this is where the §0 trap
   surfaces if step 3 was wrong.
6. Write a finding with `analysis_basis = 'fixture'` and confirm it stores. A migration that applies
   proves the constraint exists, not that the value is permitted.
7. `bash scripts/verify.sh` green, then required CI green. Neither has ever run on a merged tree.

---

## 6. What is not established

- No merged tree has passed `verify.sh`, or run at all.
- §2's ported code was written and diffed but **never executed**.
- The four files in §4 have no proposed resolution, only hazards to check.
- Whether #388's `server/` reaches parity on the routes `main`'s contract carries is **out of scope
  here** and unverified by this document.

---

## 7. Addendum — #388 cannot pass its own gate on its own head

Added 2026-08-18, after a session attempted this merge end to end. It resolved all twelve conflicts,
fixed three merge-caused defects and closed the §0 trap, then stopped: **the merged tree cannot go
green by merging well, because #388's own gate does not pass on #388's own head.** That work was
never pushed and is presumed lost with its container; this section is what survived it.

### 7.1 VERIFIED — #388's `verify.sh` names files that do not exist in #388's tree

Re-checked here against `codex/lean-flutter-node-consolidation` @ `aee5927`, independently of the
session that first reported it. Of the 208 script/test paths its `verify.sh` references:

```
MISSING  scripts/migrate.mjs                     (#388 has it at server/scripts/migrate.mjs)
MISSING  scripts/provision-role.mjs              (#388 has it at server/scripts/provision-role.mjs)
MISSING  services/node-api/routes/ml-proxy.mjs   (#388 deletes services/node-api entirely)
```

and three suites it runs import a module #388 deleted:

```
tests/node-api/superuser-role.test.mjs          -> services/node-api/lib/db.mjs
tests/security/definer-bypass-coverage.test.mjs -> services/node-api/lib/db.mjs
tests/security/rls-policy-coverage.test.mjs     -> services/node-api/lib/db.mjs
```

Six concrete instances, and that is a **floor**: the scan only follows relative `../` imports of
`services/` and `scripts/` paths from files `verify.sh` names directly. Transitive imports and
non-matching path shapes are not covered.

These three test names are exactly the ones the earlier session listed independently, which is why
this is recorded as verified rather than as a lead.

**What it means.** PR #388's body states *"Canonical gate: `bash scripts/verify.sh` — passed locally
with live PostgreSQL."* That claim is not reproducible on the branch as it stands. The gate cannot
have run these suites successfully, because the files they need are not there. This is not an
argument against the work in #388 — it is a statement that its self-reported green must be
re-established before the merge can be judged on its own merits, and that **merging correctly is not
sufficient to reach a green tree.**

The mechanical half is unambiguous: these are moved files, and a test pointing at a moved file has
exactly one correct new target (`server/src/lib/db.mjs`, `server/scripts/*`). Retargeting them is
safe. It is the rest of §7.2 that is not.

### 7.2 REPORTED — six further defects and two product decisions

From the same session's final summary, **not independently verified here**. Treat as leads:

- **six further defects** in the merged tree, unenumerated in anything that outlived the container.
- **two product decisions** it would not take alone, correctly:
  - ship without the **tajweed registry**, or rework scope?
  - ship without **Flutter CI coverage**, or rework scope?
- two **security declarations** it was explicitly instructed NOT to write, because they are #388's
  design and its author's to declare: `token-revocability` and `erasure-coverage` for
  `device_sessions` and `device_enrollment_invitations`. An agent authoring text asserting how token
  columns are checked, in order to turn a gate green, is evidence written to satisfy a check rather
  than to describe a system. Whoever finishes this merge should decline it too.

### 7.3 Consequence for sequencing

The plan above assumed the merge was the work and a green gate the outcome. That is wrong. Order is:

1. **#388's author repairs #388's own gate** on its own branch — the six references in §7.1, plus
   whatever else `verify.sh` cannot currently run — and re-establishes the green it claims.
2. Only then does the merge in §1-§5 become judgeable, because only then does a red result mean
   something the merge caused.

Attempting them in the other order means every failure is ambiguous: nobody can tell whether the
merge broke it or whether it was already broken. That ambiguity cost one full session.
