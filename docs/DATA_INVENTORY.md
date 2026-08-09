# Data & PII inventory (F16 input packet)

> **Purpose.** A factual map of the personal data the system collects, where it lives, how long it is
> kept, and how it is erased — the input a lawyer / DPO needs to write the privacy policy, the COPPA
> assessment, the data-retention policy, and the pilot-tenant DPA (§F16). **This is documentation of
> the system as built, not legal advice.** It is derived from the code cited inline; verify against the
> code before relying on it, and update it when the data flows change.

## 1. Personal data collected

| Data | Where | Notes |
|------|-------|-------|
| **Learner audio** (recitation recordings) | Private S3-compatible object storage in production; the shared filesystem adapter is development/test only. Keys are server-derived as `audio/v1/<tenant>/<learner>/<session>/<chunk>.pcm`. | The most sensitive item — a minor's voice. Retention is consent-driven (see §3); metadata and SHA-256 integrity travel with each object. |
| **Recognised text / word alignments** | Postgres `word_alignments` (`heard_text`) | What the learner said, per word. |
| **Account** | Postgres `users` — `id`, `tenant_id`, `display_name`, optional `email`, `password_hash` (bcrypt cost 12), `role`, `language` | Passwords are only ever stored hashed. |
| **Consent record** | Postgres `recitation_sessions.consent_snapshot` (`ConsentSnapshot` in `packages/contracts`) | `audioRetention`, `anonymizedLearning`, `externalAsrProcessing`, `guardianApproved`, `recordingConsent`, `consentVersion`. |
| **Learning progress** | Postgres `learner_progress` (SM-2 spaced-repetition state) | Per-learner mastery/scheduling. |
| **Tajweed findings** | Postgres `tajweed_findings` | Assessment of the learner's recitation. |
| **Audit events** | Postgres `audit_events` | Actor id + action for accountability. |
| **Agent-run records** | Postgres `agent_runs` (`goal`, `trace`, and nullable structured `learner_id`) | The agent-run API accepts and persists `learner_id` for learner-specific runs; privacy export/delete enumerates and removes these rows by tenant + learner key. Cohort-level runs may omit the key. The service deliberately does not infer an individual from free text/JSON, so any legacy or unstructured record must not be represented as erased for a learner without a structured link. |
| **Durable workflow records** | Postgres `background_jobs` | Tenant/actor/subject identifiers, kind/state/fixed error code, bounded control manifest, and bounded response record for finalization, Tajweed evaluation, or privacy. The validator refuses raw audio, transcripts, credentials, and dependency addresses. A privacy manifest may contain server-derived learner record and private object keys; it never contains object bytes. |
| **Device enrollment invitations and sessions** | Postgres `device_enrollment_invitations`, `device_sessions` | Tenant/user, creator, audit, expiry, status, and generation lineage plus hash-only invitation, access, and refresh credentials. Raw 256-bit credentials are returned only at provisioning/exchange/refresh and never stored or exported. The routes are implemented but default off until owner activation. |
| **Realtime replay claims** | Postgres `realtime_ticket_replay_claims` | Tenant/session, expiry, claim time, and lowercase SHA-256 of the exact signed nonce. Raw tickets/nonces are never stored. Rows are forced-RLS tenant data and cascade when the owning recitation session is erased. |
| **Realtime delivery diagnostics** | Postgres `realtime_audio_chunk_outcomes` | Tenant/session/chunk identity, immutable span/rate, a closed accepted-lost or stored-unindexed reason, first-observed time, and nullable repair time. It stores no audio, credential, caller object key, trace, exception, or learner display field; forced RLS and session cascade apply. `audio_chunks`, not this table, controls playback. |

## 2. Who can access it (isolation)

- **Tenant isolation is enforced at the database** by Postgres RLS: every tenant-scoped query runs inside
  `begin_tenant_tx` (`SET LOCAL app.tenant_id`), and production runs as the restricted `quran_ai_app`
  role (`nosuperuser`, `nobypassrls`) so the policies actually bite. One institution cannot read another's.
- **Service keys stay server-side.** The browser/mobile client never talks to ML/ASR directly; the
  platform-api proxies them with `ML_API_KEY` / `ASR_API_KEY`, and JWT/header-auth gates every route.
