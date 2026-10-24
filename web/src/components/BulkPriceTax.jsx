import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatMoney, parseMoney } from '../lib/money.js';

// Manager-only: change price and/or tax for many products at once - the
// ticked products, one category, or everything. Always previewed first.
export default function BulkPriceTax({ token, products, selectedIds = [], currency, onClose, onDone }) {
  const categories = useMemo(() => [...new Set(products.map((p) => p.category))].sort(), [products]);
  const [scope, setScope] = useState(selectedIds.length ? 'selected' : 'category');
  const [category, setCategory] = useState(categories[0] || '');
  const [mode, setMode] = useState('percent');
  const [value, setValue] = useState('');
  const [taxOn, setTaxOn] = useState(false);
  const [tax, setTax] = useState('13');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function body() {
    const b = {};
    if (scope === 'selected') b.productIds = selectedIds;
    else if (scope === 'category') b.category = category;
    else b.all = true;
    if (mode !== 'none') {
      const raw = value.trim();
      const neg = raw.startsWith('-');
      const abs = raw.replace(/^[+-]/, '');
      let v;
      if (mode === 'percent') v = Number(abs) * 100;
      else v = parseMoney(abs);
      if (v == null || !Number.isFinite(v) || abs === '') throw new Error(mode === 'percent' ? 'Enter a percentage, e.g. 10 or -5' : 'Enter an amount, e.g. 2.50');
      if (mode === 'set' && neg) throw new Error('A price cannot be negative');
      b.price = { mode, value: Math.round(neg ? -v : v) };
    }
    if (taxOn) {
      const t = Number(tax);
      if (!Number.isFinite(t) || t < 0 || t > 50) throw new Error('Tax must be between 0 and 50 %');
      b.taxRateBp = Math.round(t * 100);
    }
    if (!b.price && b.taxRateBp === undefined) throw new Error('Choose a price change and/or a new tax rate');
    return b;
  }

  async function run(dryRun) {
    setError('');
    setBusy(true);
    try {
      const out = await api('/api/products/bulk-update', { method: 'POST', token, body: { ...body(), dryRun } });
      if (dryRun) setPreview(out);
      else onDone?.(out);
    } catch (err) {
      setError(err.message);
      if (dryRun) setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const reset = (fn) => (e) => {
    fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    setPreview(null);
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
      <div className="card dialog wide">
        <h2 id="bulk-title">Change prices and tax</h2>
        <fieldset>
          <legend>Products</legend>
          {selectedIds.length > 0 && (
            <label className="check">
              <input type="radio" name="scope" checked={scope === 'selected'} onChange={() => (setScope('selected'), setPreview(null))} /> The {selectedIds.length}{' '}
              ticked product(s)
            </label>
          )}
          <label className="check">
            <input type="radio" name="scope" checked={scope === 'category'} onChange={() => (setScope('category'), setPreview(null))} /> Category
            <select aria-label="Category" value={category} onChange={reset(setCategory)} disabled={scope !== 'category'}>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="radio" name="scope" checked={scope === 'all'} onChange={() => (setScope('all'), setPreview(null))} /> All products
          </label>
        </fieldset>
        <fieldset>
          <legend>Price</legend>
          <select aria-label="Price change" value={mode} onChange={reset(setMode)}>
            <option value="none">Keep prices</option>
            <option value="percent">Increase / decrease by %</option>
            <option value="amount">Increase / decrease by $</option>
            <option value="set">Set price to $</option>
          </select>
          {mode !== 'none' && (
            <input
              aria-label="Price change value"
              value={value}
              onChange={reset(setValue)}
              inputMode="decimal"
              placeholder={mode === 'percent' ? 'e.g. 10 or -5' : mode === 'amount' ? 'e.g. 0.25 or -0.50' : 'e.g. 2.99'}
            />
          )}
        </fieldset>
        <fieldset>
          <legend>Tax</legend>
          <label className="check">
            <input type="checkbox" checked={taxOn} onChange={reset(setTaxOn)} /> Change tax to
            <input aria-label="New tax %" value={tax} onChange={reset(setTax)} disabled={!taxOn} inputMode="decimal" size={4} /> %
          </label>
        </fieldset>
        {preview && (
          <div className="scroll">
            <table className="table" aria-label="Preview">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th className="num">Price now</th>
                  <th className="num">New price</th>
                  <th className="num">Tax now</th>
                  <th className="num">New tax</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.id}>
                    <td>{c.sku}</td>
                    <td>{c.name}</td>
                    <td className="num">{formatMoney(c.before.priceCents, currency)}</td>
                    <td className="num">
                      <b>{formatMoney(c.after.priceCents, currency)}</b>
                    </td>
                    <td className="num">{c.before.taxRateBp / 100}%</td>
                    <td className="num">
                      <b>{c.after.taxRateBp / 100}%</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => run(true)} disabled={busy}>
            Preview
          </button>
          <button className="primary" disabled={!preview || busy} onClick={() => run(false)}>
            Apply to {preview ? preview.count : '…'} product(s)
          </button>
        </div>
      </div>
    </div>
  );
}
