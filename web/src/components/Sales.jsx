import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { formatMoney } from '../lib/money.js';
import Receipt from './Receipt.jsx';
import RefundItems from './RefundItems.jsx';
import { useLoader } from '../lib/useLoader.js';
import { today, tz } from '../lib/dates.js';
import { paymentLabel } from '../lib/payments.js';

export default function Sales({ token, currency, canRefund = false, canOverride = false, onAuthError }) {
  const [date, setDate] = useState(today());
  const [open, setOpen] = useState(null);
  const [refunding, setRefunding] = useState(false);
  const [error, setError] = useState('');

  const fetchRows = useCallback(() => api(`/api/sales?date=${date}&tz=${tz()}&limit=200`, { token }), [date, token]);
  const [rows, load, loadError] = useLoader(fetchRows, onAuthError, []);

  async function show(id) {
    setError('');
    try {
      setOpen(await api(`/api/sales/${id}/receipt`, { token }));
    } catch (err) {
      setError(err.message);
    }
  }
  async function refund() {
    try {
      await api(`/api/sales/${open.saleId}/refund`, { method: 'POST', token });
      setOpen(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h2>Sales</h2>
        <label className="inline">
          Day <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      <table className="card table">
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Time</th>
            <th>Cashier</th>
            <th>Items</th>
            <th>Payment</th>
            <th className="num">Total</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                No sales on this day.
              </td>
            </tr>
          )}
          {rows.map((s) => (
            <tr key={s.id} className="clickable" onClick={() => show(s.id)}>
              <td>#{s.receiptNo}</td>
              <td>{new Date(s.createdAt).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })}</td>
              <td>{s.cashierName}</td>
              <td>{s.lines.reduce((n, l) => n + l.qty, 0)}</td>
              <td>{paymentLabel(s.payment)}</td>
              <td className="num">{formatMoney(s.totalCents, currency)}</td>
              <td>
                {s.status === 'refunded' ? (
                  <span className="badge red">refunded</span>
                ) : s.refundedCents > 0 ? (
                  <span className="badge amber">part refunded</span>
                ) : (
                  <span className="badge green">paid</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && refunding && (
        <RefundItems
          receipt={open}
          token={token}
          canOverride={canOverride}
          onCancel={() => setRefunding(false)}
          onDone={(out) => {
            setRefunding(false);
            setOpen({ ...out.receipt, source: 'live' });
            load();
          }}
        />
      )}
      {open && !refunding && (
        <Receipt
          receipt={open}
          closeLabel="Close"
          onClose={() => setOpen(null)}
          extra={
            canRefund && open.status === 'completed' ? (
              <>
                {open.lines.every((l) => l.lineNo) && <button onClick={() => setRefunding(true)}>Refund items</button>}
                <button className="danger" onClick={refund}>
                  {open.refundedCents > 0 ? 'Refund the rest' : 'Refund sale'}
                </button>
              </>
            ) : null
          }
        />
      )}
    </section>
  );
}
