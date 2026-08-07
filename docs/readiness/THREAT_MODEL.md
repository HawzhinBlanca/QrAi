# Threat model (P4.1) — DRAFT, pending owner + security approval

**Status:** Engineering draft (2026-07-23). Assets/actors/threats and the mitigations already in
code are mine to state; **accepting residual risk and signing this off is the owner's + an
independent security reviewer's call** (P4.1 approval, P1.7/P4.5 sign-off — see `SIGNOFF_REGISTER.md`).

## Assets
- Learner PII + recitation audio + derived analysis (per tenant).
- Tenant isolation (multi-tenant; `hikmah-pilot-erbil` is the pilot).
- Qur'anic content integrity (canonical text; tajweed instruction correctness).
- Service credentials (JWT/ticket secrets, ML/ASR keys).
- Durable workflow manifests, replay lineage, and privacy object identifiers.

## Actors / trust boundaries
- Unauthenticated internet.
- Malicious **learner** (holds a valid pilot cookie; role pinned `learner`).
- Malicious **staff** (teacher/scholar/admin of some tenant).
- The browser (untrusted; sends only data, never authority).
- Internal ASR plus the worker's private compatibility ingress, reachable only through server-side
  authenticated callers.
- Restricted Node API/worker processes and authorized tenant operations staff.

## Threats → mitigations (in code) / residual

