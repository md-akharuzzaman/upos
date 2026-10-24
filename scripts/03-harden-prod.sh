#!/usr/bin/env bash
# 03 — Production hardening (run after the first successful production release).
#
#  * CanNotDelete locks on the production data tier (SQL server, storage, Key Vault)
#    so neither a person nor the pipeline can delete them by mistake.
#  * Confirms the private endpoints are Approved and public access is off.
#  * Reports the Defender for Cloud secure score (free Foundational CSPM is on by default).
#
#   ./scripts/03-harden-prod.sh            add locks + verify
#   ./scripts/03-harden-prod.sh --unlock   remove the locks (teardown does this too)
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require az jq
az_context

RG=$(rg_for prod)
o=$(env_outputs prod)
[[ "$(out "$o" webAppName)" != "" ]] || die "Production has not been deployed yet (no eurc-main deployment in ${RG})"

ids=(
  "$(az sql server show -g "$RG" -n "$(out "$o" sqlServerName)" --query id -o tsv)"
  "$(az storage account show -g "$RG" -n "$(out "$o" storageAccountName)" --query id -o tsv)"
  "$(az keyvault show -g "$RG" -n "$(out "$o" keyVaultName)" --query id -o tsv)"
)

if [[ "${1:-}" == "--unlock" ]]; then
  step "Removing locks"
  for id in "${ids[@]}"; do
    az lock delete --name lock-eurc-nodelete --resource "$id" -o none 2>/dev/null && ok "unlocked ${id##*/}" || true
  done
  exit 0
fi

step "Delete locks on the production data tier"
for id in "${ids[@]}"; do
  az lock create --name lock-eurc-nodelete --lock-type CanNotDelete --resource "$id" \
    --notes "eURC prod data - remove with 03-harden-prod.sh --unlock" -o none
  ok "CanNotDelete: ${id##*/}"
done

step "Private endpoints"
az network private-endpoint list -g "$RG" \
  --query "[].{name:name, status:privateLinkServiceConnections[0].privateLinkServiceConnectionState.status}" -o tsv |
  while read -r name status; do
    [[ "$status" == "Approved" ]] && ok "${name}: ${status}" || warn "${name}: ${status}"
  done

step "Public network access (expected: Disabled)"
printf '  SQL      %s\n' "$(az sql server show --ids "${ids[0]}" --query publicNetworkAccess -o tsv)"
printf '  Storage  %s\n' "$(az storage account show --ids "${ids[1]}" --query publicNetworkAccess -o tsv)"
printf '  KeyVault %s\n' "$(az keyvault show -g "$RG" -n "$(out "$o" keyVaultName)" --query properties.publicNetworkAccess -o tsv)"

step "Defender for Cloud secure score"
score=$(az rest --method get \
  --uri "https://management.azure.com/subscriptions/${SUB_ID}/providers/Microsoft.Security/secureScores/ascScore?api-version=2020-01-01" \
  --query "properties.score.percentage" -o tsv 2>/dev/null || echo "n/a")
ok "Secure score: ${score} (updates within 24 h of new resources)"
