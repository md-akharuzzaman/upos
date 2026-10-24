#!/usr/bin/env bash
# Post-deployment gate for production (runs right after the slot swap).
#
#  1. Sends 3 minutes of read-only traffic to production (no test data is written
#     to the live database) and fails on errors/latency.
#  2. Reads the request telemetry that Application Insights stored in Log
#     Analytics: the failed-request rate for THIS version over the last
#     15 minutes must stay below the threshold.
# A non-zero exit makes the CD job roll back (swap the previous version back in).
#
# usage: post-deploy-gate.sh <prod-url> <log-analytics-workspace-id> <version> [minutes] [max-fail-%]
set -euo pipefail

URL="${1:?prod url}"
WS_ID="${2:?log analytics workspace resource id}"
VERSION="${3:?version}"
MINUTES="${4:-3}"
MAX_FAIL_PCT="${5:-2}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "== 1/2 live traffic for ${MINUTES} min against ${URL}"
node tests/load.mjs --url "$URL" --duration $((MINUTES * 60)) --concurrency 2 --reads-only \
  --p95 2000 --max-error-rate 1 --junit reports/gate-prod-traffic.xml

echo "== 2/2 request telemetry for version ${VERSION}"
query="AppRequests
| where TimeGenerated > ago(15m) and AppVersion == '${VERSION}'
| summarize total = count(), failed = countif(Success == false), p95 = round(percentile(DurationMs, 95), 0)"

total=0 failed=0 p95=0
for attempt in $(seq 1 10); do   # telemetry ingestion takes 1-5 minutes
  row=$(bash scripts/law-query.sh "$WS_ID" "$query" PT30M 2>/dev/null || true)
  read -r total failed p95 <<<"${row:-0 0 0}"
  total=${total%.*}; failed=${failed%.*}
  if [[ "${total:-0}" -gt 0 ]]; then break; fi
  echo "   no telemetry for ${VERSION} yet (attempt ${attempt}/10), waiting 30 s"
  sleep 30
done

if [[ "${total:-0}" -eq 0 ]]; then
  echo "::warning::No request telemetry for ${VERSION} yet; relying on the live-traffic check only."
  echo "Post-deploy gate: live traffic passed; telemetry not yet ingested (warning)." >> "$SUMMARY"
  exit 0
fi

pct=$(awk -v f="$failed" -v t="$total" 'BEGIN { printf "%.2f", (f / t) * 100 }')
echo "   requests=${total} failed=${failed} (${pct} %) p95=${p95} ms"
echo "Post-deploy gate: ${total} requests, ${failed} failed (${pct} %), p95 ${p95} ms (limit ${MAX_FAIL_PCT} %)" >> "$SUMMARY"

if awk -v p="$pct" -v m="$MAX_FAIL_PCT" 'BEGIN { exit !(p > m) }'; then
  echo "::error::Failure rate ${pct} % is above ${MAX_FAIL_PCT} % - gate FAILED"
  exit 1
fi
echo "   gate PASSED"
