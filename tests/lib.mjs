// Shared helpers for the pipeline test suites (no npm dependencies; Node 22+).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function http(url, opts = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, body, ms: performance.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

export class Suite {
  constructor(name) {
    this.name = name;
    this.results = [];
    this.started = Date.now();
  }

  async check(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      this.results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
      console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      this.results.push({ name, ok: false, ms: Date.now() - t0, detail: err.message });
      console.log(`  ✘ ${name} — ${err.message}`);
    }
  }

  get failed() {
    return this.results.filter((r) => !r.ok).length;
  }

  finish({ junit } = {}) {
    const passed = this.results.length - this.failed;
    console.log(`\n${this.name}: ${passed}/${this.results.length} passed in ${((Date.now() - this.started) / 1000).toFixed(1)} s`);
    if (junit) {
      const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
      const cases = this.results
        .map(
          (r) =>
            `  <testcase classname="${esc(this.name)}" name="${esc(r.name)}" time="${(r.ms / 1000).toFixed(3)}">` +
            (r.ok ? '' : `<failure message="${esc(r.detail)}"/>`) +
            '</testcase>',
        )
        .join('\n');
      mkdirSync(dirname(junit), { recursive: true });
      writeFileSync(
        junit,
        `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(this.name)}" tests="${this.results.length}" failures="${this.failed}">\n${cases}\n</testsuite>\n`,
      );
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = this.results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|')} |`).join('\n');
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### ${this.name}: ${passed}/${this.results.length} passed\n\n| | Check | Detail |\n|---|---|---|\n${rows}\n`,
      );
    }
    process.exitCode = this.failed ? 1 : 0;
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
