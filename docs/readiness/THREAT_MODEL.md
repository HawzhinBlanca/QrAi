# Threat model (P4.1) — DRAFT, pending owner + security approval

**Status:** Engineering draft (2026-07-23). Assets/actors/threats and the mitigations already in
code are mine to state; **accepting residual risk and signing this off is the owner's + an
independent security reviewer's call** (P4.1 approval, P1.7/P4.5 sign-off — see `SIGNOFF_REGISTER.md`).

## Assets
- Learner PII + recitation audio + derived analysis (per tenant).
- Tenant isolation (multi-tenant; `hikmah-pilot-erbil` is the pilot).
- Qur'anic content integrity (canonical text; tajweed instruction correctness).
- Service credentials (JWT/ticket secrets, ML/ASR keys).

## Actors / trust boundaries
- Unauthenticated internet.
- Malicious **learner** (holds a valid pilot cookie; role pinned `learner`).
- Malicious **staff** (teacher/scholar/admin of some tenant).
- The browser (untrusted; sends only data, never authority).
- Internal services (ml/asr) reachable only via platform-api proxies.

## Threats → mitigations (in code) / residual

| # | Threat | Mitigation (implemented) | Residual → owner |
|---|--------|--------------------------|------------------|
| T1 | Browser asserts its own identity/role | Prod runs `ALLOW_HEADER_AUTH` off; only Bearer JWT or the `__Host-qrai-pilot` cookie (role pinned learner) carry authority. Proven live (P1.6): spoofed headers → 401. | Deploy MUST set the flag off (turnkey). |
| T2 | Cross-tenant / cross-user data access (IDOR) | Every handler scopes on `actor.tenant_id` + `require_self_or_any`; RLS `FORCE` + `begin_tenant_tx`. Adversarial audit (2026-07-23) found **no IDOR** across 13 handlers. | Independent re-review (P4.5). |
| T3 | Pilot session forgery via `pg_temp` shadowing | Definer fns pinned `search_path=public,pg_temp` + `REVOKE … FROM public` (0021, F2). | — |
| T4 | CSRF / session fixation on the pilot cookie | `SameSite=Strict; HttpOnly; Secure; __Host-`; server-minted session token; constant-time CSRF digest compare + Origin allowlist on mutations. | Origin allowlist requires `CORS_ALLOWED_ORIGINS` set — now **fails closed** on boot if unset (F1). |
| T5 | Invite abuse / brute force | UUIDv4 tokens hashed at rest; single-use atomic consume; uniform 401 (no oracle); rate-limited router. | — |
| T6 | Privilege escalation via self-registration | Elevated roles require an authed admin/ops + tenant match. **Open learner self-registration bypasses invitation-only (F2)** | **OWNER DECISION** (task_fc1f2385). |
| T7 | Consent bypass (analyze without consent) | ml_proxy overwrites client consent with the session's stored record + scopes the session to the caller (F3); the ML service hard-requires `sessionId`. | — |
| T8 | Secret/weak-config in prod | `ensure_secure_config()` fail-closes on weak JWT/ticket/ML/ASR secrets, superuser DB role, and empty `CORS_ALLOWED_ORIGINS`. | — |
| T9 | Right-to-erasure gaps | privacy delete/export enumerate agent_runs + pilot rows + ML audio blobs. | — |
| T10 | Supply-chain advisory | JS `pnpm audit`, Rust `cargo audit` (CI gates); ASR from a pip-audit-clean lock. | SBOM/license gates = follow-up. |
| T11 | Availability (rate-limit collapse behind proxy; DoS) | Governor limiter; `TRUST_PROXY_HEADERS` for real-IP keying; kill-switch for graceful shutdown. | SRE load/DoS validation (P5.4/P5.7). |
| T12 | **Incorrect religious content** shown as authoritative | Learner-facing tajweed gated on teacher-review + source + confidence; unapproved rules withheld (ADR-0013). | **SCHOLAR sign-off (P3.6) — outranks CI.** |

## Explicitly out of my scope (human)
Independent penetration test (P4.5), legal/privacy review + user notice (P4.6), and the scholar
ruling on tajweed scope (P3.6). None of these can be satisfied by code or by me.
