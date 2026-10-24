#!/usr/bin/env bash
# Run a KQL query against a Log Analytics workspace using only core Azure CLI
# (az rest + Entra token), so no CLI extension is needed. Prints the first
# result table as TSV (one line per row).
#
# usage: law-query.sh <workspace-resource-id> '<KQL>' [timespan ISO8601, default PT1H]
set -euo pipefail

WS_ID="${1:?workspace resource id}"
KQL="${2:?KQL query}"
SPAN="${3:-PT1H}"

cid=$(az monitor log-analytics workspace show --ids "$WS_ID" --query customerId -o tsv)
body=$(jq -cn --arg q "$KQL" --arg t "$SPAN" '{query: $q, timespan: $t}')
az rest --method post \
  --uri "https://api.loganalytics.io/v1/workspaces/${cid}/query" \
  --resource "https://api.loganalytics.io" \
  --body "$body" -o json |
  jq -r '.tables[0].rows[] | map(tostring) | @tsv'
