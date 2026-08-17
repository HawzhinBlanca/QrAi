-- `model-v0.3` claims it passed evaluation. Its evaluation measured nothing.
--
-- 0027 downgraded `tajweed-v0.1` for having no `eval_runs` row at all, and DELIBERATELY LEFT THIS
-- ONE ALONE, on the stated grounds that it "clears the gate". It does clear the gate. It clears it
-- because somebody typed the numbers into a seed file:
--
--     -- 0006_seed_internal.sql
--     ('eval-v0.3', 'hikmah-pilot-erbil', 'model-v0.3', 'fatihah-juz-amma-smoke-v1', '{}',
--      0.93, 0.86, 0.05, 0.92, 0, true)
--
-- Three things are wrong with that row as evidence:
--
--   metrics = '{}'      A real evaluation records what it measured. This records nothing. And every
--                       scalar column carries a DEFAULT (`word_alignment_f1 numeric not null
--                       default 0`, and so on), so a hand-typed row can clear
--                       `modelEvalPassesReleaseGate` while saying nothing about what was run.
--   dataset_version     'fatihah-juz-amma-smoke-v1' is a SMOKE FIXTURE. Al-Fatihah plus part of
--                       Juz Amma is what the smoke suite recites; it is not a held-out corpus, it
--                       has no representative slices, and no protocol predeclared it (that is P3.4).
--   the six scalars     Constants in a seed file, not outputs of a run.
--
-- `docker-compose.yml:30` mounts 0006 into every fresh database, so every deployment of this
-- project has started life asserting that its alignment model passed an evaluation that never
-- happened.
--
-- This is 0027's rule applied one level down. 0027 said: a claim with no evidence is a fabricated
-- evaluation. This says: a claim whose evidence measured nothing is the same fabrication with an
-- extra row in front of it.
--
-- `draft` is the honest status. Nothing branches on the value — `model_versions.status` is read by
-- no service — which is exactly why a false one matters: evidence nothing acts on is evidence
-- nobody re-derives, and it is read years later as fact.
--
-- The eval_runs row is KEPT. It is a true record of a smoke run; what was wrong was the status
-- claiming it was an evaluation. Deleting it would destroy history to make a number look better,
-- which is the same class of act this migration exists to undo.
--
-- NOT an edit to 0006. Migrations are append-only, and rewriting a seed would leave every database
-- that already applied it still carrying the claim.
--
-- WHEN model-v0.3 IS GENUINELY EVALUATED (P3.4/P3.5 — protocol, held-out set, representative
-- slices, predeclared metrics, scholar sign-off), insert its real eval_runs row with populated
-- `metrics` and set the status back. `scripts/check-model-eval-claims.mjs` now refuses an
-- empty-metrics run, so the claim will have to rest on a measurement rather than on six constants.
update model_versions
   set status = 'draft'
 where id = 'model-v0.3'
   and status = 'eval-passed'
   and not exists (
     select 1
       from eval_runs
      where model_version_id = model_versions.id
        and metrics is not null
        and metrics <> '{}'::jsonb
   );
