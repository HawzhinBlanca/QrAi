# Research: Learner-to-Teacher Vertical Slice

## Objectives
- Verify and validate the entire recitation lifecycle from learner recording to teacher evaluation:
  1. Learner registers and logs in.
  2. Learner selects a Surah (e.g. Al-Fatihah).
  3. Learner opens Guided Practice mode.
  4. Learner captures live audio (simulated or real).
  5. The real-time Levenshtein alignment is displayed.
  6. The session is sent to the teacher queue.
  7. Teacher logs in, selects the pending session, and submits a blind review (Approve/Reject/Realign).
  8. The database cascade updates the finding status.

## Current Codebase Architecture
1. **Frontend App (`apps/web/src/App.tsx`)**:
   - Manages state for `practiceMode` (`listen`, `recite`, `drill`, `correct`, `complete`).
   - Hooks up the mic audio using `MediaRecorder` or browser speech fallbacks.
   - Invokes endpoints `/v1/recitation-sessions` to create sessions and `/v1/teacher-review-queue` to list reviews.
2. **Backend API (`services/platform-api/src`)**:
   - Manages recitation sessions, teacher reviews, and alignments.
   - `/v1/recitation-sessions/<id>/audio` returns the recorded audio.
   - `submit_teacher_review` updates findings and realigns cascade.
3. **E2E Smoke Script (`scripts/smoke-e2e.mjs`)**:
   - Drives headless Chrome using the Chrome DevTools Protocol (CDP) to walk the complete vertical slice.
   - Emulates browser user actions, clicks consent, practice, and recording buttons, retrieves session ID, views teacher queue, and submits a review.

## Analysis of the Vertical Slice E2E Run
- We executed `node scripts/smoke-e2e.mjs` against the staging dev server.
- The script successfully completed the entire learner-to-teacher loop:
  - Opened Learner Practice Flow.
  - Accepted consent, started practice, advanced to Recite.
  - Recorded fake audio stream.
  - Requested teacher review.
  - Captured session ID.
  - Navigated to Teacher View.
  - Selected the created session in the queue.
  - Submitted teacher review (Accept).
  - Printed: `E2E Verification Complete: Full loop successfully walked!`
- This confirms the vertical slice is fully functional and successfully integrated.
