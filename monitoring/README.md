# HTTP canary monitoring

This stack scrapes the Node API, durable worker, Rust compatibility API, and realtime gateway. Its
alerts are machine stop signals for W2.18; live receiver validation and SRE sign-off remain external
release gates.

## Run without placing a secret in the repository

Create an owner-readable file outside the checkout containing exactly the deployed `METRICS_TOKEN`,
then pass its path to Compose. Prometheus reads the header from `/run/secrets/metrics_token`; the
tracked YAML never contains the token.

```bash
METRICS_TOKEN_FILE=/secure/path/qrai-metrics-token \
GRAFANA_ADMIN_PASSWORD='<operator-supplied password>' \
docker compose -f docker-compose.yml -f monitoring/docker-compose.monitoring.yml \
  up -d prometheus grafana
```

Prometheus is loopback-only at `http://127.0.0.1:9090`. Grafana is loopback-only at
`http://127.0.0.1:3000`; import `monitoring/grafana-dashboard.json` and select the Prometheus
datasource. The dashboard separates Node HTTP rate/error/latency/fallback, worker queue/retry/dead
state, component readiness, and stored-but-unindexed audio. It contains no tenant, learner, user,
session, or trace labels.

## Stop policy

| Alert | Immutable stop condition |
|---|---|
| `NodeCanaryDown` | Node readiness is lost |
| `JobWorkerDown` | durable worker readiness is lost |
| `RustOracleDown` | transition/rollback oracle readiness is lost |
| `NodeCanaryHighErrorRate` | Node 5xx share exceeds 1% for 5 minutes |
| `NodeCanaryHighLatency` | Node global p95 exceeds 1000 ms for 5 minutes |
| `NodeCanaryFallbackShare` | compatibility fallback exceeds 5% for 5 minutes |
| `DurableJobBacklog` | queued jobs exceed 100 for 5 minutes |
| `DurableJobRetries` | retry jobs exceed 10 for 5 minutes |
| `DurableJobDeadLetter` | any dead-letter job exists |
| `StoredAudioUnindexed` | any stored chunk lacks its durable index |

Privacy, tenant isolation, and learner-feedback withholding are active trust probes, not
Prometheus dimensions. Their measured failure counts join the low-cardinality metrics snapshot in
the controller observation document described in `docs/STAGING_RUNBOOK.md`. The controller accepts
the closed observation schema, calculates stop signals itself, and can only await human promotion
or rollback; it cannot approve a release. Promotion additionally requires the same values in a
role-bound signed monitoring attestation covering at least 15 minutes, with hashes of the
Prometheus queries and active-probe results. A hand-authored healthy JSON document can trigger
neither release closure nor promotion.

`alerts.yml` defines rules only. Alertmanager routing is intentionally absent until the owner/SRE
chooses and validates the receiver; do not add a placeholder receiver and call paging complete.
