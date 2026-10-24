import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BulkPriceTax from './BulkPriceTax.jsx';
import ImportProducts from './ImportProducts.jsx';
import Promotions from './Promotions.jsx';
import RefundItems from './RefundItems.jsx';
import Products from './Products.jsx';
import { parseCsv, productsToSheet, rowsToProducts } from '../lib/excel.js';

const json = (status, body) => new Response(JSON.stringify(body), { status });
const products = [
  { id: 'p1', sku: 'COF-001', name: 'Coffee', category: 'Drinks', priceCents: 375, taxRateBp: 1300, stock: 10, active: true, refundable: true },
  { id: 'p2', sku: 'SAN-001', name: 'Sandwich', category: 'Food', priceCents: 600, taxRateBp: 1300, stock: 4, active: true, refundable: false },
];
afterEach(() => vi.unstubAllGlobals());

describe('excel helpers', () => {
  it('maps headings in any order and case, converts money, tax, Yes/No', () => {
    const { rows, problems } = rowsToProducts([
      ['name', 'SKU', 'Price', 'TAX %', 'Stock', 'Refundable', 'Colour'],
      ['Coffee', 'COF-001', 2.45, 0.13, 20, 'no'],
      [],
      ['Tea', 'TEA-001', '$1.99', '13%', '5', 'Yes'],
      ['Bad', 'BAD-1', 'abc', 'x', '1.5', 'maybe'],
    ]);
    expect(rows[0]).toEqual({ name: 'Coffee', sku: 'COF-001', priceCents: 245, taxRateBp: 1300, stock: 20, refundable: false });
    expect(rows[1]).toEqual({ name: 'Tea', sku: 'TEA-001', priceCents: 199, taxRateBp: 1300, stock: 5, refundable: true });
    expect(rows).toHaveLength(3);
    expect(problems).toEqual([
      'Unknown column "Colour" is ignored.',
      'Row 5: price "abc" is not a number.',
      'Row 5: tax "x" is not a number.',
      'Row 5: stock "1.5" is not a whole number.',
      'Row 5: refundable must be Yes or No.',
    ]);
    expect(rowsToProducts([['Name'], ['x']]).problems[0]).toMatch(/SKU/);
  });

  it('reads CSV with quotes and builds the template/export sheet', () => {
    expect(parseCsv('SKU,Name\r\nA-1,"Coffee, ""large"""\nB-2,Tea')).toEqual([
      ['SKU', 'Name'],
      ['A-1', 'Coffee, "large"'],
      ['B-2', 'Tea'],
    ]);
    const sheet = productsToSheet(products);
    expect(sheet[0].map((c) => c.value)).toEqual([
      'SKU',
      'Barcode',
      'Name',
      'Category',
      'Sub-category',
      'Price',
      'Tax %',
      'Stock',
      'Expiry date',
      'Refundable',
      'Active',
    ]);
    expect(sheet[2].map((c) => c.value)).toEqual(['SAN-001', '', 'Sandwich', 'Food', '', 6, 13, 4, '', 'No', 'Yes']);
    // v2.3 columns round-trip through the import mapping
    const back = rowsToProducts([
      ['SKU', 'Barcode', 'Name', 'Sub-category', 'Expiry date'],
      ['A-1', '4006381333931', 'Milk', 'Dairy', '2026-11-30'],
      ['A-2', '', 'Bad date', '', '30/11/2026'],
    ]);
    expect(back.rows[0]).toEqual({ sku: 'A-1', barcode: '4006381333931', name: 'Milk', subcategory: 'Dairy', expiresOn: '2026-11-30' });
    expect(back.problems).toEqual(['Row 3: expiry date "30/11/2026" must be YYYY-MM-DD.']);
    expect(productsToSheet([])).toHaveLength(3); // headings + 2 example rows
  });
});

