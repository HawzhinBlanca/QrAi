# Review Status Contract Plan

1. Extend shared contracts and tests.
   - Add `teacher-review-required` to `ReviewStatus`.
   - Prove learner-facing gates block it.

2. Extend mirrors.
   - Add `TeacherReviewRequired` to Rust `ReviewStatus`.
   - Add it to the recitation row parser.
   - Block it in the agents gate mirror.

3. Extend SQL proof.
   - Add a follow-up migration widening the review-status check constraint.
   - Include the constraint migration in Docker compose initialization.
   - Include the constraint migration in live SQL smoke setup.

4. Verify and commit.
   - `pnpm --filter @quran-ai/contracts test`
   - `pnpm --filter @quran-ai/web test`
   - `pnpm smoke:sql`
   - `bash scripts/verify.sh`
