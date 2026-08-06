-- `tajweed-v0.1` claimed it had passed evaluation. Nothing had evaluated it.
--
-- `0006_seed_internal.sql` seeds two model versions with `status = 'eval-passed'`:
--
--     ('model-v0.3',   'alignment', '0.3', 'eval-passed')
--     ('tajweed-v0.1', 'tajweed',   '0.1', 'eval-passed')
--
-- and seeds an `eval_runs` row for the first one only. Measured before this migration:
--
--     model-v0.3    eval-passed   0.93 / 0.86 / 0.05 / 0.92 / 0 / passed   <- clears the gate
--     tajweed-v0.1  eval-passed   NO EVAL RUN AT ALL
--
-- `modelEvalPassesReleaseGate` (packages/contracts) encodes the bar that status asserts —
-- wordAlignmentF1 >= 0.9, tajweedF1 >= 0.82, falsePositiveRate <= 0.08, teacherAgreementRate >= 0.9,
-- zero unsourced learner outputs, and `passed`. It had exactly one reference in the repository
-- outside its own unit test: its own definition. A release gate no release ran, next to a claim
-- nothing checked.
--
-- `model_versions.status` is read by no service. That is precisely why a false value matters here:
-- evidence nothing acts on is evidence nobody re-derives, and it is read years later as fact. A
-- model asserting it met a bar nobody measured is a fabricated evaluation.
--
-- `draft` is the honest status for a model with no evaluation. This does not block anything — no
-- code branches on the value — it stops the database asserting something untrue.
--
-- NOT an edit to 0006. Migrations are append-only, and rewriting a seed would leave every database
-- that already applied it still carrying the claim. This corrects both: a fresh database gets
-- 'eval-passed' from 0006 and then this, and an existing one gets this.
--
-- WHEN tajweed-v0.1 IS GENUINELY EVALUATED (P3.4/P3.5 — protocol, held-out set, representative
-- slices, scholar sign-off), insert its eval_runs row and set the status back. The gate
-- `scripts/check-model-eval-claims.mjs` will then pass on its own terms rather than because the
-- claim was quietly lowered.
update model_versions
   set status = 'draft'
 where id = 'tajweed-v0.1'
   and status = 'eval-passed'
   and not exists (
     select 1 from eval_runs where model_version_id = model_versions.id
   );
