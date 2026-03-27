#!/usr/bin/env bash
set -euo pipefail

# A2A Scenario Health-check wrapper (cron/CI friendly)
#
# Usage:
#   scripts/a2a_healthcheck.sh single   # runs single_agent_iteration
#   scripts/a2a_healthcheck.sh multi    # runs multi_agent_review_loop
#   scripts/a2a_healthcheck.sh all      # runs both (single then multi)
#
# Env passthrough (optional):
#   A2A_BASE_URL, A2A_PROJECT_SLUG, A2A_PARENT_TASK_ID,
#   A2A_REVIEWER_HANDLE, A2A_REVIEWER_TOKEN,
#   A2A_WORKER_HANDLE, A2A_WORKER_TOKEN,
#   A2A_SCENARIO_ARTIFACTS_DIR

MODE=${1:-single}

run_one() {
  local SCENARIO=$1
  node scripts/a2a_scenario_runner.mjs "$SCENARIO"
}

case "$MODE" in
  single)
    run_one single_agent_iteration
    ;;
  multi)
    run_one multi_agent_review_loop
    ;;
  all)
    run_one single_agent_iteration
    run_one multi_agent_review_loop
    ;;
  *)
    echo "Usage: $0 {single|multi|all}" >&2
    exit 2
    ;;
esac
