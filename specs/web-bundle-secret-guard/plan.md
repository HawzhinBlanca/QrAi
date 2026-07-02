# Web Bundle Secret Guard Plan

Approved-by: user directive, "do all and continue"

1. Add the bundle scanner first.
   - Scan built web assets for known dev credential/weak-secret literals.
   - Wire it into `scripts/verify.sh` after build.
   - Confirm it fails against the current production bundle.

2. Remove the dev auto-login bypass.
   - Delete the hardcoded dev account and silent auto-login path from `AuthProvider`.
   - Keep stored-session login and explicit login/register behavior.

3. Refresh docs.
   - Update the web README to state login-enabled runs use the real auth flow.

4. Verify and commit.
   - `pnpm --filter @quran-ai/web build`
   - `node scripts/check-web-bundle-secrets.mjs`
   - `bash scripts/verify.sh`
