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
          <table>
            <tbody>
              {receipt.lines.map((l) => (
                <tr key={l.sku}>
                  <td>
                    {l.qty} × {l.name}
                  </td>
                  <td className="num">{formatMoney(l.lineSubtotalCents, c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="totals">
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
