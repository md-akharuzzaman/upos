import { useState } from 'react';
import { formatMoney, parseMoney, quickTenders } from '../lib/money.js';

export default function CheckoutDialog({ totalCents, currency, onCancel, onComplete, busy, error }) {
  const [method, setMethod] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const tenderedCents = parseMoney(tendered);
  const change = tenderedCents != null ? tenderedCents - totalCents : null;
  const canPay = method === 'cash' ? tenderedCents != null && change >= 0 : /^[A-Za-z0-9-]{4,40}$/.test(reference.trim());

  function submit(e) {
    e.preventDefault();
    if (!canPay) return;
    onComplete(method === 'cash' ? { method, tenderedCents } : { method, reference: reference.trim() });
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <form className="card dialog" onSubmit={submit}>
        <h2 id="checkout-title">Take payment</h2>
        <p className="due">
          Amount due <b>{formatMoney(totalCents, currency)}</b>
        </p>
        <div className="segmented" role="radiogroup" aria-label="Payment method">
          {['cash', 'card'].map((m) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => setMethod(m)}>
              {m === 'cash' ? 'Cash' : 'Card'}
            </button>
          ))}
        </div>
        {method === 'cash' ? (
          <>
            <label>
              Cash received
              <input inputMode="decimal" autoFocus value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="0.00" />
            </label>
            <div className="quick">
              {quickTenders(totalCents).map((v) => (
                <button type="button" key={v} onClick={() => setTendered((v / 100).toFixed(2))}>
                  {formatMoney(v, currency)}
                </button>
              ))}
            </div>
            <p className={`change ${change != null && change < 0 ? 'short' : ''}`} aria-live="polite">
              {change == null ? 'Enter the cash received' : change < 0 ? `Short by ${formatMoney(-change, currency)}` : `Change due ${formatMoney(change, currency)}`}
            </p>
          </>
        ) : (
          <>
            <label>
              Terminal approval code
              <input autoFocus value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. AUTH-7731" />
            </label>
            <p className="hint">Take the card on the payment terminal, then enter its approval code. Card numbers are never entered here.</p>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Back
          </button>
          <button className="primary" disabled={!canPay || busy}>
            {busy ? 'Saving…' : 'Complete sale'}
          </button>
        </div>
      </form>
    </div>
  );
}
