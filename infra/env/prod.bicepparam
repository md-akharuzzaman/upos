// prod: S1 (needed for deployment slots) with a staging slot for zero-downtime
// swap, private endpoints for SQL / Blob / Key Vault, ZRS storage and alerts.
// ALERT_EMAIL comes from the GitHub "prod" environment variable.
using '../main.bicep'

param environmentName = 'prod'
param appServiceSku = 'S1'
param enableStagingSlot = true
param enablePrivateNetworking = true
param enableAlerts = true
param alertEmail = readEnvironmentVariable('ALERT_EMAIL', '')
param storageSku = 'Standard_ZRS'
param vnetAddressPrefix = '10.20.0.0/16'
