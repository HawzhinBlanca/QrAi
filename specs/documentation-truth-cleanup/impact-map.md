# Documentation Truth Cleanup — Impact Map

| File / content to change | Consumers / references | Planned action |
|---|---|---|
| `README.md` current-boundary prose | New contributors; root runbook | Update obsolete implementation claims only. |
| `docs/DATA_INVENTORY.md` agent-run row and erasure section | Lawyer/DPO packet; architecture doc | Describe the implemented structured-key export/delete path and keep policy gaps open. |
| `docs/architecture/10-10-platform.md` platform/infra bullets | Root README; architecture readers | Remove the obsolete agent-run deletion gap and preserve genuine production gaps. |
| `docs/SHIP_PLAN.md` | `SHIP_READINESS.md`; historical references | Add historical/superseded banner; retain content. |
| `docs/ROAD_TO_1_TASKS.md` | `DATA_LICENSES.md`; historical references | Add historical banner; retain task/evidence history. |
| `docs/10-10-true-implementation-plan.md` and `docs/superpowers/plans/2026-06-25-full-platform-ship-ready.md` | Historical planning context | Add the same authoritative-ledger banner; do not delete or move files. |
| `docs/DATA_LICENSES.md` opening rule | External-data contributors | Make its registration rule self-contained; remove roadmap dependency. |

No production symbol, SQL migration, API route, test, or readiness-ledger status is
changed. Serena is unavailable in this environment; CCC plus repository reference
search supplied the read-only caller/reference map.
