#!/usr/bin/env bash
# Swap the staging slot into production in two phases ("swap with preview"),
# so a slow start can no longer hit App Service's fixed swap warm-up timeout
# (CD #3 for v2.2 and CD #4 for v2.3 both failed that way):
#   1. preview  - production's slot settings (EURC_SLOT=production) are applied
#                 to the staging slot, which restarts; production is untouched
#   2. wait     - smoke test the staging slot with those settings, up to 15 min,
#                 until it is Healthy (SQL, Blob, Key Vault) and on the right version
#   3. swap     - traffic switches; staging is already warm, so it takes seconds
# Any failure before the switch resets the preview: production keeps running.
#
# usage: swap-slots.sh <resource-group> <app> <staging-url> [expected-version] [junit-file]
set -euo pipefail
rg=$1
app=$2
url=$3
version=${4:-}
junit=${5:-reports/smoke-swap-preview.xml}

swap() { az webapp deployment slot swap -g "$rg" -n "$app" --slot staging --target-slot production --action "$1" -o none; }
reset() {
  echo "::warning::swap cancelled - resetting the preview, production is unchanged"
  swap reset || echo "::error::reset failed - run: az webapp deployment slot swap -g $rg -n $app --slot staging --action reset"
  exit 1
}

echo "phase 1/3: preview - apply production settings to the staging slot ($(date -u +%T) UTC)"
swap preview || reset

echo "phase 2/3: wait until the staging slot is healthy with production settings"
args=(--url "$url" --expect-env prod --expect-slot production --wait 900 --junit "$junit")
if [ -n "$version" ]; then args+=(--expect-version "$version"); fi
node tests/smoke.mjs "${args[@]}" || reset

echo "phase 3/3: swap ($(date -u +%T) UTC)"
swap swap || reset
echo "swapped at $(date -u +%T) UTC"
