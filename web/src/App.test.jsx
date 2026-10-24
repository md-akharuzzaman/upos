import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';

// A tiny fake of the eURC POS API, enough to drive every screen.
function fakeApi() {
  const store = { id: 's1', slug: 'demo', name: 'Demo Café', currency: 'CAD' };
  const users = [
    { id: 'u1', email: 'manager@demo.test', name: 'Maya Manager', role: 'manager', active: true },
    { id: 'u2', email: 'cashier@demo.test', name: 'Cal Cashier', role: 'cashier', active: true },
  ];
  const products = [
    { id: 'p1', sku: 'COF-001', name: 'Coffee', category: 'Drinks', priceCents: 245, taxRateBp: 1300, stock: 10, active: true },
    { id: 'p2', sku: 'BAK-002', name: 'Muffin', category: 'Bakery', priceCents: 295, taxRateBp: 0, stock: 5, active: true },
  ];
  const sales = [];
  let current = null;

  const json = (status, body) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));

  const handler = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const path = url.split('?')[0];
    if (path === '/api/info') return json(200, { environment: 'test', slot: 'production', version: '2.0.0+7.abc', commit: 'abc', region: 'canadacentral' });
    if (path === '/api/auth/login') {
      current = users.find((u) => u.email === body.email);
      return current ? json(200, { token: `t-${current.id}`, user: current, store }) : json(401, { error: 'incorrect' });
    }
    if (path === '/api/products' && method === 'GET') return json(200, products.filter((p) => p.active || url.includes('all=1')));
    if (path === '/api/products' && method === 'POST') {
      const p = { id: `p${products.length + 1}`, category: 'General', taxRateBp: 1300, stock: 0, active: true, ...body };
      products.push(p);
      return json(201, p);
    }
    if (path.startsWith('/api/products/') && method === 'PATCH') {
      const p = products.find((x) => x.id === path.split('/').pop());
      Object.assign(p, body);
      return json(200, p);
    }
    if (path === '/api/sales' && method === 'POST') {
      let sub = 0;
      let tax = 0;
      const lines = body.items.map((i) => {
        const p = products.find((x) => x.id === i.productId);
        p.stock -= i.qty;
        const s = p.priceCents * i.qty;
        const t = Math.round((s * p.taxRateBp) / 10000);
        sub += s;
        tax += t;
        return { sku: p.sku, name: p.name, qty: i.qty, lineSubtotalCents: s, lineTaxCents: t };
      });
      const total = sub + tax;
      const pay = body.payment.method === 'cash' ? { ...body.payment, changeCents: body.payment.tenderedCents - total } : { method: 'card', cardReference: body.payment.reference };
      const sale = { id: `x${sales.length + 1}`, receiptNo: 1001 + sales.length, cashierName: current.name, createdAt: new Date().toISOString(), lines, subtotalCents: sub, taxCents: tax, totalCents: total, payment: pay, status: 'completed' };
      sales.push(sale);
      return json(201, { sale, receipt: { ...sale, saleId: sale.id, cashier: sale.cashierName, store } });
    }
    if (path === '/api/sales') return json(200, sales);
    if (/^\/api\/sales\/[^/]+\/receipt$/.test(path)) {
      const s = sales.find((x) => x.id === path.split('/')[3]);
      return json(200, { ...s, saleId: s.id, cashier: s.cashierName, store });
    }
    if (/\/refunds$/.test(path)) {
      const s = sales.find((x) => x.id === path.split('/')[3]);
      const lines = body.items.map(({ lineNo, qty }) => {
        const l = s.lines.find((x) => x.lineNo === lineNo);
        l.refundedQty = (l.refundedQty || 0) + qty;
        return { lineNo, sku: l.sku, name: l.name, qty, lineSubtotalCents: l.unitPriceCents * qty, lineTaxCents: 0 };
      });
      const total = lines.reduce((t, l) => t + l.lineSubtotalCents, 0);
      const refund = { id: `r${(s.refunds || []).length + 1}`, refundNo: `R-${s.receiptNo}-1`, createdAt: new Date().toISOString(), lines, totalCents: total, reason: body.reason };
      s.refunds = [...(s.refunds || []), refund];
      s.refundedCents = (s.refundedCents || 0) + total;
      s.refundState = 'partial';
      return json(201, { sale: s, refund, receipt: { ...s, saleId: s.id, cashier: s.cashierName, store } });
    }
    if (/\/refund$/.test(path)) {
      const s = sales.find((x) => x.id === path.split('/')[3]);
      s.status = 'refunded';
      return json(200, s);
    }
    if (path === '/api/reports/daily') {
      const done = sales.filter((s) => s.status === 'completed');
      return json(200, {
        salesCount: done.length,
        refundsCount: sales.length - done.length,
        grossCents: done.reduce((t, s) => t + s.totalCents, 0),
        taxCents: 0,
        averageSaleCents: 0,
        byPayment: { cash: { count: done.length, totalCents: 0 }, card: { count: 0, totalCents: 0 } },
        topProducts: [{ sku: 'COF-001', name: 'Coffee', qty: 2, revenueCents: 490 }],
      });
    }
    if (path === '/api/users' && method === 'GET') return json(200, users);
    if (path === '/api/users' && method === 'POST') {
      const u = { id: `u${users.length + 1}`, active: true, ...body };
      users.push(u);
      return json(201, u);
    }
    if (path.startsWith('/api/users/')) {
      const u = users.find((x) => x.id === path.split('/').pop());
      u.active = body.active;
      return json(200, u);
    }
    return json(404, { error: 'not found' });
  });
  return { handler, products, sales, users };
}

