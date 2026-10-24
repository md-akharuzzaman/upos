// Production-only private network: App Service VNet integration subnet,
// private-endpoint subnet, NSGs and the three private DNS zones.
//
// Only private (RFC 1918) traffic is routed into the VNet. That is all the app
// needs to reach the private endpoints; internet egress (Entra ID token
// requests, Application Insights ingestion) stays on App Service's own
// outbound path, so no NAT gateway is required.

param location string
param tags object
param vnetName string
param addressPrefix string = '10.20.0.0/16'
param appIntegrationPrefix string = '10.20.1.0/24'
param privateEndpointPrefix string = '10.20.2.0/24'
param subnetAppName string
param subnetPeName string

var privateDnsZoneNames = [
  'privatelink${environment().suffixes.sqlServerHostname}' // privatelink.database.windows.net
  'privatelink.blob.${environment().suffixes.storage}' // privatelink.blob.core.windows.net
  'privatelink.vaultcore.azure.net'
]

resource nsgApp 'Microsoft.Network/networkSecurityGroups@2026-01-01' = {
  name: 'nsg-${subnetAppName}'
  location: location
  tags: tags
  properties: { securityRules: [] }
}

resource nsgPe 'Microsoft.Network/networkSecurityGroups@2026-01-01' = {
  name: 'nsg-${subnetPeName}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-AppIntegration-To-PrivateEndpoints'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: appIntegrationPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: privateEndpointPrefix
          destinationPortRanges: ['443', '1433']
        }
      }
      {
        name: 'Deny-Other-VNet-Inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2026-01-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: subnetAppName
        properties: {
          addressPrefix: appIntegrationPrefix
          networkSecurityGroup: { id: nsgApp.id }
          delegations: [{ name: 'webapp', properties: { serviceName: 'Microsoft.Web/serverFarms' } }]
        }
      }
      {
        name: subnetPeName
        properties: {
          addressPrefix: privateEndpointPrefix
          networkSecurityGroup: { id: nsgPe.id }
          privateEndpointNetworkPolicies: 'Enabled' // lets the NSG above apply to private endpoints
        }
      }
    ]
  }
}

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for z in privateDnsZoneNames: {
    name: z
    location: 'global'
    tags: tags
  }
]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (z, i) in privateDnsZoneNames: {
    parent: zones[i]
    name: 'link-${vnetName}'
    location: 'global'
    tags: tags
    properties: {
      registrationEnabled: false
      virtualNetwork: { id: vnet.id }
    }
  }
]

output vnetId string = vnet.id
output appSubnetId string = vnet.properties.subnets[0].id
output peSubnetId string = vnet.properties.subnets[1].id
output sqlZoneId string = zones[0].id
output blobZoneId string = zones[1].id
output vaultZoneId string = zones[2].id
