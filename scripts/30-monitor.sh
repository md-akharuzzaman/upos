#!/usr/bin/env bash
# 30 — Operations monitor across dev, test and prod.
#
#   ./scripts/30-monitor.sh                  snapshot of all environments (+ markdown report)
#   ./scripts/30-monitor.sh --watch 60       refresh the snapshot every 60 s (Ctrl+C to stop)
#   ./scripts/30-monitor.sh --load test 120  send 120 s of traffic to an environment, then snapshot
#   ./scripts/30-monitor.sh --dora           delivery metrics from GitHub Actions history
#   ./scripts/30-monitor.sh --test-alert     send a test notification through the prod action group
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require az jq curl node
az_context

ROW_FMT='%-5s %-11s %-26s %-10s %8s %8s %8s %6s\n'
# shellcheck disable=SC2059  # ROW_FMT is a fixed format string defined here

env_row() { # prints one line per slot for an environment
  local env=$1 o url stag rg ws
  rg=$(rg_for "$env")
  o=$(env_outputs "$env")
  url=$(out "$o" webAppUrl); stag=$(out "$o" stagingUrl); ws=$(out "$o" logAnalyticsWorkspaceId)
  if [[ -z "$url" ]]; then printf "$ROW_FMT" "$env" "-" "not deployed" "-" "-" "-" "-" "-"; return; fi

  local stats req fail p95 exc
  stats=$(bash "${ROOT_DIR}/scripts/law-query.sh" "$ws" \
    "AppRequests | where TimeGenerated > ago(1h) | summarize req=count(), fail=countif(Success == false), p95=round(percentile(DurationMs,95),0)
     | extend exc = toscalar(AppExceptions | where TimeGenerated > ago(1h) | count)" PT1H 2>/dev/null || echo "? ? ? ?")
  read -r req fail p95 exc <<<"$stats"

  local slot u h v
  for slot in production staging; do
    u=$([[ $slot == production ]] && echo "$url" || echo "$stag")
    [[ -z "$u" ]] && continue
    h=$(curl -s --max-time 15 "$u/health" || echo '{}')
    v=$(jq -r '.version // "unreachable"' <<<"$h" 2>/dev/null || echo unreachable)
    printf "$ROW_FMT" "$env" "$slot" "$v" "$(jq -r '.status // "-"' <<<"$h" 2>/dev/null)" \
      "$([[ $slot == production ]] && echo "${req:-?}" || echo "")" \
      "$([[ $slot == production ]] && echo "${fail:-?}" || echo "")" \
      "$([[ $slot == production ]] && echo "${p95:-?}" || echo "")" \
      "$([[ $slot == production ]] && echo "${exc:-?}" || echo "")"
  done
  : "$rg"
}

snapshot() {
  local report
  report="${REPORT_DIR}/monitor-$(stamp).md"
  {
    echo "eURC operations snapshot — $(date -u '+%F %T') UTC"
    echo
    # shellcheck disable=SC2059
    printf "$ROW_FMT" ENV SLOT VERSION HEALTH "REQ/1h" "FAIL/1h" "P95(ms)" EXC
    for e in $ENVIRONMENTS; do env_row "$e"; done
    echo
    echo "Fired alerts (last 24 h, prod):"
    az rest --method get \
      --uri "https://management.azure.com/subscriptions/${SUB_ID}/providers/Microsoft.AlertsManagement/alerts?api-version=2019-05-05-preview&timeRange=1d&targetResourceGroup=$(rg_for prod)" \
      --query "value[].{time:properties.essentials.startDateTime, severity:properties.essentials.severity, state:properties.essentials.monitorCondition, name:name}" \
      -o table 2>/dev/null || echo "  (none or not available)"
    echo
    echo "Cost month-to-date by resource group (from Cost Management, may lag ~24 h):"
    az rest --method post \
      --uri "https://management.azure.com/subscriptions/${SUB_ID}/providers/Microsoft.CostManagement/query?api-version=2023-03-01" \
      --body '{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"None","aggregation":{"cost":{"name":"Cost","function":"Sum"}},"grouping":[{"type":"Dimension","name":"ResourceGroupName"}],"filter":{"tags":{"name":"application","operator":"In","values":["eurc"]}}}}' \
      -o json 2>/dev/null | jq -r '.properties.rows[]? | "  \(.[1])\t\(.[0] | . * 100 | round / 100) \(.[2])"' || echo "  (not available for this offer)"
  } | tee "$report"
  echo; ok "Saved ${report}"
}

case "${1:-}" in
  "")
    snapshot ;;
  --watch)
    every=${2:-60}
    while true; do clear; snapshot; sleep "$every"; done ;;
  --load)
    env=${2:-test}; secs=${3:-120}
    url=$(out "$(env_outputs "$env")" webAppUrl)
    [[ -n "$url" ]] || die "$env is not deployed"
    log "Sending ${secs}s of traffic to ${env} (${url})"
    node "${ROOT_DIR}/tests/load.mjs" --url "$url" --duration "$secs" --concurrency 5 --junit "${REPORT_DIR}/load-${env}.xml" || true
    log "Waiting 120 s for telemetry ingestion"; sleep 120
    snapshot ;;
  --test-alert)
    az monitor action-group test-notifications create -g "$(rg_for prod)" --action-group ag-eurc-ops-prod \
      --alert-type metricstaticthreshold -a email ops-email "$ALERT_EMAIL" usecommonalertschema -o none
    ok "Test notification sent to ${ALERT_EMAIL} through ag-eurc-ops-prod (check your inbox)" ;;
  --dora)
    require gh
    REPO="${GITHUB_OWNER}/${GITHUB_REPO}"
    step "Delivery metrics (last 30 CD runs on main) — ${REPO}"
    runs=$(gh run list -R "$REPO" --workflow cd.yml --branch main --limit 30 \
             --json databaseId,headSha,createdAt,conclusion,event)
    total=0 prod_ok=0 prod_fail=0 lead_sum=0
    while read -r id sha created; do
      total=$((total + 1))
      job=$(gh run view "$id" -R "$REPO" --json jobs --jq '.jobs[] | select(.name=="prod") | [.conclusion, .completedAt] | @tsv' 2>/dev/null || true)
      read -r concl done_at <<<"${job:-none none}"
      case "$concl" in
        success)
          prod_ok=$((prod_ok + 1))
          commit_t=$(gh api "repos/${REPO}/commits/${sha}" --jq .commit.committer.date)
          lead_sum=$((lead_sum + $(date -d "$done_at" +%s) - $(date -d "$commit_t" +%s))) ;;
        failure) prod_fail=$((prod_fail + 1)) ;;
      esac
      : "$created"
    done < <(jq -r '.[] | [.databaseId, .headSha, .createdAt] | @tsv' <<<"$runs")
    first=$(jq -r 'last.createdAt' <<<"$runs"); days=$(( ( $(date +%s) - $(date -d "$first" +%s) ) / 86400 + 1 ))
    printf '  CD runs analysed        %s over %s day(s)\n' "$total" "$days"
    printf '  Deployment frequency    %s production release(s) (%s per day)\n' "$prod_ok" "$(awk -v a="$prod_ok" -v d="$days" 'BEGIN{printf "%.2f", a/d}')"
    [[ $prod_ok -gt 0 ]] && printf '  Lead time for changes   %s min average (commit -> live in prod, incl. approval wait)\n' $((lead_sum / prod_ok / 60))
    attempts=$((prod_ok + prod_fail))
    [[ $attempts -gt 0 ]] && printf '  Change failure rate     %s %% (%s failed of %s production attempts)\n' \
      "$(awk -v f="$prod_fail" -v a="$attempts" 'BEGIN{printf "%.0f", f*100/a}')" "$prod_fail" "$attempts"
    echo "  Time to restore         see the Rollback production workflow runs (swap back takes ~1-2 min)" ;;
  *)
    die "unknown option ${1}. Use --watch N | --load ENV SECONDS | --dora | --test-alert" ;;
esac
