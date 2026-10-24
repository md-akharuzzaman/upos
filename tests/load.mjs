#!/usr/bin/env node
// Load test with pass/fail thresholds (performance gate in the test stage and
// the production post-deployment gate).
//
// Traffic mix per worker: register screen reads (products), checkouts (sales,
// which write to SQL in a transaction and to Blob), and static/front-end hits.
// A temporary store is created first and deleted at the end.
//
//   node tests/load.mjs --url https://<host> [--duration 60] [--concurrency 10]
//        [--p95 1500] [--max-error-rate 1] [--reads-only] [--junit reports/load-test.xml]
import { parseArgs, http, Suite, assert } from './lib.mjs';
import { client, runTag } from './pos-client.mjs';

const args = parseArgs();
const base = String(args.url || '').replace(/\/$/, '');
// --local allows http://127.0.0.1 for rehearsing the suites against `npm run dev`.
const local = Boolean(args.local) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
if (!base.startsWith('https://') && !local) {
  console.error('usage: load.mjs --url https://<host> [--duration s] [--concurrency n] [--p95 ms] [--max-error-rate %] [--reads-only]');
  process.exit(2);
}
const duration = Number(args.duration || 60) * 1000;
const concurrency = Number(args.concurrency || 10);
const p95Limit = Number(args.p95 || 1500);
const maxErrPct = Number(args['max-error-rate'] || 1);
const readsOnly = Boolean(args['reads-only']);

const api = client(base);
let session = null;
let productId = null;
if (!readsOnly) {
  session = await api.createStore(`load-${runTag()}`);
  const p = await api.call('POST', '/api/products', {
    token: session.token,
    body: { sku: 'LOAD-001', name: 'Load test item', priceCents: 199, taxRateBp: 1300, stock: 1_000_000 },
  });
  if (p.status !== 201) throw new Error(`could not create load product: HTTP ${p.status}`);
  productId = p.body.id;
}
const auth = () => ({ authorization: `Bearer ${session.token}`, 'content-type': 'application/json' });

// weights: products 4, sale 2, info 1, live 1, home 1  (reads-only: public paths)
const ops = readsOnly
  ? [() => ['GET', '/api/info'], () => ['GET', '/health/live'], () => ['GET', '/']]
  : [
      ...Array(4).fill(() => ['GET', '/api/products', { headers: auth() }]),
      ...Array(2).fill(() => [
        'POST',
        '/api/sales',
        { headers: auth(), body: JSON.stringify({ items: [{ productId, qty: 1 }], payment: { method: 'card', reference: 'LOAD-TEST' } }) },
      ]),
      () => ['GET', '/api/info'],
      () => ['GET', '/health/live'],
      () => ['GET', '/'],
    ];

console.log(`Load: ${concurrency} workers for ${duration / 1000} s against ${base}${readsOnly ? ' (reads only)' : ''}`);
const lat = [];
let errors = 0;
let sales = 0;
const codes = {};
const end = Date.now() + duration;

async function worker(id) {
  let i = id;
  while (Date.now() < end) {
    const [method, path, opts = {}] = ops[i++ % ops.length]();
    try {
      const r = await http(base + path, { method, ...opts }, 10000);
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.status >= 500 || r.status === 401 || r.status === 409) errors++;
      if (path === '/api/sales' && r.status === 201) sales++;
      lat.push(r.ms);
    } catch {
      errors++;
      codes.timeout = (codes.timeout || 0) + 1;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

lat.sort((a, b) => a - b);
const pct = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : NaN);
const total = lat.length + (codes.timeout || 0);
const errPct = total ? (errors / total) * 100 : 100;
const rps = total / (duration / 1000);
const summary = `${total} requests (${sales} sales), ${rps.toFixed(1)} req/s, p50 ${pct(0.5).toFixed(0)} ms, p95 ${pct(0.95).toFixed(0)} ms, p99 ${pct(0.99).toFixed(0)} ms, errors ${errPct.toFixed(2)} %, codes ${JSON.stringify(codes)}`;
console.log(summary);

const suite = new Suite('Load');
await suite.check(`p95 latency under ${p95Limit} ms`, async () => {
  assert(pct(0.95) <= p95Limit, `p95 ${pct(0.95).toFixed(0)} ms`);
  return `p95 ${pct(0.95).toFixed(0)} ms`;
});
await suite.check(`error rate under ${maxErrPct} %`, async () => {
  assert(errPct <= maxErrPct, `${errPct.toFixed(2)} %`);
  return `${errPct.toFixed(2)} % of ${total}`;
});
await suite.check('throughput recorded', async () => summary);
if (session) {
  await suite.check('clean-up: delete load-test store', async () => {
    const s = await api.deleteStore(session);
    assert(s === 204, `HTTP ${s}`);
  });
}
suite.finish({ junit: args.junit });