describe('<ImportProducts>', () => {
  it('previews the file, shows row errors, and imports only when every row is valid', async () => {
    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push(body);
        if (body.rows.some((r) => r.sku === 'BAD'))
          return json(400, {
            error: '1 row(s) need fixing',
            created: 1,
            updated: 0,
            unchanged: 0,
            rows: [],
            errors: [{ row: 3, sku: 'BAD', error: 'name must be 1-120 characters' }],
          });
        return json(200, {
          dryRun: Boolean(body.dryRun),
          created: 1,
          updated: 1,
          unchanged: 0,
          errors: [],
          rows: [
            { row: 2, sku: 'NEW-1', action: 'create', name: 'New', changed: [] },
            { row: 3, sku: 'COF-001', action: 'update', name: 'Coffee', changed: ['priceCents'] },
          ],
        });
      }),
    );
    let sheet = [
      ['SKU', 'Name', 'Price'],
      ['NEW-1', 'New', 1],
      ['BAD', '', 1],
    ];
    const onImported = vi.fn();
    render(<ImportProducts token="t" onClose={vi.fn()} onImported={onImported} read={async () => sheet} />);
    const file = () => new File(['x'], 'products.xlsx');
    await userEvent.upload(screen.getByLabelText('Excel or CSV file'), file());
    expect(await screen.findByText('name must be 1-120 characters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();

    sheet = [
      ['SKU', 'Name', 'Price'],
      ['NEW-1', 'New', 1],
      ['COF-001', 'Coffee', 4],
    ];
    await userEvent.upload(screen.getByLabelText('Excel or CSV file'), file());
    expect(await screen.findByText('update priceCents')).toBeInTheDocument();
    expect(screen.getByTestId('import-summary')).toHaveTextContent('1 new · 1 updated · 0 unchanged');
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 products' }));
    expect(await screen.findByText(/Imported: 1 new, 1 updated/)).toBeInTheDocument();
    expect(calls.at(-1).dryRun).toBeUndefined();
    expect(onImported).toHaveBeenCalled();
  });

  it('reports unreadable files and empty sheets', async () => {
    render(<ImportProducts token="t" onClose={vi.fn()} read={async () => [['SKU']]} />);
    await userEvent.upload(screen.getByLabelText('Excel or CSV file'), new File(['x'], 'empty.csv'));
    expect(await screen.findByRole('alert')).toHaveTextContent('no product rows');
  });
});

describe('<BulkPriceTax>', () => {
  it('previews then applies a % change to the ticked products, with a tax change', async () => {
    const sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        const b = JSON.parse(opts.body);
        sent.push(b);
        return json(200, {
          dryRun: b.dryRun,
          count: 1,
          changes: [{ id: 'p1', sku: 'COF-001', name: 'Coffee', before: { priceCents: 375, taxRateBp: 1300 }, after: { priceCents: 356, taxRateBp: 500 } }],
        });
      }),
    );
    const onDone = vi.fn();
    render(<BulkPriceTax token="t" products={products} selectedIds={['p1']} currency="CAD" onClose={vi.fn()} onDone={onDone} />);
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Price change value'), '-5');
    await userEvent.click(screen.getByLabelText(/Change tax to/));
    await userEvent.clear(screen.getByLabelText('New tax %'));
    await userEvent.type(screen.getByLabelText('New tax %'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const table = await screen.findByRole('table', { name: 'Preview' });
    expect(within(table).getByText('$3.56')).toBeInTheDocument();
    expect(sent[0]).toEqual({ productIds: ['p1'], price: { mode: 'percent', value: -500 }, taxRateBp: 500, dryRun: true });
    await userEvent.click(screen.getByRole('button', { name: 'Apply to 1 product(s)' }));
    expect(sent[1].dryRun).toBe(false);
    expect(onDone).toHaveBeenCalled();
  });

  it('category and "set price" modes; validation messages', async () => {
    const sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => (sent.push(JSON.parse(opts.body)), json(200, { count: 1, changes: [] }))),
    );
    render(<BulkPriceTax token="t" products={products} currency="CAD" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'Food');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a percentage');
    await userEvent.selectOptions(screen.getByLabelText('Price change'), 'set');
    await userEvent.type(screen.getByLabelText('Price change value'), '-1');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be negative');
    await userEvent.clear(screen.getByLabelText('Price change value'));
    await userEvent.type(screen.getByLabelText('Price change value'), '6.25');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await vi.waitFor(() => expect(sent[0]).toEqual({ category: 'Food', price: { mode: 'set', value: 625 }, dryRun: true }));
    await userEvent.selectOptions(screen.getByLabelText('Price change'), 'none');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a price change');
  });
});

