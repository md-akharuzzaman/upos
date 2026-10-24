// Production alerting: action group, metric alerts, availability (synthetic)
// test and an activity-log alert on every slot swap (i.e. every release).

param location string
param tags object
param envShort string
param alertEmail string
param siteId string
param siteUrl string
param planId string
param sqlDatabaseId string
param appInsightsId string

resource ag 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-eurc-ops-${envShort}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'eurc-ops'
    enabled: true
    emailReceivers: [{ name: 'ops-email', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

var metricAlerts = [
  {
    name: 'alert-eurc-http5xx-${envShort}'
    description: 'More than 5 server errors (HTTP 5xx) in 5 minutes'
    severity: 1
    scope: siteId
    ns: 'Microsoft.Web/sites'
    metric: 'Http5xx'
    agg: 'Total'
    op: 'GreaterThan'
    threshold: 5
  }
  {
    name: 'alert-eurc-latency-${envShort}'
    description: 'Average response time above 2 seconds'
    severity: 2
    scope: siteId
    ns: 'Microsoft.Web/sites'
    metric: 'HttpResponseTime'
    agg: 'Average'
    op: 'GreaterThan'
    threshold: 2
  }
  {
    name: 'alert-eurc-healthcheck-${envShort}'
    description: 'App Service health check below 100 % (instance failing /health/ready)'
    severity: 1
    scope: siteId
    ns: 'Microsoft.Web/sites'
    metric: 'HealthCheckStatus'
    agg: 'Average'
    op: 'LessThan'
    threshold: 100
  }
  {
    name: 'alert-eurc-plan-cpu-${envShort}'
    description: 'App Service plan CPU above 80 %'
    severity: 2
    scope: planId
    ns: 'Microsoft.Web/serverfarms'
    metric: 'CpuPercentage'
    agg: 'Average'
    op: 'GreaterThan'
    threshold: 80
  }
  {
    name: 'alert-eurc-sql-dtu-${envShort}'
    description: 'Azure SQL DTU consumption above 80 %'
    severity: 2
    scope: sqlDatabaseId
    ns: 'Microsoft.Sql/servers/databases'
    metric: 'dtu_consumption_percent'
    agg: 'Average'
    op: 'GreaterThan'
    threshold: 80
  }
]

resource alerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for a in metricAlerts: {
    name: a.name
    location: 'global'
    tags: tags
    properties: {
      description: a.description
      severity: a.severity
      enabled: true
      scopes: [a.scope]
      evaluationFrequency: 'PT1M'
      windowSize: 'PT5M'
      autoMitigate: true
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
        allOf: [
          {
            criterionType: 'StaticThresholdCriterion'
            name: 'c1'
            metricNamespace: a.ns
            metricName: a.metric
            timeAggregation: a.agg
            operator: a.op
            threshold: a.threshold
          }
        ]
      }
      actions: [{ actionGroupId: ag.id }]
    }
  }
]

// Standard availability test: GET /health from three Azure test locations every
// 10 minutes (432 runs/day, about USD 0.22/day at USD 0.0005 per run).
var webTestName = 'webtest-eurc-health-${envShort}'
resource webTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: webTestName
  location: location
  tags: union(tags, { 'hidden-link:${appInsightsId}': 'Resource' })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: webTestName
    Name: 'eURC ${envShort} /health'
    Enabled: true
    Frequency: 600
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [{ Id: 'us-va-ash-azr' }, { Id: 'us-il-ch1-azr' }, { Id: 'us-ca-sjc-azr' }]
    Request: {
      RequestUrl: '${siteUrl}/health'
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 7
    }
  }
}

resource availabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-eurc-availability-${envShort}'
  location: 'global'
  tags: tags
  properties: {
    description: '/health failing from 2 or more test locations'
    severity: 0
    enabled: true
    scopes: [webTest.id, appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M' // must cover at least one test run per location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: webTest.id
      componentId: appInsightsId
      failedLocationCount: 2
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

// Informational: notify on every production slot swap (release or rollback).
resource swapAlert 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: 'alert-eurc-slot-swap-${envShort}'
  location: 'Global'
  tags: tags
  properties: {
    description: 'A production slot swap (release or rollback) was performed'
    enabled: true
    scopes: [resourceGroup().id]
    condition: {
      allOf: [
        { field: 'category', equals: 'Administrative' }
        { field: 'operationName', equals: 'Microsoft.Web/sites/slots/slotsswap/action' }
      ]
    }
    actions: { actionGroups: [{ actionGroupId: ag.id }] }
  }
}

output actionGroupId string = ag.id
output webTestId string = webTest.id
