#!/usr/bin/env bash
# Refresh the saved plan-page fixtures used by test/run.mjs
set -euo pipefail
cd "$(dirname "$0")/fixtures"
for plan in go goat pro max; do
  curl -sL "https://commandcode.ai/docs/plans/$plan" -o "$plan.html"
  echo "$plan: $(wc -c < "$plan.html") bytes"
done
