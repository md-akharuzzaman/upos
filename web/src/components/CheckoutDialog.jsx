import { useState } from 'react';
import { formatMoney, parseMoney, quickTenders } from '../lib/money.js';
import { CARD_BRANDS, LABELS, offeredMethods, validReference } from '../lib/payments.js';

// Takes the payment for a sale. The POS only records how the customer paid:
// cards go through the store's payment terminal, e-Transfers to the store's
// e-mail, Stripe through Stripe. No card number is ever typed in here.
export default function CheckoutDialog({ totalCents, currency, profile, onCancel, onComplete, busy, error }) {
  const methods = offeredMethods(profile);
  const [method, setMethod] = useState(methods[0]);
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [brand, setBrand] = useState('');
  const tenderedCents = parseMoney(tendered);
  const change = tenderedCents != null ? tenderedCents - totalCents : null;
  const canPay = method === 'cash' ? tenderedCents != null && change >= 0 : validReference(method, reference);

  const choose = (m) => {
    setMethod(m);
    setReference('');
  };

  function submit(e) {
    e.preventDefault();
    if (!canPay) return;
    if (method === 'cash') return onComplete({ method, tenderedCents });
    return onComplete({ method, reference: reference.trim(), ...(method === 'credit' && brand ? { brand } : {}) });
  }

  const due = formatMoney(totalCents, currency);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <form className="card dialog" onSubmit={submit}>
        <h2 id="checkout-title">Take payment</h2>
        <p className="due">
          Amount due <b>{due}</b>
        </p>
        <div className="segmented" role="radiogroup" aria-label="Payment method">
          {methods.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => choose(m)}>
              {LABELS[m]}
            </button>
          ))}
        </div>
        {method === 'cash' && (
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
              {change == null
                ? 'Enter the cash received'
                : change < 0
                  ? `Short by ${formatMoney(-change, currency)}`
                  : `Change due ${formatMoney(change, currency)}`}
            </p>
          </>
        )}
        {(method === 'debit' || method === 'credit') && (
          <>
            {method === 'credit' && (
              <label>
                Card brand (optional)
                <select value={brand} onChange={(e) => setBrand(e.target.value)}>
                  <option value="">Not recorded</option>
                  {CARD_BRANDS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Terminal approval code
              <input autoFocus value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. AUTH-7731" />
            </label>
            <p className="hint">
              Take the {method === 'debit' ? 'Interac debit' : 'credit card'} payment of {due} on the terminal, then enter its approval code. Card numbers are
              never entered here.
            </p>
          </>
        )}
        {method === 'etransfer' && (
          <>
            <p className="hint" data-testid="etransfer-instructions">
              Ask the customer to send <b>{due}</b> by Interac e-Transfer to <b>{profile?.etransferEmail || 'the store e-mail'}</b>. When the deposit
              notification arrives, enter its reference number.
            </p>
            <label>
              e-Transfer reference number
              <input autoFocus value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. CA1MRtX9cXyz" />
            </label>
          </>
        )}
        {method === 'stripe' && (
          <>
            <p className="hint">Charge {due} in Stripe (Terminal reader, payment link or invoice), then enter the payment id from the Stripe dashboard.</p>
            <label>
              Stripe payment id
              <input autoFocus value={reference} onChange={(e) => setReference(e.target.value)} placeholder="pi_…" />
            </label>
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
