# P1 Identity Decision Packet — Invited No-Login Pilot

**Status:** Approved by Hawzhin  
**Approval date:** 2026-07-19  
**Decision choice:** Bounded invitation-only identity bootstrap design with server-scoped HttpOnly cookies.

## Decision requested

Approve or reject this bounded pilot model:

> An invited learner starts a no-password pilot session from a server-issued,
> one-time opaque invitation.  The server, not the browser, binds the session
> to one existing learner, tenant, and the `learner` role.  The browser holds
> only an `HttpOnly`, `Secure`, host-only session cookie and never sends a
> trusted tenant, user, or role header.

This preserves “no general-user login screen” while avoiding the current shared
`learner-1` impersonation.  It is invitation-only, not an anonymous public
launch.  An invitation may be delivered by an authorized teacher or pilot
administrator through an approved out-of-band channel.

### Owner choices that cannot be inferred

1. **Pilot admission:** invitation-only (recommended) or a different approved
   enrollment mechanism.  A public no-login bootstrap has no safe way to bind
   progress, privacy, consent, and deletion rights to an individual learner.
2. **Invitation delivery:** approved institutional channel and support recovery
   procedure when a link is forwarded, lost, or opened on the wrong device.
3. **Session lifetime:** proposed 30-minute idle timeout and 8-hour absolute
   expiry; choose shorter limits if the pilot risk assessment requires them.
4. **Privacy disclosure:** the exact learner-facing wording for the pilot
   invitation/session and the accountable privacy reviewer.

No code may pick these on the owner's behalf.

## Current evidence and root cause

`AppInner` intentionally renders `AuthenticatedApp` with `bypassLogin` when
`VITE_REQUIRE_LOGIN` is not `1`.  That path creates a default `learner-1` /
`hikmah-pilot-erbil` identity with an empty token.  Both
`apps/web/src/lib/api.ts` and `apps/web/src/data/platform.ts` then emit
`x-tenant-id`, `x-user-id`, and `x-user-role` headers.  Secure
`actor_from_headers` correctly rejects those headers when `ALLOW_HEADER_AUTH`
is disabled.

The retained P1.1 browser evidence proves the complete current path: normal
route, no smoke parameter, no bearer header, `Progress API 401`, and the
learner-visible unavailable screen.  It is recorded in `research.md` with an
external artifact path and hashes.  Existing Rust unit and integration tests
separately prove production rejects a spoofed header identity.

## Recommended security design

### 1. One-time invitation bootstrap

An authorized staff workflow creates an opaque, cryptographically-random
invitation bound in the database to an existing `learner` row and its tenant.
Only a hash of the invitation secret is stored.  The link places the opaque
secret in the URL fragment, not the query string, so it is not sent in HTTP
requests, reverse-proxy logs, referrers, or browser history after the client
immediately removes the fragment.

The normal learner page exchanges the fragment once at a same-origin
`POST /v1/pilot/session/bootstrap` endpoint.  The server atomically verifies
the hash, expiry, tenant/user/role binding, and unused/revoked status; consumes
or rotates the invitation; creates the pilot session; writes an audit event;
then sets the session cookie.  The response contains display-only profile data,
never a bearer token or raw session secret.

The bootstrap endpoint is unavailable unless an explicit production pilot mode
is enabled.  It MUST fail closed when the allowed origins, database-backed
invitation store, or secure-cookie deployment prerequisites are absent.

### 2. Server-side session and cookie

The cookie value is an independent, 256-bit random secret.  The database stores
only its hash plus immutable `tenant_id`, `learner_id`, `role = learner`,
created/last-seen/idle-expiry/absolute-expiry/revoked timestamps, and the
minimal audit linkage required for support and revocation.  It does not store
raw invitation or session secrets.

The cookie is named `__Host-qrai-pilot` and MUST be `HttpOnly; Secure;
SameSite=Strict; Path=/` with no `Domain` attribute.  The server resolves its
hash for each protected request, checks expiry/revocation, and creates the
same `Actor` used by existing RLS-scoped handlers.  Rotate the cookie/session
on bootstrap; revoke it on logout, expiry, explicit support action, and invite
revocation.  A bearer JWT remains supported for the existing login-enabled
staff/product path, but the pilot browser receives neither bearer JWT nor a
browser-readable identity token.

### 3. CSRF, origin, and CORS boundary

Pilot session mode requires same-origin web/API deployment through the existing
`/v1/` proxy.  It MUST require an explicit exact production origin list; a
wildcard CORS policy is prohibited.  Every state-changing cookie-authenticated
request MUST pass an exact `Origin` check and a CSRF proof designed with the
security reviewer; bootstrap, privacy deletion, recording/session creation,
progress updates, and teacher-review submission are included.  Safe `GET`
routes still require a valid session where learner data is returned.

Development and isolated CI can retain explicit `ALLOW_HEADER_AUTH=1` only
with `ALLOW_INSECURE_DEFAULTS=1`.  Production must ignore all browser-supplied
identity headers, including when a valid pilot cookie is absent or malformed.

### 4. Learner experience and failure behavior

Before a session exists, the no-login page shows a bounded “open your pilot
invitation” state, not a fabricated learner or a generic platform outage.  A
successful bootstrap loads actual progress and proceeds to practice.  An
expired/revoked session clears client-only display state and gives a safe
recovery instruction; it does not retry identity or silently substitute
`learner-1`.  The existing offline screen remains only for transport/service
failure after a valid session has been established.

## Threat model and required controls

