import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { formatMoney, parseMoney } from '../lib/money.js';
import { useLoader } from '../lib/useLoader.js';
import { downloadProducts } from '../lib/excel.js';
import BulkPriceTax from './BulkPriceTax.jsx';
import ImportProducts from './ImportProducts.jsx';

const EMPTY = { sku: '', name: '', category: 'General', price: '', tax: '13', stock: '0' };

export default function Products({ token, currency, onAuthError }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restock, setRestock] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [editing, setEditing] = useState(null); // { id, price, tax }
  const [dialog, setDialog] = useState(null); // 'import' | 'bulk'

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
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  async function saveEdit() {
    const priceCents = parseMoney(editing.price);
    const tax = Number(editing.tax);
    if (priceCents == null) return setError('Enter a valid price, e.g. 2.45');
    if (!Number.isFinite(tax) || tax < 0 || tax > 50) return setError('Tax must be between 0 and 50 %');
    if (await patch(editing.id, { priceCents, taxRateBp: Math.round(tax * 100) })) setEditing(null);
  }

  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allTicked = rows.length > 0 && rows.every((p) => selected.has(p.id));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <section className="page">
      <div className="page-head">
        <h2>Products</h2>
        <div className="actions">
          <button onClick={() => setDialog('import')}>Import from Excel</button>
          <button onClick={() => downloadProducts(rows, 'eurc-products.xlsx').catch((err) => setError(err.message))} disabled={rows.length === 0}>
            Export to Excel
          </button>
          <button className="primary" onClick={() => setDialog('bulk')} disabled={rows.length === 0}>
            Change prices / tax{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>
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
      <p className="hint">Products in the category “Food” are final sale by default. Use the Refunds column to change any product.</p>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      <table className="card table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Tick all products"
                checked={allTicked}
                onChange={() => setSelected(allTicked ? new Set() : new Set(rows.map((p) => p.id)))}
              />
            </th>
            <th>SKU</th>
            <th>Name</th>
            <th>Category</th>
            <th className="num">Price</th>
            <th className="num">Tax</th>
            <th />
            <th className="num">Stock</th>
            <th>Receive stock</th>
            <th>Refunds</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const ed = editing?.id === p.id;
            return (
              <tr key={p.id} className={p.active ? '' : 'inactive'}>
                <td>
                  <input type="checkbox" aria-label={`Tick ${p.sku}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                </td>
                <td>{p.sku}</td>
                <td>{p.name}</td>
                <td>{p.category}</td>
                {ed ? (
                  <>
                    <td className="num">
                      <input
                        aria-label={`Price for ${p.sku}`}
                        size={6}
                        inputMode="decimal"
                        value={editing.price}
                        onChange={(e) => setEditing({ ...editing, price: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input aria-label={`Tax % for ${p.sku}`} size={3} inputMode="decimal" value={editing.tax} onChange={(e) => setEditing({ ...editing, tax: e.target.value })} />
                    </td>
                    <td>
                      <button className="primary" onClick={saveEdit}>
                        Save
                      </button>{' '}
                      <button className="link" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="num">{formatMoney(p.priceCents, currency)}</td>
                    <td className="num">{p.taxRateBp / 100}%</td>
                    <td>
                      <button
                        className="link"
                        aria-label={`Edit price and tax of ${p.sku}`}
                        onClick={() => setEditing({ id: p.id, price: (p.priceCents / 100).toFixed(2), tax: String(p.taxRateBp / 100) })}
                      >
                        Edit
                      </button>
                    </td>
                  </>
                )}
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
                  <button className="link" aria-label={`Refund policy for ${p.sku}`} onClick={() => patch(p.id, { refundable: !p.refundable })}>
                    {p.refundable ? 'Refundable' : 'Final sale'}
                  </button>
                </td>
                <td>
                  <button className="link" onClick={() => patch(p.id, { active: !p.active })}>
                    {p.active ? 'Active' : 'Hidden'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {dialog === 'import' && (
        <ImportProducts
          token={token}
          onClose={() => setDialog(null)}
          onImported={(out) => {
            setNotice(`Imported ${out.created} new and ${out.updated} updated product(s).`);
            load();
          }}
        />
      )}
      {dialog === 'bulk' && (
        <BulkPriceTax
          token={token}
          products={rows}
          selectedIds={[...selected]}
          currency={currency}
          onClose={() => setDialog(null)}
          onDone={(out) => {
            setDialog(null);
            setSelected(new Set());
            setNotice(`Updated ${out.count} product(s).`);
            load();
          }}
        />
      )}
    </section>
  );
}
