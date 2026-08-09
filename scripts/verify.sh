#!/usr/bin/env bash
# CODYSTEM verify gate for quran-ai-platform — the single source of "does it work".
# CI runs this SAME script (.github/workflows/ci.yml), so local == CI.
#
#   bash scripts/verify.sh           full gate: guard + lint + typecheck + test + build
#   bash scripts/verify.sh --fast    lint + typecheck only (used by the PostToolUse hook)
#   bash scripts/verify.sh --release release gate: full gate + required live DB + full-stack smoke
#
# Polyglot: TS (web/contracts/quran-data via pnpm) + Rust (gateway/platform-api via cargo).
# DB-dependent platform-api integration tests run ONLY when a live Postgres is reachable —
# they are SKIPPED (never faked) otherwise. This script never prints a false "VERIFY OK".
set -uo pipefail

MODE="${1:-}"
case "$MODE" in
  "") FAST="no"; RELEASE="no" ;;
  --fast) FAST="yes"; RELEASE="no" ;;
  --release) FAST="no"; RELEASE="yes" ;;
  *)
    echo "usage: bash scripts/verify.sh [--fast|--release]" >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/postgresql@16/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
CALLER_DATABASE_URL="${DATABASE_URL:-}"
export DATABASE_URL="${DATABASE_URL:-postgresql://hawzhin@localhost:5432/quran_ai}"

GW="services/realtime-gateway/Cargo.toml"
API="services/platform-api/Cargo.toml"

# Optional, git-ignored per-machine overrides (e.g. custom DATABASE_URL).
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [[ -f "${_here}/stack.env" ]]; then
  # shellcheck disable=SC1091
  source "${_here}/stack.env"
fi
# An explicit command/CI input is authoritative. stack.env is only a per-machine default and must
# not silently redirect a verification run to a different database.
if [[ -n "$CALLER_DATABASE_URL" ]]; then
  export DATABASE_URL="$CALLER_DATABASE_URL"
fi
# Migration proofs create/drop isolated databases and therefore need an administrative connection.
# CI's DATABASE_URL is administrative; restricted local stacks can supply a separate explicit URL.
export MIGRATION_TEST_ADMIN_URL="${MIGRATION_TEST_ADMIN_URL:-$DATABASE_URL}"

