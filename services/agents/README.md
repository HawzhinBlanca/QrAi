# Quran AI Agents Service

Agents are supervised workflow tools, not religious authorities.

## Implemented

- **Tajweed Explainer** — reads real tajweed findings from platform-api
  (`GET /v1/tajweed-findings`), turns each into a learner-facing explanation candidate
  from a fixed, sourced knowledge base of tajweed rules, enforces the source/review gate,
  and records a real `agent_run` (`POST /v1/agent-runs`). Every candidate is emitted with
  `reviewStatus: "ai-suggested"` → status `needs-human-review`; it is **never** auto-shown
  to a learner. It does not invent rulings.

## Run

```bash
node server.mjs               # GET /health, POST /run   (default :8092)
node --test agents.test.mjs   # unit tests
```

Env: `AGENTS_PORT` (8092), `PLATFORM_API_URL` (http://127.0.0.1:8080),
`AGENTS_TENANT_ID` (hikmah-pilot-erbil), `AGENTS_API_TOKEN` (ops Bearer JWT; in dev the
header fallback works when platform-api runs with `ALLOW_HEADER_AUTH=1`).

## Roadmap agents (not yet built)

Recitation Coach, Memorization Planner, Teacher Copilot, Curriculum Builder,
Localization Agent, Support Agent, Data QA Agent, Scholar Review Agent.

Every learner-facing agent answer must pass the source/review gate in
`packages/contracts` (`canShowLearnerFacingAiOutput`, mirrored in `lib/gate.mjs`) before
display.
