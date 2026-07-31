#!/usr/bin/env bash
# F2 acceptance: capturing twice must produce BYTE-IDENTICAL output.
# specs/api-golden-fixtures/plan.md
#
# Resets the tables the scenario writes between the two runs. Without that, the second capture sees
# the first one's recitation session in every list endpoint and the outputs differ — a property of
# the SCENARIO, not of the normalizer (no amount of value normalization can hide an extra array
# element). That failure was found by this test rather than reasoned about in advance, which is the
# reason the test exists.
#
#   FIXTURE_TARGET_URL=http://127.0.0.1:8098 FIXTURE_PG_CONTAINER=qrai-fx-pg \
#     bash scripts/verify-fixture-determinism.sh
#
# Both variables are REQUIRED with no defaults: this truncates tables, and a default pointing at a
# real database would destroy live data during what the operator believed was a test.
set -euo pipefail

: "${FIXTURE_TARGET_URL:?set FIXTURE_TARGET_URL (no default — this script truncates tables)}"
: "${FIXTURE_PG_CONTAINER:?set FIXTURE_PG_CONTAINER (the ISOLATED capture database container)}"

reset_mutable_tables() {
  docker exec -i "$FIXTURE_PG_CONTAINER" psql -q -U hawzhin -d quran_ai \
    -c "TRUNCATE recitation_sessions, consent_records, agent_runs, audit_events CASCADE;" >/dev/null
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

reset_mutable_tables
FIXTURE_OUT="$tmp/a.json" node scripts/capture-api-fixtures.mjs >/dev/null
reset_mutable_tables
FIXTURE_OUT="$tmp/b.json" node scripts/capture-api-fixtures.mjs >/dev/null

if diff -q "$tmp/a.json" "$tmp/b.json" >/dev/null; then
  # Read the recorded stepCount rather than counting "name" keys, which also matches nested
  # response fields and reported a misleadingly large number.
  steps="$(node -p "JSON.parse(require('fs').readFileSync('$tmp/a.json','utf8')).stepCount")"
  echo "ok   two captures are byte-identical (${steps} steps)"
else
  echo "FAIL captures differ — the fixtures are not deterministic:" >&2
  diff "$tmp/a.json" "$tmp/b.json" | head -30 >&2
  exit 1
fi
