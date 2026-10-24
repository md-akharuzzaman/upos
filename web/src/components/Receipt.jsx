import { formatMoney } from '../lib/money.js';

export default function Receipt({ receipt, onClose, closeLabel = 'New sale', extra }) {
  const c = receipt.store?.currency || 'CAD';
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={`Receipt ${receipt.receiptNo}`}>
      <div className="card dialog receipt">
        <div className="printable">
          <h2>{receipt.store?.name}</h2>
          <p className="muted">
            Receipt <b>#{receipt.receiptNo}</b> · {new Date(receipt.createdAt).toLocaleString('en-CA')}
            <br />
            Cashier: {receipt.cashier}
          </p>
          {receipt.status === 'refunded' && <p className="stamp">REFUNDED</p>}
          {receipt.status !== 'refunded' && receipt.refundState === 'partial' && <p className="stamp partial">PARTLY REFUNDED</p>}
          <table>
            <tbody>
              {receipt.lines.map((l) => (
                <tr key={l.lineNo ?? l.sku}>
                  <td>
                    {l.qty} × {l.name}
                    {l.refundable === false && <span title="Final sale"> *</span>}
                    {l.discountCents > 0 && (
                      <small className="line-promo">
                        <br />
                        {l.promotionName} −{formatMoney(l.discountCents, c)}
                      </small>
                    )}
                    {l.refundedQty > 0 && receipt.status !== 'refunded' && (
                      <span className="refunded-note"> · {l.refundedQty === l.qty ? 'refunded' : `${l.refundedQty} refunded`}</span>
                    )}
                  </td>
                  <td className="num">{formatMoney(l.lineSubtotalCents, c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="totals">
            {receipt.discountCents > 0 && (
              <>
                <dt>You saved</dt>
                <dd className="saving" data-testid="receipt-savings">
                  {formatMoney(receipt.discountCents, c)}
                </dd>
              </>
            )}
            <dt>Subtotal</dt>
            <dd>{formatMoney(receipt.subtotalCents, c)}</dd>
            <dt>Tax</dt>
            <dd>{formatMoney(receipt.taxCents, c)}</dd>
            <dt className="grand">Total</dt>
            <dd className="grand">{formatMoney(receipt.totalCents, c)}</dd>
            {receipt.payment.method === 'cash' ? (
              <>
                <dt>Cash</dt>
                <dd>{formatMoney(receipt.payment.tenderedCents, c)}</dd>
                <dt>Change</dt>
                <dd data-testid="receipt-change">{formatMoney(receipt.payment.changeCents, c)}</dd>
              </>
            ) : (
              <>
                <dt>Card</dt>
                <dd>{receipt.payment.cardReference}</dd>
              </>
            )}
          </dl>
          {receipt.refunds?.length > 0 && (
            <table className="refunds" aria-label="Refunds">
              <tbody>
                {receipt.refunds.map((r) => (
                  <tr key={r.id}>
                    <td>
                      Refund {r.refundNo} · {new Date(r.createdAt).toLocaleString('en-CA')}
                      <br />
                      <small className="muted">
                        {r.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}
                        {r.reason ? ` — ${r.reason}` : ''}
                      </small>
                    </td>
                    <td className="num">−{formatMoney(r.totalCents, c)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <b>Net paid</b>
                  </td>
                  <td className="num" data-testid="receipt-net">
                    <b>{formatMoney(receipt.totalCents - receipt.refundedCents, c)}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {receipt.policy && (
            <p className="muted center policy" data-testid="receipt-policy">
              {receipt.policy}
            </p>
          )}
          <p className="muted center">Thank you!</p>
        </div>
        <div className="actions no-print">
          {extra}
          <button onClick={() => window.print()}>Print</button>
          <button className="primary" onClick={onClose}>
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