# A release verification must never quietly run against a developer's default
# database or emit its proof into the candidate checkout. The caller supplies a
# dedicated, disposable release DB and external artifact destinations; CI is
# responsible for making those inputs isolated and protected.
if [[ "$RELEASE" == "yes" ]]; then
  required_release_vars=(
    RELEASE_DATABASE_URL
    RELEASE_APP_DATABASE_PASSWORD
    RELEASE_SMOKE_ARTIFACT_DIR
    RELEASE_SMOKE_TRACE_ID
    RELEASE_TEST_SUMMARY
    RELEASE_ENVIRONMENT_SUMMARY
    RELEASE_ENVIRONMENT_CLASS
    RELEASE_ENVIRONMENT_PROVIDER
    RELEASE_IMAGE_DIGESTS_JSON
    RELEASE_HTTP_CANARY_CANDIDATE_EVIDENCE
    RELEASE_HTTP_CANARY_CLASSROOM_LOAD_EVIDENCE
    RELEASE_HTTP_CANARY_BURST_LOAD_EVIDENCE
    RELEASE_HTTP_CANARY_SOAK_LOAD_EVIDENCE
    RELEASE_HTTP_CANARY_OBSERVATION_EVIDENCE
    RELEASE_HTTP_CANARY_HEALTHY_CONTROLLER_EVIDENCE
    RELEASE_HTTP_CANARY_ROLLBACK_CONTROLLER_EVIDENCE
    RELEASE_HTTP_CANARY_REMOTE_CI_EVIDENCE
    RELEASE_HTTP_CANARY_OWNER_APPROVAL
    RELEASE_HTTP_CANARY_SECURITY_APPROVAL
    RELEASE_HTTP_CANARY_SRE_APPROVAL
    RELEASE_HTTP_CANARY_TRUST_POLICY
    RELEASE_HTTP_CANARY_CLOSURE_OUTPUT
  )
  for variable in "${required_release_vars[@]}"; do
    if [[ -z "${!variable:-}" ]]; then
      echo "release verification requires $variable" >&2
      exit 2
    fi
  done
  export DATABASE_URL="$RELEASE_DATABASE_URL"
  export SMOKE_ARTIFACT_DIR="$RELEASE_SMOKE_ARTIFACT_DIR"
  export SMOKE_TRACE_ID="$RELEASE_SMOKE_TRACE_ID"
  export SMOKE_CANDIDATE_SHA="$(git rev-parse HEAD)"
  export SMOKE_REQUIRE_CANDIDATE_EVIDENCE="1"
  export SMOKE_IMAGE_DIGESTS_JSON="$RELEASE_IMAGE_DIGESTS_JSON"
  export SMOKE_ENVIRONMENT_CLASS="$RELEASE_ENVIRONMENT_CLASS"
  export SMOKE_ENVIRONMENT_PROVIDER="$RELEASE_ENVIRONMENT_PROVIDER"
  export SMOKE_TEST_ACTOR_CLASS="release-automation"
  http_canary_release_args=(
    --candidate-sha "$(git rev-parse HEAD)"
    --candidate-evidence "$RELEASE_HTTP_CANARY_CANDIDATE_EVIDENCE"
    --classroom-load-evidence "$RELEASE_HTTP_CANARY_CLASSROOM_LOAD_EVIDENCE"
    --burst-load-evidence "$RELEASE_HTTP_CANARY_BURST_LOAD_EVIDENCE"
    --soak-load-evidence "$RELEASE_HTTP_CANARY_SOAK_LOAD_EVIDENCE"
    --observation-evidence "$RELEASE_HTTP_CANARY_OBSERVATION_EVIDENCE"
    --healthy-controller-evidence "$RELEASE_HTTP_CANARY_HEALTHY_CONTROLLER_EVIDENCE"
    --rollback-controller-evidence "$RELEASE_HTTP_CANARY_ROLLBACK_CONTROLLER_EVIDENCE"
    --remote-ci-evidence "$RELEASE_HTTP_CANARY_REMOTE_CI_EVIDENCE"
    --owner-approval "$RELEASE_HTTP_CANARY_OWNER_APPROVAL"
    --security-approval "$RELEASE_HTTP_CANARY_SECURITY_APPROVAL"
    --sre-approval "$RELEASE_HTTP_CANARY_SRE_APPROVAL"
    --trust-policy "$RELEASE_HTTP_CANARY_TRUST_POLICY"
  )
  if ! node scripts/http-canary-release-evidence.mjs \
    --validate-only \
    "${http_canary_release_args[@]}"; then
    echo "release verification requires valid candidate-bound canary, CI, and human evidence" >&2
    exit 2
  fi
  if ! node scripts/release-evidence-summary.mjs \
    --validate-only \
    --test-output "$RELEASE_TEST_SUMMARY" \
    --environment-output "$RELEASE_ENVIRONMENT_SUMMARY" \
    --environment-class "$RELEASE_ENVIRONMENT_CLASS" \
    --environment-provider "$RELEASE_ENVIRONMENT_PROVIDER" \
    --smoke-artifact-dir "$RELEASE_SMOKE_ARTIFACT_DIR"; then
    echo "release verification requires clean checkout and external evidence destinations" >&2
    exit 2
  fi
  if ! MIGRATION_DATABASE_URL="$RELEASE_DATABASE_URL" node server/scripts/migrate.mjs; then
    echo "release verification failed to converge the dedicated database through the migration runner" >&2
    exit 2
  fi
  if ! MIGRATION_DATABASE_URL="$RELEASE_DATABASE_URL" \
       APP_DATABASE_PASSWORD="$RELEASE_APP_DATABASE_PASSWORD" \
       node server/scripts/provision-role.mjs; then
    echo "release verification failed to provision the restricted application role" >&2
    exit 2
  fi
fi

fail=0
say() { printf '\n==> %s\n' "$*"; }
run() { # run <name> <shell-command>
  local name="$1" cmd="$2"
  say "$name"
  if ! bash -c "$cmd"; then
    echo "    ✗ ${name} failed" >&2
    fail=1
  fi
}

# --- 0. Guard: no tracked secrets / protected files (anti-leak boundary) ------
# Allow template files (.env.example/.sample/.template) — they hold no real secrets.
say "guard: tracked secrets & protected paths"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  leaked="$(git ls-files \
    | grep -E '(^|/)\.env$|(^|/)\.env\.|(^|/)secrets/|\.pem$' \
    | grep -vE '(^|/)\.env\.(example|sample|template)$' || true)"
  if [[ -n "$leaked" ]]; then
    echo "    ✗ secret/protected file(s) tracked — untrack them (see AGENTS.md):" >&2
    printf '        %s\n' $leaked >&2
    fail=1
  fi
fi

# --- 1. Lint (Rust fmt + clippy; TS "lint" == typecheck, run below) -----------
run "lint: rust fmt"    "cargo fmt --manifest-path $GW --check && cargo fmt --manifest-path $API --check"
run "lint: rust clippy" "cargo clippy --manifest-path $GW -- -D warnings && cargo clippy --manifest-path $API -- -D warnings"

# --- 2. Typecheck (TS workspaces) ---------------------------------------------
run "typecheck: ts" "pnpm --filter @quran-ai/contracts typecheck && pnpm --filter @quran-ai/quran-data typecheck && pnpm --filter @quran-ai/server typecheck && pnpm --filter @quran-ai/web typecheck"

