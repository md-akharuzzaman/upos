import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { formatMoney, parseMoney } from '../lib/money.js';
import { useLoader } from '../lib/useLoader.js';
import ProductPicker from './ProductPicker.jsx';
import { categoryOptions } from '../lib/categories.js';

const EMPTY = { name: '', kind: 'percent', value: '', target: 'all', category: '', skus: [], from: '', to: '' };

/** Local date (YYYY-MM-DD from <input type=date>) -> ISO at local midnight. */
const startOfDay = (d) => new Date(`${d}T00:00:00`).toISOString();
/** Local midnight at the END of that day (calendar arithmetic, so DST days are 23 or 25 hours). */
const endOfDay = (d) => {
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + 1);
  return t.toISOString();
};

const COLORS = { running: 'green', scheduled: 'amber', ended: 'red' };

export default function Promotions({ token, currency, onAuthError }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const fetchRows = useCallback(() => api('/api/promotions', { token }), [token]);
  const [rows, load, loadError] = useLoader(fetchRows, onAuthError, []);
  const fetchCats = useCallback(() => api('/api/categories', { token }).catch(() => []), [token]);
  const [cats] = useLoader(fetchCats, onAuthError, []);

  async function add(e) {
    e.preventDefault();
    setError('');
    const value = form.kind === 'percent' ? Math.round(Number(form.value) * 100) : parseMoney(form.value);
    if (!value || value < 1) return setError(form.kind === 'percent' ? 'Enter a percentage, e.g. 15' : 'Enter an amount, e.g. 0.50');
    const body = { name: form.name, kind: form.kind, value, target: form.target };
    if (form.target === 'category') body.category = form.category;
    if (form.target === 'skus') {
      if (form.skus.length === 0) return setError('Choose at least one product');
      body.skus = form.skus;
    }
    if (form.from) body.startsAt = startOfDay(form.from);
    // "to" is the last day of the offer, inclusive: it ends at the next midnight
    if (form.to) body.endsAt = endOfDay(form.to);
    try {
      await api('/api/promotions', { method: 'POST', token, body });
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function end(p) {
    try {
      await api(`/api/promotions/${p.id}`, { method: 'PATCH', token, body: { active: false } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <section className="page">
      <h2>Promotions</h2>
      <form className="card inline-form" onSubmit={add} aria-label="New promotion">
        <label className="grow">
          Name
          <input value={form.name} onChange={set('name')} required minLength={2} maxLength={120} placeholder="e.g. Coffee week" />
        </label>
        <label>
          Discount
          <select value={form.kind} onChange={set('kind')}>
            <option value="percent">% off</option>
            <option value="amount">$ off each</option>
          </select>
        </label>
        <label>
          {form.kind === 'percent' ? 'Percent' : 'Amount'}
          <input value={form.value} onChange={set('value')} inputMode="decimal" required size={6} placeholder={form.kind === 'percent' ? '15' : '0.50'} />
        </label>
        <label>
          Applies to
          <select value={form.target} onChange={set('target')}>
            <option value="all">All products</option>
            <option value="category">A category</option>
            <option value="skus">Chosen SKUs</option>
          </select>
        </label>
        {form.target === 'category' && (
          <label>
            Category
            {cats.length ? (
              <select value={form.category} onChange={set('category')} required>
                <option value="">— choose —</option>
                {categoryOptions(cats).map((o) => (
                  <option key={o.key} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input value={form.category} onChange={set('category')} required />
            )}
          </label>
        )}
        {form.target === 'skus' && <ProductPicker token={token} label="SKUs" value={form.skus} onChange={(skus) => setForm({ ...form, skus })} />}
        <label>
          From
          <input type="date" value={form.from} onChange={set('from')} />
        </label>
        <label>
          To (last day)
          <input type="date" value={form.to} onChange={set('to')} />
        </label>
        <button className="primary">Create promotion</button>
      </form>
      <p className="hint">
        The best running promotion applies automatically at the till (they never stack). Tax is charged on the discounted price. Leave “From” empty to start now
        and “To” empty to run until you end it.
      </p>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      <table className="card table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Discount</th>
            <th>Applies to</th>
            <th>From</th>
            <th>To</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                No promotions yet.
              </td>
            </tr>
          )}
          {rows.map((p) => {
            const label = p.state || (p.running ? 'running' : 'ended'); // state comes from the server clock
            const color = COLORS[label];
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.kind === 'percent' ? `${p.value / 100}% off` : `${formatMoney(p.value, currency)} off each`}</td>
                <td>{p.target === 'all' ? 'All products' : p.target === 'category' ? `Category: ${p.category}` : p.skus.join(', ')}</td>
                <td>{new Date(p.startsAt).toLocaleDateString('en-CA')}</td>
                <td>{p.endsAt ? new Date(new Date(p.endsAt).getTime() - 1).toLocaleDateString('en-CA') : '—'}</td>
                <td>
                  <span className={`badge ${color}`}>{label}</span>
                </td>
                <td>
                  {label !== 'ended' && (
                    <button className="link" onClick={() => end(p)} aria-label={`End ${p.name}`}>
                      End now
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
