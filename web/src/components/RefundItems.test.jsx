import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RefundItems from './RefundItems.jsx';
import { refundPreview } from '../lib/money.js';

// Receipt #1001: 3 x Tea $1.05 (13 %, line tax 41 ¢), 2 x Bun $2.95 (no tax); one tea already refunded.
const receipt = {
  saleId: 'x1',
  receiptNo: 1001,
  store: { currency: 'CAD' },
  payment: { method: 'card', cardReference: 'AUTH-7731' },
  lines: [
    { lineNo: 1, sku: 'TEA', name: 'Tea', qty: 3, unitPriceCents: 105, taxRateBp: 1300, lineSubtotalCents: 315, lineTaxCents: 41, refundedQty: 1, refundedSubtotalCents: 105, refundedTaxCents: 14 },
    { lineNo: 2, sku: 'BUN', name: 'Bun', qty: 2, unitPriceCents: 295, taxRateBp: 0, lineSubtotalCents: 590, lineTaxCents: 0, refundedQty: 0, refundedSubtotalCents: 0, refundedTaxCents: 0 },
  ],
};

describe('refundPreview (must match app/src/domain/refunds.js)', () => {
  it('rounds per unit, and the last units return the tax still held', () => {
    expect(refundPreview(receipt.lines, { 1: 1 })).toEqual({ subtotal: 105, tax: 14, total: 119, items: 1 });
    expect(refundPreview(receipt.lines, { 1: 2 })).toEqual({ subtotal: 210, tax: 27, total: 237, items: 2 }); // 41 - 14
    expect(refundPreview(receipt.lines, {})).toEqual({ subtotal: 0, tax: 0, total: 0, items: 0 });
  });
});

describe('<RefundItems>', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('previews the refund, caps quantities and posts the chosen lines', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sale: {}, refund: { refundNo: 'R-1001-2' }, receipt: {} }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const onDone = vi.fn();
    render(<RefundItems receipt={receipt} token="t" onCancel={vi.fn()} onDone={onDone} />);

    const submit = screen.getByRole('button', { name: /^refund \$/i });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/reverse this amount on the card terminal/i)).toHaveTextContent('AUTH-7731');

    const bun = screen.getByLabelText('Refund quantity for Bun');
    await userEvent.clear(bun);
    await userEvent.type(bun, '5'); // only 2 sold: capped
    expect(bun).toHaveValue(2);
    expect(screen.getByTestId('refund-total')).toHaveTextContent('$5.90');

    await userEvent.type(screen.getByLabelText(/reason/i), 'stale');
    await userEvent.click(screen.getByRole('button', { name: 'Refund $5.90' }));
    expect(fetch).toHaveBeenCalledWith('/api/sales/x1/refunds', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ items: [{ lineNo: 2, qty: 2 }], reason: 'stale' });
    expect(onDone).toHaveBeenCalled();
  });

  it('"Select everything left" picks the remaining quantities; server errors are shown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'only 1 × Tea can still be refunded' }), { status: 409 })));
    render(<RefundItems receipt={receipt} token="t" onCancel={vi.fn()} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /select everything left/i }));
    expect(screen.getByLabelText('Refund quantity for Tea')).toHaveValue(2);
    expect(screen.getByTestId('refund-total')).toHaveTextContent('$8.27'); // 2.37 + 5.90
    await userEvent.click(screen.getByRole('button', { name: 'Refund $8.27' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('only 1 × Tea');
  });
});
