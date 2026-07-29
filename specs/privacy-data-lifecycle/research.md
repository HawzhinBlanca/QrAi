# Research: Consent, Retention, Export, and Deletion Lifecycle

## Objectives
- Map out the exact data-lifecycle E2E behavior of the platform for different audio retention modes.
- Define the behavior for:
  - `discard`: Audio chunks are deleted immediately after processing/transcribing; no audio blobs remain.
  - `teacher-review`: Audio chunks are kept for review; deleted only when privacy delete is explicitly requested.
  - `training-opt-in`: Audio chunks are kept for ML training; deleted only when privacy delete is explicitly requested.
- Ensure that for each mode:
  - Before/after database rows are correctly populated and erased.
  - Audit events are emitted.
  - Export manifests contain the exact list of records.
  - Deletion receipts match the erased records.

## Data Schema & Relationships
When a learner recites:
1. `recitation_sessions` and `consent_records` are created.
2. `audio_chunks` are created and uploaded to the ML service.
3. `word_alignments` and `tajweed_findings` are generated.
4. If a teacher reviews it, a `teacher_reviews` record is created.

When a learner triggers a Delete job:
- Platform API calls the ML service to delete the raw audio files (`deleteAudioObjects`).
- Platform API Cascade-deletes:
  - `teacher_reviews`
  - `tajweed_findings`
  - `word_alignments`
  - `audio_chunks`
  - `alignment_runs`
  - `realtime_session_tickets`
  - `recitation_sessions`
  - `consent_records`
  - `learner_progress`

## Proposed Test Script (`scripts/privacy-audit-run.mjs`)
We will create a script that runs on the host using the staging environment:
1. Registers two distinct learners for Tenant A with different consent modes.
2. Simulates recitation session creations and audio chunks.
3. Performs a privacy export for each learner and checks the manifest.
4. Performs a privacy delete for each learner and checks the receipt.
5. Queries the staging database and object-storage (ML service) to verify that all rows and files were successfully deleted/retained as expected.
6. Writes the report directly to the Antigravity artifact directory.
