// eURC SaaS platform — one environment (dev, test or prod) per resource group.
// Deployed by the GitHub Actions pipeline with that environment's OIDC identity:
//   az deployment group create -g rg-eurc-<env>-cc -n eurc-main \
//     -f infra/main.bicep -p infra/env/<env>.bicepparam
targetScope = 'resourceGroup'

@allowed(['dev', 'test', 'prod'])
param environmentName string
param location string = resourceGroup().location
@description('Short region code used in names (CAF style), e.g. cc = Canada Central.')
param locationShort string = 'cc'
@description('App Service plan SKU. Deployment slots need S1 or higher.')
param appServiceSku string = 'B1'
param enableStagingSlot bool = false
param enablePrivateNetworking bool = false
param enableAlerts bool = false
@description('Email for production alerts (empty = alerts not deployed).')
param alertEmail string = ''
@allowed(['Standard_LRS', 'Standard_ZRS'])
param storageSku string = 'Standard_LRS'
param vnetAddressPrefix string = '10.20.0.0/16'
param logRetentionDays int = 30
param costCenter string = 'cc-eurc-lab'
param owner string = 'platform-team'

var envShort = environmentName
var sfx = take(uniqueString(subscription().id, resourceGroup().id), 5)
var tags = {
  application: 'eurc'
  environment: environmentName
  costCenter: costCenter
  owner: owner
  managedBy: 'github-actions-bicep'
  project: 'hands-on-02-cicd'
}

// CAF names: <type>-<workload>-<env>-<region>[-<instance|suffix>]
var names = {
  identity: 'id-eurc-app-${envShort}-${locationShort}'
  workspace: 'log-eurc-${envShort}-${locationShort}-001'
  appInsights: 'appi-eurc-${envShort}-${locationShort}-001'
  vnet: 'vnet-eurc-${envShort}-${locationShort}-001'
  subnetApp: 'snet-eurc-appint-${envShort}-${locationShort}'
  subnetPe: 'snet-eurc-pe-${envShort}-${locationShort}'
  sqlServer: 'sql-eurc-${envShort}-${locationShort}-${sfx}'
  sqlDatabase: 'sqldb-eurc-core-${envShort}'
  storage: 'steurc${envShort}${locationShort}${sfx}'
  keyVault: 'kv-eurc-${envShort}-${locationShort}-${sfx}'
  plan: 'asp-eurc-${envShort}-${locationShort}-001'
  site: 'app-eurc-web-${envShort}-${locationShort}-${sfx}'
}

// Runtime identity of the web app (shared by the production and staging slots,
// so a swap never changes which identity talks to SQL, Blob and Key Vault).
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: names.identity
  location: location
  tags: tags
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    tags: tags
    workspaceName: names.workspace
    appInsightsName: names.appInsights
    retentionInDays: logRetentionDays
  }
}

module network 'modules/network.bicep' = if (enablePrivateNetworking) {
  name: 'network'
  params: {
    location: location
    tags: tags
    vnetName: names.vnet
    addressPrefix: vnetAddressPrefix
    appIntegrationPrefix: cidrSubnet(vnetAddressPrefix, 24, 1)
    privateEndpointPrefix: cidrSubnet(vnetAddressPrefix, 24, 2)
    subnetAppName: names.subnetApp
    subnetPeName: names.subnetPe
  }
}

module data 'modules/data.bicep' = {
  name: 'data'
  params: {
    location: location
    tags: tags
    envShort: envShort
    locationShort: locationShort
    sqlServerName: names.sqlServer
    sqlDatabaseName: names.sqlDatabase
    storageAccountName: names.storage
    keyVaultName: names.keyVault
    storageSku: storageSku
    appIdentityName: appIdentity.name
    appIdentityPrincipalId: appIdentity.properties.principalId
    appIdentityClientId: appIdentity.properties.clientId
    privateNetworking: enablePrivateNetworking
    peSubnetId: enablePrivateNetworking ? network!.outputs.peSubnetId : ''
    sqlZoneId: enablePrivateNetworking ? network!.outputs.sqlZoneId : ''
    blobZoneId: enablePrivateNetworking ? network!.outputs.blobZoneId : ''
    vaultZoneId: enablePrivateNetworking ? network!.outputs.vaultZoneId : ''
    workspaceId: monitoring.outputs.workspaceId
  }
}

module web 'modules/web.bicep' = {
  name: 'web'
  params: {
    location: location
    tags: tags
    planName: names.plan
    siteName: names.site
    skuName: appServiceSku
    environmentName: environmentName
    appIdentityId: appIdentity.id
    appIdentityClientId: appIdentity.properties.clientId
    sqlServerFqdn: data.outputs.sqlServerFqdn
    sqlDatabaseName: data.outputs.sqlDatabaseName
    blobEndpoint: data.outputs.blobEndpoint
    containerName: data.outputs.containerName
    keyVaultUri: data.outputs.keyVaultUri
    appInsightsConnectionString: monitoring.outputs.connectionString
    workspaceId: monitoring.outputs.workspaceId
    enableStagingSlot: enableStagingSlot
    appSubnetId: enablePrivateNetworking ? network!.outputs.appSubnetId : ''
  }
}

module alerts 'modules/alerts.bicep' = if (enableAlerts && !empty(alertEmail)) {
  name: 'alerts'
  params: {
    location: location
    tags: tags
    envShort: envShort
    alertEmail: alertEmail
    siteId: web.outputs.siteId
    siteUrl: web.outputs.url
    planId: web.outputs.planId
    sqlDatabaseId: data.outputs.sqlDatabaseId
    appInsightsId: monitoring.outputs.appInsightsId
  }
}

// Read by the pipeline (az deployment group show -n eurc-main) to find where to deploy.
output environmentName string = environmentName
output webAppName string = web.outputs.siteName
output webAppUrl string = web.outputs.url
output stagingUrl string = web.outputs.stagingUrl
output hasStagingSlot bool = enableStagingSlot
output appInsightsName string = monitoring.outputs.appInsightsName
output appInsightsId string = monitoring.outputs.appInsightsId
output logAnalyticsWorkspaceId string = monitoring.outputs.workspaceId
output sqlServerName string = data.outputs.sqlServerName
output sqlDatabaseName string = data.outputs.sqlDatabaseName
output storageAccountName string = data.outputs.storageAccountName
output keyVaultName string = data.outputs.keyVaultName
output appIdentityName string = appIdentity.name
output privateNetworking bool = enablePrivateNetworking
output alertsEnabled bool = enableAlerts && !empty(alertEmail)
