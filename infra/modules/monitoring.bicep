// Log Analytics workspace + workspace-based Application Insights for one environment.

param location string
param tags object
param workspaceName string
param appInsightsName string
@minValue(30)
param retentionInDays int = 30
@description('Daily ingestion cap in GB (cost guardrail). -1 = no cap.')
param dailyQuotaGb int = 1

resource law 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionInDays
    workspaceCapping: { dailyQuotaGb: dailyQuotaGb }
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
    IngestionMode: 'LogAnalytics'
    RetentionInDays: retentionInDays
  }
}

output workspaceId string = law.id
output appInsightsId string = appi.id
output appInsightsName string = appi.name
output connectionString string = appi.properties.ConnectionString