describe('<Promotions>', () => {
  it('lists promotions with their state and creates one for chosen SKUs with dates', async () => {
    const list = [
      {
        id: 'a',
        name: 'Coffee week',
        kind: 'percent',
        value: 2000,
        target: 'skus',
        skus: ['COF-001'],
        startsAt: '2026-10-20T04:00:00Z',
        endsAt: null,
        active: true,
        state: 'running',
      },
      {
        id: 'b',
        name: 'Bakery',
        kind: 'amount',
        value: 50,
        target: 'category',
        category: 'Food',
        skus: [],
        startsAt: '2026-11-01T04:00:00Z',
        endsAt: '2026-11-08T05:00:00Z',
        active: true,
        state: 'scheduled',
      },
    ];
    const posted = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts = {}) => {
        if (opts.method === 'POST') posted.push(JSON.parse(opts.body));
        if (opts.method === 'PATCH') return json(200, {});
        if (url.startsWith('/api/products'))
          return json(200, {
            items: [
              { id: 'p9', sku: 'TEA-001', name: 'Green tea' },
              { id: 'p8', sku: 'TEA-002', name: 'Black tea' },
            ],
            total: 2,
          });
        if (url.startsWith('/api/categories')) return json(200, []);
        return json(200, list);
      }),
    );
    render(<Promotions token="t" currency="CAD" />);
    expect(await screen.findByText('20% off')).toBeInTheDocument();
    expect(screen.getByText('$0.50 off each')).toBeInTheDocument();
    expect(screen.getByText('scheduled')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'End Coffee week' }));

    await userEvent.type(screen.getByLabelText('Name', { exact: true }), 'Tea time');
    await userEvent.type(screen.getByLabelText('Percent', { exact: true }), '15');
    await userEvent.selectOptions(screen.getByLabelText(/^Applies to/), 'skus');
    await userEvent.type(screen.getByLabelText('Search SKUs'), 'tea');
    await userEvent.click(await screen.findByRole('option', { name: 'TEA-001 · Green tea' }));
    await userEvent.type(screen.getByLabelText('Search SKUs'), 'tea');
    await userEvent.click(await screen.findByRole('option', { name: 'TEA-002 · Black tea' }));
    expect(within(screen.getByLabelText('Chosen SKUs')).getByText('TEA-001')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('From'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('To (last day)'), '2026-11-07');
    await userEvent.click(screen.getByRole('button', { name: 'Create promotion' }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ name: 'Tea time', kind: 'percent', value: 1500, target: 'skus', skus: ['TEA-001', 'TEA-002'] });
    // the "to" day is inclusive: the promotion ends at the following local midnight,
    // also across the end of daylight saving time (1 Nov 2026 in Toronto)
    const end = new Date(posted[0].endsAt);
    expect([end.getFullYear(), end.getMonth() + 1, end.getDate(), end.getHours(), end.getMinutes()]).toEqual([2026, 11, 8, 0, 0]);
    expect(new Date(posted[0].startsAt).getHours()).toBe(0);
  });
});

describe('<RefundItems> refund policy', () => {
  const receipt = (extra = {}) => ({
    saleId: 'x1',
    receiptNo: 1001,
    store: { currency: 'CAD' },
    payment: { method: 'cash' },
    refundBy: '2026-11-22T04:00:00Z',
    lines: [
      {
        lineNo: 1,
        name: 'Coffee',
        qty: 2,
        unitPriceCents: 413,
        taxRateBp: 1300,
        discountCents: 166,
        lineSubtotalCents: 660,
        lineTaxCents: 86,
        refundable: true,
        refundedQty: 0,
      },
      {
        lineNo: 2,
        name: 'Sandwich',
        qty: 1,
        unitPriceCents: 600,
        taxRateBp: 1300,
        lineSubtotalCents: 600,
        lineTaxCents: 78,
        refundable: false,
        refundedQty: 0,
      },
    ],
    ...extra,
  });

  it('final-sale lines are locked until a manager overrides with a reason', async () => {
    let sent;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => ((sent = JSON.parse(opts.body)), json(201, { receipt: {} }))),
    );
    render(<RefundItems receipt={receipt()} token="t" onCancel={vi.fn()} onDone={vi.fn()} now={Date.parse('2026-10-24T00:00:00Z')} />);
    expect(screen.getByLabelText('Refund quantity for Sandwich')).toBeDisabled();
    expect(screen.getByText('$3.30 paid each · sold 2')).toBeInTheDocument(); // the discounted price
    await userEvent.click(screen.getByRole('button', { name: /select everything left/i }));
    expect(screen.getByTestId('refund-total')).toHaveTextContent('$7.46');

    await userEvent.click(screen.getByLabelText(/Override the store refund policy/));
    await userEvent.click(screen.getByRole('button', { name: /select everything left/i }));
    expect(screen.getByTestId('refund-total')).toHaveTextContent('$14.24');
    const submit = screen.getByRole('button', { name: 'Refund $14.24' });
    expect(submit).toBeDisabled(); // reason required
    await userEvent.type(screen.getByLabelText(/Reason/), 'spoiled');
    await userEvent.click(submit);
    expect(sent).toEqual({
      items: [
        { lineNo: 1, qty: 2 },
        { lineNo: 2, qty: 1 },
      ],
      reason: 'spoiled',
      override: true,
    });
  });

  it('after the refund window everything is locked unless overridden', async () => {
    render(<RefundItems receipt={receipt()} token="t" onCancel={vi.fn()} onDone={vi.fn()} now={Date.parse('2026-12-01T00:00:00Z')} />);
    expect(screen.getByRole('status')).toHaveTextContent('refund window for this sale ended');
    expect(screen.getByLabelText('Refund quantity for Coffee')).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Override the store refund policy/));
    expect(screen.getByLabelText('Refund quantity for Coffee')).toBeEnabled();
  });
});

