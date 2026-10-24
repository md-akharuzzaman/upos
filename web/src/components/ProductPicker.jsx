import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Searchable product picker (type to search the server; works with any
// catalogue size). value: array of SKUs.
export default function ProductPicker({ token, value, onChange, label = 'Products' }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);

  useEffect(() => {
    if (q.trim().length < 2) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      api(`/api/products?limit=8&q=${encodeURIComponent(q.trim())}`, { token })
        .then((r) => alive && setHits(Array.isArray(r) ? r.slice(0, 8) : r.items))
        .catch(() => alive && setHits([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, token]);

  const shown = q.trim().length < 2 ? [] : hits;
  return (
    <div className="picker grow">
      <label>
        {label}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name, SKU or barcode" aria-label={`Search ${label}`} />
      </label>
      {shown.length > 0 && (
        <ul className="suggest" role="listbox">
          {shown.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={value.includes(p.sku)}
                onClick={() => {
                  if (!value.includes(p.sku)) onChange([...value, p.sku]);
                  setQ('');
                }}
              >
                {p.sku} · {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length > 0 && (
        <div className="chips-list" aria-label={`Chosen ${label}`}>
          {value.map((sku) => (
            <span key={sku} className="chip on">
              {sku}
              <button type="button" className="link light" aria-label={`Remove ${sku}`} onClick={() => onChange(value.filter((s) => s !== sku))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
