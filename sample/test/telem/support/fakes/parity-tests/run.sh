#!/usr/bin/env bash
# Runs all parity suites for fakes that have a live counterpart.
# Blocked suites (fake-mysql — needs a running MySQL instance) are skipped here.
#
# Usage:
#   npm run bdd-test:fakes-parity        # run all covered suites
#   ./test/telem/support/fakes/parity-tests/run.sh  # same, directly

set -euo pipefail
cd "$(dirname "$0")/../../../../../"

# Runs one parity suite and fails if it errors at load OR executes zero tests.
# A stale import throws at load (npx tsx exits non-zero → set -e catches it). A suite
# that loads but runs nothing prints no PARITY_TESTS_RUN marker → we exit 1 here, so a
# silently-disabled suite can never read green.
run_parity() {
  local name="$1" file="$2"
  echo "=== $name ==="
  local output
  output="$(npx tsx "$file")"
  echo "$output"
  local count
  count="$(printf '%s\n' "$output" | sed -n 's/^PARITY_TESTS_RUN=//p' | tail -1)"
  if [[ -z "$count" || "$count" -le 0 ]]; then
    echo "✗ $name executed zero tests — parity is silently disabled" >&2
    exit 1
  fi
  echo "  → $name ran $count tests"
}

run_parity "fake-fetch parity" test/telem/support/fakes/parity-tests/fake-fetch.parity.ts

# Add covered fakes here as they graduate from Blocked → Covered:
# PARITY_MYSQL=true run_parity "fake-mysql parity" test/telem/support/fakes/parity-tests/fake-mysql.parity.ts
