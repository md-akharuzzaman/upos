#!/usr/bin/env node
// 40 — Bulk product import from Cloud Shell (v2.3), for catalogues too big for
// a browser upload (e.g. the 200,000-product supermarket sample).
//
//   node scripts/40-bulk-import.mjs --env test --store supershop-demo \
//        --email you@example.com --file supershop-200k.csv [--dry-run] [--batch 1000]
//
// * Reads a CSV with the product sheet headings: SKU, Barcode, Name, Category,
//   Sub-category, Price, Tax %, Stock, Expiry date, Refundable, Active
//   (Excel: File > Save As > CSV UTF-8).
// * Signs in as a store manager/admin/procurement user (password from the
//   EURC_PASSWORD variable, or asked for), creates any missing categories and
//   sub-categories, then sends batches through the same API the browser uses:
//   every row is validated by the server, each batch is one transaction.
// * --dry-run validates the whole file without saving anything.
// * Progress is saved after every batch: run the same command again to resume.
// * The API checks every row - the script never talks to the database itself.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else args[a.slice(2)] = process.argv[++i];
}
const die = (m) => {
  console.error(`[FAIL] ${m}`);
  process.exit(1);
};
if (!args.file || !args.store || !args.email || !(args.url || args.env)) {
  die(
    'usage: 40-bulk-import.mjs (--env dev|test|prod | --url https://...) --store <code> --email <e-mail> --file <file.csv> [--dry-run] [--batch 1000] [--restart]',
  );
}
const BATCH = Math.min(Math.max(Number(args.batch) || 1000, 50), 1000);

// ---- where to send it ----------------------------------------------------
let base = args.url;
if (!base) {
  if (!['dev', 'test', 'prod'].includes(args.env)) die('--env must be dev, test or prod');
  const root = new URL('..', import.meta.url).pathname;
  const rg = execFileSync('bash', ['-c', 'source config/eurc.env && rg_for "$1"', 'rg', args.env], { cwd: root }).toString().trim();
  base = execFileSync('az', ['deployment', 'group', 'show', '-g', rg, '-n', 'eurc-main', '--query', 'properties.outputs.webAppUrl.value', '-o', 'tsv'])
    .toString()
    .trim();
}
base = base.replace(/\/$/, '');
if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) die(`not an https URL: ${base}`);

// ---- read and map the file --------------------------------------------------
function parseCsv(text) {
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) out.push([...row, cell]);
  return out;
}
const KEYS = {
  sku: 'sku',
  barcode: 'barcode',
  name: 'name',
  category: 'category',
  'sub-category': 'subcategory',
  subcategory: 'subcategory',
  price: 'price',
  'tax %': 'tax',
  tax: 'tax',
  stock: 'stock',
  'expiry date': 'expiresOn',
  expiry: 'expiresOn',
  refundable: 'refundable',
  active: 'active',
};
const yes = (v) => (/^(yes|y|true|1)$/i.test(v) ? true : /^(no|n|false|0)$/i.test(v) ? false : undefined);

const sheet = parseCsv(fs.readFileSync(args.file, 'utf8').replace(/^﻿/, ''));
const head = sheet.shift().map((h) => KEYS[String(h).trim().toLowerCase()]);
if (!head.includes('sku')) die('the first row must hold the headings, including SKU');
const rows = [];
const problems = [];
sheet.forEach((cells, i) => {
  if (cells.every((c) => !String(c).trim())) return;
  const r = {};
  head.forEach((k, j) => {
    const v = (cells[j] ?? '').trim();
    if (!k || v === '') return;
    if (k === 'price') {
      const n = Number(v.replace(/[$,]/g, ''));
      if (!Number.isFinite(n)) problems.push(`row ${i + 2}: price "${v}"`);
      else r.priceCents = Math.round(n * 100);
    } else if (k === 'tax') r.taxRateBp = Math.round(Number(v.replace('%', '')) * 100);
    else if (k === 'stock') r.stock = Number(v);
    else if (k === 'refundable' || k === 'active') r[k] = yes(v);
    else r[k] = v;
  });
  r._row = i + 2;
  rows.push(r);
});
if (problems.length) die(`${problems.length} unreadable value(s), e.g. ${problems.slice(0, 5).join('; ')}`);
console.log(`[ OK ] ${rows.length} product rows in ${args.file}; target ${base}, store ${args.store}${args.dryRun || args['dry-run'] ? ' (dry run)' : ''}`);

