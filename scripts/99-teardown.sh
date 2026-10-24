#!/usr/bin/env bash
# 99 — Teardown: deletes every eURC Project 02 resource so it stops using credit.
#
#   ./scripts/99-teardown.sh            Azure only (keeps the GitHub repo and its history)
#   ./scripts/99-teardown.sh --github   also delete the GitHub environments and variables
#
# Removes: prod delete locks, the four resource groups (all apps, databases,
# storage, vaults, networks, monitoring, deployment identities), purges the
# soft-deleted Key Vaults, and deletes the budget. Takes 10-20 minutes; run it
# inside tmux so a Cloud Shell timeout does not interrupt it.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require az jq
az_context

TARGET_RGS=("$(rg_for prod)" "$(rg_for test)" "$(rg_for dev)" "$RG_CICD")
echo "This permanently deletes, in subscription ${SUB_NAME}:"
for g in "${TARGET_RGS[@]}"; do
  printf '  %-22s %s\n' "$g" "$(az group exists -n "$g" | sed 's/true/(exists)/;s/false/(already gone)/')"
done
echo "  + purge of soft-deleted kv-eurc-* vaults, budget-eurc-monthly"
read -r -p "Type eURC to confirm: " answer
[[ "$answer" == "eURC" ]] || die "Cancelled"

LOG="${LOG_DIR}/99-teardown-$(stamp).log"
exec > >(tee -a "$LOG") 2>&1

step "Locks"
for g in "${TARGET_RGS[@]}"; do
  [[ "$(az group exists -n "$g")" == true ]] || continue
  az lock list -g "$g" --query "[].id" -o tsv | while read -r lid; do
    az lock delete --ids "$lid" -o none && ok "removed lock ${lid##*/} (${g})"
  done
done

step "Resource groups"
for g in "${TARGET_RGS[@]}"; do
  if [[ "$(az group exists -n "$g")" == true ]]; then
    az group delete -n "$g" --yes --no-wait && log "deleting ${g}"
  fi
done
for g in "${TARGET_RGS[@]}"; do
  az group wait -n "$g" --deleted --timeout 3600 2>/dev/null || true
  [[ "$(az group exists -n "$g")" == false ]] && ok "${g} deleted" || warn "${g} still exists"
done

step "Purge soft-deleted Key Vaults"
for kv in $(az keyvault list-deleted --resource-type vault --query "[?starts_with(name,'kv-eurc-')].name" -o tsv); do
  az keyvault purge -n "$kv" -o none && ok "purged ${kv}"
done

step "Budget"
az rest --method delete \
  --uri "https://management.azure.com/subscriptions/${SUB_ID}/providers/Microsoft.Consumption/budgets/budget-eurc-monthly?api-version=2023-05-01" \
  -o none 2>/dev/null && ok "budget-eurc-monthly deleted" || ok "no budget to delete"

if [[ "${1:-}" == "--github" ]]; then
  require gh
  step "GitHub environments and variables"
  REPO="${GITHUB_OWNER}/${GITHUB_REPO}"
  for e in $ENVIRONMENTS; do gh api -X DELETE "repos/${REPO}/environments/${e}" >/dev/null 2>&1 && ok "environment ${e} deleted"; done
  for v in AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do gh variable delete "$v" -R "$REPO" >/dev/null 2>&1 && ok "variable ${v} deleted"; done
fi

step "Verify"
left=""
for g in "${TARGET_RGS[@]}"; do [[ "$(az group exists -n "$g")" == true ]] && left+="$g "; done
vaults=$(az keyvault list-deleted --resource-type vault --query "[?starts_with(name,'kv-eurc-')].name" -o tsv)
[[ -z "$left" ]] && ok "no eURC Project 02 resource groups remain" || warn "still present: ${left}"
[[ -z "$vaults" ]] && ok "no soft-deleted eURC vaults remain" || warn "vaults pending purge: ${vaults}"
ok "Teardown complete. Log: ${LOG}"