describe('<Products> inline edit and refund flag', () => {
  it('edits one product’s price and tax and switches final sale', async () => {
    const patches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts = {}) => {
        if (opts.method === 'PATCH') {
          patches.push([url, JSON.parse(opts.body)]);
          return json(200, {});
        }
        return json(200, products);
      }),
    );
    render(<Products token="t" currency="CAD" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit price and tax of COF-001' }));
    await userEvent.clear(screen.getByLabelText('Price for COF-001'));
    await userEvent.type(screen.getByLabelText('Price for COF-001'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid price');
    await userEvent.clear(screen.getByLabelText('Price for COF-001'));
    await userEvent.type(screen.getByLabelText('Price for COF-001'), '3.99');
    await userEvent.clear(screen.getByLabelText('Tax % for COF-001'));
    await userEvent.type(screen.getByLabelText('Tax % for COF-001'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(patches[0]).toEqual(['/api/products/p1', { priceCents: 399, taxRateBp: 500, barcode: null, expiresOn: null }]));
    expect(screen.getByRole('button', { name: 'Refund policy for SAN-001' })).toHaveTextContent('Final sale');
    await userEvent.click(screen.getByRole('button', { name: 'Refund policy for SAN-001' }));
    await vi.waitFor(() => expect(patches[1]).toEqual(['/api/products/p2', { refundable: true }]));
    await userEvent.click(screen.getByLabelText('Tick all products'));
    expect(screen.getByRole('button', { name: 'Change prices / tax (2)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change prices / tax (2)' }));
    expect(screen.getByText(/The 2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import from Excel' }));
    expect(screen.getByRole('dialog', { name: 'Import products from Excel' })).toBeInTheDocument();
  });
});

describe('<Team> store refund policy', () => {
  it('saves the refund window and reports it back', async () => {
    const { default: Team } = await import('./Team.jsx');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts = {}) => {
        if (url === '/api/store/settings') {
          const b = JSON.parse(opts.body);
          return b.refundWindowDays > 365
            ? json(400, { error: 'refundWindowDays must be a whole number from 0 to 365' })
            : json(200, { refundWindowDays: b.refundWindowDays });
        }
        return json(200, [{ id: 'u1', name: 'Maya', email: 'm@x.test', role: 'manager', active: true }]);
      }),
    );
    const onStoreChange = vi.fn();
    render(<Team token="t" me={{ id: 'u1' }} store={{ name: 'S', refundWindowDays: 30 }} onStoreChange={onStoreChange} />);
    const days = screen.getByLabelText('Refund window (days)');
    await userEvent.clear(days);
    await userEvent.type(days, '400');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('0 to 365');
    await userEvent.clear(days);
    await userEvent.type(days, '14');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('Saved: refunds within 14 days.')).toBeInTheDocument();
    expect(onStoreChange).toHaveBeenCalledWith({ name: 'S', refundWindowDays: 14 });
  });
});
