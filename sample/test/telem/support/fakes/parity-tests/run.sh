#!/usr/bin/env bash
# Runs every parity suite — the single entry point (npm run bdd-test:fakes-parity); never add per-fake scripts.
#
#   fake-fetch  in-process loopback HTTP server; no container.
#   fake-db     fake repositories vs the real src/db/* on a real MySQL 8 (compose.parity.yaml).
#   fake-kafka  fake Kafka driver + offset-commit capture vs a real KafkaJS consumer on Apache Kafka (compose.parity.yaml).
#
# Docker missing / MySQL or Kafka unreachable → the container-backed suites SKIP (recorded, loud). There is no CI,
# so a skip means parity did not run at all; set CI=1 to make a skip a failure.
#
# Env: PARITY_MYSQL_PORT (default 3307), PARITY_KAFKA_PORT (default 9392), PARITY_COMPOSE_PROJECT
# (default webhooks-parity; set it to run two parity runs side by side without sharing containers),
# CI (any non-empty value makes skips fatal).

set -euo pipefail
cd "$(dirname "$0")/../../../../../"

PARITY_DIR=test/telem/support/fakes/parity-tests
COMPOSE=(docker compose -p "${PARITY_COMPOSE_PROJECT:-webhooks-parity}" -f "$PARITY_DIR/compose.parity.yaml")
export PARITY_MYSQL_PORT="${PARITY_MYSQL_PORT:-3307}"
export PARITY_KAFKA_PORT="${PARITY_KAFKA_PORT:-9392}"

started=0
cleanup() {
  if [[ "$started" == 1 ]]; then "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "=== starting MySQL (port $PARITY_MYSQL_PORT) and Kafka (port $PARITY_KAFKA_PORT) for parity ==="
  if "${COMPOSE[@]}" up -d --wait >/dev/null; then started=1; else echo "✗ could not start the parity containers" >&2; fi
else
  echo "⚠ Docker is not available — fake-db and fake-kafka parity cannot start their containers." >&2
fi

skipped=0

# Runs one parity suite and fails if it errors at load, diverges, OR executes zero tests.
# A stale import throws at load (non-zero exit); a suite that loads but runs nothing prints no
# PARITY_TESTS_RUN marker, so we exit 1 here — a silently-disabled suite can never read green.
run_parity() {
  local name="$1" file="$2"
  echo "=== $name ==="
  local output
  if ! output="$(npx tsx "$file" 2>&1)"; then
    echo "$output" >&2
    echo "✗ $name failed" >&2
    exit 1
  fi
  echo "$output"
  if printf '%s\n' "$output" | grep -q '^PARITY_SKIPPED='; then
    if [[ -n "${CI:-}" ]]; then
      echo "✗ $name SKIPPED with CI set — the real side must be reachable (see compose.parity.yaml)" >&2
      exit 1
    fi
    skipped=$((skipped + 1))
    return
  fi
  local count
  count="$(printf '%s\n' "$output" | sed -n 's/^PARITY_TESTS_RUN=//p' | tail -1)"
  if [[ -z "$count" || "$count" -le 0 ]]; then
    echo "✗ $name executed zero tests — parity is silently disabled" >&2
    exit 1
  fi
  echo "  → $name ran $count tests"
}

run_parity "fake-fetch parity" "$PARITY_DIR/fake-fetch.parity.ts"
run_parity "fake-db parity" "$PARITY_DIR/fake-db.parity.ts"
run_parity "fake-kafka parity" "$PARITY_DIR/fake-kafka.parity.ts"

if [[ "$skipped" -gt 0 ]]; then
  echo "⚠ $skipped parity suite(s) SKIPPED — parity did NOT run for them (there is no CI to catch it). Start Docker and re-run." >&2
fi
