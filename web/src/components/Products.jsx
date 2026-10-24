import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatMoney, parseMoney } from '../lib/money.js';
import { useLoader } from '../lib/useLoader.js';
import { downloadProducts } from '../lib/excel.js';
import BulkPriceTax from './BulkPriceTax.jsx';
import ImportProducts from './ImportProducts.jsx';
import Categories from './Categories.jsx';

const PAGE = 50;
const EMPTY = { sku: '', barcode: '', name: '', category: '', subcategory: '', price: '', tax: '13', stock: '0', expiresOn: '' };
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function Products({ token, currency, canEditCategories = true, onAuthError }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restock, setRestock] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [editing, setEditing] = useState(null); // { id, price, tax, barcode, expiresOn }
  const [dialog, setDialog] = useState(null); // 'import' | 'bulk' | 'categories'
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState({ category: '', subcategory: '', expiring: '' });
  const [offset, setOffset] = useState(0);
  const [today] = useState(() => localDate());

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Server-side search and paging: works the same for 50 or 200,000 products.
  const fetchRows = useCallback(() => {
    const p = new URLSearchParams({ all: '1', limit: String(PAGE), offset: String(offset) });
    if (search) p.set('q', search);
    if (filter.category) p.set('category', filter.category);
    if (filter.subcategory) p.set('subcategory', filter.subcategory);
    if (filter.expiring !== '') p.set('expiring', filter.expiring);
    return api(`/api/products?${p}`, { token });
  }, [token, search, filter, offset]);
  const [result, load, loadError] = useLoader(fetchRows, onAuthError, { items: [], total: 0 });
  const rows = Array.isArray(result) ? result : result.items; // older servers: plain array
  const total = Array.isArray(result) ? result.length : result.total;

  const fetchCats = useCallback(() => api('/api/categories', { token }).catch(() => []), [token]);
  const [cats, reloadCats] = useLoader(fetchCats, onAuthError, []);
  const tops = useMemo(() => cats.filter((c) => !c.parentId), [cats]);
  const subsOf = (name) => {
    const t = tops.find((c) => c.name === name);
    return t ? cats.filter((c) => c.parentId === t.id) : [];
  };

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
          subcategory: form.subcategory || null,
          barcode: form.barcode || null,
          expiresOn: form.expiresOn || null,
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
    const body = { priceCents, taxRateBp: Math.round(tax * 100) };
    if (editing.barcode !== undefined) body.barcode = editing.barcode || null;
    if (editing.expiresOn !== undefined) body.expiresOn = editing.expiresOn || null;
    if (await patch(editing.id, body)) setEditing(null);
  }

  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allTicked = rows.length > 0 && rows.every((p) => selected.has(p.id));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value, ...(k === 'category' ? { subcategory: '' } : {}) });
  const setF = (k) => (e) => {
    setFilter({ ...filter, [k]: e.target.value, ...(k === 'category' ? { subcategory: '' } : {}) });
    setOffset(0);
  };

  async function exportAll() {
    setError('');
    try {
      // the export follows the current search/filters, up to 20,000 rows (the CLI handles more)
      const all = [];
      for (let off = 0; off < Math.min(total, 20000); off += 200) {
        const p = new URLSearchParams({ all: '1', limit: '200', offset: String(off) });
        if (search) p.set('q', search);
        if (filter.category) p.set('category', filter.category);
        if (filter.subcategory) p.set('subcategory', filter.subcategory);
        if (filter.expiring !== '') p.set('expiring', filter.expiring);
        const r = await api(`/api/products?${p}`, { token });
        all.push(...(Array.isArray(r) ? r : r.items));
        if (Array.isArray(r)) break;
      }
      await downloadProducts(all, 'eurc-products.xlsx');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h2>Products</h2>
        <div className="actions">
          {canEditCategories && <button onClick={() => setDialog('categories')}>Categories</button>}
          <button onClick={() => setDialog('import')}>Import from Excel</button>
          <button onClick={exportAll} disabled={total === 0}>
            Export to Excel
          </button>
          <button className="primary" onClick={() => setDialog('bulk')} disabled={total === 0}>
            Change prices / tax{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>
      <form className="card inline-form" onSubmit={add} aria-label="Add product">
        <label>
          SKU
          <input value={form.sku} onChange={set('sku')} required maxLength={40} />
        </label>
        <label>
          Barcode
          <input value={form.barcode} onChange={set('barcode')} maxLength={32} inputMode="numeric" placeholder="scan or type" />
        </label>
        <label className="grow">
          Name
          <input value={form.name} onChange={set('name')} required maxLength={120} />
        </label>
        <label>
          Category
          {tops.length ? (
            <select value={form.category} onChange={set('category')}>
              <option value="">General</option>
              {tops.map((c) => (
                <option key={c.id}>{c.name}</option>
              ))}
            </select>
          ) : (
            <input value={form.category} onChange={set('category')} maxLength={60} placeholder="General" />
          )}
        </label>
        {subsOf(form.category).length > 0 && (
          <label>
            Sub-category
            <select value={form.subcategory} onChange={set('subcategory')}>
              <option value="">—</option>
              {subsOf(form.category).map((c) => (
                <option key={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
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
        <label>
          Expiry date
          <input type="date" value={form.expiresOn} onChange={set('expiresOn')} />
        </label>
        <button className="primary">Add product</button>
      </form>
      <p className="hint">Products in a category marked “Final sale” (by default: Food) are not refundable. Use the Refunds column to change any product.</p>
      <div className="filters card" role="search" aria-label="Find products">
        <label className="grow">
          Search
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, SKU or barcode" aria-label="Search the catalogue" />
        </label>
        {tops.length > 0 && (
          <label>
            Category
            <select value={filter.category} onChange={setF('category')} aria-label="Filter by category">
              <option value="">All</option>
              {tops.map((c) => (
                <option key={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
        {subsOf(filter.category).length > 0 && (
          <label>
            Sub-category
            <select value={filter.subcategory} onChange={setF('subcategory')} aria-label="Filter by sub-category">
              <option value="">All</option>
              {subsOf(filter.category).map((c) => (
                <option key={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Expiry
          <select value={filter.expiring} onChange={setF('expiring')} aria-label="Filter by expiry">
            <option value="">Any</option>
            <option value="0">Expired</option>
            <option value="3">Within 3 days</option>
            <option value="7">Within 7 days</option>
            <option value="30">Within 30 days</option>
          </select>
        </label>
      </div>
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
            <th>Expiry</th>
            <th>Refunds</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={12} className="empty">
                {search || filter.category || filter.expiring !== '' ? 'Nothing matches.' : 'No products yet.'}
              </td>
            </tr>
          )}
          {rows.map((p) => {
            const ed = editing?.id === p.id;
            const expired = p.expiresOn && p.expiresOn < today;
            return (
              <tr key={p.id} className={p.active ? '' : 'inactive'}>
                <td>
                  <input type="checkbox" aria-label={`Tick ${p.sku}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                </td>
                <td>
                  {p.sku}
                  {p.barcode && !ed && <small className="muted block">{p.barcode}</small>}
                  {ed && (
                    <input
                      aria-label={`Barcode for ${p.sku}`}
                      size={13}
                      value={editing.barcode ?? ''}
                      onChange={(e) => setEditing({ ...editing, barcode: e.target.value })}
                      placeholder="barcode"
                    />
                  )}
                </td>
                <td>{p.name}</td>
                <td>
                  {p.category}
                  {p.subcategory && <small className="muted block">{p.subcategory}</small>}
                </td>
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
                      <input
                        aria-label={`Tax % for ${p.sku}`}
                        size={3}
                        inputMode="decimal"
                        value={editing.tax}
                        onChange={(e) => setEditing({ ...editing, tax: e.target.value })}
                      />
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
                        onClick={() =>
                          setEditing({
                            id: p.id,
                            price: (p.priceCents / 100).toFixed(2),
                            tax: String(p.taxRateBp / 100),
                            barcode: p.barcode ?? '',
                            expiresOn: p.expiresOn ?? '',
                          })
                        }
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
                  {ed ? (
                    <input
                      type="date"
                      aria-label={`Expiry date for ${p.sku}`}
                      value={editing.expiresOn ?? ''}
                      onChange={(e) => setEditing({ ...editing, expiresOn: e.target.value })}
                    />
                  ) : p.expiresOn ? (
                    <span className={expired ? 'badge red' : 'badge grey'}>{expired ? `expired ${p.expiresOn}` : p.expiresOn}</span>
                  ) : (
                    '—'
                  )}
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
      {!Array.isArray(result) && total > PAGE && (
        <div className="pager">
          {offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString('en-CA')}
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </button>
          <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </button>
        </div>
      )}
      {dialog === 'import' && (
        <ImportProducts
          token={token}
          onClose={() => setDialog(null)}
          onImported={(out) => {
            setNotice(`Imported ${out.created.toLocaleString('en-CA')} new and ${out.updated.toLocaleString('en-CA')} updated product(s).`);
            load();
          }}
        />
      )}
      {dialog === 'bulk' && (
        <BulkPriceTax
          token={token}
          products={rows}
          categories={cats}
          selectedIds={[...selected]}
          currency={currency}
          onClose={() => setDialog(null)}
          onDone={(out) => {
            setDialog(null);
            setSelected(new Set());
            setNotice(`Updated ${out.count.toLocaleString('en-CA')} product(s).`);
            load();
          }}
        />
      )}
      {dialog === 'categories' && (
        <Categories
          token={token}
          categories={cats}
          onChanged={reloadCats}
          onClose={() => {
            setDialog(null);
            reloadCats();
          }}
        />
      )}
    </section>
  );
}
