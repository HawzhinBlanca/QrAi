# Data & PII inventory (F16 input packet)

> **Purpose.** A factual map of the personal data the system collects, where it lives, how long it is
> kept, and how it is erased — the input a lawyer / DPO needs to write the privacy policy, the COPPA
> assessment, the data-retention policy, and the pilot-tenant DPA (§F16). **This is documentation of
> the system as built, not legal advice.** It is derived from the code cited inline; verify against the
> code before relying on it, and update it when the data flows change.

## 1. Personal data collected

| Data | Where | Notes |
|------|-------|-------|
| **Learner audio** (recitation recordings) | ml-inference `AUDIO_STORAGE_DIR` (raw blobs) + streamed via the realtime gateway | The most sensitive item — a minor's voice. Retention is consent-driven (see §3). |
| **Recognised text / word alignments** | Postgres `word_alignments` (`heard_text`) | What the learner said, per word. |
| **Account** | Postgres `users` — `id`, `tenant_id`, `display_name`, optional `email`, `password_hash` (bcrypt cost 12), `role`, `language` | Passwords are only ever stored hashed. |
| **Consent record** | Postgres `recitation_sessions.consent_snapshot` (`ConsentSnapshot` in `packages/contracts`) | `audioRetention`, `anonymizedLearning`, `externalAsrProcessing`, `guardianApproved`, `recordingConsent`, `consentVersion`. |
| **Learning progress** | Postgres `learner_progress` (SM-2 spaced-repetition state) | Per-learner mastery/scheduling. |
| **Tajweed findings** | Postgres `tajweed_findings` | Assessment of the learner's recitation. |
| **Audit events** | Postgres `audit_events` | Actor id + action for accountability. |
| **Agent-run records** | Postgres `agent_runs` (`goal`, `trace` — free text/JSON) | The Practice Plan Recommender agent embeds the learner's id directly in the free-text `goal` column (e.g. "Recommend the next practice step for learner-1."). **As of this writing, `agent_runs` has no dedicated learner-id column and is NOT covered by the `/v1/privacy/delete` erasure cascade in §4** — a learner's id persists here after an erasure request. A fix (adds a structured `agent_runs.learner_id` column and includes it in the delete cascade) is in review; update this row once it merges. |

## 2. Who can access it (isolation)

- **Tenant isolation is enforced at the database** by Postgres RLS: every tenant-scoped query runs inside
  `begin_tenant_tx` (`SET LOCAL app.tenant_id`), and production runs as the restricted `quran_ai_app`
  role (`nosuperuser`, `nobypassrls`) so the policies actually bite. One institution cannot read another's.
- **Service keys stay server-side.** The browser/mobile client never talks to ML/ASR directly; the
  platform-api proxies them with `ML_API_KEY` / `ASR_API_KEY`, and JWT/header-auth gates every route.

## 3. Retention

- **Audio** is deleted on a TTL keyed to the learner's consent (`services/ml-inference/server.mjs`):
  `audioRetention: "discard"` → **1 hour** (default), `"teacher-review"` → **7 days** (default). Both are
  env-configurable (`AUDIO_RETENTION_DISCARD_TTL_HOURS`, `AUDIO_RETENTION_REVIEW_TTL_HOURS`). A periodic
  cleanup enforces it.
- **DB records** persist until account/data deletion (see §4). *A retention policy for the DB rows
  (progress, findings, audit) is a policy decision for the lawyer — the code does not auto-expire them.*

## 4. Data-subject rights (already implemented)

- **Erasure:** `POST /v1/privacy/delete` runs a single tenant-scoped transaction that cascades
  teacher_reviews → tajweed_findings → word_alignments → audio_chunks/alignment_runs → tickets →
  sessions → consent_records, **and** calls ml-inference `/v1/privacy/delete` to erase the raw audio
  blobs first (`erase_ml_audio`, `services/platform-api/src/handlers/privacy.rs`). An ML failure aborts
  with the DB untouched — no "success while audio survives". **Gap, as of this writing:** the cascade
  does not yet reach `agent_runs` — see the note on that row in §1.
- **Access/portability:** a privacy **export** endpoint returns the subject's data.

## 5. Children's data (COPPA / age) — decisions the lawyer must make

- The consent model carries **`guardianApproved`**, and **external ASR processing is code-gated on it**:
  `canUseExternalAsr = externalAsrProcessing && guardianApproved` (`packages/contracts`). Today ASR is
  **self-hosted** (no third-party processor), so no learner audio leaves the deployment by default.
- **`recordingConsent`** must be affirmatively true before the mic path records (enforced on web + mobile).
- Open questions for §F16: (a) the **minimum age** + how guardian consent is **verified** (the flag exists;
  the verification workflow is a policy decision); (b) the **DB-row retention** period; (c) the **DPA**
  terms with the pilot tenant (`hikmah-pilot-erbil`); (d) whether the reference-audio CDN
  (`cdn.islamic.network`, used only to play canonical recitations — **no learner data is sent to it**)
  needs disclosure.

## 6. Third parties

- **None process learner data by default.** ASR/tajweed inference is self-hosted. `cdn.islamic.network`
  serves *reference* recitation audio to the browser (outbound fetch of public Qur'an audio); no personal
  data is transmitted to it. If a hosted ASR is ever enabled, it becomes a processor and must be added
  here + gated on `externalAsrProcessing && guardianApproved` (already wired).

---

**Sign-off.** The lawyer/DPO uses this to author the privacy policy, COPPA assessment, retention policy,
and DPA, and records the decisions (age threshold, DB retention, guardian-verification method) as an ADR
in `docs/DECISIONS.md`. That ADR + the published documents are what clear §F16.
