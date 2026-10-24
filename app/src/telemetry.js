'use strict';

// Loaded first (before express/mssql) so OpenTelemetry can instrument them.
// Sends requests, dependencies (SQL, Blob, Key Vault), exceptions and logs to
// the environment's Application Insights resource.

const { readBuildInfo } = require('./config');

function startTelemetry(env = process.env) {
  if (!env.APPLICATIONINSIGHTS_CONNECTION_STRING) return false;
  const build = readBuildInfo();
  env.OTEL_SERVICE_NAME = env.OTEL_SERVICE_NAME || 'eurc-web';
  const attrs = [
    `service.version=${build.version}`,
    `deployment.environment=${env.EURC_ENVIRONMENT || 'unknown'}`,
    `eurc.slot=${env.EURC_SLOT || 'production'}`,
  ].join(',');
  env.OTEL_RESOURCE_ATTRIBUTES = env.OTEL_RESOURCE_ATTRIBUTES ? `${env.OTEL_RESOURCE_ATTRIBUTES},${attrs}` : attrs;
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({ samplingRatio: 1 });
  return true;
}

module.exports = { startTelemetry };