| Threat | Required control and proof |
| --- | --- |
| Browser chooses another tenant/user/role | Cookie session actor is server-bound; production rejects all identity headers; test spoofed headers with/without cookie. |
| Invitation forwarded or leaked | One-time hashed secret, short invitation expiry, atomically consumed, revocable; token never appears in query/referrer/logs; replay test. |
| Cookie theft or session fixation | `__Host-`, `Secure`, `HttpOnly`, strict same-site cookie; fresh random secret at bootstrap; hash at rest; expiry/revocation; fixation/rotation tests. |
| Cross-site state change | Exact `Origin` plus CSRF proof for every unsafe cookie-authenticated route; browser CORS/credentials tests. |
| Tenant crossover or privilege escalation | Server derives immutable learner actor before RLS transaction; no bootstrap for staff roles; cross-tenant/read/write/privacy/realtime/ML tests. |
| Enumeration and bootstrap abuse | Uniform denial response, rate limit by source/invitation hash, no raw token logging, alert on repeated invalid attempts. |
| Stale or lost device | Idle + absolute expiry, logout/revoke support action, session audit trail, safe re-invitation workflow. |
| Dev switch leaks to production | Production config validation fails when pilot origin/cookie prerequisites are missing or `ALLOW_HEADER_AUTH` is enabled; deployment policy test. |

## Exact impact map (P1.3)

### Web and mobile callers

- `apps/web/src/App.tsx`: `AppInner`, `AuthenticatedApp`, `effectiveUser`,
  `authToken`, `loadInitialData`, retry/offline state, start-practice and all
  downstream calls receiving the current default actor.
- `apps/web/src/lib/auth.tsx`: `AuthProvider`, browser-token persistence,
  login/logout behavior; pilot session must not add an identity token to
  localStorage.
- `apps/web/src/lib/api.ts`: its private `actorHeaders` and every learner
  mutation/read: privacy export/delete, session creation, teacher-review
  request, alignment persistence, realtime ticket, ML prediction, ASR and
  forced alignment.
- `apps/web/src/data/platform.ts`: exported `actorHeaders`, progress read/write,
  weekly progress, memorization plan, evaluation and internal-console readers.
- `apps/web/src/data/quran.ts`: `loadWeeklyProgress`.
- `apps/web/src/lib/serverAsr.ts` and `apps/web/src/components/TeacherSurface.tsx`:
  bearer handling must remain deliberate and never fall back to spoofable
  identity in production.
- `apps/mobile/lib/session.ts`: its header fallback must remain dev-only or be
  replaced by the approved native session model; web cookie assumptions do not
  automatically apply to React Native.

### API authorization boundary

`services/platform-api/src/auth.rs` is the one actor derivation boundary.
`actor_from_headers` is currently reached by protected handlers in
`auth`, `agent`, `audit`, `eval`, `ml_proxy`, `privacy`, `progress`,
`recitation`, `review`, and elevated-role `user::register`.  The affected
handler call sites are 28 direct uses in those files.  The implementation MUST
replace the duplicated per-handler header extraction with one request actor
resolver that has explicit bearer, pilot-cookie, and development-header modes.

`services/platform-api/src/lib.rs` owns route registration, CORS, rate limiting,
and outer middleware ordering.  It must register the bootstrap/logout/session
routes and apply exact production origin/credential policy without weakening
preflight behavior.  `AppState`, migrations, integration fixtures, and
`infra/sql/0003_tenant_rls.sql` are affected by the new tenant-owned session
and invitation tables and policies.

## EARS acceptance criteria and proof mapping

| Criterion | Automated proof required |
| --- | --- |
| WHEN a valid unconsumed invitation is presented from the exact pilot origin, THE system SHALL create a session bound to that invitation’s one learner/tenant/role and set only a secure HttpOnly cookie. | API integration plus clean-browser normal-route proof. |
| WHEN an invitation is expired, revoked, malformed, or replayed, THE system SHALL deny it uniformly without issuing a cookie or revealing identity. | API negative/replay/rate-limit tests. |
| WHEN a cookie-authenticated request supplies `x-tenant-id`, `x-user-id`, or `x-user-role`, THE system SHALL ignore those headers and use only the server-bound session actor. | Handler-family mutation/adversarial tests. |
| WHEN a pilot session is expired or revoked, THE system SHALL deny protected data/actions and the browser SHALL present a bounded recovery state without falling back to a default learner. | Browser/API expiry, logout, revocation tests. |
| WHEN a cross-origin or CSRF-invalid unsafe request carries a pilot cookie, THE system SHALL reject it before changing state. | CORS/origin/CSRF integration and browser tests. |
| WHEN a valid pilot learner uses the normal route, THE system SHALL load real progress, select a surah, begin practice, and preserve the existing source/review/consent gates. | Full browser/API/DB journey with declared fixture audio. |
| WHEN production starts with pilot mode enabled but secure origin/cookie/session prerequisites are absent, THE system SHALL fail closed. | Configuration/unit/deployment-policy tests. |

## Implementation order after approval

1. Add a failing integration test for invitation exchange, cookie actor binding,
   header spoofing, replay, expiry, revocation, CSRF, and tenant crossover.
2. Add migration/RLS policies and server-side invitation/session repository.
3. Implement the request actor resolver and pilot bootstrap/logout endpoints.
4. Replace production web identity-header fallback; add bounded bootstrap and
   expiry UI without enabling the existing login screen.
5. Add normal-route browser proof, then run `bash scripts/verify.sh --release`,
   protected CI, independent security challenge, and the recovery ledger gate.

## Explicit non-goals

- Do not enable `VITE_REQUIRE_LOGIN=1` for general users.
- Do not embed a JWT, service credential, tenant identifier, role, invite
  secret, or session secret in the web bundle or localStorage.
- Do not make public anonymous practice appear individually attributable.
- Do not use a shared `learner-1` production identity, a browser-supplied
  header identity, or a wildcard credentialed CORS configuration.
