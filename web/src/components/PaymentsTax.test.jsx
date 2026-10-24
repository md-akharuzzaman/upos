import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TaxReport from './TaxReport.jsx';
import Receipt from './Receipt.jsx';
import RefundItems from './RefundItems.jsx';
import Report from './Report.jsx';
import { offeredMethods, paymentLabel, refundInstruction, validReference } from '../lib/payments.js';
import { periodPresets, taxReportSheets } from '../lib/taxreport.js';
import { can } from '../lib/permissions.js';

const json = (status, body) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

const REPORT = {
  from: '2026-07-01',
  to: '2026-09-30',
  timeZone: 'America/Toronto',
  currency: 'CAD',
  business: { name: 'Big Mart', legalName: 'Big Mart Inc.', gstHstNumber: '123456789RT0001' },
  sales: { count: 4, totalCents: 133000, discountCents: 500 },
  refunds: { count: 1, totalCents: 11300 },
  byRate: [
    {
      rateBp: 0,
      label: 'Zero-rated / exempt (0 %)',
      salesNetCents: 20000,
      salesTaxCents: 0,
      refundNetCents: 0,
      refundTaxCents: 0,
      netCents: 20000,
      taxCents: 0,
    },
    {
      rateBp: 1300,
      label: 'HST 13 %',
      salesNetCents: 100000,
      salesTaxCents: 13000,
      refundNetCents: 10000,
      refundTaxCents: 1300,
      netCents: 90000,
      taxCents: 11700,
    },
  ],
  payments: [
    { method: 'cash', salesCount: 3, salesCents: 128000, refundsCount: 1, refundCents: 11300, netCents: 116700 },
    { method: 'stripe', salesCount: 1, salesCents: 5000, refundsCount: 0, refundCents: 0, netCents: 5000 },
  ],
  totals: {
    salesNetCents: 120000,
    refundNetCents: 10000,
    taxCollectedCents: 13000,
    taxRefundedCents: 1300,
    line101Cents: 110000,
    line103Cents: 11700,
    zeroRatedCents: 20000,
    taxableCents: 90000,
  },
};

describe('payment helpers (mirror app/src/domain/payments.js)', () => {
  it('labels, references, offered methods and refund instructions', () => {
    expect(offeredMethods(undefined)).toEqual(['cash', 'debit', 'credit']);
    expect(offeredMethods({ paymentMethods: ['stripe', 'cash'] })).toEqual(['cash', 'stripe']);
    expect(paymentLabel({ method: 'credit', brand: 'amex' })).toBe('Credit card · American Express');
    expect(paymentLabel({ method: 'debit', brand: 'interac' })).toBe('Debit (Interac)');
    expect(paymentLabel({ method: 'card' })).toBe('Card');
    expect(validReference('debit', 'AUTH-1')).toBe(true);
    expect(validReference('debit', '4111 1111 1111 1111')).toBe(false);
    expect(validReference('etransfer', 'CA1MRtX9')).toBe(true);
    expect(validReference('stripe', 'pi_3Q0abcDEF123')).toBe(true);
    expect(validReference('stripe', 'ch_1')).toBe(false);
    expect(refundInstruction({ method: 'stripe', reference: 'pi_1' })).toMatch(/Stripe dashboard/);
  });

  it('only Admins and Managers see the GST/HST tab', () => {
    expect(can({ role: 'manager' }, 'reports.tax')).toBe(true);
    expect(can({ role: 'sales' }, 'reports.tax')).toBe(false);
  });
});

describe('GST/HST periods and export', () => {
  it('monthly, quarterly and annual periods around today', () => {
    const p = Object.fromEntries(periodPresets('2026-01-15').map((x) => [x.id, [x.from, x.to]]));
    expect(p['this-month']).toEqual(['2026-01-01', '2026-01-31']);
    expect(p['last-month']).toEqual(['2025-12-01', '2025-12-31']);
    expect(p['this-quarter']).toEqual(['2026-01-01', '2026-03-31']);
    expect(p['last-quarter']).toEqual(['2025-10-01', '2025-12-31']);
    expect(p['last-year']).toEqual(['2025-01-01', '2025-12-31']);
    expect(Object.fromEntries(periodPresets('2028-02-10').map((x) => [x.id, x.to]))['this-month']).toBe('2028-02-29');
    expect(periodPresets('2026-10-24').find((x) => x.id === 'last-quarter').label).toBe('Last quarter (Q3 2026)');
  });

  it('the workbook has the return lines, the rates and the payments', async () => {
    const sheets = taxReportSheets(REPORT);
    expect(sheets.map((s) => s.sheet)).toEqual(['Summary', 'By tax rate', 'Payments']);
    const line = (label) => sheets[0].data.find((row) => row[0]?.value?.startsWith(label))[1].value;
    expect(line('Line 101')).toBe(1100);
    expect(line('Line 103')).toBe(117);
    expect(sheets[1].data[2].map((c) => c.value)).toEqual(['HST 13 %', 1000, 130, 100, 13, 900, 117]);
    expect(sheets[2].data[1][0].value).toBe('Cash');
    const { default: writeExcelFile } = await import('write-excel-file/universal');
    const blob = await writeExcelFile(sheets).toBlob();
    expect(blob.size).toBeGreaterThan(3000);
  });
});

