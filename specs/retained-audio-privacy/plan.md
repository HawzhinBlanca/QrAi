# Retained Audio Privacy Plan

Approved-by: user directive, "do all and continue"

1. Extend privacy smoke first.
   - Store a retained audio chunk for a smoke learner using `/v1/audio-chunks`.
   - Export privacy data and assert audio plus metadata objects are visible.
   - Delete privacy data and assert audio plus metadata objects are reported as deleted.
   - Export again and assert no audio or metadata objects remain.

2. Harden ML local object deletion.
   - List audio object keys and metadata object keys separately.
   - Delete both object classes for the learner.
   - Return deleted metadata keys in the delete job response.

3. Refresh proof docs.
   - Tighten the checklist wording so the local proof specifically covers retained audio and metadata sidecar deletion.

4. Verify and commit.
   - `pnpm smoke:privacy`
   - `bash scripts/verify.sh`
