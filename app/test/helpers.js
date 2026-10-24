'use strict';

const { createApp } = require('../src/app');
const { createMemoryDb, createMemoryBlobs, createMemorySecrets } = require('../src/adapters/memory');

const config = {
  environment: 'test',
  slot: 'production',
  region: 'local',
  build: { version: '1.2.3', commit: 'abc1234', buildTime: '2026-10-23T00:00:00Z', runId: '42' },
};

async function startServer(overrides = {}) {
  const ctx = { db: createMemoryDb(), blobs: createMemoryBlobs(), secrets: createMemorySecrets(), ...overrides };
  const app = createApp({ config, ...ctx, log: { info() {}, error() {} } });
  await new Promise((resolve) => {
    ctx.server = app.listen(0, resolve);
  });
  ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
  ctx.call = async (method, path, { body, token } = {}) => {
    const r = await fetch(ctx.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, body: json, headers: r.headers };
  };
  return ctx;
}

async function newStore(ctx, slug = 'corner-shop') {
  const r = await ctx.call('POST', '/api/stores', {
    body: { slug, storeName: 'Corner Shop', managerName: 'Maya Manager', email: `maya@${slug}.test`, password: 'Password123' },
  });
  if (r.status !== 201) throw new Error(`store signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

module.exports = { config, startServer, newStore };
