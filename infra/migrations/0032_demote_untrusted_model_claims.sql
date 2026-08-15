-- No production release signer is currently approved, so no historical model version can honestly
-- claim `eval-passed` or `released`. The old model-v0.3 aggregate row predates the signed row-level
-- evidence authority and is explicitly classified as a fixture by 0031.
--
-- This is additive rather than an edit to 0006: existing databases must lose the unsupported claim
-- too. A future promotion is an explicit release operation performed only after the checker verifies
-- one unique release-candidate bundle against the operator's production trust policy.

update model_versions
   set status = 'draft'
 where status in ('eval-passed', 'released');
