# Impact map — agent-closable-closure

Blast radius of the plan in `./plan.md`. Per-task maps are refined during IMPLEMENT; this records
what is known before any code is written.

## Overwhelmingly additive

14 of 17 tasks add **new test files and two new ADRs**. They import production symbols; they do not
change them. No caller of any existing symbol is affected by T1, T3, T5, T7, T9, T10–T12, T13, T15,
T16, T17.

## Where production code can change, and who calls it

### W1 T2 / T4 — accessibility remediation (`apps/web/src/components/*.tsx`)

23 components. Changes are expected to be attribute-level (`aria-*`, `role`, label association,
heading order, focus management) rather than structural.

| component | callers to re-check |
|---|---|
| `LearnerHome`, `PracticeFlow`, `QuranReader`, `SurahPicker`, `ProgressPanel`, `TajweedPanel`, `AudioCoach`, `CompletePanel`, `IssuePanel`, `MutashabihatPanel` | learner route composition + existing `*.test.tsx` (`QuranReader.marks.test.tsx`, `LearnerHome.test.tsx`, `SurahPicker.test.tsx`) |
| `TeacherSurface` | teacher route; `apps/web/src/lib/tajweedReview.test.ts`; the per-finding audited playback added in #403 — **do not** reintroduce a session-level fetch |
| `ConsentPanel`, `PrivacySettings`, `MicNotice` | consent flow; `PrivacyConsent.a11y.test.tsx` |
| `TopBar`, `Sidebar`, `BrandMark`, `ModeBanner`, `OfflineBanner`, `ErrorBoundary`, `LoginScreen`, `PlatformCommand`, `InternalSurface` | app shell; `ModeBanner` is covered by the mode-banner honesty test (#352) — its *text* is an honesty assertion and must not be reworded for a11y |

**Trap found while surveying:** `PrivacyConsent.a11y.test.tsx` exists but **no `PrivacyConsent.tsx`
does**. A name-matching coverage guard (T1) would therefore mis-pair it and could report a false
positive. T1 must pair audits to components by the component each test *imports*, not by filename.

**Risk:** a DOM change that satisfies axe while breaking a query in an existing `*.test.tsx`. Mitigated
by running the full `test: ts` step, not just the new file, on every W1 PR.

### W2 T6 — fault paths

Reads and asserts existing behavior; touches production only if a fault path proves wrong.

| symbol | callers / parity obligation |
|---|---|
| `/ready` pool-acquire 503 (`services/platform-api`) | orchestrator probes; `tests/node-api/readiness-fault.test.mjs`; **must stay identical in `services/node-api`** — the parity suite runs every portable route through the port |
| ML proxy 502 (`handlers/ml_proxy.rs`, `services/node-api/routes/ml-proxy.mjs`) | `tests/api-parity/ml-proxy.test.mjs`, `upstream-malformed.test.mjs`, `no-secret-logging.test.mjs` |
| maintenance exemption set (`services/node-api/server.mjs` `onRequest`) | `tests/api-parity/maintenance-parity.test.mjs` — asserting a **closed** set will fail if Rust and Node disagree; that disagreement would itself be the finding |
| WS reconnect / buffer (`apps/web/src/lib/reconnect.ts`, `liveRecitation.ts`) | live recitation surface; chaos test T13 |

**Any change to a shared behavior must land in both platform-api and node-api in the same PR**, or
the parity suite fails — by design (ADR-0034).

### W4 T14 — degradation states

Same component set as W1, plus `apps/web/src/lib/http.ts` (`fetchWithTimeout`, 15 s abort) if a
timeout state needs to distinguish abort from network failure. Callers: every data hook in
`apps/web/src/data/platform.ts` (386 keys) — a signature change there is broad, so **prefer adding a
discriminant to the existing error shape over changing `fetchWithTimeout`'s signature**.

### Gate file

`scripts/verify.sh` gains steps for each new test. Requires the audited
`.codystem-allow-self-edit` sentinel, ADD-only, deleted in the same commit. Every existing step is
left byte-identical.

## Explicitly not touched

`services/shared-ticket`, the RLS policies, the canonical Quran bundle, the learner gate's decision
logic (ADR-0028), the teacher audio audit path (ADR-0037), `PORTABLE`, and the cutover default
(`NODE_API_PORTED ?? ""` — still zero routes, still an owner's call).
