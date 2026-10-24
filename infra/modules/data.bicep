// Data and secrets tier: Azure SQL (Entra ID only), Blob Storage (no shared
// keys) and Key Vault (RBAC). All three are reached by the app's
// user-assigned managed identity. In prod they are private-endpoint only.

param location string
param tags object
param sqlServerName string
param sqlDatabaseName string
param storageAccountName string
param keyVaultName string
param containerName string = 'pos-receipts'
@allowed(['Standard_LRS', 'Standard_ZRS'])
param storageSku string = 'Standard_LRS'
param sqlSkuName string = 'Basic'
param sqlSkuTier string = 'Basic'
param sqlCapacity int = 5
@allowed(['Local', 'Zone', 'Geo'])
param sqlBackupRedundancy string = 'Local'

@description('User-assigned managed identity of the web app (runtime identity).')
param appIdentityName string
param appIdentityPrincipalId string
param appIdentityClientId string

param privateNetworking bool = false
param peSubnetId string = ''
param sqlZoneId string = ''
param blobZoneId string = ''
param vaultZoneId string = ''
param envShort string
param locationShort string

param workspaceId string

// Built-in role definition IDs (the deployment identity may assign only these two).
var roleKeyVaultSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var roleStorageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// ---------------------------------------------------------------- Azure SQL
resource sql 'Microsoft.Sql/servers@2025-01-01' = {
  name: sqlServerName
  location: location
  tags: tags
  properties: {
    minimalTlsVersion: '1.2'
    publicNetworkAccess: privateNetworking ? 'Disabled' : 'Enabled'
    // Entra ID-only authentication: there is no SQL login or password at all.
    // The environment's app identity is the server's Entra admin so it can run
    // schema migrations (see app/src/migrations.js). Lab trade-off: a real
    // production system would split migration and runtime identities.
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: true
      login: appIdentityName
      sid: appIdentityClientId
      principalType: 'Application'
      tenantId: subscription().tenantId
    }
  }
}

resource sqlAllowAzure 'Microsoft.Sql/servers/firewallRules@2025-01-01' = if (!privateNetworking) {
  parent: sql
  name: 'AllowAllWindowsAzureIps' // 0.0.0.0 = Azure services (App Service outbound) in dev/test only
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource db 'Microsoft.Sql/servers/databases@2025-01-01' = {
  parent: sql
  name: sqlDatabaseName
  location: location
  tags: tags
  sku: { name: sqlSkuName, tier: sqlSkuTier, capacity: sqlCapacity }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 2147483648
    requestedBackupStorageRedundancy: sqlBackupRedundancy
    zoneRedundant: false
  }
}

resource dbBackupShortTerm 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies@2025-01-01' = {
  parent: db
  name: 'default'
  properties: { retentionDays: 7 }
}

resource dbDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: db
  name: 'diag-to-law'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'Errors', enabled: true }
      { category: 'Timeouts', enabled: true }
      { category: 'Blocks', enabled: true }
      { category: 'Deadlocks', enabled: true }
    ]
    metrics: [{ category: 'Basic', enabled: true }]
  }
}

// ------------------------------------------------------------- Blob Storage
resource st 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: storageSku }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // Entra ID (managed identity) only
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    publicNetworkAccess: privateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: privateNetworking ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: st
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobSvc
  name: containerName
  properties: { publicAccess: 'None' }
}

resource blobDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: blobSvc
  name: 'diag-to-law'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

// ---------------------------------------------------------------- Key Vault
resource kv 'Microsoft.KeyVault/vaults@2026-02-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    // Purge protection is left off so the lab can be torn down and redeployed
    // with the same names; turn it on for a real production vault.
    publicNetworkAccess: privateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: privateNetworking ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource kvDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: kv
  name: 'diag-to-law'
  properties: {
    workspaceId: workspaceId
    logs: [{ category: 'AuditEvent', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

// ----------------------------------------------- RBAC for the app identity
resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, appIdentityPrincipalId, roleKeyVaultSecretsOfficer)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsOfficer)
    principalId: appIdentityPrincipalId
    principalType: 'ServicePrincipal'
    description: 'eURC POS: create and read the session-signing key'
  }
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: container
  name: guid(container.id, appIdentityPrincipalId, roleStorageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleStorageBlobDataContributor)
    principalId: appIdentityPrincipalId
    principalType: 'ServicePrincipal'
    description: 'eURC POS: write and read receipts (container scope only)'
  }
}

// ------------------------------------------------ Private endpoints (prod)
var privateTargets = [
  { name: 'sql', id: sql.id, group: 'sqlServer', zone: sqlZoneId }
  { name: 'blob', id: st.id, group: 'blob', zone: blobZoneId }
  { name: 'kv', id: kv.id, group: 'vault', zone: vaultZoneId }
]

resource pes 'Microsoft.Network/privateEndpoints@2026-01-01' = [
  for t in privateTargets: if (privateNetworking) {
    name: 'pe-eurc-${t.name}-${envShort}-${locationShort}'
    location: location
    tags: tags
    properties: {
      subnet: { id: peSubnetId }
      customNetworkInterfaceName: 'nic-pe-eurc-${t.name}-${envShort}-${locationShort}'
      privateLinkServiceConnections: [
        {
          name: 'plsc-${t.name}'
          properties: { privateLinkServiceId: t.id, groupIds: [t.group] }
        }
      ]
    }
  }
]

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2026-01-01' = [
  for (t, i) in privateTargets: if (privateNetworking) {
    parent: pes[i]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [{ name: t.name, properties: { privateDnsZoneId: t.zone } }]
    }
  }
]

output sqlServerName string = sql.name
output sqlServerFqdn string = sql.properties.fullyQualifiedDomainName
output sqlDatabaseName string = db.name
output sqlDatabaseId string = db.id
output storageAccountName string = st.name
output blobEndpoint string = st.properties.primaryEndpoints.blob
output containerName string = container.name
output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
