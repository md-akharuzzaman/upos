// Compute tier: Linux App Service plan + Node 22 web app, optional staging
// slot (prod) and VNet integration (prod).

param location string
param tags object
param planName string
param siteName string
param skuName string
param environmentName string
param appIdentityId string
param appIdentityClientId string
param sqlServerFqdn string
param sqlDatabaseName string
param blobEndpoint string
param containerName string
param keyVaultUri string
param appInsightsConnectionString string
param workspaceId string
param enableStagingSlot bool = false
param appSubnetId string = ''

var vnetIntegrated = !empty(appSubnetId)
var alwaysOn = !contains(['F1', 'FREE', 'D1', 'SHARED'], toUpper(skuName))

func settings(environmentName string, slot string, location string, clientId string, sqlFqdn string, sqlDb string, blob string, container string, kvUri string, aiConn string) array => [
  { name: 'EURC_ENVIRONMENT', value: environmentName }
  { name: 'EURC_SLOT', value: slot }
  { name: 'EURC_REGION', value: location }
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AZURE_CLIENT_ID', value: clientId }
  { name: 'SQL_SERVER', value: sqlFqdn }
  { name: 'SQL_DATABASE', value: sqlDb }
  { name: 'STORAGE_BLOB_URL', value: blob }
  { name: 'STORAGE_CONTAINER', value: container }
  { name: 'KEY_VAULT_URL', value: kvUri }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: aiConn }
  // The pipeline ships a ready-built package (node_modules included).
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
  // Slot swap warm-up: App Service waits for /health/ready = 200 (app started,
  // database schema current) on the source slot before it switches traffic.
  // Not /health: its live dependency checks can be slow on a cold restart and
  // made a swap time out (CD #3, v2.2.0); the smoke test and the post-deploy
  // gate still check every dependency through /health.
  { name: 'WEBSITE_SWAP_WARMUP_PING_PATH', value: '/health/ready' }
  { name: 'WEBSITE_SWAP_WARMUP_PING_STATUSES', value: '200' }
]

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: skuName }
  properties: { reserved: true }
}

var siteConfig = {
  linuxFxVersion: 'NODE|22-lts'
  appCommandLine: 'node src/server.js'
  alwaysOn: alwaysOn
  ftpsState: 'Disabled'
  minTlsVersion: '1.2'
  scmMinTlsVersion: '1.2'
  http20Enabled: true
  // Platform health check (replaces failing instances): instance readiness only,
  // so a shared dependency blip does not take every instance out at once.
  healthCheckPath: '/health/ready'
  use32BitWorkerProcess: false
}

resource site 'Microsoft.Web/sites@2025-03-01' = {
  name: siteName
  location: location
  tags: union(tags, { 'eurc-role': 'web' })
  kind: 'app,linux'
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentityId}': {} } }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: appIdentityId
    virtualNetworkSubnetId: vnetIntegrated ? appSubnetId : null
    siteConfig: union(siteConfig, {
      appSettings: settings(environmentName, 'production', location, appIdentityClientId, sqlServerFqdn, sqlDatabaseName, blobEndpoint, containerName, keyVaultUri, appInsightsConnectionString)
    })
  }
}

// Basic-auth publishing (FTP and SCM user/password) is disabled: the pipeline
// deploys with its Entra ID token over OIDC.
resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: site
  name: 'ftp'
  properties: { allow: false }
}

resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: site
  name: 'scm'
  properties: { allow: false }
}

// EURC_SLOT stays with its slot during a swap; everything else moves with the code.
resource slotSticky 'Microsoft.Web/sites/config@2025-03-01' = {
  parent: site
  name: 'slotConfigNames'
  properties: { appSettingNames: ['EURC_SLOT'] }
}

resource staging 'Microsoft.Web/sites/slots@2025-03-01' = if (enableStagingSlot) {
  parent: site
  name: 'staging'
  location: location
  tags: union(tags, { 'eurc-role': 'web-staging' })
  kind: 'app,linux'
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentityId}': {} } }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: appIdentityId
    virtualNetworkSubnetId: vnetIntegrated ? appSubnetId : null
    siteConfig: union(siteConfig, {
      appSettings: settings(environmentName, 'staging', location, appIdentityClientId, sqlServerFqdn, sqlDatabaseName, blobEndpoint, containerName, keyVaultUri, appInsightsConnectionString)
    })
  }
}

resource stagingFtp 'Microsoft.Web/sites/slots/basicPublishingCredentialsPolicies@2025-03-01' = if (enableStagingSlot) {
  parent: staging
  name: 'ftp'
  properties: { allow: false }
}

resource stagingScm 'Microsoft.Web/sites/slots/basicPublishingCredentialsPolicies@2025-03-01' = if (enableStagingSlot) {
  parent: staging
  name: 'scm'
  properties: { allow: false }
}

resource siteDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: site
  name: 'diag-to-law'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output siteName string = site.name
output siteId string = site.id
output planId string = plan.id
output url string = 'https://${site.properties.defaultHostName}'
output stagingUrl string = enableStagingSlot ? 'https://${staging!.properties.defaultHostName}' : ''
