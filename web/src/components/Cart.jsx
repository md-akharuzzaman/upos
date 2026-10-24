import { cartTotals, formatMoney } from '../lib/money.js';

export default function Cart({ lines, currency, onQty, onRemove, onClear, onCheckout }) {
  const t = cartTotals(lines);
  return (
    <aside className="card cart" aria-label="Current sale">
      <div className="cart-head">
        <h2>Current sale</h2>
        {lines.length > 0 && (
          <button className="link" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="empty">Tap a product to add it.</p>
      ) : (
        <ul className="cart-lines">
          {lines.map((l) => (
            <li key={l.product.id}>
              <div className="cl-name">
                {l.product.name}
                <small>
                  {formatMoney(l.product.priceCents, currency)}
                  {l.product.taxRateBp ? ` · tax ${l.product.taxRateBp / 100}%` : ' · no tax'}
                </small>
              </div>
              <div className="qty" role="group" aria-label={`Quantity of ${l.product.name}`}>
                <button aria-label={`Decrease ${l.product.name}`} onClick={() => (l.qty > 1 ? onQty(l.product.id, l.qty - 1) : onRemove(l.product.id))}>
                  −
                </button>
                <span aria-live="polite">{l.qty}</span>
                <button aria-label={`Increase ${l.product.name}`} disabled={l.qty >= l.product.stock} onClick={() => onQty(l.product.id, l.qty + 1)}>
                  +
                </button>
              </div>
              <div className="cl-total">{formatMoney(l.product.priceCents * l.qty, currency)}</div>
            </li>
          ))}
        </ul>
      )}
      <dl className="totals">
        <dt>Subtotal</dt>
        <dd>{formatMoney(t.subtotal, currency)}</dd>
        <dt>Tax</dt>
        <dd>{formatMoney(t.tax, currency)}</dd>
        <dt className="grand">Total</dt>
        <dd className="grand" data-testid="cart-total">
          {formatMoney(t.total, currency)}
        </dd>
      </dl>
      <button className="primary big" disabled={lines.length === 0} onClick={onCheckout}>
        Charge {formatMoney(t.total, currency)}
      </button>
    </aside>
  );
}
