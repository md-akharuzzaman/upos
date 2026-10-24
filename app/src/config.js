'use strict';

const fs = require('node:fs');
const path = require('node:path');

// build.json is written by the CI pipeline (build job) and travels inside the
// deployment package, so every environment reports exactly which build it runs.
function readBuildInfo() {
  const file = path.join(__dirname, '..', 'build.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: '0.0.0-local', commit: 'local', buildTime: null, runId: null };
  }
}

function loadConfig(env = process.env) {
  const build = readBuildInfo();
  return {
    port: Number(env.PORT || 8080),
    environment: env.EURC_ENVIRONMENT || 'local',
    slot: env.EURC_SLOT || 'production',
    region: env.REGION_NAME || env.EURC_REGION || 'local',
    // "memory" runs the whole app without Azure (local dev + unit tests);
    // "azure" uses SQL, Blob and Key Vault through the managed identity.
    store: env.EURC_STORE || (env.SQL_SERVER ? 'azure' : 'memory'),
    sql: { server: env.SQL_SERVER, database: env.SQL_DATABASE },
    blobUrl: env.STORAGE_BLOB_URL,
    blobContainer: env.STORAGE_CONTAINER || 'pos-receipts',
    keyVaultUrl: env.KEY_VAULT_URL,
    managedIdentityClientId: env.AZURE_CLIENT_ID,
    runningInAzure: Boolean(env.WEBSITE_SITE_NAME),
    build,
  };
}

module.exports = { loadConfig, readBuildInfo };
