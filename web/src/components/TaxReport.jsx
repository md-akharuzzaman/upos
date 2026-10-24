import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatMoney } from '../lib/money.js';
import { today } from '../lib/dates.js';
import { LONG_LABELS } from '../lib/payments.js';
import { downloadTaxReport, periodPresets } from '../lib/taxreport.js';
import { useLoader } from '../lib/useLoader.js';

// GST/HST report (v2.4): what goes on the GST/HST return for a filing period.
export default function TaxReport({ token, currency, onAuthError, now = today() }) {
  const presets = useMemo(() => periodPresets(now), [now]);
  const [preset, setPreset] = useState('this-month');
  const [custom, setCustom] = useState({ from: presets[0].from, to: now });
  const period = preset === 'custom' ? custom : presets.find((p) => p.id === preset);
  const [exportError, setExportError] = useState('');

  const fetchReport = useCallback(() => api(`/api/reports/tax?from=${period.from}&to=${period.to}`, { token }), [period.from, period.to, token]);
  const [r, , error] = useLoader(fetchReport, onAuthError, null);
  const m = (cents) => formatMoney(cents, r?.currency || currency);
  const minus = (cents) => (cents ? `−${m(cents)}` : m(0));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  async function exportExcel() {
    setExportError('');
    try {
      await downloadTaxReport(r);
    } catch (err) {
      setExportError(`Could not create the Excel file: ${err.message}`);
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h2>GST/HST report</h2>
        <label className="inline">
          Period{' '}
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom dates…</option>
          </select>
        </label>
        {preset === 'custom' && (
          <>
            <label className="inline">
              From <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </label>
            <label className="inline">
              To <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </label>
          </>
        )}
        <button onClick={exportExcel} disabled={!r}>
          Export to Excel
        </button>
      </div>
      {(error || exportError) && (
        <p className="error" role="alert">
          {error || exportError}
        </p>
      )}
      {r && (
        <>
          <p className="muted" data-testid="tax-business">
            {r.business.legalName || r.business.name} ·{' '}
            {r.business.gstHstNumber ? `GST/HST ${r.business.gstHstNumber}` : <b className="bad">No GST/HST number yet - add it in Business</b>} · {r.from} to{' '}
            {r.to} ({r.timeZone})
          </p>
          <div className="kpis">
            <div className="card kpi">
              <span>Line 101 · Sales and other revenue</span>
              <b data-testid="tax-line101">{m(r.totals.line101Cents)}</b>
              <small>before tax, after refunds · zero-rated {m(r.totals.zeroRatedCents)}</small>
            </div>
            <div className="card kpi">
              <span>GST/HST collected on sales</span>
              <b>{m(r.totals.taxCollectedCents)}</b>
              <small>{plural(r.sales.count, 'sale', 'sales')}</small>
            </div>
            <div className="card kpi">
              <span>GST/HST refunded</span>
              <b>{minus(r.totals.taxRefundedCents)}</b>
              <small>{plural(r.refunds.count, 'refund', 'refunds')}</small>
            </div>
            <div className="card kpi">
              <span>Line 103 · GST/HST collected</span>
              <b data-testid="tax-line103">{m(r.totals.line103Cents)}</b>
              <small>net of refunds given in the period</small>
            </div>
          </div>
          <table className="card table" aria-label="By tax rate">
            <thead>
              <tr>
                <th>Tax rate</th>
                <th className="num">Sales before tax</th>
                <th className="num">Tax on sales</th>
                <th className="num">Refunds</th>
                <th className="num">Tax refunded</th>
                <th className="num">Net sales</th>
                <th className="num">Net tax</th>
              </tr>
            </thead>
            <tbody>
              {r.byRate.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No sales or refunds in this period.
                  </td>
                </tr>
              )}
              {r.byRate.map((x) => (
                <tr key={x.rateBp}>
                  <td>{x.label}</td>
                  <td className="num">{m(x.salesNetCents)}</td>
                  <td className="num">{m(x.salesTaxCents)}</td>
                  <td className="num">{minus(x.refundNetCents)}</td>
                  <td className="num">{minus(x.refundTaxCents)}</td>
                  <td className="num">{m(x.netCents)}</td>
                  <td className="num">
                    <b>{m(x.taxCents)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="two">
            <table className="card table" aria-label="Payments">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th className="num">Sales</th>
                  <th className="num">Refunded</th>
                  <th className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {r.payments.map((p) => (
                  <tr key={p.method}>
                    <td>{LONG_LABELS[p.method] || p.method}</td>
                    <td className="num">
                      {m(p.salesCents)} <small className="muted">({p.salesCount})</small>
                    </td>
                    <td className="num">{minus(p.refundCents)}</td>
                    <td className="num">{m(p.netCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card notes">
              <h3>Before you file</h3>
              <ul>
                <li>Sales count in the period they were made; refunds in the period they were given.</li>
                <li>Promotion discounts ({m(r.sales.discountCents)}) are already taken off: tax was charged on the discounted price.</li>
                <li>Input tax credits (line 106) come from your purchase invoices and are not part of this report.</li>
                <li>Check the figures with your accountant or the CRA before you file. This report does not file anything.</li>
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
