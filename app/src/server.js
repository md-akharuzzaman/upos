'use strict';

const telemetryOn = require('./telemetry').startTelemetry();

const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const log = console;

function buildAdapters() {
  if (config.store === 'azure') return require('./adapters/azure').createAzureAdapters(config, log);
  const m = require('./adapters/memory');
  return { db: m.createMemoryDb(), blobs: m.createMemoryBlobs(), secrets: m.createMemorySecrets() };
}

const adapters = buildAdapters();
const state = { ready: false, schemaVersion: 0, error: null };
const app = createApp({ config, ...adapters, state, log });

const server = app.listen(config.port, () => {
  log.info(
    `[eurc] ${config.build.version} env=${config.environment} slot=${config.slot} db=${adapters.db.kind} ` +
      `telemetry=${telemetryOn} listening on :${config.port}`,
  );
});

// Apply database migrations in the background; /health reports "Starting"
// (HTTP 503) until this completes, so slot-swap warm-up and smoke tests wait.
async function initialise(attempt = 1) {
  try {
    const r = await adapters.db.init();
    state.schemaVersion = r.schemaVersion;
    if (config.store === 'memory' && process.env.EURC_SEED_DEMO === '1') {
      await require('./seed').seedDemo(adapters.db);
      log.info('[eurc] demo store seeded: store "demo", manager@demo.test / Password123');
    }
    state.ready = true;
    state.error = null;
    log.info(`[eurc] database ready, schema version ${r.schemaVersion}`);
  } catch (err) {
    state.error = err.message;
    const delay = Math.min(30000, 2000 * attempt);
    log.error(`[eurc] init attempt ${attempt} failed: ${err.message}; retrying in ${delay} ms`);
    setTimeout(() => initialise(attempt + 1), delay).unref();
  }
}
initialise();

function shutdown(signal) {
  log.info(`[eurc] ${signal} received, closing`);
  server.close(async () => {
    await adapters.db.close?.().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
