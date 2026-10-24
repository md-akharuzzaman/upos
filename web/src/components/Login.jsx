import { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onSignedIn, environment }) {
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ store: '', email: '', password: '', storeName: '', managerName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const s =
        mode === 'signin'
          ? await api('/api/auth/login', { method: 'POST', body: { store: form.store, email: form.email, password: form.password } })
          : await api('/api/stores', {
              method: 'POST',
              body: { slug: form.store, storeName: form.storeName, managerName: form.managerName, email: form.email, password: form.password },
            });
      onSignedIn(s);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit} aria-label={mode === 'signin' ? 'Sign in' : 'Create store'}>
        <div className="login-brand">
          <b>eURC</b> <span>Point of Sale</span>
        </div>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'signin'} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} onClick={() => setMode('signup')}>
            Create a store
          </button>
        </div>
        {mode === 'signup' && (
          <>
            <label>
              Store name
              <input value={form.storeName} onChange={set('storeName')} required minLength={2} autoComplete="organization" />
            </label>
            <label>
              Your name
              <input value={form.managerName} onChange={set('managerName')} required minLength={2} autoComplete="name" />
            </label>
          </>
        )}
        <label>
          Store code
          <input
            value={form.store}
            onChange={set('store')}
            required
            placeholder="e.g. corner-shop"
            autoCapitalize="none"
            pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{1,38}[a-zA-Z0-9]"
          />
        </label>
        <label>
          E-mail
          <input type="email" value={form.email} onChange={set('email')} required autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            minLength={mode === 'signup' ? 10 : 1}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
        </label>
        {mode === 'signup' && <p className="hint">At least 10 characters with letters and digits. You become the store manager.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary big" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create store'}
        </button>
        {environment && environment !== 'prod' && <p className="hint center">{environment.toUpperCase()} environment — test data only</p>}
      </form>
    </main>
  );
}
