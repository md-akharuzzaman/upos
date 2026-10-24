import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { bestPromotion, cartTotals, formatMoney } from '../lib/money.js';
import Cart from './Cart.jsx';
import CheckoutDialog from './CheckoutDialog.jsx';
import Receipt from './Receipt.jsx';
import CameraScanner from './CameraScanner.jsx';
import { useLoader } from '../lib/useLoader.js';

const PAGE = 48;
// What a barcode scanner (or a typed SKU) looks like: no spaces, has digits or a dash.
const looksLikeCode = (s) => /^[A-Za-z0-9.-]{3,40}$/.test(s) && /[\d-]/.test(s);
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function Register({ token, currency, onAuthError }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState(''); // debounced query sent to the server
  const [category, setCategory] = useState('All');
  const [subcategory, setSubcategory] = useState('');
  const [offset, setOffset] = useState(0);
  const [lines, setLines] = useState([]);
  const [checkout, setCheckout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [camera, setCamera] = useState(false);
  const searchBox = useRef(null);
  const [today] = useState(() => localDate());

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // The server searches and pages: a 200,000-product catalogue never travels to the till.
  const fetchProducts = useCallback(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (search) p.set('q', search);
    if (category !== 'All') p.set('category', category);
    if (subcategory) p.set('subcategory', subcategory);
    return api(`/api/products?${p}`, { token });
  }, [token, search, category, subcategory, offset]);
  const [result, load, loadError] = useLoader(fetchProducts, onAuthError, { items: [], total: 0 });
  // older servers answer with a plain array: filter it here
  const page = useMemo(() => {
    if (!Array.isArray(result)) return result;
    const q = query.trim().toLowerCase(); // local list: filter as you type
    const items = result.filter(
      (p) => (category === 'All' || p.category === category) && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)),
    );
    return { items, total: items.length, legacy: true, all: result };
  }, [result, query, category]);

  const fetchCategories = useCallback(() => api('/api/categories', { token }).catch(() => []), [token]);
  const [cats] = useLoader(fetchCategories, onAuthError, []);
  const tops = useMemo(() => {
    const t = cats.filter((c) => !c.parentId).map((c) => c.name);
    if (t.length) return t;
    return [...new Set((page.all || page.items).map((p) => p.category))];
  }, [cats, page]);
  const subs = useMemo(() => {
    const parent = cats.find((c) => !c.parentId && c.name === category);
    return parent ? cats.filter((c) => c.parentId === parent.id).map((c) => c.name) : [];
  }, [cats, category]);

  // running promotions, for the price preview (the server applies them again at checkout)
  const fetchPromos = useCallback(() => api('/api/promotions?running=1', { token }).catch(() => []), [token]);
  const [promotions, reloadPromos] = useLoader(fetchPromos, onAuthError, []);

  const expired = (p) => Boolean(p.expiresOn) && p.expiresOn < today;

  function add(p) {
    setNotice('');
    if (expired(p)) return setError(`${p.name} expired on ${p.expiresOn} and cannot be sold.`);
    if (p.stock < 1) return setError(`${p.name} is out of stock.`);
    setError('');
    setLines((ls) => {
      const found = ls.find((l) => l.product.id === p.id);
      if (found) return ls.map((l) => (l.product.id === p.id ? { ...l, qty: Math.min(l.qty + 1, p.stock) } : l));
      return [...ls, { product: p, qty: 1 }];
    });
  }

  // Barcode scanner: types the code and presses Enter. Exact barcode/SKU match -> into the cart.
  async function scan(code) {
    const c = code.trim();
    if (!looksLikeCode(c)) return false;
    try {
      const p = await api(`/api/products/lookup?code=${encodeURIComponent(c)}`, { token });
      add(p);
      setNotice(`Added ${p.name}`);
      setQuery('');
      return true;
    } catch (err) {
      if (err.status === 401) onAuthError();
      if (err.status === 404) setError(`No product with barcode or SKU ${c}`);
      else setError(err.message);
      return false;
    }
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
      reloadPromos();
    } catch (err) {
      if (err.status === 401) onAuthError();
      setError(err.message);
      if (err.status === 409) load();
    } finally {
      setBusy(false);
    }
  }

  const pick = (c) => {
    setCategory(c);
    setSubcategory('');
    setOffset(0);
  };
  return (
    <div className="register">
      <section className="catalog">
        {(loadError || error) && (
          <p className="error" role="alert">
            {error || loadError}
          </p>
        )}
        {notice && (
          <p className="ok" role="status">
            {notice}
          </p>
        )}
        <div className="toolbar">
          <div className="scan-row">
            <input
              ref={searchBox}
              type="search"
              aria-label="Search products"
              placeholder="Scan a barcode, or search name / SKU"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  scan(query);
                }
              }}
            />
            {typeof window !== 'undefined' && 'BarcodeDetector' in window && (
              <button type="button" onClick={() => setCamera(true)} aria-label="Scan with camera">
                Camera
              </button>
            )}
          </div>
          <div className="chips">
            {['All', ...tops].map((c) => (
              <button key={c} className={c === category ? 'chip on' : 'chip'} onClick={() => pick(c)}>
                {c}
              </button>
            ))}
          </div>
          {subs.length > 0 && (
            <div className="chips" aria-label="Sub-categories">
              {subs.map((s) => (
                <button
                  key={s}
                  className={s === subcategory ? 'chip on' : 'chip'}
                  onClick={() => {
                    setSubcategory(s === subcategory ? '' : s);
                    setOffset(0);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        {page.total === 0 && !search && category === 'All' && <p className="empty">No products yet. A manager can add them under Products.</p>}
        {page.total === 0 && (search || category !== 'All') && <p className="empty">Nothing matches.</p>}
        <div className="grid">
          {page.items.map((p) => {
            const promo = bestPromotion(p, promotions);
            const gone = expired(p);
            return (
              <button
                key={p.id}
                className={`tile${promo ? ' promo' : ''}${gone ? ' expired' : ''}`}
                onClick={() => add(p)}
                disabled={p.stock < 1 || gone}
                aria-label={`Add ${p.name}`}
              >
                <span className="t-name">{p.name}</span>
                {promo ? (
                  <span className="t-price">
                    <s>{formatMoney(p.priceCents, currency)}</s> {formatMoney(p.priceCents - promo.unitDiscountCents, currency)}
                    <small className="t-promo">{promo.promotion.name}</small>
                  </span>
                ) : (
                  <span className="t-price">{formatMoney(p.priceCents, currency)}</span>
                )}
                <span className={p.stock < 5 ? 't-stock low' : 't-stock'}>
                  {p.stock < 1 ? 'Out of stock' : `${p.stock} in stock`}
                  {p.refundable === false ? ' · final sale' : ''}
                </span>
                {p.expiresOn && <span className="t-expiry">{gone ? `Expired ${p.expiresOn}` : `Best before ${p.expiresOn}`}</span>}
              </button>
            );
          })}
        </div>
        {!page.legacy && page.total > PAGE && (
          <div className="pager">
            {offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total.toLocaleString('en-CA')}
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </button>
            <button disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>
              Next
            </button>
          </div>
        )}
      </section>
      <Cart
        lines={lines}
        promotions={promotions}
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
          totalCents={cartTotals(lines, promotions).total}
          currency={currency}
          busy={busy}
          error={error}
          onCancel={() => setCheckout(false)}
          onComplete={complete}
        />
      )}
      {camera && (
        <CameraScanner
          onCode={async (code) => {
            if (await scan(code)) setCamera(false);
          }}
          onClose={() => {
            setCamera(false);
            searchBox.current?.focus();
          }}
        />
      )}
      {receipt && <Receipt receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
