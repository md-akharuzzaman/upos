#!/usr/bin/env bash
# eURC Hands-on Project 02 — one-shot setup from Azure Cloud Shell (Bash).
#   1. edit config/eurc.env (GITHUB_OWNER, ALERT_EMAIL)
#   2. gh auth login -s workflow
#   3. ./setup.sh
# Then approve the prod deployment in GitHub Actions when it asks.
set -euo pipefail
cd "$(dirname "$0")"
chmod +x scripts/*.sh .github/scripts/*.sh
./scripts/00-preflight.sh
./scripts/01-bootstrap-azure.sh
./scripts/02-setup-github.sh
