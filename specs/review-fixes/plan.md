# Review Fixes Plan

1. Wire authentication through web API helpers.
   - Add optional bearer-token support to learner and console API calls.
   - Pass the effective user token from `App.tsx` and `PlatformCommand`.
   - Keep explicit header fallback for no-login preview/dev only.

2. Gate server-side ASR by consent.
   - Add a visible `externalAsrProcessing` consent control.
   - Use server ASR only when external ASR consent and guardian approval are both true.
   - Keep recording/playback local when consent is not sufficient.

3. Repair database migrations and bootstrap.
   - Add `consent_snapshot` to recitation sessions.
   - Add learner-progress RLS in a migration that runs after the table exists.
   - Make internal seed data self-contained enough for a fresh DB.
   - Mount new migrations in compose and make dev scripts set explicit dev auth flags.

4. Update SQL smoke coverage.
   - Include later migration files in static/live RLS checks.
   - Add `learner_progress` to tenant table coverage and live proof data.

5. Clean whitespace and verify.
   - Fix `git diff --check` failures.
   - Run focused typecheck/tests and the canonical verify script where feasible.

