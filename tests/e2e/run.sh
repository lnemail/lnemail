#!/usr/bin/env bash
# Convenience runner for the e2e suite.
#
#   ./tests/e2e/run.sh                # fully headless
#   ./tests/e2e/run.sh --watch        # headed + slowmo, easier to follow
#   ./tests/e2e/run.sh -- -k signup   # forward extra args to pytest
#
# Videos and on-failure screenshots are saved to tests/e2e/artifacts/
# (gitignored). Add --tracing on for Playwright traces too.
set -euo pipefail

cd "$(dirname "$0")/../.."

WATCH=0
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --) shift; PASSTHROUGH=("$@"); break ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

ARGS=(tests/e2e -v)
if [ "$WATCH" -eq 1 ]; then
  ARGS+=(--headed --slowmo=300 --browser=chromium)
fi

# Always-on artifacts: video via record_video_dir in conftest; traces and
# screenshots via pytest-playwright's flags. Traces are kept on failure.
ARGS+=(
  --tracing=retain-on-failure
  --screenshot=only-on-failure
  --output=tests/e2e/artifacts/playwright
)

exec python -m pytest "${ARGS[@]}" "${PASSTHROUGH[@]}"
