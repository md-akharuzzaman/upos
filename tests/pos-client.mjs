// Minimal POS API client shared by the integration and load suites.
import { http } from './lib.mjs';

export function client(base) {
  const call = (method, path, { token, body } = {}) =>
    http(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    call,
    async createStore(slug, password = 'Pipeline-Test-2026') {
      const r = await call('POST', '/api/stores', {
        body: { slug, storeName: `Pipeline ${slug}`, managerName: 'Pipeline Manager', email: `manager@${slug}.test`, password },
      });
      if (r.status !== 201) throw new Error(`create store ${slug}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async deleteStore(session) {
      const r = await call('DELETE', '/api/stores/current', { token: session.token, body: { confirm: session.store.slug } });
      return r.status;
    },
  };
}

export const runTag = () =>
  `${(process.env.GITHUB_RUN_ID || 'local').slice(-6)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
