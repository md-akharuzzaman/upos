import { useState } from 'react';
import { api } from '../api.js';
import { formatMoney, refundPreview } from '../lib/money.js';

// Manager-only: refund chosen items from a receipt. The server re-prices and
// re-checks everything (including the store's refund policy); this screen
// only previews the amount and explains the policy.
export default function RefundItems({ receipt, token, onCancel, onDone, now: nowProp }) {
  const c = receipt.store?.currency || 'CAD';
  const [opened] = useState(() => Date.now()); // the moment the dialog opened
  const now = nowProp ?? opened;
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const left = (l) => l.qty - (l.refundedQty || 0);
  const expired = Boolean(receipt.refundBy) && now > Date.parse(receipt.refundBy);
  const allowed = (l) => override || (!expired && l.refundable !== false);
  const policyBlocks = expired || receipt.lines.some((l) => l.refundable === false && left(l) > 0);
  const chosen = Object.fromEntries(Object.entries(qty).filter(([lineNo]) => allowed(receipt.lines.find((l) => l.lineNo === Number(lineNo)))));
  const t = refundPreview(receipt.lines, chosen);
  const cash = receipt.payment.method === 'cash';
  const reasonOk = !override || reason.trim().length >= 5;

  const set = (lineNo, v, max) => {
    const n = Math.max(0, Math.min(max, Number.parseInt(v, 10) || 0));
    setQty((q) => ({ ...q, [lineNo]: n }));
  };

  async function submit(e) {
    e.preventDefault();
    if (t.items === 0 || !reasonOk) return;
    setBusy(true);
    setError('');
    try {
      const items = Object.entries(chosen)
        .filter(([, q]) => q > 0)
        .map(([lineNo, q]) => ({ lineNo: Number(lineNo), qty: q }));
      const out = await api(`/api/sales/${receipt.saleId}/refunds`, {
        method: 'POST',
        token,
        body: { items, reason: reason.trim() || undefined, ...(override ? { override: true } : {}) },
      });
      onDone(out);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="refund-title">
      <form className="card dialog refund" onSubmit={submit}>
        <h2 id="refund-title">Refund items</h2>
        <p className="muted">
          Receipt <b>#{receipt.receiptNo}</b> · choose how many of each item come back.
          {receipt.refundBy && !expired && <> Refundable until {new Date(receipt.refundBy).toLocaleDateString('en-CA')}.</>}
        </p>
        {expired && (
          <p className="notice" role="status">
            The refund window for this sale ended on {new Date(receipt.refundBy).toLocaleDateString('en-CA')}.
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Can refund</th>
              <th className="num">Refund</th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>
                  {l.name}
                  <small>
                    {formatMoney(Math.round(l.lineSubtotalCents / l.qty), c)} paid each · sold {l.qty}
                    {l.refundedQty ? ` · ${l.refundedQty} refunded` : ''}
                    {l.refundable === false && <b className="final"> · Final sale</b>}
                  </small>
                </td>
                <td className="num">{left(l)}</td>
                <td className="num">
                  <input
                    type="number"
                    min="0"
                    max={left(l)}
                    disabled={left(l) === 0 || !allowed(l)}
                    aria-label={`Refund quantity for ${l.name}`}
                    value={allowed(l) ? (qty[l.lineNo] ?? 0) : 0}
                    onChange={(e) => set(l.lineNo, e.target.value, left(l))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          className="link"
          onClick={() => setQty(Object.fromEntries(receipt.lines.filter(allowed).map((l) => [l.lineNo, left(l)])))}
        >
          Select everything left
        </button>
        {policyBlocks && (
          <label className="check">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            Override the store refund policy (manager) — a reason is required and recorded
          </label>
        )}
        <label>
          {override ? 'Reason (required for an override)' : 'Reason (optional)'}
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged, wrong item" />
        </label>
        <dl className="totals">
          <dt>Subtotal</dt>
          <dd>{formatMoney(t.subtotal, c)}</dd>
          <dt>Tax</dt>
          <dd>{formatMoney(t.tax, c)}</dd>
          <dt className="grand">Refund</dt>
          <dd className="grand" data-testid="refund-total">
            {formatMoney(t.total, c)}
          </dd>
        </dl>
        <p className="hint">
          {cash
            ? 'Give the customer this amount in cash from the drawer.'
            : `Reverse this amount on the card terminal (original approval ${receipt.payment.cardReference}).`}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Back
          </button>
          <button className="danger" disabled={t.items === 0 || busy || !reasonOk}>
            {busy ? 'Saving…' : `Refund ${formatMoney(t.total, c)}`}
          </button>
        </div>
      </form>
    </div>
  );
}
