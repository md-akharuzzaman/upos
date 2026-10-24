#!/usr/bin/env bash
# 00 — Preflight: tools, logins, subscription, region and SKU availability.
# Safe to run any time; changes nothing except registering resource providers.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

step "Tools"
require az jq git gh node curl zip
ok "az $(az version --query '"azure-cli"' -o tsv), gh $(gh --version | head -1 | awk '{print $3}'), node $(node --version), jq, git"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node 18+ needed for the test suites"

step "Configuration"
check_config
ok "GitHub repo: ${GITHUB_OWNER}/${GITHUB_REPO} (${GITHUB_VISIBILITY}); alerts to ${ALERT_EMAIL}"

step "Azure login"
az_context
state=$(az account show --query state -o tsv)
[[ "$state" == "Enabled" ]] || die "Subscription state is '$state'"
ok "Subscription: ${SUB_NAME} (${SUB_ID}), tenant ${TENANT_ID}"
me=$(az ad signed-in-user show --query userPrincipalName -o tsv 2>/dev/null || echo "unknown")
ok "Signed in as: ${me}"

step "Role on the subscription"
my_oid=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
if [[ -n "$my_oid" ]]; then
  roles=$(az role assignment list --assignee "$my_oid" --scope "/subscriptions/${SUB_ID}" --include-inherited \
            --query "[].roleDefinitionName" -o tsv | sort -u | tr '\n' ' ')
  [[ "$roles" == *Owner* || "$roles" == *"User Access Administrator"* ]] \
    || die "You need Owner (or User Access Administrator + Contributor) to create role assignments. You have: ${roles:-none}"
  ok "Roles: ${roles}"
else
  warn "Could not read your user object; continuing"
fi

step "Resource providers"
for p in Microsoft.Web Microsoft.Sql Microsoft.Storage Microsoft.KeyVault Microsoft.Insights \
         Microsoft.OperationalInsights Microsoft.ManagedIdentity Microsoft.Network Microsoft.AlertsManagement \
         Microsoft.Consumption Microsoft.CostManagement; do
  st=$(az provider show -n "$p" --query registrationState -o tsv 2>/dev/null || echo NotFound)
  if [[ "$st" != "Registered" ]]; then
    az provider register -n "$p" --wait -o none && ok "$p registered" || warn "$p could not be registered"
  else
    ok "$p"
  fi
done

step "Region ${LOCATION}"
az account list-locations --query "[?name=='${LOCATION}'].displayName" -o tsv | grep -q . || die "Unknown region ${LOCATION}"
policy_regions=$(az policy assignment list --disable-scope-strict-match \
  --query "[?contains(displayName || '', 'llowed') && contains(displayName || '', 'ocation')].parameters.listOfAllowedLocations.value" -o tsv 2>/dev/null | tr '\t\n' '  ')
if [[ -n "${policy_regions// /}" ]]; then
  [[ " $policy_regions " == *" ${LOCATION} "* ]] || die "${LOCATION} is not in your allowed-locations policy: ${policy_regions}"
  ok "${LOCATION} allowed by policy (${policy_regions})"
else
  ok "No allowed-locations policy restricts ${LOCATION}"
fi

step "Service availability in ${LOCATION}"
az sql db list-editions -l "$LOCATION" --edition Basic --available --query "[].name" -o tsv | grep -q Basic \
  && ok "Azure SQL Basic available" || die "Azure SQL Basic is not available to this subscription in ${LOCATION}"
display=$(az account list-locations --query "[?name=='${LOCATION}'].displayName" -o tsv)
has_sku() { az appservice list-locations --sku "$1" --linux-workers-enabled --query "[].name" -o tsv | grep -qi "^${display}$"; }
if has_sku B1; then ok "App Service B1 (Linux) available"; else die "App Service B1 (Linux) not offered in ${LOCATION}"; fi
prod_sku=$(grep -E "^param appServiceSku" "${ROOT_DIR}/infra/env/prod.bicepparam" | sed -E "s/.*'([A-Za-z0-9]+)'.*/\1/")
if has_sku S1; then
  ok "App Service S1 (Linux) available - production gets a staging slot"
elif [[ "$prod_sku" == "B1" ]]; then
  warn "App Service S1 not offered; production is already set to B1 without a staging slot (fallback)"
else
  die "App Service S1 (Linux) not offered in ${LOCATION}. Fallback: in infra/env/prod.bicepparam set appServiceSku = 'B1' and enableStagingSlot = false, then re-run."
fi

step "GitHub"
gh auth status >/dev/null 2>&1 || die "GitHub CLI not logged in. Run: gh auth login   (choose GitHub.com, HTTPS, login with a web browser)"
gh_user=$(gh api user --jq .login)
ok "gh logged in as ${gh_user}"
scopes=$(gh auth status 2>&1 | grep -i 'token scopes' || true)
[[ -z "$scopes" || "$scopes" == *repo* ]] || warn "gh token may lack the 'repo' scope: ${scopes}"
[[ "$scopes" == *workflow* || -z "$scopes" ]] || warn "gh token lacks 'workflow' scope (needed to push .github/workflows). Run: gh auth refresh -s workflow"

echo
ok "Preflight passed. Next: ./scripts/01-bootstrap-azure.sh"