// ---- HTTP helpers --------------------------------------------------------------
async function call(method, path, body, token, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status >= 500 || r.status === 429) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { retry: true });
      return { status: r.status, body: data };
    } catch (err) {
      if (attempt >= tries) throw err;
      const wait = Math.min(30000, 1000 * 2 ** attempt);
      console.log(`[WARN] ${method} ${path}: ${err.message}; retry ${attempt}/${tries - 1} in ${wait / 1000}s`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}
async function password() {
  if (process.env.EURC_PASSWORD) return process.env.EURC_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => rl.output.write(s.includes('Password') ? s : '');
  const pw = await new Promise((res) => rl.question(`Password for ${args.email}: `, res));
  rl.close();
  process.stdout.write('\n');
  return pw;
}

// ---- go ----------------------------------------------------------------------
const login = await call('POST', '/api/auth/login', { store: args.store, email: args.email, password: await password() });
if (login.status !== 200) die(`sign-in failed: ${login.body.error}`);
const token = login.body.token;
console.log(`[ OK ] signed in as ${login.body.user.name} (${login.body.user.role})`);
if (!login.body.user.permissions?.includes('products.manage')) die('this user cannot manage products (needs admin, manager or procurement)');

const dry = Boolean(args.dryRun || args['dry-run']);
if (!dry) {
  // categories and sub-categories used in the file
  const have = (await call('GET', '/api/categories', undefined, token)).body;
  const key = (n, p) => `${p || ''}|${n.toLowerCase()}`;
  const ids = new Map(have.map((c) => [key(c.name, c.parentId), c.id]));
  const pairs = new Map();
  for (const r of rows) if (r.category) pairs.set(`${r.category}\u0000${r.subcategory || ''}`, [r.category, r.subcategory]);
  let made = 0;
  for (const [cat, sub] of pairs.values()) {
    let pid = ids.get(key(cat, null));
    if (!pid) {
      const c = await call('POST', '/api/categories', { name: cat, finalSale: /^(food|produce|dairy|meat|bakery|frozen)/i.test(cat) }, token);
      if (c.status !== 201) die(`category ${cat}: ${c.body.error}`);
      pid = c.body.id;
      ids.set(key(cat, null), pid);
      made++;
    }
    if (sub && !ids.has(key(sub, pid))) {
      const c = await call('POST', '/api/categories', { name: sub, parentId: pid }, token);
      if (c.status !== 201) die(`sub-category ${sub}: ${c.body.error}`);
      ids.set(key(sub, pid), c.body.id);
      made++;
    }
  }
  console.log(`[ OK ] categories ready (${made} created)`);
}

const stateFile = `.bulk-import-${args.store}-${fs.statSync(args.file).size}.json`;
let start = 0;
if (!dry && !args.restart && fs.existsSync(stateFile)) {
  start = JSON.parse(fs.readFileSync(stateFile, 'utf8')).next;
  console.log(`[ OK ] resuming at row ${start + 2} (${stateFile}; --restart to start over)`);
}
const t0 = Date.now();
const totals = { created: 0, updated: 0, unchanged: 0 };
const errors = [];
for (let i = start; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const startRow = batch[0]._row;
  const body = { rows: batch.map(({ _row, ...r }) => r), startRow, dryRun: dry };
  const r = await call('POST', '/api/products/import', body, token);
  if (r.status === 401) die('session expired - run the command again to resume');
  if (r.status === 400 && r.body.errors) {
    errors.push(...r.body.errors);
    if (!dry) {
      console.error(
        r.body.errors
          .slice(0, 10)
          .map((e) => `  row ${e.row} ${e.sku ?? ''}: ${e.error}`)
          .join('\n'),
      );
      die(`batch starting at row ${startRow} has ${r.body.errors.length} invalid row(s); nothing in it was saved. Fix the file and run again to resume.`);
    }
  } else if (r.status !== 200) die(`batch at row ${startRow}: HTTP ${r.status} ${r.body.error || ''}`);
  else for (const k of Object.keys(totals)) totals[k] += r.body[k];
  const done = Math.min(i + BATCH, rows.length);
  if (!dry) fs.writeFileSync(stateFile, JSON.stringify({ next: done, at: new Date().toISOString() }));
  const rate = (done - start) / ((Date.now() - t0) / 1000);
  const eta = Math.round((rows.length - done) / Math.max(rate, 0.001));
  const line = `  ${done.toLocaleString()} / ${rows.length.toLocaleString()} rows · ${rate.toFixed(0)} rows/s · ETA ${Math.floor(eta / 60)}m ${eta % 60}s`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
  else if (done === rows.length || ((done - start) / BATCH) % 20 === 0) console.log(line); // logs: every 20 batches
}
process.stdout.write('\n');
if (dry) {
  if (errors.length) {
    console.error(
      errors
        .slice(0, 20)
        .map((e) => `  row ${e.row} ${e.sku ?? ''}: ${e.error}`)
        .join('\n'),
    );
    die(`dry run: ${errors.length} row(s) need fixing`);
  }
  console.log(`[ OK ] dry run: all ${rows.length} rows are valid (${totals.created} new, ${totals.updated} updates, ${totals.unchanged} unchanged)`);
} else {
  fs.rmSync(stateFile, { force: true });
  console.log(`[ OK ] imported: ${totals.created} new, ${totals.updated} updated, ${totals.unchanged} unchanged in ${Math.round((Date.now() - t0) / 1000)}s`);
}
