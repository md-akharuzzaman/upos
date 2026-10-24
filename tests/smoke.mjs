#!/usr/bin/env node
// Smoke test: is the expected build running and healthy at this URL?
//
//   node tests/smoke.mjs --url https://app-eurc-web-dev-cc-xxxxx.azurewebsites.net \
//        --expect-version 2.0.0+42.abc1234 --expect-env dev [--expect-slot staging] \
//        [--wait 600] [--junit reports/smoke-dev.xml]
//
// --wait polls /health until it is Healthy AND reports the expected version
// (App Service restarts the site after a deployment, so this can take a minute).
import { parseArgs, http, sleep, Suite, assert } from './lib.mjs';

const args = parseArgs();
const base = String(args.url || '').replace(/\/$/, '');
// --local allows http://127.0.0.1 for rehearsing the suites against `npm run dev`.
const local = Boolean(args.local) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
if (!base.startsWith('https://') && !local) {
  console.error('usage: smoke.mjs --url https://<host> [--expect-version v] [--expect-env e] [--expect-slot s] [--wait seconds]');
  process.exit(2);
}
const waitSec = Number(args.wait || 0);
const suite = new Suite(`Smoke ${args['expect-env'] || ''} ${args['expect-slot'] || ''}`.trim());
console.log(`Smoke testing ${base}`);

await suite.check('site becomes Healthy with the expected build', async () => {
  const deadline = Date.now() + waitSec * 1000;
  let last = 'no response';
  do {
    try {
      const r = await http(`${base}/health`, {}, 20000);
      const v = r.body?.version;
      last = `HTTP ${r.status} ${r.body?.status ?? ''} version=${v ?? '?'}`;
      if (r.status === 200 && r.body.status === 'Healthy' && (!args['expect-version'] || v === args['expect-version'])) {
        return `${last} (sql ${r.body.checks.sql.ms} ms, blob ${r.body.checks.blob.ms} ms, kv ${r.body.checks.keyVault.ms} ms)`;
      }
    } catch (err) {
      last = err.name === 'AbortError' ? 'timeout' : err.message;
    }
    if (Date.now() < deadline) await sleep(10000);
  } while (Date.now() < deadline);
  throw new Error(`not healthy/expected build: ${last}`);
});

await suite.check('liveness endpoint', async () => {
  const r = await http(`${base}/health/live`);
  assert(r.status === 200, `HTTP ${r.status}`);
  return `${Math.round(r.ms)} ms`;
});

await suite.check('/api/info reports environment, slot and version', async () => {
  const r = await http(`${base}/api/info`);
  assert(r.status === 200, `HTTP ${r.status}`);
  const i = r.body;
  if (args['expect-env']) assert(i.environment === args['expect-env'], `environment=${i.environment}`);
  if (args['expect-slot']) assert(i.slot === args['expect-slot'], `slot=${i.slot}`);
  if (args['expect-version']) assert(i.version === args['expect-version'], `version=${i.version}`);
  if (!local) assert(i.store === 'azure-sql', `store=${i.store} (expected azure-sql)`);
  return `${i.environment}/${i.slot} ${i.version} (${i.commit})`;
});

await suite.check('React front end is served (home + deep link)', async () => {
  const r = await http(`${base}/`);
  assert(r.status === 200 && String(r.body).includes('<div id="root">') && String(r.body).includes('eURC POS'), `HTTP ${r.status}`);
  const deep = await http(`${base}/sales/today`);
  assert(deep.status === 200 && String(deep.body).includes('<div id="root">'), `deep link HTTP ${deep.status}`);
  const js = String(r.body).match(/src="(\/assets\/[^"]+\.js)"/);
  assert(js, 'no script bundle referenced');
  const bundle = await http(base + js[1]);
  assert(bundle.status === 200, `bundle HTTP ${bundle.status}`);
  return js[1];
});

await suite.check('security headers present', async () => {
  const r = await http(`${base}/api/info`);
  for (const h of ['strict-transport-security', 'x-content-type-options', 'x-frame-options']) assert(r.headers.get(h), `missing ${h}`);
  assert(!r.headers.get('x-powered-by'), 'x-powered-by is exposed');
});

await suite.check('plain HTTP is redirected to HTTPS', async () => {
  if (local) return 'skipped (--local)';
  const r = await http(`${base.replace('https://', 'http://')}/api/info`, { redirect: 'manual' });
  assert([301, 302, 307, 308].includes(r.status), `HTTP ${r.status}`);
  assert(String(r.headers.get('location')).startsWith('https://'), `location=${r.headers.get('location')}`);
  return `HTTP ${r.status}`;
});

await suite.check('API requires sign-in (401 without a token)', async () => {
  const r = await http(`${base}/api/products`);
  assert(r.status === 401, `HTTP ${r.status}`);
});

await suite.check('sign-in path reaches the database (unknown store -> 401)', async () => {
  const r = await http(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store: 'smoke-no-such-store', email: 'nobody@example.com', password: 'x' }),
  });
  assert(r.status === 401, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return `${Math.round(r.ms)} ms`;
});

suite.finish({ junit: args.junit });
