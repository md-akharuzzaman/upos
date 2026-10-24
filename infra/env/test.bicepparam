// test: production-like app configuration, runs the integration and load
// gates. Same tier as dev to stay inside the student budget.
using '../main.bicep'

param environmentName = 'test'
param appServiceSku = 'B1'
param enableStagingSlot = false
param enablePrivateNetworking = false
param enableAlerts = false
param storageSku = 'Standard_LRS'
param locationShort = 'ncus'
param sqlLocation = 'mexicocentral'
