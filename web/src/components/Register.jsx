import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { cartTotals, formatMoney } from '../lib/money.js';
import Cart from './Cart.jsx';
import CheckoutDialog from './CheckoutDialog.jsx';
import Receipt from './Receipt.jsx';
import { useLoader } from '../lib/useLoader.js';

export default function Register({ token, currency, onAuthError }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [lines, setLines] = useState([]);
  const [checkout, setCheckout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);

  const fetchProducts = useCallback(() => api('/api/products', { token }), [token]);
  const [products, load, loadError] = useLoader(fetchProducts, onAuthError, []);

  const categories = useMemo(() => ['All', ...new Set(products.map((p) => p.category))], [products]);
  const shown = products.filter(
    (p) =>
      (category === 'All' || p.category === category) &&
      (!query || p.name.toLowerCase().includes(query.toLowerCase()) || p.sku.toLowerCase().includes(query.toLowerCase())),
  );

  function add(p) {
    setLines((ls) => {
      const found = ls.find((l) => l.product.id === p.id);
      if (found) return ls.map((l) => (l.product.id === p.id ? { ...l, qty: Math.min(l.qty + 1, p.stock) } : l));
      return [...ls, { product: p, qty: 1 }];
    });
  }

  async function complete(payment) {
    setBusy(true);
    setError('');
    try {
      const r = await api('/api/sales', {
        method: 'POST',
        token,
        body: { items: lines.map((l) => ({ productId: l.product.id, qty: l.qty })), payment },
      });
      setReceipt(r.receipt);
      setCheckout(false);
      setLines([]);
      load();
    } catch (err) {
      if (err.status === 401) onAuthError();
      setError(err.message);
      if (err.status === 409) load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register">
      <section className="catalog">
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        <div className="toolbar">
          <input type="search" aria-label="Search products" placeholder="Search name or SKU" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="chips">
            {categories.map((c) => (
              <button key={c} className={c === category ? 'chip on' : 'chip'} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>
        {products.length === 0 && <p className="empty">No products yet. A manager can add them under Products.</p>}
        <div className="grid">
          {shown.map((p) => (
            <button key={p.id} className="tile" onClick={() => add(p)} disabled={p.stock < 1} aria-label={`Add ${p.name}`}>
              <span className="t-name">{p.name}</span>
              <span className="t-price">{formatMoney(p.priceCents, currency)}</span>
              <span className={p.stock < 5 ? 't-stock low' : 't-stock'}>{p.stock < 1 ? 'Out of stock' : `${p.stock} in stock`}</span>
            </button>
          ))}
        </div>
      </section>
      <Cart
        lines={lines}
        currency={currency}
        onQty={(id, qty) => setLines((ls) => ls.map((l) => (l.product.id === id ? { ...l, qty } : l)))}
        onRemove={(id) => setLines((ls) => ls.filter((l) => l.product.id !== id))}
        onClear={() => setLines([])}
        onCheckout={() => {
          setError('');
          setCheckout(true);
        }}
      />
      {checkout && (
        <CheckoutDialog
          totalCents={cartTotals(lines).total}
          currency={currency}
          busy={busy}
          error={error}
          onCancel={() => setCheckout(false)}
          onComplete={complete}
        />
      )}
      {receipt && <Receipt receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
