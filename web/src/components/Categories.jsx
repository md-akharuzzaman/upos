import { useState } from 'react';
import { api } from '../api.js';

// Category tree (two levels) with the final-sale default per category.
export default function Categories({ token, categories, onChanged, onClose }) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [finalSale, setFinalSale] = useState(false);
  const [error, setError] = useState('');
  const tops = categories.filter((c) => !c.parentId);
  const kids = (id) => categories.filter((c) => c.parentId === id);

  async function run(fn) {
    setError('');
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  const add = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/api/categories', { method: 'POST', token, body: { name, parentId: parentId || null, finalSale } });
      setName('');
    });
  };
  const flip = (c) => run(() => api(`/api/categories/${c.id}`, { method: 'PATCH', token, body: { finalSale: !c.finalSale } }));
  const row = (c) => (
    <li key={c.id}>
      <span>{c.name}</span>
      <button className="link" onClick={() => flip(c)} aria-label={`Final sale default for ${c.name}`}>
        {c.finalSale ? 'Final sale' : 'Refundable'}
      </button>
    </li>
  );

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="cat-title">
      <div className="card dialog wide">
        <h2 id="cat-title">Categories</h2>
        <p className="hint">New products in a category marked “Final sale” are not refundable by default. Two levels: category and sub-category.</p>
        <form className="inline-form" onSubmit={add} aria-label="Add category">
          <label className="grow">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </label>
          <label>
            Under
            <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">(top level)</option>
              {tops.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={finalSale} onChange={(e) => setFinalSale(e.target.checked)} /> Final sale
          </label>
          <button className="primary">Add</button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="scroll cat-tree">
          {tops.length === 0 && <p className="empty">No categories yet. An Admin can add starter categories for the store type on the Business page.</p>}
          <ul>
            {tops.map((t) => (
              <li key={t.id} style={{ display: 'block' }}>
                <ul style={{ paddingLeft: 0 }}>{row(t)}</ul>
                <ul>{kids(t.id).map(row)}</ul>
              </li>
            ))}
          </ul>
        </div>
        <div className="actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
