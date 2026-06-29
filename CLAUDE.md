# CLAUDE.md

This file is the Claude Code bridge to the single source of truth, `AGENTS.md`.
AGENTS.md is the de-facto open standard (read natively by Codex/Copilot/Gemini too),
so all operating rules live there and are imported here.

@AGENTS.md

## Claude-only notes
- MCP servers: configured in `.mcp.json` (Serena is always on for symbolic code nav).
- Hooks: `.claude/settings.json` wires PreToolUse (guard), PostToolUse (fast verify),
  and Stop (full verify). These are deterministic guardrails — do not attempt to bypass.
- Skills: `.claude/skills/{research,plan,implement}` encode the Research → Plan →
  Implement loop. Invoke them in order; the PLAN step stops for human approval.
- The gate is polyglot: it compiles/tests Rust (cargo) AND TS (pnpm). Expect the first
  run to be slow (cargo builds two crates). Postgres-only integration tests are skipped
  unless a live DB is reachable — see `docs/TESTING.md`.
