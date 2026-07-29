# Monitoring (P5.5)

Deployable alerts + dashboards for the pilot, scraping `platform-api`'s existing `/metrics`
(`http_requests_total`, `http_request_duration_ms`). This is the engineering deliverable; the **live
validation + on-call sign-off is SRE (P5.7)**, and the alert thresholds are proposals the owner/SRE
ratify (P5.1, see `docs/readiness/OPERATIONS.md`).

## Run

```bash
# 1. Put the real METRICS_TOKEN into prometheus.yml (Prometheus doesn't expand env vars):
sed -i '' "s/REPLACE_WITH_METRICS_TOKEN/$METRICS_TOKEN/" monitoring/prometheus.yml   # or envsubst / secret mount

# 2. Bring up Prometheus + Grafana alongside the app (from the repo root):
GRAFANA_ADMIN_PASSWORD=... \
docker compose -f docker-compose.yml -f monitoring/docker-compose.monitoring.yml up -d prometheus grafana
```

- Prometheus → http://127.0.0.1:9090 (Alerts tab shows `alerts.yml` firing state).
- Grafana → http://127.0.0.1:3000 (admin / `$GRAFANA_ADMIN_PASSWORD`). Add a Prometheus datasource
  (`http://prometheus:9090`), then import `monitoring/grafana-dashboard.json` (it prompts for the
  datasource). Panels: request rate by status, 5xx error-rate %, latency p50/p95/p99, 401 rate.

## Alerts → SLOs (see OPERATIONS.md)

| Alert | Maps to |
|-------|---------|
| `PlatformApiDown` | availability; page → kill-switch/rollback runbook |
| `HighErrorRate` (5xx > 1%/5m) | 99% success/day error budget |
| `HighAuthFailureRate` (401s) | security — spoofing/brute-force or a broken `ALLOW_HEADER_AUTH` deploy |
| `HighLatencyP95` (global p95 > 1s) | latency SLO (histogram is global, not per-route) |
| `NoTrafficReceived` | web→API path broken (DNS/TLS/CORS) |

## Wiring alerts to a receiver

`alerts.yml` only defines the rules; routing to Slack/email/PagerDuty needs an Alertmanager with the
team's receiver config (owner/SRE task, P0.1 on-call + P5.5 routes). Add an `alertmanager` service and
`alerting:` block to `prometheus.yml` when the receiver is chosen.
