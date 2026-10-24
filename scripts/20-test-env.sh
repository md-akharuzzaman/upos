#!/usr/bin/env bash
# 20 — Environment conformance + functional tests, from Cloud Shell.
#
#   ./scripts/20-test-env.sh            all environments
#   ./scripts/20-test-env.sh prod       one environment
#   ./scripts/20-test-env.sh test --integration
#
# Checks that each environment matches its design (security settings, private
# networking in prod, slot, alerts), proves the prod data tier is NOT reachable
# from the internet, then runs the same smoke suite the pipeline uses.
# Writes reports/test-<env>-<timestamp>.md
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require az jq curl node
az_context

TARGETS=()
INTEGRATION=false
for a in "$@"; do
  case "$a" in
    --integration) INTEGRATION=true ;;
    dev|test|prod) TARGETS+=("$a") ;;
    *) die "unknown argument: $a" ;;
  esac
done
[[ ${#TARGETS[@]} -gt 0 ]] || read -r -a TARGETS <<<"$ENVIRONMENTS"

TOTAL_FAIL=0
for ENV in "${TARGETS[@]}"; do
  RG=$(rg_for "$ENV")
  REPORT="${REPORT_DIR}/test-${ENV}-$(stamp).md"
  PASS=0 FAIL=0
  { echo "# eURC ${ENV} — environment test"; echo; echo "Run: $(date -u '+%F %T') UTC · subscription ${SUB_NAME}"; echo
    echo "| Result | Check | Detail |"; echo "|---|---|---|"; } > "$REPORT"

  check() { # <description> <expected> <actual>
    if [[ "$3" == "$2" ]]; then PASS=$((PASS + 1)); ok "$1 = $3"; echo "| PASS | $1 | $3 |" >> "$REPORT"
    else FAIL=$((FAIL + 1)); warn "$1: expected '$2', got '$3'"; echo "| FAIL | $1 | expected $2, got $3 |" >> "$REPORT"; fi
  }
  check_ge() { # <description> <min> <actual>
    if [[ "${3:-0}" -ge "$2" ]]; then PASS=$((PASS + 1)); ok "$1 = $3 (>= $2)"; echo "| PASS | $1 | $3 |" >> "$REPORT"
    else FAIL=$((FAIL + 1)); warn "$1: expected >= $2, got ${3:-0}"; echo "| FAIL | $1 | expected >= $2, got ${3:-0} |" >> "$REPORT"; fi
  }

  step "${ENV}: ${RG}"
  o=$(env_outputs "$ENV")
  APP=$(out "$o" webAppName)
  if [[ -z "$APP" ]]; then
    warn "${ENV} not deployed yet (no eurc-main deployment) — skipping"
    echo "| SKIP | deployment | not deployed yet |" >> "$REPORT"
    continue
  fi
  URL=$(out "$o" webAppUrl)
  SQL=$(out "$o" sqlServerName); ST=$(out "$o" storageAccountName); KV=$(out "$o" keyVaultName)
  private=$([[ "$ENV" == "prod" ]] && echo true || echo false)
  pna_expect=$([[ "$private" == true ]] && echo Disabled || echo Enabled)

  check "resource group tag environment" "$ENV" "$(az group show -n "$RG" --query tags.environment -o tsv)"

  # --- App Service ---------------------------------------------------------
  site=$(az webapp show -g "$RG" -n "$APP" -o json)
  cfg=$(az webapp config show -g "$RG" -n "$APP" -o json)
  check "web: HTTPS only" true "$(jq -r .httpsOnly <<<"$site")"
  check "web: identity type" UserAssigned "$(jq -r .identity.type <<<"$site")"
  check "web: runtime" "NODE|22-lts" "$(jq -r .linuxFxVersion <<<"$cfg")"
  check "web: minimum TLS" "1.2" "$(jq -r .minTlsVersion <<<"$cfg")"
  check "web: FTP(S) disabled" Disabled "$(jq -r .ftpsState <<<"$cfg")"
  check "web: health check path" /health "$(jq -r .healthCheckPath <<<"$cfg")"
  check "web: basic-auth publishing (SCM)" false \
    "$(az resource show --ids "$(jq -r .id <<<"$site")/basicPublishingCredentialsPolicies/scm" --query properties.allow -o tsv)"
  secretish=$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?contains(name,'PASSWORD') || contains(name,'KEY') && name!='KEY_VAULT_URL'].name" -o tsv | tr '\n' ' ')
  check "web: no password/key app settings" "" "${secretish% }"

  # --- Data tier -------------------------------------------------------------
  check "sql: Entra ID-only authentication" true \
    "$(az sql server ad-only-auth get -g "$RG" -n "$SQL" --query azureAdOnlyAuthentication -o tsv)"
  check "sql: minimal TLS" "1.2" "$(az sql server show -g "$RG" -n "$SQL" --query minimalTlsVersion -o tsv)"
  check "sql: public network access" "$pna_expect" "$(az sql server show -g "$RG" -n "$SQL" --query publicNetworkAccess -o tsv)"
  stj=$(az storage account show -g "$RG" -n "$ST" -o json)
  check "storage: shared key access" false "$(jq -r .allowSharedKeyAccess <<<"$stj")"
  check "storage: anonymous blob access" false "$(jq -r .allowBlobPublicAccess <<<"$stj")"
  check "storage: minimum TLS" TLS1_2 "$(jq -r .minimumTlsVersion <<<"$stj")"
  check "storage: public network access" "$pna_expect" "$(jq -r .publicNetworkAccess <<<"$stj")"
  kvj=$(az keyvault show -g "$RG" -n "$KV" -o json)
  check "key vault: RBAC authorization" true "$(jq -r .properties.enableRbacAuthorization <<<"$kvj")"
  check "key vault: public network access" "$([[ $private == true ]] && echo Disabled || echo Enabled)" \
    "$(jq -r .properties.publicNetworkAccess <<<"$kvj")"

  # --- Production-only design -------------------------------------------------
  if [[ "$ENV" == "prod" ]]; then
    check "prod: staging slot exists" staging \
      "$(az webapp deployment slot list -g "$RG" -n "$APP" --query "[0].name" -o tsv)"
    check "prod: plan tier" Standard "$(az appservice plan show --ids "$(jq -r .serverFarmId <<<"$site")" --query sku.tier -o tsv)"
    check_ge "prod: VNet integration" 1 "$(az webapp vnet-integration list -g "$RG" -n "$APP" --query 'length(@)' -o tsv)"
    check_ge "prod: approved private endpoints" 3 \
      "$(az network private-endpoint list -g "$RG" --query "length([?privateLinkServiceConnections[0].privateLinkServiceConnectionState.status=='Approved'])" -o tsv)"
    check_ge "prod: metric alerts" 6 "$(az monitor metrics alert list -g "$RG" --query 'length(@)' -o tsv)"
    check_ge "prod: activity-log alerts (slot swap)" 1 "$(az monitor activity-log alert list -g "$RG" --query 'length(@)' -o tsv)"
    check_ge "prod: availability test" 1 "$(az resource list -g "$RG" --resource-type Microsoft.Insights/webtests --query 'length(@)' -o tsv)"
    # Reachability from the internet (Cloud Shell): must be refused.
    # Key Vault answers an outside caller with 401 (no token) or 403
    # ForbiddenByRbac (token but no data role) before its network rule shows,
    # so a probe from here cannot prove the network block. Check the setting
    # itself; the app's own health check proves the private path works.
    check "prod: Key Vault public network access" Disabled \
      "$(az keyvault show -g "$RG" -n "$KV" --query properties.publicNetworkAccess -o tsv)"
    check "prod: Key Vault network default action" Deny \
      "$(az keyvault show -g "$RG" -n "$KV" --query properties.networkAcls.defaultAction -o tsv)"
    st_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${ST}.blob.core.windows.net/pos-receipts?restype=container" || echo 000)
    check "prod: Storage refuses internet (HTTP 403)" 403 "$st_code"
  else
    check "${ENV}: no staging slot (cost)" "" "$(az webapp deployment slot list -g "$RG" -n "$APP" --query "[0].name" -o tsv)"
  fi

  # --- TLS 1.0 must be refused by the front end ------------------------------
  if curl -s -o /dev/null --max-time 15 --tlsv1.0 --tls-max 1.0 "$URL/health/live" 2>/dev/null; then
    check "web: TLS 1.0 refused" refused accepted
  else
    check "web: TLS 1.0 refused" refused refused
  fi

  # --- Functional ------------------------------------------------------------
  step "${ENV}: smoke suite"
  slot_args=()
  [[ "$ENV" == "prod" ]] && slot_args=(--expect-slot production)
  if node "${ROOT_DIR}/tests/smoke.mjs" --url "$URL" --expect-env "$ENV" "${slot_args[@]}" --wait 60 \
       --junit "${REPORT_DIR}/smoke-${ENV}.xml"; then
    check "smoke suite" pass pass
  else
    check "smoke suite" pass fail
  fi
  if [[ "$INTEGRATION" == true ]]; then
    if node "${ROOT_DIR}/tests/integration.mjs" --url "$URL" --junit "${REPORT_DIR}/integration-${ENV}.xml"; then
      check "integration suite" pass pass
    else
      check "integration suite" pass fail
    fi
  fi

  { echo; echo "**${PASS} passed, ${FAIL} failed** · ${URL}"; } >> "$REPORT"
  if [[ $FAIL -eq 0 ]]; then ok "${ENV}: ${PASS} checks passed  (report: ${REPORT})"
  else warn "${ENV}: ${FAIL} of $((PASS + FAIL)) checks failed  (report: ${REPORT})"; fi
  TOTAL_FAIL=$((TOTAL_FAIL + FAIL))
done

exit $((TOTAL_FAIL > 0))
