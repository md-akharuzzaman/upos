#!/usr/bin/env bash
# Shared helpers for the eURC Project 02 scripts. Sourced, not executed.
# shellcheck disable=SC2034  # variables are used by the scripts that source this file

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../config/eurc.env
source "${ROOT_DIR}/config/eurc.env"

LOG_DIR="${ROOT_DIR}/logs"
REPORT_DIR="${ROOT_DIR}/reports"
mkdir -p "$LOG_DIR" "$REPORT_DIR"

if [[ -t 1 ]]; then
  C_RED=$'\e[31m' C_GRN=$'\e[32m' C_YEL=$'\e[33m' C_BLU=$'\e[34m' C_DIM=$'\e[2m' C_OFF=$'\e[0m'
else
  C_RED='' C_GRN='' C_YEL='' C_BLU='' C_DIM='' C_OFF=''
fi

log()  { printf '%s[ .. ]%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()   { printf '%s[ OK ]%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_YEL" "$C_OFF" "$*"; }
die()  { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
step() { printf '\n%s== %s ==%s\n' "$C_BLU" "$*" "$C_OFF"; }

require() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "'$c' is required but not installed"; done
}

# retry <attempts> <sleep-seconds> <command...>  (new identities take a while to replicate)
retry() {
  local n=$1 s=$2 i
  shift 2
  for ((i = 1; i <= n; i++)); do
    if "$@"; then return 0; fi
    [[ $i -lt $n ]] && { warn "attempt $i/$n failed; retrying in ${s}s"; sleep "$s"; }
  done
  return 1
}

check_config() {
  [[ "$GITHUB_OWNER" != CHANGE-ME* ]] || die "Set GITHUB_OWNER in config/eurc.env"
  [[ "$ALERT_EMAIL" != CHANGE-ME* ]] || die "Set ALERT_EMAIL in config/eurc.env"
  local v
  for v in DEV1 DEV2 TESTER; do
    [[ "${!v:-}" != CHANGE-ME* ]] || die "Set ${v} in config/eurc.env (GitHub user name, or empty to skip)"
  done
}

# Unique, non-empty GitHub logins of the team (owner, developers, tester).
team_members() { printf '%s\n' "$GITHUB_OWNER" "${DEV1:-}" "${DEV2:-}" "${TESTER:-}" | awk 'NF && !seen[tolower($0)]++'; }
developers() { printf '%s\n' "${DEV1:-}" "${DEV2:-}" | awk 'NF && !seen[tolower($0)]++'; }

az_context() {
  SUB_ID=$(az account show --query id -o tsv 2>/dev/null) || die "Not logged in to Azure. Run: az login"
  TENANT_ID=$(az account show --query tenantId -o tsv)
  SUB_NAME=$(az account show --query name -o tsv)
}

rg_tags() {
  echo "application=${TAG_APPLICATION} environment=$1 costCenter=${TAG_COSTCENTER} owner=${TAG_OWNER} project=hands-on-02-cicd"
}

# Read the latest Bicep deployment outputs of an environment (written by the pipeline).
env_outputs() {
  az deployment group show -g "$(rg_for "$1")" -n eurc-main --query properties.outputs -o json 2>/dev/null || echo '{}'
}
out() { jq -r --arg k "$2" '.[$k].value // empty' <<<"$1"; }

stamp() { date -u +%Y%m%dT%H%M%SZ; }
