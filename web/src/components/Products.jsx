import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { formatMoney, parseMoney } from '../lib/money.js';
import { useLoader } from '../lib/useLoader.js';

const EMPTY = { sku: '', name: '', category: 'General', price: '', tax: '13', stock: '0' };

export default function Products({ token, currency, onAuthError }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [restock, setRestock] = useState({});

  const fetchRows = useCallback(() => api('/api/products?all=1', { token }), [token]);
  const [rows, load, loadError] = useLoader(fetchRows, onAuthError, []);

  async function add(e) {
    e.preventDefault();
    setError('');
    const priceCents = parseMoney(form.price);
    if (priceCents == null) return setError('Enter a valid price, e.g. 2.45');
    try {
      await api('/api/products', {
        method: 'POST',
        token,
        body: {
          sku: form.sku,
          name: form.name,
          category: form.category || 'General',
          priceCents,
          taxRateBp: Math.round(Number(form.tax) * 100),
          stock: Number.parseInt(form.stock, 10) || 0,
        },
      });
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function patch(id, body) {
    setError('');
    try {
      await api(`/api/products/${id}`, { method: 'PATCH', token, body });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <section className="page">
      <h2>Products</h2>
      <form className="card inline-form" onSubmit={add} aria-label="Add product">
        <label>
          SKU
          <input value={form.sku} onChange={set('sku')} required maxLength={40} />
        </label>
        <label className="grow">
          Name
          <input value={form.name} onChange={set('name')} required maxLength={120} />
        </label>
        <label>
          Category
          <input value={form.category} onChange={set('category')} maxLength={60} />
        </label>
        <label>
          Price
          <input value={form.price} onChange={set('price')} inputMode="decimal" required placeholder="0.00" />
        </label>
        <label>
          Tax %
          <input value={form.tax} onChange={set('tax')} inputMode="decimal" />
        </label>
        <label>
          Stock
          <input value={form.stock} onChange={set('stock')} inputMode="numeric" />
        </label>
        <button className="primary">Add product</button>
      </form>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      <table className="card table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Category</th>
            <th className="num">Price</th>
            <th className="num">Tax</th>
            <th className="num">Stock</th>
            <th>Receive stock</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className={p.active ? '' : 'inactive'}>
              <td>{p.sku}</td>
              <td>{p.name}</td>
              <td>{p.category}</td>
              <td className="num">{formatMoney(p.priceCents, currency)}</td>
              <td className="num">{p.taxRateBp / 100}%</td>
              <td className={p.stock < 5 ? 'num low' : 'num'}>{p.stock}</td>
              <td>
                <span className="restock">
                  <input
                    aria-label={`Units received for ${p.sku}`}
                    inputMode="numeric"
                    value={restock[p.id] || ''}
                    onChange={(e) => setRestock({ ...restock, [p.id]: e.target.value })}
                  />
                  <button
                    onClick={() => {
                      const n = Number.parseInt(restock[p.id], 10);
                      if (n > 0) patch(p.id, { stock: p.stock + n }).then(() => setRestock({ ...restock, [p.id]: '' }));
                    }}
                  >
                    Add
                  </button>
                </span>
              </td>
              <td>
                <button className="link" onClick={() => patch(p.id, { active: !p.active })}>
                  {p.active ? 'Active' : 'Hidden'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
