#!/usr/bin/env bash
# 01 — Azure bootstrap (run once, as subscription Owner, in Cloud Shell).
#
# Creates the things the pipeline cannot create for itself:
#   * resource groups: rg-eurc-cicd-cc, rg-eurc-dev-cc, rg-eurc-test-cc, rg-eurc-prod-cc
#   * one deployment identity per environment (user-assigned managed identity)
#     id-eurc-gh-<env>-cc, trusted ONLY by GitHub Actions jobs that run in the
#     matching GitHub environment (OIDC federated credential, no secrets)
#   * least-privilege RBAC: each identity is Contributor on its own resource
#     group only, plus a *constrained* RBAC Administrator role that can assign
#     just two data roles (Key Vault Secrets Officer, Storage Blob Data
#     Contributor) to service principals — nothing else.
#   * a monthly budget with email alerts
# Re-runnable: existing items are detected and left as they are.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require az jq
check_config
az_context

ROLE_KV_SECRETS_OFFICER="b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
ROLE_BLOB_DATA_CONTRIBUTOR="ba92f5b4-2d11-453d-a403-e96b0029c9fe"
OIDC_ISSUER="https://token.actions.githubusercontent.com"
OIDC_AUDIENCE="api://AzureADTokenExchange"

# The deployment identity may create/delete role assignments only for the two
# data roles above, and only for service principals (managed identities).
RBAC_CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${ROLE_KV_SECRETS_OFFICER}, ${ROLE_BLOB_DATA_CONTRIBUTOR}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${ROLE_KV_SECRETS_OFFICER}, ${ROLE_BLOB_DATA_CONTRIBUTOR}}))"

LOG="${LOG_DIR}/01-bootstrap-$(stamp).log"
exec > >(tee -a "$LOG") 2>&1
log "Subscription ${SUB_NAME} (${SUB_ID}); log: ${LOG}"

step "Resource groups"
ensure_rg() {
  local name=$1 env=$2
  # shellcheck disable=SC2046
  az group create -n "$name" -l "$LOCATION" --tags $(rg_tags "$env") -o none
  ok "$name"
}
ensure_rg "$RG_CICD" shared
for e in $ENVIRONMENTS; do ensure_rg "$(rg_for "$e")" "$e"; done

has_role() { # <principalId> <role> <scope>
  [[ -n "$(az role assignment list --assignee "$1" --role "$2" --scope "$3" --query '[0].id' -o tsv 2>/dev/null)" ]]
}

declare -A CLIENT_IDS
for e in $ENVIRONMENTS; do
  step "Deployment identity for ${e}"
  id_name="id-eurc-gh-${e}-${LOC_SHORT}"
  rg_env=$(rg_for "$e")
  scope="/subscriptions/${SUB_ID}/resourceGroups/${rg_env}"

  # shellcheck disable=SC2046
  az identity create -g "$RG_CICD" -n "$id_name" -l "$LOCATION" --tags $(rg_tags "$e") -o none
  client_id=$(az identity show -g "$RG_CICD" -n "$id_name" --query clientId -o tsv)
  principal_id=$(az identity show -g "$RG_CICD" -n "$id_name" --query principalId -o tsv)
  CLIENT_IDS[$e]=$client_id
  ok "${id_name} clientId=${client_id}"

  subject="repo:${GITHUB_OWNER}/${GITHUB_REPO}:environment:${e}"
  fc_name="fc-github-${GITHUB_REPO}-${e}"
  existing=$(az identity federated-credential list -g "$RG_CICD" --identity-name "$id_name" \
               --query "[?subject=='${subject}'].name" -o tsv)
  if [[ -z "$existing" ]]; then
    az identity federated-credential create -g "$RG_CICD" --identity-name "$id_name" -n "$fc_name" \
      --issuer "$OIDC_ISSUER" --subject "$subject" --audiences "$OIDC_AUDIENCE" -o none
    ok "federated credential: ${subject}"
  else
    ok "federated credential exists: ${subject}"
  fi

  if has_role "$principal_id" Contributor "$scope"; then
    ok "Contributor on ${rg_env} (exists)"
  else
    retry 6 20 az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal \
      --role Contributor --scope "$scope" --description "eURC GitHub Actions ${e} deployments" -o none
    ok "Contributor on ${rg_env}"
  fi

  if has_role "$principal_id" "Role Based Access Control Administrator" "$scope"; then
    ok "Constrained RBAC Administrator on ${rg_env} (exists)"
  else
    retry 6 20 az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal \
      --role "Role Based Access Control Administrator" --scope "$scope" \
      --condition "$RBAC_CONDITION" --condition-version "2.0" \
      --description "eURC ${e}: may assign only Key Vault Secrets Officer / Storage Blob Data Contributor to managed identities" -o none
    ok "Constrained RBAC Administrator on ${rg_env}"
  fi
done

step "Budget"
budget_name="budget-eurc-monthly"
start=$(date -u +%Y-%m-01)
end=$(date -u -d "${start} +1 year" +%Y-%m-01)
rg_list=$( { echo "$RG_CICD"; for e in $ENVIRONMENTS; do rg_for "$e"; done; } | jq -R . | paste -sd, -)
body=$(cat <<JSON
{
  "properties": {
    "category": "Cost",
    "amount": ${BUDGET_AMOUNT},
    "timeGrain": "Monthly",
    "timePeriod": { "startDate": "${start}T00:00:00Z", "endDate": "${end}T00:00:00Z" },
    "filter": { "dimensions": { "name": "ResourceGroupName", "operator": "In", "values": [${rg_list}] } },
    "notifications": {
      "actual50":   { "enabled": true, "operator": "GreaterThan", "threshold": 50,  "thresholdType": "Actual",   "contactEmails": ["${ALERT_EMAIL}"] },
      "actual80":   { "enabled": true, "operator": "GreaterThan", "threshold": 80,  "thresholdType": "Actual",   "contactEmails": ["${ALERT_EMAIL}"] },
      "forecast100":{ "enabled": true, "operator": "GreaterThan", "threshold": 100, "thresholdType": "Forecasted","contactEmails": ["${ALERT_EMAIL}"] }
    }
  }
}
JSON
)
if az rest --method put \
     --uri "https://management.azure.com/subscriptions/${SUB_ID}/providers/Microsoft.Consumption/budgets/${budget_name}?api-version=2023-05-01" \
     --body "$body" -o none 2>"${LOG_DIR}/budget-error.txt"; then
  ok "${budget_name}: ${BUDGET_AMOUNT}/month, alerts at 50 % / 80 % actual and 100 % forecast"
else
  warn "Budget not created (some student offers do not support budgets yet): $(head -c 300 "${LOG_DIR}/budget-error.txt")"
fi

step "Values for GitHub"
OUT="${ROOT_DIR}/.github-values.env"
{
  echo "AZURE_TENANT_ID=${TENANT_ID}"
  echo "AZURE_SUBSCRIPTION_ID=${SUB_ID}"
  for e in $ENVIRONMENTS; do
    echo "AZURE_CLIENT_ID_${e^^}=${CLIENT_IDS[$e]}"
    echo "AZURE_RESOURCE_GROUP_${e^^}=$(rg_for "$e")"
  done
} > "$OUT"
cat "$OUT"
echo
ok "Bootstrap complete (none of these values are secrets). Next: ./scripts/02-setup-github.sh"
