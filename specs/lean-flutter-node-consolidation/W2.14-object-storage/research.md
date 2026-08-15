# W2.14 research — private retained-audio object lifecycle

**Status:** complete · **Date:** 2026-08-07 · **Criterion:** BE-6
## Grounded current state

- Serena is unavailable; manual `rg` symbol/reference mapping is in `impact-map.md`.
- `services/ml-inference/server.mjs` owns filesystem-only synchronous put/get/list/delete, JSON
  sidecars, retention sweeping, session assembly, and an explicit boot refusal for S3.
- Keys are currently `<tenant>/<learner>/<chunk>.bin`; the gateway and index body can supply the
  database `object_key`, so neither the session component nor the key is server-authoritative.
- Same-chunk retry is hash-idempotent, but separate byte/sidecar writes can leave an incomplete pair.
- `server/src/routes/review.mjs` and `privacy.mjs` call ML over HTTP for reads/deletes. API export
  inventories no retained audio, and storage success can precede a failed database index.
- Repair handles only local storage-without-index, not S3 pages or inverse/incomplete orphans.
- `audio_chunks` is RLS-protected and already the durable playback index. W2.15, not this task,
  adds durable job/outbox leasing; W3.6 joins Node realtime storage/index acknowledgement.

## Current primary-source findings
- S3 `If-None-Match: *` makes create-only PutObject atomic; existing keys return 412 and delete
  races may return 409. Signature V4 is required: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- PutObject accepts a full-object SHA-256 checksum; HeadObject can return that checksum with
  checksum mode enabled. ETag is not a universal content digest.
  https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
- S3 object operations/metadata are strongly consistent and one-key atomic, not multi-key
  transactional: https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html
- ListObjectsV2 is limited to 1,000 keys per response and requires continuation-token pagination.
  DeleteObjects may return HTTP 200 with per-key errors, which must be inspected.
  https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
  https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
- AWS recommends Block Public Access and bucket-owner-enforced ownership with ACLs disabled; the app
  sets no ACL and issues no playback URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html
- AWS SDK v3 supports explicit endpoints/`forcePathStyle`, AbortSignal, and consumable GetObject
  streams: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-client-constructors.html
- Registry inspection on 2026-08-07 found `@aws-sdk/client-s3` 3.1105 newest but published hours
  earlier; exact 3.1101 is the newest release older than the repository's supply-chain age window.

## Decision
- Add one `server/src/storage/audio-object-store.mjs` interface used by API and transitional ML.
  Production driver is S3; filesystem requires an explicit local/test acknowledgement in a
  production-built image. Unknown or incomplete config refuses boot—never falls back.
- Use one S3 object per chunk at
  `audio/v1/<tenant>/<learner>/<session>/<chunk>.pcm`; identity, retention, span, size, schema, and
  hexadecimal SHA-256 live in object metadata, with uploaded `ChecksumSHA256`.
- Validate every identity segment, derive every key internally, and ignore/refuse caller key
  authority. Existing legacy filesystem objects remain readable/reconcilable during migration.
- Put is create-only and retry-safe: identical identity/hash returns the prior result; differing
  bytes or metadata return conflict. Reads revalidate key metadata, retention, size, and digest.
- List/export/delete stay inside a derived learner prefix, paginate fully, check partial delete
  errors, and verify emptiness. Deadlines reach every SDK call.
- Reconciliation treats storage as a candidate, never ownership authority: tenant-scoped session
  rows independently confirm learner/session/retention before repair; inverse and incomplete
  orphans are reported, with dry-run default and explicit apply.

## Non-decisions and risks

- No presigned URLs, multipart upload, public bucket, broker, new service, or canonical-Quran change.
- S3-compatible stores vary in control-plane APIs; deployment evidence must separately prove the
  bucket policy/ownership/encryption posture. The data-plane adapter remains portable.
- Cross-resource exactly-once is impossible without W2.15 jobs; this task provides idempotent
  effects plus honest orphan states and reconciliation, never a false atomicity claim.