- **Audio object authority stays server-side.** Clients cannot choose an object key and never receive
  a bucket URL. The Node API derives the key from verified tenant, learner, session, and chunk
  identity, reads the private store for teacher playback/privacy, and validates stored identity,
  byte length, and SHA-256 before serving bytes. Production refuses an implicit storage driver and
  the filesystem driver unless the explicit development-only acknowledgement is present.

## 3. Retention

- **Audio** is deleted by the `job-worker` retention sweep through the shared object-store adapter
  (`server/src/inference/runtime.mjs`), on a TTL keyed to the learner's consent:
  `audioRetention: "discard"` → **1 hour** (default), `"teacher-review"` → **7 days** (default). Both are
  env-configurable (`AUDIO_RETENTION_DISCARD_TTL_HOURS`, `AUDIO_RETENTION_REVIEW_TTL_HOURS`). A periodic
  cleanup enforces it; `training-opt-in` has no automatic TTL until the owner-approved policy sets one.
- **DB records** persist until account/data deletion (see §4). *A retention policy for the DB rows
  (progress, findings, audit) is a policy decision for the lawyer — the code does not auto-expire them.*
- **Durable workflow rows** are not auto-expired. Completed and dead rows, their bounded manifests,
  and replay lineage remain for audit/recovery until an owner/DPO-approved database retention and
  backup-expiry policy is implemented. Operators must not delete or rewrite them ad hoc.
- **Device credentials** stop authorizing at their enforced lifetimes: invitations after 24 hours,
  access credentials after 15 minutes, sessions after seven idle days, and every family after 30
  absolute days. Expiry/revocation does not itself erase the audit/lineage rows; those persist until
  subject deletion or a later owner/DPO-approved database retention policy.
- **Realtime replay claims** authorize only once and become cleanup-eligible at database-time
  expiry. Bounded cleanup removes expired rows; subject/session deletion cascades them immediately.
- **Realtime delivery diagnostics** do not auto-expire. They remain diagnostic/recovery evidence
  until the session is erased or a later owner/DPO-approved DB retention policy is implemented.

## 4. Data-subject rights (already implemented)

- **Erasure:** `POST /v1/privacy/delete` first commits a forced-RLS durable intent containing the
  bounded server-derived record/object manifest. It then deletes the learner's objects through the
  injected private store, verifies that the learner prefix is empty, and runs the fenced
  tenant-scoped database transaction that records the privacy receipt, completes the job, and cascades
  teacher_reviews → tajweed_findings → word_alignments → audio_chunks/alignment_runs → tickets →
  sessions (which cascade replay and realtime-delivery diagnostics) → consent records → device sessions/invitations → pilot sessions/invitations →
  structured learner-linked `agent_runs`.
  A storage failure leaves a retryable intent and no completed cascade—no "success while audio
  survives". A crash after storage deletion repeats the idempotent erase and commits the captured
  receipt on retry. The Rust
  compatibility runtime still uses the authenticated ML privacy boundary during consolidation and
  applies the same storage-first rule. The same structured agent-run and audio-object keys are
  included in privacy export; the integration suite proves target deletion, storage-fault rollback,
  and preservation of another learner's records and objects.
- **Access/portability:** a privacy **export** endpoint returns the subject's data, including
  structured learner-linked agent-run record identifiers. Device identity is represented only by
  count-only device credential markers (`device_session_count:N` and
  `device_enrollment_invitation_count:N` when nonzero); no row id, hash, token, or family lineage is
  disclosed in the export.

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

- **ASR/tajweed inference is self-hosted by default.** `cdn.islamic.network`
  serves *reference* recitation audio to the browser (outbound fetch of public Qur'an audio); no personal
  data is transmitted to it. If a hosted ASR is ever enabled, it becomes a processor and must be added
  here + gated on `externalAsrProcessing && guardianApproved` (already wired). A hosted
  S3-compatible provider would process learner audio as a storage provider; the production provider,
  region, DPA/subprocessor terms, encryption/key ownership, retention, and deletion guarantees remain
  owner/legal deployment decisions and must be recorded here before go-live. No production bucket is
  represented as deployed by this repository.

---

**Sign-off.** The lawyer/DPO uses this to author the privacy policy, COPPA assessment, retention policy,
and DPA, and records the decisions (age threshold, DB retention, guardian-verification method) as an ADR
in `docs/DECISIONS.md`. That ADR + the published documents are what clear §F16.