describe('<TaxReport>', () => {
  it('loads the chosen period and shows the return lines', async () => {
    const urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        urls.push(url);
        return json(200, REPORT);
      }),
    );
    render(<TaxReport token="t" currency="CAD" now="2026-10-24" />);
    expect(await screen.findByTestId('tax-line101')).toHaveTextContent('$1,100.00');
    expect(screen.getByTestId('tax-line103')).toHaveTextContent('$117.00');
    expect(screen.getByTestId('tax-business')).toHaveTextContent('GST/HST 123456789RT0001');
    expect(urls[0]).toBe('/api/reports/tax?from=2026-10-01&to=2026-10-31');
    const rates = screen.getByRole('table', { name: 'By tax rate' });
    expect(within(rates).getByText('HST 13 %').closest('tr')).toHaveTextContent('$117.00');
    expect(within(screen.getByRole('table', { name: 'Payments' })).getByText('Stripe')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/period/i), 'last-quarter');
    expect(urls.at(-1)).toBe('/api/reports/tax?from=2026-07-01&to=2026-09-30');
    await userEvent.selectOptions(screen.getByLabelText(/period/i), 'custom');
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-01');
  });

  it('warns when the GST/HST number is missing and shows API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { ...REPORT, business: { name: 'Shop' } })),
    );
    const { unmount } = render(<TaxReport token="t" currency="CAD" now="2026-10-24" />);
    expect(await screen.findByText(/no gst\/hst number yet/i)).toBeInTheDocument();
    unmount();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(403, { error: 'your role (sales) cannot do this' })),
    );
    render(<TaxReport token="t" currency="CAD" now="2026-10-24" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot do this');
  });
});

describe('payments on receipts, refunds and the daily report', () => {
  const receipt = {
    saleId: 'x1',
    receiptNo: 1002,
    store: { currency: 'CAD', name: 'Big Mart' },
    createdAt: '2026-10-24T15:00:00Z',
    cashier: 'Cam',
    lines: [{ lineNo: 1, sku: 'A', name: 'Apples', qty: 1, unitPriceCents: 500, taxRateBp: 0, lineSubtotalCents: 500, lineTaxCents: 0, refundedQty: 0 }],
    subtotalCents: 500,
    taxCents: 0,
    totalCents: 500,
    payment: { method: 'etransfer', reference: 'CA1MRtX9cXyz' },
    refunds: [],
  };

  it('the receipt names the method and its reference', () => {
    render(<Receipt receipt={{ ...receipt, payment: { method: 'credit', brand: 'visa', reference: 'CR-9' } }} onClose={vi.fn()} />);
    expect(screen.getByText('Credit card · Visa')).toBeInTheDocument();
    expect(screen.getByTestId('receipt-payment-ref')).toHaveTextContent('CR-9');
  });

  it('a refund goes back the way the customer paid', () => {
    render(<RefundItems receipt={receipt} token="t" onCancel={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText(/send this amount back to the customer by interac e-transfer/i)).toHaveTextContent('CA1MRtX9cXyz');
  });

  it('the daily report lists each method used', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(200, {
          salesCount: 3,
          refundsCount: 0,
          grossCents: 1500,
          refundedCents: 0,
          discountCents: 0,
          taxCents: 0,
          averageSaleCents: 500,
          byPayment: {
            cash: { count: 0, totalCents: 0 },
            card: { count: 0, totalCents: 0 },
            debit: { count: 2, totalCents: 1000 },
            stripe: { count: 1, totalCents: 500 },
          },
          topProducts: [],
        }),
      ),
    );
    render(<Report token="t" currency="CAD" />);
    expect(await screen.findByText('Debit (Interac)')).toBeInTheDocument();
    expect(screen.getByText('Stripe')).toBeInTheDocument();
    expect(screen.queryByText('Card')).not.toBeInTheDocument();
  });
});
