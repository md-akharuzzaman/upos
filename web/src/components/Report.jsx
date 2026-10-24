import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { formatMoney } from '../lib/money.js';
import { today, tz } from '../lib/dates.js';
import { useLoader } from '../lib/useLoader.js';

export default function Report({ token, currency, onAuthError }) {
  const [date, setDate] = useState(today());
  const fetchReport = useCallback(() => api(`/api/reports/daily?date=${date}&tz=${tz()}`, { token }), [date, token]);
  const [r, , error] = useLoader(fetchReport, onAuthError, null);

  return (
    <section className="page">
      <div className="page-head">
        <h2>Daily report</h2>
        <label className="inline">
          Day <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {r && (
        <>
          <div className="kpis">
            <div className="card kpi">
              <span>Gross sales</span>
              <b data-testid="report-gross">{formatMoney(r.grossCents, currency)}</b>
            </div>
            <div className="card kpi">
              <span>Refunded</span>
              <b data-testid="report-refunded">−{formatMoney(r.refundedCents, currency)}</b>
            </div>
            <div className="card kpi">
              <span>Net sales</span>
              <b data-testid="report-net">{formatMoney(r.netSalesCents ?? r.grossCents, currency)}</b>
            </div>
            <div className="card kpi">
              <span>Transactions</span>
              <b data-testid="report-count">{r.salesCount}</b>
            </div>
            <div className="card kpi">
              <span>Average sale</span>
              <b>{formatMoney(r.averageSaleCents, currency)}</b>
            </div>
            <div className="card kpi">
              <span>Tax collected</span>
              <b>{formatMoney(r.taxCents, currency)}</b>
            </div>
            <div className="card kpi">
              <span>Refunds</span>
              <b data-testid="report-refunds">{r.refundsCount}</b>
            </div>
          </div>
          <div className="two">
            <table className="card table">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th className="num">Count</th>
                  <th className="num">Net total</th>
                </tr>
              </thead>
              <tbody>
                {['cash', 'card'].map((m) => (
                  <tr key={m}>
                    <td>{m}</td>
                    <td className="num">{r.byPayment[m].count}</td>
                    <td className="num">{formatMoney(r.byPayment[m].totalCents, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="card table">
              <thead>
                <tr>
                  <th>Top products</th>
                  <th className="num">Qty</th>
                  <th className="num">Revenue (pre-tax)</th>
                </tr>
              </thead>
              <tbody>
                {r.topProducts.length === 0 && (
                  <tr>
                    <td colSpan={3} className="empty">
                      No sales yet.
                    </td>
                  </tr>
                )}
                {r.topProducts.map((p) => (
                  <tr key={p.sku}>
                    <td>{p.name}</td>
                    <td className="num">{p.qty}</td>
                    <td className="num">{formatMoney(p.revenueCents, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