async function signIn(email) {
  await userEvent.type(screen.getByLabelText(/store code/i), 'demo');
  await userEvent.type(screen.getByLabelText(/e-mail/i), email);
  await userEvent.type(screen.getByLabelText(/password/i), 'Password123');
  await userEvent.click(screen.getAllByRole('button', { name: 'Sign in' }).at(-1));
}

describe('<App> end-to-end against a fake API', () => {
  let fake;
  beforeEach(() => {
    sessionStorage.clear();
    fake = fakeApi();
    vi.stubGlobal('fetch', fake.handler);
    vi.stubGlobal('print', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('cashier sells two coffees and a muffin for cash', async () => {
    render(<App />);
    expect(await screen.findByTestId('env-badge')).toHaveTextContent('test');
    await signIn('cashier@demo.test');
    await userEvent.click(await screen.findByRole('button', { name: 'Add Coffee' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Coffee' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Muffin' }));
    expect(screen.getByTestId('cart-total')).toHaveTextContent('$8.49');
    expect(screen.queryByRole('button', { name: 'Products' })).toBeNull();

    // filter by category and search
    await userEvent.click(screen.getByRole('button', { name: 'Bakery' }));
    expect(screen.queryByRole('button', { name: 'Add Coffee' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.type(screen.getByLabelText('Search products'), 'muf');
    expect(screen.queryByRole('button', { name: 'Add Coffee' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /charge/i }));
    await userEvent.type(screen.getByLabelText(/cash received/i), '10');
    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }));
    expect(await screen.findByTestId('receipt-change')).toHaveTextContent('$1.51');
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    await userEvent.click(screen.getByRole('button', { name: 'New sale' }));
    expect(screen.getByText(/tap a product/i)).toBeInTheDocument();
    expect(fake.sales).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getAllByRole('button', { name: 'Sign in' }).length).toBeGreaterThan(0);
  });

  it('manager manages products, staff, sales and sees the report', async () => {
    fake.sales.push({
      id: 'x1', receiptNo: 1001, cashierName: 'Cal', createdAt: new Date().toISOString(),
      lines: [{ sku: 'COF-001', name: 'Coffee', qty: 2, lineSubtotalCents: 490 }],
      subtotalCents: 490, taxCents: 64, totalCents: 554, payment: { method: 'cash', tenderedCents: 600, changeCents: 46 }, status: 'completed',
    });
    render(<App />);
    await signIn('manager@demo.test');

    await userEvent.click(await screen.findByRole('button', { name: 'Products' }));
    const form = screen.getByRole('form', { name: 'Add product' });
    await userEvent.type(within(form).getByLabelText('SKU'), 'TEA-001');
    await userEvent.type(within(form).getByLabelText('Name'), 'Green tea');
    await userEvent.type(within(form).getByLabelText('Price'), '2.25');
    await userEvent.click(within(form).getByRole('button', { name: 'Add product' }));
    expect(await screen.findByRole('cell', { name: 'TEA-001' })).toBeInTheDocument();
    expect(fake.products.at(-1).priceCents).toBe(225);
    await userEvent.type(screen.getByLabelText('Units received for COF-001'), '5');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    await vi.waitFor(() => expect(fake.products[0].stock).toBe(15));
    await userEvent.click(screen.getAllByRole('button', { name: 'Active' })[0]);
    await vi.waitFor(() => expect(fake.products[0].active).toBe(false));
    await userEvent.type(within(form).getByLabelText('Price'), 'abc');
    await userEvent.type(within(form).getByLabelText('SKU'), 'X');
    await userEvent.type(within(form).getByLabelText('Name'), 'Y');
    await userEvent.click(within(form).getByRole('button', { name: 'Add product' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid price/);

    await userEvent.click(screen.getByRole('button', { name: 'Staff' }));
    const staff = screen.getByRole('form', { name: 'Add staff member' });
    await userEvent.type(within(staff).getByLabelText('Name'), 'Casey');
    await userEvent.type(within(staff).getByLabelText('E-mail'), 'casey@demo.test');
    await userEvent.type(within(staff).getByLabelText('Temporary password'), 'Password123');
    await userEvent.click(within(staff).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('cell', { name: 'Casey' })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /deactivate/ })[0]);
    await vi.waitFor(() => expect(fake.users[1].active).toBe(false));

    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(await screen.findByTestId('report-gross')).toHaveTextContent('$5.54');
    expect(screen.getByTestId('report-count')).toHaveTextContent('1');

    await userEvent.click(screen.getByRole('button', { name: 'Sales' }));
    await userEvent.click(await screen.findByText('#1001'));
    await userEvent.click(await screen.findByRole('button', { name: 'Refund sale' }));
    await vi.waitFor(() => expect(fake.sales[0].status).toBe('refunded'));
  });

  it('manager refunds one item, then the rest', async () => {
    fake.sales.push({
      id: 'x1', receiptNo: 1001, cashierName: 'Cal', createdAt: new Date().toISOString(),
      lines: [
        { lineNo: 1, sku: 'COF-001', name: 'Coffee', qty: 2, unitPriceCents: 245, taxRateBp: 0, lineSubtotalCents: 490, lineTaxCents: 0, refundedQty: 0 },
        { lineNo: 2, sku: 'BAK-002', name: 'Muffin', qty: 1, unitPriceCents: 295, taxRateBp: 0, lineSubtotalCents: 295, lineTaxCents: 0, refundedQty: 0 },
      ],
      subtotalCents: 785, taxCents: 0, totalCents: 785, payment: { method: 'cash', tenderedCents: 800, changeCents: 15 },
      status: 'completed', refundedCents: 0, refundState: 'none', refunds: [],
    });
    render(<App />);
    await signIn('manager@demo.test');
    await userEvent.click(await screen.findByRole('button', { name: 'Sales' }));
    await userEvent.click(await screen.findByText('#1001'));
    await userEvent.click(await screen.findByRole('button', { name: 'Refund items' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Refund items' }));
    const qty = screen.getByLabelText('Refund quantity for Coffee');
    await userEvent.clear(qty);
    await userEvent.type(qty, '1');
    await userEvent.click(screen.getByRole('button', { name: 'Refund $2.45' }));

    expect(await screen.findByText('PARTLY REFUNDED')).toBeInTheDocument();
    expect(screen.getByText(/Refund R-1001-1/)).toBeInTheDocument();
    expect(screen.getByTestId('receipt-net')).toHaveTextContent('$5.40');
    expect(await screen.findByText('part refunded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refund the rest' }));
    await vi.waitFor(() => expect(fake.sales[0].status).toBe('refunded'));
  });

  it('an expired session returns to the sign-in screen', async () => {
    sessionStorage.setItem('eurc.session', JSON.stringify({ token: 'old', user: { name: 'X', role: 'cashier' }, store: { name: 'S', currency: 'CAD' } }));
    fake.handler.mockImplementation(async (url) =>
      url === '/api/info' ? new Response('{}', { status: 200 }) : new Response(JSON.stringify({ error: 'session expired' }), { status: 401 }),
    );
    render(<App />);
    expect(await screen.findByLabelText(/store code/i)).toBeInTheDocument();
  });
});