| # | Threat | Mitigation (implemented) | Residual → owner |
|---|--------|--------------------------|------------------|
| T1 | Browser/device asserts its own identity/role | Prod runs `ALLOW_HEADER_AUTH` off. Authority comes only from a verified Bearer JWT, a database-resolved `qrai_at_v1` device access credential when its owner gate is enabled, or the `__Host-qrai-pilot` cookie (role pinned learner). Device tenant/user/role are loaded from stored state, never token claims. Proven live: spoofed headers/role fields → 401/422. | Deploy MUST keep header auth off. Device routes stay off until owner approval and W4.10 native secure storage proof. |
| T2 | Cross-tenant / cross-user data access (IDOR) | Every ordinary handler scopes on `actor.tenant_id`; RLS is forced; Rust `begin_tenant_tx` and Node `withTenant` install a transaction-local tenant. Node refuses privileged DB roles before listen and statically allowlists the few unscoped canonical/readiness/security-definer queries. | Independent re-review (P4.5). |
| T3 | Pilot session forgery via `pg_temp` shadowing | Definer fns pinned `search_path=public,pg_temp` + `REVOKE … FROM public` (0021, F2). | — |
| T4 | CSRF / session fixation on the pilot cookie | `SameSite=Strict; HttpOnly; Secure; __Host-`; server-minted session token; constant-time CSRF digest compare + Origin allowlist on mutations. | Origin allowlist requires `CORS_ALLOWED_ORIGINS` set — now **fails closed** on boot if unset (F1). |
| T5 | Invite abuse / brute force | Pilot UUIDv4 tokens and 256-bit opaque device invitations are hashed at rest, atomically single-use, expiring, and return a uniform 401 without an existence oracle. Device invitations are created only by the restricted operator command after validating an in-tenant admin. The HTTP boundary is rate-limited. | Secure out-of-band delivery and operator access review remain deployment obligations. |
| T6 | Privilege escalation via self-registration | Elevated roles require an authed admin/ops + tenant match. **Open learner self-registration bypasses invitation-only (F2)** | **OWNER DECISION** (task_fc1f2385). |
| T7 | Consent bypass (analyze without consent) | `ml_proxy` overwrites client consent with the session's stored record and scopes the session to the caller (F3); the worker inference runtime hard-requires `sessionId`. | — |
| T8 | Secret/weak-config in prod | Both API runtimes fail closed on weak JWT/ticket/ML/ASR secrets and empty `CORS_ALLOWED_ORIGINS`. Node's pre-listen role gate additionally refuses superuser, RLS-bypass, DB/role-creation, and replication capabilities; staging must never use its explicit local relaxation. | — |
| T9 | Right-to-erasure gaps | Privacy delete/export enumerate structured agent runs, pilot rows, device identity rows as count-only markers, and the full paginated learner object prefix. Node deletes and verifies private storage before committing DB deletion; the fenced transaction then deletes device sessions/invitations before user data. A storage fault leaves DB state intact. The Rust compatibility path applies the same storage-first rule. | Hosted-provider versions/replicas/backups require a provider-specific erasure drill before go-live. |
| T10 | Supply-chain advisory | JS `pnpm audit`, Rust `cargo audit` (CI gates); ASR from a pip-audit-clean lock. | SBOM/license gates = follow-up. |
| T11 | Availability (rate-limit collapse, hung dependency, partial completion; DoS) | Rust Governor and Node's bounded 200/50 ms token bucket are default-on; both have a maintenance kill switch. Node ignores forwarded identity by default and bounds opt-in trusted hops plus client-state cardinality/eviction. One monotonic AbortSignal budget cancels compatibility, ASR, storage/privacy/review, and worker calls; PostgreSQL server-side timeouts roll transactions back before fixed retryable responses, and review audio distinguishes attempted from served. Node SIGTERM closes admission, drains active HTTP, bounds raw/upgraded sockets, reserves Postgres teardown time, and hard-exits inside the configured grace. | Enable proxy trust only behind an overwriting proxy; release-bound load/soak remains W2.18/P5.7, and protocol WebSocket close frames remain W3. |
| T12 | **Incorrect religious content** shown as authoritative | Learner-facing tajweed gated on teacher-review + source + confidence; unapproved rules withheld (ADR-0013). | **SCHOLAR sign-off (P3.6) — outranks CI.** |
| T13 | Audio object overwrite, traversal, corruption, or public disclosure | The server derives strict versioned keys from verified identity; create-only conditional writes are idempotent only for identical metadata and checksum; reads verify identity, length, SHA-256, retention, and span. Production requires an explicit private S3-compatible driver; no signed/public URL is issued. Reconciliation reports incomplete and inverse orphans without guessing authority. | Provider IAM, public-access block, encryption, alerting, and restore/erasure rehearsal require independent deployment review. |
| T14 | Lost, duplicated, stale, cross-tenant, or poisoned background work | One forced-RLS Postgres outbox uses per-tenant `SKIP LOCKED` leases, bounded attempts/backoff, monotonic fences, fixed errors, and atomic effect+completion. Privacy intent precedes idempotent erase. Documents reject sensitive/unbounded fields; metrics have closed labels. The worker refuses privileged roles, rotates tenants, and drains on SIGTERM. Dead recovery is internal, admin/ops-only, audited, idempotent, and creates a successor without mutating the dead row. Online jobs cannot write evaluation evidence or access signing keys. | Alert routing, load/soak, hosted Postgres failover, and a staging crash/replay drill remain release gates; remote inference and object erase are intentionally at-least-once. |
| T15 | Stolen or replayed native device credentials; provisioning abuse | Independent 256-bit access/refresh credentials are stored only as hashes. Access lasts 15 minutes; sessions have seven-day idle and 30-day absolute limits. Every refresh rotates both credentials under a locked generation. Refresh replay revokes and audits the whole credential family before generic 401; logout does the same. Provisioning requires a stored in-tenant admin, cannot create admin/ops, cannot select a session role, and returns the invitation once. Routes and Compose are default off. | W4.10 must add Keychain/Keystore, auth-state rebuild, and logout/401 erasure. DPoP/App Attest/native key binding, secure invitation delivery, device compromise response, load/soak, and independent security review remain release gates. |

## Explicitly out of my scope (human)
Independent penetration test (P4.5), legal/privacy review + user notice (P4.6), and the scholar
ruling on tajweed scope (P3.6). None of these can be satisfied by code or by me.
