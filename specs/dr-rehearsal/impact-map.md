# Impact Map — deploy, rollback, and restore rehearsal

Companion to `plan.md` (AGENTS.md step 2). Measured at main `0e49078`.

Unusually for this repo, **this phase touches almost no application code.** It adds ops scripts, one
architectural change to the deploy model, and documentation. That is why the blast radius is small
while the ledger value is high — and also why the one architectural change (T4) needs an ADR.

---

## 1. New files

| Path | Task | Callers |
|---|---|---|
| `scripts/restore-db.sh` | T1 | none yet — invoked by hand and by the T1 drill. Counterpart to `scripts/backup-db.sh` |
| `scripts/backup-audio.sh` (+ restore path) | T2 | none yet |
| `specs/dr-rehearsal/evidence/*.log` | T1–T4 | committed drill output, referenced by the runbook |

No new runtime dependency. `pg_dump`/`pg_restore` are already required by `backup-db.sh` and by
`verify.sh`'s DB-gated path.

---

## 2. Modified symbols and files

### `docker-compose.yml` — T4, the only architectural change

Currently: 5 app services use `build:`; `postgres` uses `image: postgres:16-alpine`; volumes
`postgres_data`, `audio_storage`.

T4 adds an image/tag strategy. **Everything that consumes compose is affected:**

| Consumer | Why it matters |
|---|---|
| `docs/STAGING_RUNBOOK.md` | Every documented `docker compose` command; the runbook is edited in T5 anyway |
| `scripts/smoke-all.mjs` and the `smoke-*.mjs` family | Drive the compose stack; must still work against tagged images |
| `.github/workflows/ci.yml` | If images are built in CI, this grows a build step — and CI currently produces no image at all |
| `monitoring/docker-compose.monitoring.yml` | Overlay composed with the base file; `depends_on: platform-api` must still resolve |

**Requires an ADR** (AGENTS.md: architectural change). This is the reason T4 is not a quick fix.

### `scripts/release-manifest.mjs` — T4, satisfying an existing expectation

`assertImageDigests()` at `:179`, enforced at `:241-243`; `release-challenge.mjs:248` passes
`RELEASE_IMAGE_DIGESTS_JSON`. **Not modified** — T4 makes the deploy path *produce* what this already
demands. Verify against `release-manifest.test.mjs` and `release-build-evidence.test.mjs`
(which already fixture `imageDigests`) rather than editing the verifier to match reality.

### `docs/BACKUP_RESTORE.md` — T1, T2

Restore prose is replaced by a reference to the tested script, and gains the erasure-re-application
step (research.md §8.4).

### `docs/STAGING_RUNBOOK.md` — T5

Gains take-down / rollback / restore / bring-up sections. `monitoring/alerts.yml` already points
`PlatformApiDown` here for "kill-switch + rollback", so this closes a dangling reference rather than
adding a new one.

### `scripts/verify.sh` — T1, T2

New tests must be gated or they rot. Guarded file — needs the `.codystem-allow-self-edit` sentinel at
the CODYSTEM root.

---

## 3. Application code: unchanged

| Symbol | Note |
|---|---|
| `maintenance_guard` / `AppState::maintenance_mode` (`platform-api/src/lib.rs:45`, layer at `:344`) | **Not modified.** T3 exercises existing behaviour through the real stack |
| `maintenance_mode_503s_normal_routes_but_keeps_health_live` (integration.rs) | **Not modified.** T3 complements it at the stack level |
| Privacy/erasure handlers (`privacy.rs`) | **Not modified.** T2 *invokes* existing erasure, it does not reimplement it |
| RLS policies, `begin_tenant_tx` | Untouched. A restored database keeps them — they are DB-side |

---

## 4. Data safety — the highest risk in this phase

Unlike Phase 3, this phase **runs destructive operations** (drop, restore, volume delete). Controls:

1. **Isolated infrastructure only** — separate container name and port, as in MIG1. The running
   `quran-ai-staging` stack is not touched.
2. **`restore-db.sh` refuses a non-empty target without `--force`** — the guard that stops a drill
   from overwriting real data.
3. **No drill script may default to `DATABASE_URL`.** `verify.sh:28` defaults it to a real local
   database; a drill inheriting that default could drop a developer's data. Drill scripts must
   require an explicit target and fail closed with no default.

That third point is a concrete hazard created by this phase and does not exist elsewhere in the repo.

---

## 5. Tests per task

| Task | New | Must stay green |
|---|---|---|
| T1 | `t-p4t1-restore` (guard refuses; row-count check fails on deliberate truncation) | `smoke-database.test.mjs`, DB-gated integration suite |
| T2 | `t-p4t2-audio` (erasure re-application is mandatory, not optional) | privacy integration tests |
| T3 | drill log; no new unit test (behaviour already unit-tested) | `maintenance_mode_*` integration test |
| T4 | `release-manifest.test.mjs` + `release-build-evidence.test.mjs` **unchanged and passing** | full smoke family |
| T5 | none (documentation) | — |

---

## 6. What could break that these tests would not catch

- **A drill that passes on isolated infra but not on real infrastructure.** Isolated Postgres has no
  network latency, no concurrent load, no volume-size realism. A restore of a 6,236-ayah corpus is not
  a restore of a year of pilot audio. **The measured RTO is a floor, not a prediction** — this must be
  stated in the evidence log, or the number will be over-read.
- **Tag drift after T4:** a tag pointing at a rebuilt image with different content. Digest pinning,
  not tag pinning, is what actually prevents this — hence wiring `imageDigests`.
- **Backups still unencrypted** (P5.6 says encrypted). Named in plan.md §5, deliberately not closed.
