# Privacy export and delete, against the running service

**2026-08-02.** The Flutter client's privacy screen had never made a real request. These are the
exact bodies it sends (`api_client.dart`), against `platform-api` on the Docker Postgres.

Erasure is verified **by querying the tables**, never by the 200 — the same rule `N17` was held to.

## Export

```
POST /v1/privacy/export   {"learnerId":"learner-demo"}   -> 200
{"id":"privacy-job-6862599c-…","kind":"export",
 "includedRecords":["session-7a1a061a-…","learner_progress:1:1"],
 "deletedRecords":[],"auditEventId":"audit-c2ca5868-…"}
```

Real records, and `deletedRecords` empty — export destroys nothing.

## Delete, with the ML service DOWN

```
POST /v1/privacy/delete   {"learnerId":"learner-demo"}   -> 502
{"error":"audio erasure service unavailable"}
```

Table state immediately after:

| | before | after the 502 |
|---|---|---|
| `recitation_sessions` | 1 | **1** |
| `learner_progress` | 1 | **1** |
| `realtime_session_tickets` | 1 | **1** |

**Nothing was deleted.** `platform-api` erases audio *before* the database cascade and fails fast,
so an ML outage leaves the learner's data whole rather than half-erased. The code comment claims
this; this is the measurement.

That measurement is what licenses the client's failure message. `privacy_screen.dart` now leads with
**"Nothing was deleted — your data is still here."** rather than interpolating the exception, which
had been putting `ApiException(ApiErrorKind.server, 502): audio erasure service unavailable` in
front of a learner who could not tell whether their recordings were gone.

## Delete, with the ML service UP

```
POST /v1/privacy/delete   -> 200
{"kind":"delete",
 "deletedRecords":["session-7a1a061a-…","learner_progress:1:1"],
 "audioObjectKeysDeleted":[],"auditEventId":"audit-12426e94-…"}
```

| | before | after |
|---|---|---|
| `recitation_sessions` | 1 | **0** |
| `learner_progress` | 1 | **0** |
| `realtime_session_tickets` | 1 | **0** |
| `users` row | 1 | **1** |
| `audit_events` | — | **4** |

The learner's records are gone. Two things deliberately survive, and both are correct: the `users`
row (this is erasure of a learner's *data*, and `privacy_jobs.learner_id` references it), and the
audit trail — erasing the record that erasure happened would defeat the point.

`audioObjectKeysDeleted` is empty because this learner never streamed audio that the ML service
stored. That is not proof the audio path erases; `scripts/smoke-privacy.mjs` covers that.

## What this does NOT prove

- No audio was ever stored for this learner, so the object-erasure path was exercised only in its
  "nothing to delete" shape.
- The Flutter UI was not driven for these calls; the request bodies were replayed exactly as
  `api_client.dart` builds them. The screen's own behaviour is covered by
  `test/privacy_screen_test.dart`.
