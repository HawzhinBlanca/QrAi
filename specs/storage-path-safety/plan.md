# Storage Path Safety Plan

Approved-by: user directive, "do all and continue"

1. Extend privacy smoke first.
   - POST a retained audio chunk with a traversal-like learner ID.
   - Assert the ML service returns HTTP 400.

2. Harden storage path handling.
   - Add a safe segment validator for filesystem-backed storage IDs.
   - Apply it to tenant, learner, and chunk segments before path joins.
   - Keep valid hyphenated smoke IDs working.

3. Document the boundary.
   - Add the storage ID constraint to the ML inference README.

4. Verify and commit.
   - `pnpm smoke:privacy`
   - `bash scripts/verify.sh`
