# Web Speech Consent Plan

1. Add a small consent helper.
   - Return true only when external ASR processing and guardian approval are both enabled.
   - Cover the helper with unit tests.

2. Restore the external-ASR processing consent control.
   - Keep privacy-preserving defaults.
   - Explain that this applies to browser/cloud speech fallback when local Quran ASR is unavailable.

3. Gate the Web Speech fallback.
   - Keep `startServerAsr` first so local Quran ASR remains the default.
   - If Web Speech is available but consent is missing, show a privacy-safe notice and continue to local recording fallback.

4. Verify.
   - `pnpm --filter @quran-ai/web test`
   - `bash scripts/verify.sh`
   - Commit only after the gate passes.
