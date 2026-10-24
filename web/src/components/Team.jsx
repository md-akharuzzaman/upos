import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { useLoader } from '../lib/useLoader.js';
import { ROLE_LABELS, assignableRoles } from '../lib/permissions.js';

const ROLE_HELP = {
  admin: 'everything, incl. business profile',
  manager: 'products, prices, promotions, refunds, reports, staff',
  cashier: 'register and sales',
  sales: 'register, promotions, reports',
  procurement: 'products, stock, categories',
  support: 'sales look-up and refunds',
};

export default function Team({ token, me, store, canEditPolicy = true, onStoreChange, onAuthError }) {
  const roles = assignableRoles(me.role);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'cashier',
  });
  const [error, setError] = useState('');
  const [days, setDays] = useState(String(store?.refundWindowDays ?? 30));
  const [saved, setSaved] = useState('');

  async function savePolicy(e) {
    e.preventDefault();
    setError('');
    setSaved('');
    try {
      const s = await api('/api/store/settings', {
        method: 'PATCH',
        token,
        body: { refundWindowDays: Number.parseInt(days, 10) },
      });
      onStoreChange?.({ ...store, ...s });
      setSaved(`Saved: refunds within ${s.refundWindowDays} days.`);
    } catch (err) {
      setError(err.message);
    }
  }

  const fetchRows = useCallback(() => api('/api/users', { token }), [token]);
  const [rows, load, loadError] = useLoader(fetchRows, onAuthError, []);

  async function add(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/users', { method: 'POST', token, body: form });
      setForm({ name: '', email: '', password: '', role: 'cashier' });
      load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function change(u, body) {
    setError('');
    try {
      await api(`/api/users/${u.id}`, { method: 'PATCH', token, body });
      load();
    } catch (err) {
      setError(err.message);
    }
  }
  const toggle = (u) => change(u, { active: !u.active });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <section className="page">
      <h2>Staff and store policy</h2>
      {canEditPolicy && (
        <form className="card inline-form" onSubmit={savePolicy} aria-label="Refund policy">
          <label>
            Refund window (days)
            <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" size={4} />
          </label>
          <button>Save policy</button>
          <span className="hint">Printed on every receipt. Final-sale items are set per product on the Products page.</span>
          {saved && (
            <span className="ok" role="status">
              {saved}
            </span>
          )}
        </form>
      )}
      <form className="card inline-form" onSubmit={add} aria-label="Add staff member">
        <label className="grow">
          Name
          <input value={form.name} onChange={set('name')} required />
        </label>
        <label className="grow">
          E-mail
          <input type="email" value={form.email} onChange={set('email')} required />
        </label>
        <label>
          Temporary password
          <input type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
        </label>
        <label>
          Role
          <select value={form.role} onChange={set('role')}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button className="primary">Add</button>
        <span className="hint">
          {ROLE_LABELS[form.role]}: {ROLE_HELP[form.role]}
        </span>
      </form>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      <table className="card table">
        <thead>
          <tr>
            <th>Name</th>
            <th>E-mail</th>
            <th>Role</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                {u.id !== me.id && roles.includes(u.role) ? (
                  <select aria-label={`Role of ${u.name}`} value={u.role} onChange={(e) => change(u, { role: e.target.value })}>
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  ROLE_LABELS[u.role] || u.role
                )}
              </td>
              <td>
                {u.id === me.id || !roles.includes(u.role) ? (
                  u.id === me.id ? (
                    'you'
                  ) : u.active ? (
                    'Active'
                  ) : (
                    'Inactive'
                  )
                ) : (
                  <button className="link" onClick={() => toggle(u)}>
                    {u.active ? 'Active — deactivate' : 'Inactive — activate'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
