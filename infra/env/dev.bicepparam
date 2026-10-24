// dev: fast feedback. Smallest paid tier, public endpoints locked to Azure
// services + Entra ID auth, no alerts. Every merge to main lands here first.
using '../main.bicep'

param environmentName = 'dev'
param appServiceSku = 'B1'
param enableStagingSlot = false
param enablePrivateNetworking = false
param enableAlerts = false
param storageSku = 'Standard_LRS'
param locationShort = 'ncus'
param sqlLocation = 'mexicocentral'