if [[ "$FAST" != "yes" ]]; then
  # --- 3. Test --------------------------------------------------------------
  run "test: ts"                  "pnpm --filter @quran-ai/contracts test && pnpm --filter @quran-ai/quran-data test && pnpm --filter @quran-ai/web test"
  # Server inference plus agents use explicit hermetic node:test paths. Runtime entrypoints gate
  # their side effects (listen/timers) on
  # `isMain`, so server.test.mjs can import it directly; keep explicit paths (a dir glob would
  # still pick up non-test .mjs files).
  # PAR6: tests/api-parity/coverage.test.mjs belongs HERE, not in the DB-gated block below. It only
  # reads integration.rs + coverage.json, so "is every Rust test accounted for" has nothing to do
  # with Postgres. The parity suite ITSELF is DB- and binary-gated further down.
  # `--experimental-strip-types`: tests/contract/tajweed-gate-parity.test.mjs imports
  # packages/contracts/src/index.ts directly, to EXECUTE the real learner gate rather than parse it.
  # Node turns type stripping on by default from 22.18, so this line worked without the flag on a
  # current runtime and threw ERR_UNKNOWN_FILE_EXTENSION on 22.13 — the minimum package.json
  # declares. CI pins `node-version: "22"`, which floats to the newest, so the gate was red on a
  # supported runtime and green on the one that tested it. tests/contract/strip-types.test.mjs pins
  # the flag against the imports so this cannot come back.
  run "test: audio object lifecycle" "node --test tests/e2e/audio-lifecycle.test.mjs"
  run "test: durable domain workflows" "node --test --test-concurrency=1 tests/e2e/durable-workflows.test.mjs"
  run "test: durable job security" "node --test tests/security/job-boundary.test.mjs"
  run "test: device enrollment routes" "node --test --test-concurrency=1 tests/e2e/device-enrollment.test.mjs"
  run "test: audio retention worker" "node --test tests/inference/audio-retention-worker.test.mjs"
  run "test: realtime durable replay" "node --test --test-concurrency=1 tests/migrations/realtime-replay-migration.test.mjs tests/realtime/replay-protection.test.mjs"
  run "test: realtime storage/index outcomes" "node --test --test-concurrency=1 tests/migrations/realtime-audio-outcomes-migration.test.mjs tests/realtime/storage-index.test.mjs"
  run "test: node services"       "node --experimental-strip-types --test scripts/fixture-normalize.test.mjs scripts/acoustic-candidate-proof.test.mjs scripts/diff-api-fixtures.test.mjs scripts/fixture-coverage.test.mjs scripts/load-test.test.mjs tests/inference/alignment.test.mjs tests/inference/marks-parity.test.mjs tests/inference/tajweed.test.mjs tests/inference/golden-regression.test.mjs tests/inference/model-attribution.test.mjs tests/inference/server.test.mjs tests/inference/session-transcript.test.mjs tests/inference/acoustic-shadow.test.mjs tests/inference/rate-limit.test.mjs tests/inference/chunk-overwrite.test.mjs tests/inference/compatibility-ingress.test.mjs tests/inference/storage-driver.test.mjs tests/inference/privacy-erasure.test.mjs services/agents/agents.test.mjs scripts/release-manifest.test.mjs scripts/release-build-evidence.test.mjs scripts/release-evidence-summary.test.mjs scripts/smoke-evidence.test.mjs scripts/smoke-database.test.mjs scripts/release-images.test.mjs tests/release/release-artifact-consumption.test.mjs tests/release/release-deployment-selection.test.mjs tests/release/http-canary-image.test.mjs tests/release/http-canary-controller.test.mjs tests/release/canary-rollback-evidence.test.mjs tests/release/canary-release-cli-refusals.test.mjs tests/observability/http-canary-monitoring.test.mjs tests/release/model-evidence.test.mjs tests/release/model-claim-authority.test.mjs tests/inference/asr-readiness.test.mjs tests/inference/asr-candidate-evidence.test.mjs tests/inference/muaalem-candidate-evidence.test.mjs tests/inference/real-audio-spans.test.mjs tests/inference/bounded-window-spans.test.mjs tests/inference/canonical-bytes-through-alignment.test.mjs tests/api-parity/coverage.test.mjs tests/node-api/ticket-vectors.test.mjs tests/realtime/protocol-fixtures.test.mjs tests/realtime/backpressure.test.mjs tests/realtime/process-lifecycle.test.mjs tests/realtime/ticket-boundary.test.mjs tests/node-api/authz.test.mjs tests/node-api/device-sessions.test.mjs tests/node-api/shell.test.mjs tests/node-api/standalone-lifecycle.test.mjs tests/node-api/graceful-shutdown.test.mjs tests/node-api/worker-lifecycle.test.mjs tests/node-api/standalone.test.mjs tests/node-api/middleware-order.test.mjs tests/node-api/production-image.test.mjs tests/node-api/module-relocation.test.mjs tests/node-api/route-registry.test.mjs tests/node-api/db-architecture.test.mjs tests/node-api/metrics-render.test.mjs tests/node-api/rust-json.test.mjs tests/node-api/no-secret-logging.test.mjs tests/node-api/boot-guard.test.mjs tests/node-api/nul-byte-is-a-400.test.mjs tests/node-api/readiness-fault.test.mjs tests/faults/dependency-timeouts.test.mjs tests/contract/coverage.test.mjs tests/contract/openapi-completeness.test.mjs tests/contract/cutover-readiness.test.mjs tests/contract/http-canary-topology.test.mjs tests/e2e/http-canary-effects.test.mjs tests/contract/boundary-references.test.mjs tests/contract/inference-module-boundary.test.mjs tests/contract/inference-compatibility-surface.test.mjs tests/contract/node-backend-decisions.test.mjs tests/contract/realtime-decisions.test.mjs tests/contract/flutter-contract.test.mjs tests/contract/enum-parity.test.mjs tests/contract/tajweed-gate-parity.test.mjs tests/contract/learner-feedback-gate.test.mjs tests/contract/tajweed-analysis-basis.test.mjs tests/contract/acoustic-tajweed-boundary.test.mjs tests/contract/no-invented-confidence.test.mjs tests/contract/ml-findings-shape.test.mjs tests/contract/strip-types.test.mjs tests/contract/verify-invocations.test.mjs tests/contract/retired-components.test.mjs tests/contract/store-readiness.test.mjs tests/contract/compose-migrations.test.mjs tests/contract/audio-index-topology.test.mjs tests/migrations/migration-runner.test.mjs tests/migrations/schema-equivalence.test.mjs tests/migrations/restricted-role.test.mjs tests/migrations/eval-evidence-migration.test.mjs tests/migrations/job-outbox-migration.test.mjs tests/migrations/device-identity-migration.test.mjs tests/jobs/durable-jobs.test.mjs tests/jobs/local-inference-worker.test.mjs tests/jobs/api-job-wait.test.mjs tests/jobs/inference-cancellation.test.mjs scripts/check-apk.test.mjs scripts/check-web-bundle-secrets.test.mjs tests/security/arabic-regex-escapes.test.mjs tests/security/node-boundary.test.mjs tests/i18n/registers.test.mjs tests/i18n/locale-parity.test.mjs tests/i18n/drafts.test.mjs tests/security/legacy-insecure-flag.test.mjs"
  # apps/mobile is NOT a pnpm workspace member, so the TS `test: ts` line above never covered it and
  # its consent/auth/audio-format helpers went unguarded (a real audioFormat bug shipped there). The
  # helpers import ONLY node builtins, so this needs no install — just Node's type-stripping to read
  # the .ts directly. Same explicit-path style as the node services line above.
  run "test: mobile"              "node --experimental-strip-types --test apps/mobile/lib/session.test.ts"

  # FL1/FL2 — the Flutter client. SKIPPED, loudly, when the SDK is absent: it is a 2.1 GB user-space
  # install and neither CI nor a fresh clone has it, so making it mandatory would turn every other
  # machine's verify.sh red for a reason unrelated to the change under test. `--fatal-infos` is
  # deliberate — the analyzer's `info` tier is where `avoid_dynamic_calls` and `unawaited_futures`
  # live, and both are ways canonical text or a credential goes wrong quietly.
  #
  # This gate covers ANALYSIS and HEADLESS TESTS only. It is not, and must never be reported as,
  # device proof: no Xcode and no Android cmdline-tools on this machine, so FL9's iOS/Android matrix
  # stays open (specs/migration-completion/research.md §1).
  if command -v flutter >/dev/null 2>&1; then
    run "analyze: flutter client"  "cd apps/flutter && flutter pub get --enforce-lockfile >/dev/null && dart analyze --fatal-infos"
    run "test: flutter client"     "cd apps/flutter && flutter test"
  else
    say "analyze + test: flutter client"
    echo "    • SKIP — no \`flutter\` on PATH. Install the SDK to include apps/flutter."
  fi

  # P4-T1: restore-db.sh's pre-connection guards. The critical one asserts the script has NO
  # DATABASE_URL fallback — verify.sh (line 28 of this file) exports a default DATABASE_URL pointing
  # at a real local database, so a restore script that fell back to it would overwrite a developer's
  # own data during what they believed was a drill. Pure bash, no DB needed, so it always runs.
  # F2 — the hand-authored OpenAPI contract validated against the COMMITTED Phase 5 fixtures, which
  # were themselves captured from a live service. Hermetic (reads JSON, starts nothing), so it
  # belongs here and not in the DB-gated block. A spec that has never met a real response is
  # documentation; this is what makes it a contract.
  run "contract: openapi vs real responses" "node scripts/validate-openapi-responses.mjs"
  # CU1 — cutover readiness, printed for the record. INFORMATIONAL: it must never fail the gate,
  # because "not ready to cut over" is the correct and expected state, not a build break. A gate
  # that went red for that would be noise, and noise gets silenced — which is how the one signal
  # that mattered would be lost. Its LOGIC is gated properly, by cutover-readiness.test.mjs above.
  say "cutover readiness (informational)"
  node scripts/cutover-readiness.mjs 2>&1 | sed 's/^/    /' || true
  run "test: restore guards"      "bash scripts/restore-db.test.sh"
  # P4-T2. The pre-connection guards run here with no database; the ROUND TRIP — a file erased after
  # the backup was taken must still be absent after the restore — needs one and skips loudly without
  # it. `psql` is not on every host (this repo's Postgres runs in Docker), so PSQL_BIN lets the
  # drill point at the container's client rather than making the gate depend on a host install.
  run "test: audio restore guards" "bash scripts/restore-audio.test.sh"
  # P5.6. Backups hold learner PII and recordings of children, and until this gate they were written
  # with `pg_dump --format=custom` and `tar -czf` — compression, which is not confidentiality.
  # Runs the full round trip through the real backup and restore scripts with a throwaway keypair,
  # and asserts BOTH directions: that an archive is opaque, and that no backup is written at all
  # when no recipient certificate is configured. Needs only openssl, so it is not DB-gated.
  run "test: backup encryption (P5.6)" "bash scripts/backup-crypto.test.sh"
  # MIG5 — Python. asr-inference ships plain-interpreter suites (documented as `python test_x.py`)
  # that import no torch and load no model, so they run anywhere Python 3 + numpy exist. They were
  # previously ungated ENTIRELY — including test_forced_align_normalization.py, which guards the
  # diacritic character class that once deleted every Arabic letter and shipped through review
  # (PR #258). Deliberately NOT skip-if-missing: a soft skip would report green on a machine with
  # no Python and hide exactly the class of bug this exists to catch.
  # NOT included: test_audio_guards.py. Its docstring claims plain-interpreter, but it imports
  # fastapi and shells out to ffmpeg (verified: system python3 has numpy but not fastapi), so it
  # needs the service venv. It stays ungated until CI installs the asr-inference requirements —
  # a named gap, not a silent one.
  run "test: python (asr-inference)" "cd services/asr-inference && { command -v python3 >/dev/null || { echo 'python3 not found — required, not optional'; exit 1; }; } && python3 test_eval_metrics.py && python3 test_eval_pipeline.py && python3 test_forced_align_normalization.py && python3 test_force_align_unavailable.py && python3 test_ghunnah_escapes.py && python3 -m pytest -q test_model_attribution.py test_acoustic_tajweed.py"
  # W1.6 — the forced-aligner span proof. Unlike every suite above it genuinely needs torch and
  # torchaudio: it drives torchaudio's real forced_align/merge_tokens over a hand-built emission,
  # which is the only way to test the blank index and the frame->millisecond arithmetic without a
  # 1.2GB checkpoint download. `align_words` produces every forced-aligned span used when native ASR
  # timing is absent and had no gated producer test — its direct accuracy harness needs the network
  # and the real model. That gap is how it shipped passing the wrong blank index
  # to merge_tokens, which hands each word its neighbour's timing on any checkpoint whose <pad> is
  # not index 0.
  # Interpreter choice is load-bearing, not cosmetic: on macOS the Homebrew python3's torch aborts
  # at import with OMP Error #15 (Homebrew's libomp and torch's bundled copy both initialise), so
  # the service venv is preferred whenever it can import torchaudio. Deliberately NOT
  # skip-if-missing, for the same reason as the step above.
  run "test: python spans (asr-inference)" "cd services/asr-inference && PY=python3 && if [ -x .venv/bin/python ] && .venv/bin/python -c 'import torchaudio' >/dev/null 2>&1; then PY=.venv/bin/python; fi && \$PY -m pytest -q test_forced_align_spans.py"
  # shared-ticket is only ever BUILT as a dependency of the two services, so `cargo test` on them
  # never ran its own 14 tests — including the cross-language ticket vectors, which pin the one
  # credential that crosses a service boundary. Same class of gap as MIG5's ungated Python.
  run "test: rust shared-ticket"  "cargo test --manifest-path services/shared-ticket/Cargo.toml"
  run "test: rust gateway"        "cargo test --manifest-path $GW"
  run "test: rust platform-api"   "cargo test --manifest-path $API"

  # G3 — the gateway's WebSocket surface, against a REAL process. Needs no database, so it belongs
  # here rather than in the DB-gated block below. `cargo build` is explicit for the same reason the
  # parity block gives: `cargo test` above builds the test harness, not the binary this spawns, and
  # every gateway test that already exists drives the router in-process via `oneshot`, which never
  # performs a WebSocket upgrade at all.
  run "test: gateway websocket (real process)" \
    "cargo build --manifest-path $GW && node --test tests/gateway/ws-hostile-input.test.mjs"

  # Blocker 3 — the learner's audio-retention choice, end to end: real gateway, real worker ingress,
  # real websocket, and an assertion on the .meta.json actually written to disk. Also needs no
  # database: the choice travels in the signed ticket, which is the point.
  #
  # A pipeline test rather than another unit test, because every unit involved was already correct
  # when this shipped broken. The gateway simply never put the field in the body, the inference runtime's
  # `?? "discard"` filled the hole, and a learner who chose "teacher-review" had their recitation
  # deleted an hour later with nothing logged. Only an assertion on the artifact catches that.
  run "test: audio retention reaches stored audio (real processes)" \
    "cargo build --manifest-path $GW && node --test tests/gateway/audio-retention-e2e.test.mjs"

  # The other half of "fail the chunk, never lose the audio". Two unit tests cover the
  # index-failure counter and BOTH call `record_index_failure()` directly, so they prove the counter
  # counts and not that a real failure reaches it — measured: deleting the production call left the
  # gateway suite at 47 passed, 0 failed. This drives a real websocket with PLATFORM_API_URL pointed
  # at a server that answers 500, then asserts the counter moved AND the audio is still on disk.
  run "test: an index failure is reported and the audio survives (real processes)" \
    "cargo build --manifest-path $GW && node --test tests/gateway/index-failure-e2e.test.mjs"

  # DB-gated integration tests — only when a live Postgres answers and allows authentication. Skipped, not faked.
  can_auth="no"
  if command -v psql >/dev/null 2>&1; then
    PGCONNECT_TIMEOUT=2 psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1 &
    PSQL_PID=$!
    count=0
    while kill -0 $PSQL_PID 2>/dev/null && [ $count -lt 20 ]; do
      sleep 0.1
      count=$((count + 1))
    done
    if kill -0 $PSQL_PID 2>/dev/null; then
      kill -9 $PSQL_PID 2>/dev/null
      wait $PSQL_PID 2>/dev/null || true
    else
      if wait $PSQL_PID 2>/dev/null; then
        can_auth="yes"
      fi
    fi
  fi

  if [[ "$can_auth" == "yes" ]]; then
    run "test: migration system (live Postgres)" \
      "node --test --test-concurrency=1 tests/migrations/migration-runner.test.mjs tests/migrations/schema-equivalence.test.mjs tests/migrations/restricted-role.test.mjs"
    run "test: retained audio storage → index → teacher playback + repair (live Postgres)" \
      "cargo build --manifest-path $GW && cargo build --manifest-path $API && node --test --test-concurrency=1 tests/e2e/teacher-audio-index.test.mjs"
    # W1.7 — checksum-pinned real recitation PCM and a captured real ASR response traverse the
    # actual storage/windowing/alignment/finalize chain into live Postgres. The capture is explicitly
    # benchmark-ineligible; this proves span provenance and refusal/persistence semantics, not ASR
    # quality. Rust is built explicitly because this test spawns the binary.
    run "test: real-audio spans → Quran alignment → atomic persistence (live Postgres)" \
      "cargo build --manifest-path $API && node --test --test-concurrency=1 tests/e2e/real-audio-finalize.test.mjs"
    # W1.8 — the same actual ML chain is observed at the private API seam, then compared byte-for-
    # byte with the tenant-bound alignment run and the staff-only readback. It also proves learner
    # withholding and cross-tenant isolation for the producer document.
    run "test: model provenance inference → DB → restricted readback (live Postgres)" \
      "cargo build --manifest-path $API && node --test --test-concurrency=1 tests/e2e/model-provenance-roundtrip.test.mjs"
    run "test: learner-owned delayed review history (live Postgres)" \
      "cargo build --manifest-path $API && node --test --test-concurrency=1 tests/e2e/learner-history.test.mjs"
    run "test: platform-api integration (live Postgres)" "cargo test --manifest-path $API -- --include-ignored"
    # PAR5 — the cross-language API parity suite (specs/api-parity-suite/). Black-box: it starts the
    # real platform-api binary on an ephemeral port per configuration group and asserts over HTTP +
    # direct SQL. This is the oracle a future Node backend must satisfy.
    #
    # `cargo build` is explicit rather than assumed: `cargo test` above builds the test harness, and
    # a suite that silently skipped on a missing binary would gate nothing (the harness raises
    # instead — see tests/api-parity/lib/harness.mjs).
    #
    # NOT run here: scripts/verify-parity-teeth.sh, which proves each ported assertion FAILS when the
    # behaviour breaks. It requires a SUPERUSER DATABASE_URL (its rls-no-role-drop mutation cannot
    # weaken anything from an already-restricted role, and it refuses to report a hollow pass). CI's
    # DATABASE_URL is deterministic, so CI runs it as its own step — a named boundary, not a gap.
    # --test-concurrency=1 is NOT a performance knob and must not be removed to speed the gate up.
    #
    # These suites all read and write ONE database. `assertAB` issues its two requests concurrently,
    # so any row another file inserts between them makes the comparison fail on data rather than on
    # behaviour. Measured, 5 runs each: concurrent -> 3 failures, a DIFFERENT test every time
    # (audit-events, a pilot cookie lookup, a CSRF gate); serialized -> 5 clean runs of 174.
    #
    # `GET /v1/audit-events` is the clearest case — `ORDER BY created_at DESC LIMIT 200` over a table
    # every authenticated request appends to. That race was latent long before this change; N13's
    # pilot routes simply write enough audit events to surface it several times an hour instead of
    # once a month. A flaky gate is worse than a red one: it teaches everyone to re-run.
    run "test: api parity suite (live Postgres)" \
      "cargo build --manifest-path $API && node --test --test-concurrency=1 tests/api-parity/lib/harness.test.mjs tests/api-parity/default.test.mjs tests/api-parity/auth-disabled.test.mjs tests/api-parity/cors.test.mjs tests/api-parity/metrics.test.mjs tests/api-parity/ml-proxy.test.mjs tests/api-parity/realtime-ticket.test.mjs tests/api-parity/db-endpoints.test.mjs tests/api-parity/proxy-endpoints.test.mjs tests/api-parity/contract-shapes.test.mjs tests/api-parity/hostile-input.test.mjs tests/api-parity/infra-parity.test.mjs tests/api-parity/quran-parity.test.mjs tests/api-parity/progress-parity.test.mjs tests/api-parity/reports-parity.test.mjs tests/api-parity/auth-token-parity.test.mjs tests/api-parity/pilot-auth-parity.test.mjs tests/api-parity/pilot-routes-parity.test.mjs tests/api-parity/sessions-parity.test.mjs tests/api-parity/session-writes-parity.test.mjs tests/api-parity/session-finalize-parity.test.mjs tests/api-parity/review-parity.test.mjs tests/api-parity/ml-asr-proxy-parity.test.mjs tests/api-parity/privacy-parity.test.mjs tests/api-parity/agent-write-parity.test.mjs tests/api-parity/audio-playback-parity.test.mjs tests/api-parity/audio-index-parity.test.mjs tests/api-parity/authz-matrix.test.mjs tests/api-parity/upstream-hang.test.mjs tests/api-parity/upstream-malformed.test.mjs tests/api-parity/effect-parity.test.mjs tests/api-parity/tajweed-persistence-effects.test.mjs tests/observability/trace-join.test.mjs tests/observability/privacy-erasure-journey.test.mjs tests/contract/enum-db-parity.test.mjs tests/node-api/db-tenant.test.mjs tests/node-api/db-role-guard.test.mjs"

    # The SAME black-box suite, run with the Node port serving the routes instead of proxying them.
    #
    # `PARITY_THROUGH_SHELL=1` has existed since Phase 7 N2 and NOTHING ever ran it: every gate
    # exercised the Rust binary, so a Node handler could disagree with its Rust original in any way
    # at all and stay green. That is how a port stops being a port. P3.2 made it concrete — the
    # learner-redaction mirror in services/node-api/routes/ml-proxy.mjs was, until this line, a
    # security control with no gate behind it.
    #
    # WIDENED to every executable local route (was: the two ML proxy routes).
    #
    # The narrow version proved 2 of 36. The other 34 were ported, merged, and never once compared to
    # the Rust original by any gate — the same shape as the gap this line was added to close, one
    # level up. Running the full set found a real divergence on the first attempt: a caller-supplied
    # NUL byte was a 400 naming the problem in Rust and a bare `500 internal error` in Node, across
    # FOURTEEN surfaces, because the port never mirrored `impl From<sqlx::Error> for ApiError`.
    #
    # Import the executable projection. Source parsing was a second, format-sensitive route list.
    run "test: api parity THROUGH the Node port (every executable route)" \
      "PARITY_THROUGH_SHELL=1 NODE_API_PORTED=\"\$(node --input-type=module -e '
         import { ROUTES } from \"./server/src/routes/index.mjs\";
         const defaultKeys = ROUTES.filter((route) => route.ownerGate === undefined).map((route) => route.key);
         if (defaultKeys.length < 30) { console.error(\"registry has only \" + defaultKeys.length + \" default routes\"); process.exit(1); }
         console.log(defaultKeys.join(\",\"));
       ')\" node --test --test-concurrency=1 tests/api-parity/default.test.mjs tests/api-parity/auth-disabled.test.mjs tests/api-parity/cors.test.mjs tests/api-parity/metrics.test.mjs tests/api-parity/ml-proxy.test.mjs tests/api-parity/realtime-ticket.test.mjs tests/api-parity/db-endpoints.test.mjs tests/api-parity/proxy-endpoints.test.mjs tests/api-parity/contract-shapes.test.mjs tests/api-parity/hostile-input.test.mjs tests/api-parity/infra-parity.test.mjs tests/api-parity/quran-parity.test.mjs tests/api-parity/progress-parity.test.mjs tests/api-parity/reports-parity.test.mjs tests/api-parity/auth-token-parity.test.mjs tests/api-parity/pilot-auth-parity.test.mjs tests/api-parity/pilot-routes-parity.test.mjs tests/api-parity/sessions-parity.test.mjs tests/api-parity/session-writes-parity.test.mjs tests/api-parity/session-finalize-parity.test.mjs tests/api-parity/review-parity.test.mjs tests/api-parity/ml-asr-proxy-parity.test.mjs tests/api-parity/privacy-parity.test.mjs tests/api-parity/agent-write-parity.test.mjs tests/api-parity/audio-playback-parity.test.mjs tests/api-parity/audio-index-parity.test.mjs tests/api-parity/authz-matrix.test.mjs"
  else
    say "test: platform-api integration + api parity suite"
    if [[ "$RELEASE" == "yes" ]]; then
      echo "    ✗ RELEASE FAIL — dedicated release database is unreachable or authentication failed." >&2
      fail=1
    else
      echo "    • SKIP — no live Postgres or authentication failed at \$DATABASE_URL."
      echo "      Run \`docker compose up -d postgres\` (or set DATABASE_URL) to include them."
    fi
  fi

  # --- 4. Build -------------------------------------------------------------
  run "build" "pnpm --filter @quran-ai/contracts build && pnpm --filter @quran-ai/quran-data build && pnpm --filter @quran-ai/server build && pnpm --filter @quran-ai/web build"
  run "guard: web production bundle secrets" "node scripts/check-web-bundle-secrets.mjs"
  run "guard: web security headers (ADR-0010)" "node scripts/check-security-headers.mjs"
  # P4.4 named a licence gate and there was none. `pnpm audit` covers vulnerabilities and the SBOM
  # records what is present; neither says whether this project may SHIP what it depends on. A
  # transitive AGPL arrival changes the obligations of the whole distribution and turns up the same
  # silent way the undici advisory did — through someone else's lockfile bump.
  run "guard: dependency licences (P4.4)" "node scripts/check-licenses.mjs --self-test && node scripts/check-licenses.mjs"
  # A model version may not CLAIM it passed evaluation without one that passes.
  # `modelEvalPassesReleaseGate` encoded the bar and had NO caller — one reference outside its own
  # unit test, its own definition — while `model_versions.status` said `eval-passed` with nothing
  # checking it. This finally gives that gate a caller. DB-gated, like the other live-Postgres legs.
  if [[ -n "${DATABASE_URL:-}" ]] && pg_isready -q -d "$DATABASE_URL" 2>/dev/null; then
    run "guard: model eval claims (P3.5)" \
      "node --experimental-strip-types scripts/check-model-eval-claims.mjs --self-test && node --experimental-strip-types scripts/check-model-eval-claims.mjs"
  else
    say "guard: model eval claims — SKIPPED (no reachable Postgres)"
  fi

  if [[ "$RELEASE" == "yes" ]]; then
    # smoke:all drives proof, SQL, browser, API, gateway, ML, and privacy
    # surfaces. Its artifact directory and trace are supplied above rather than
    # falling back to out/ or an unbound random value.
    run "test: release full-stack smoke" "pnpm smoke:all"
    # W1.10: build the current optional Muaalem target and run the declared correct/altered
    # vectors in one offline, read-only, non-root container. The output remains structural shadow
    # evidence only and is written beside the other external release artifacts.
    run "test: protected acoustic candidate image" \
      "node scripts/acoustic-candidate-proof.mjs --output \"$RELEASE_SMOKE_ARTIFACT_DIR/acoustic-candidate-proof.json\""
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "VERIFY FAILED" >&2
  exit 1
fi

if [[ "$RELEASE" == "yes" ]]; then
  say "write: candidate-bound release test evidence"
  if ! node scripts/release-evidence-summary.mjs \
    --test-output "$RELEASE_TEST_SUMMARY" \
    --environment-output "$RELEASE_ENVIRONMENT_SUMMARY" \
    --environment-class "$RELEASE_ENVIRONMENT_CLASS" \
    --environment-provider "$RELEASE_ENVIRONMENT_PROVIDER" \
    --smoke-artifact-dir "$RELEASE_SMOKE_ARTIFACT_DIR"; then
    echo "    ✗ failed to write release test evidence" >&2
    exit 1
  fi
  say "write: signed HTTP canary release closure"
  if ! node scripts/http-canary-release-evidence.mjs \
    "${http_canary_release_args[@]}" \
    --output "$RELEASE_HTTP_CANARY_CLOSURE_OUTPUT"; then
    echo "    ✗ failed to write signed HTTP canary release closure" >&2
    exit 1
  fi
fi
echo
echo "VERIFY OK"
