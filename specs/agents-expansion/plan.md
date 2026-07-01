# Plan — New AI agents (feature #3)

## Context (grounded)
Agents follow a fixed pattern: deterministic knowledge/logic → sourced candidate with
`reviewStatus:"ai-suggested"` → `statusForRun` (gate) → `POST /v1/agent-runs` (camelCase:
name, goal, status, confidence, reviewStatus, sources, lastEvent, findingId). Ops identity.
Gate (`lib/gate.mjs`): learner-facing only if `reviewStatus` non-blocking AND confidence≥0.82
AND sources>0; a fresh "ai-suggested" run is always `needs-human-review`.

## Acceptance (EARS)
- WHEN the agents `/run` endpoint is invoked, THE service SHALL produce recorded agent_runs for
  the Mistake Pattern Summarizer and Practice Plan Recommender in addition to the Tajweed Explainer.
- Every new agent run SHALL be emitted `ai-suggested` (never auto-approved) with ≥1 source.
- WHEN a teacher/admin/ops requests `GET /v1/learner/progress?learnerId=X`, THE API SHALL return
  learner X's progress; a learner SHALL only read their own (else 403).

## Tasks (each: edit → `bash scripts/verify.sh` green)
1. **Backend: `?learnerId=` on GET /v1/learner/progress** (`progress.rs`). Add `Query<ProgressQuery>`;
   resolve effective learner via `require_self_or_any(id, [Teacher,Admin,Ops])`; default = caller.
   Integration test proving cross-learner read for ops + self-only for learner.
2. **Mistake Pattern Summarizer** (`lib/mistakePatterns.mjs`): aggregate `/v1/tajweed-findings` by
   rule → top-N recurring issues → ONE summary agent_run (sourced, gated). Pure `summarizePatterns`.
3. **Practice Plan Recommender** (`lib/practiceRecommender.mjs`): per-learner SM-2 progress →
   next-step recommendation (due/low-mastery/streak) → one run per active learner (sourced, gated).
   Pure `recommendNextStep`.
4. **Wire `server.mjs`**: fetchers + batch runners; `/run` runs all three agents and aggregates;
   `/health` lists all three. Keep the pipeline functions exported + IO-injectable for tests.
5. **Tests** (`agents.test.mjs`, already in the gate): pure-logic + gate assertions for both agents.
6. **Verify**: `verify.sh` VERIFY OK; live `/run` records real runs; smoke-all green.

## Impact / risk
- Task 1 touches a security-sensitive endpoint — default (no param) behavior is unchanged; the
  cross-learner path is gated by `require_self_or_any`. RLS still scopes to tenant.
- Agents 2/3 are additive (new files + server wiring); no schema change.
