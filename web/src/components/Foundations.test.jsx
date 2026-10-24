import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Business from './Business.jsx';
import Categories from './Categories.jsx';
import Register from './Register.jsx';
import Products from './Products.jsx';
import ImportProducts from './ImportProducts.jsx';
import CameraScanner from './CameraScanner.jsx';
import { can, assignableRoles } from '../lib/permissions.js';
import { categoryOptions } from '../lib/categories.js';

const json = (status, body) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

const cats = [
  { id: 'c1', name: 'Food', parentId: null, finalSale: true },
  { id: 'c2', name: 'Dairy', parentId: 'c1', finalSale: true },
  { id: 'c3', name: 'Household', parentId: null, finalSale: false },
];

describe('permissions and category helpers', () => {
  it('mirror the API matrix', () => {
    expect(can({ role: 'support' }, 'refunds.create')).toBe(true);
    expect(can({ role: 'support' }, 'sales.create')).toBe(false);
    expect(can({ role: 'cashier', permissions: ['sales.view'] }, 'sales.create')).toBe(false); // the API list wins
    expect(assignableRoles('manager')).not.toContain('admin');
    expect(categoryOptions(cats).map((o) => o.label)).toEqual(['Food', 'Food › Dairy', 'Household']);
  });
});

describe('<Business>', () => {
  it('loads the profile, saves changes and new bank details, adds starter categories', async () => {
    const calls = [];
    const profile = {
      name: 'Big Mart',
      profile: {
        legalName: 'Big Mart Inc.',
        paymentMethods: ['cash', 'debit'],
        timeZone: 'America/Toronto',
        bank: { bankName: 'RBC', accountName: 'Big Mart Inc.', institution: '003', transit: '•••45', account: '••••3210' },
      },
      storeTypes: [{ id: 'supermarket', label: 'Supermarket / grocery' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts = {}) => {
        calls.push([url, opts.method || 'GET', opts.body && JSON.parse(opts.body)]);
        if (url === '/api/categories/suggested') return json(200, { created: 12 });
        if (opts.method === 'PUT') return json(200, { ...profile, name: 'Big Mart 2' });
        return json(200, profile);
      }),
    );
    const onStoreChange = vi.fn();
    render(<Business token="t" onStoreChange={onStoreChange} />);
    expect(await screen.findByTestId('bank-masked')).toHaveTextContent('account ••••3210');
    await userEvent.selectOptions(screen.getByLabelText('Store type'), 'supermarket');
    await userEvent.click(screen.getByRole('button', { name: 'Add starter categories for this type' }));
    expect(await screen.findByText(/12 starter categories/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('GST/HST number'), '123456789RT0001');
    await userEvent.click(screen.getByLabelText('Interac e-Transfer'));
    await userEvent.type(screen.getByLabelText('e-Transfer e-mail'), 'pay@bigmart.test');
    await userEvent.click(screen.getByRole('button', { name: 'Replace bank details' }));
    await userEvent.type(screen.getByLabelText('Bank'), 'TD');
    await userEvent.type(screen.getByLabelText('Account name'), 'Big Mart Inc.');
    await userEvent.type(screen.getByLabelText('Institution (3 digits)'), '004');
    await userEvent.type(screen.getByLabelText('Transit (5 digits)'), '12345');
    await userEvent.type(screen.getByLabelText('Account number'), '1234567');
    await userEvent.click(screen.getByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByText('Business profile saved.')).toBeInTheDocument();
    const put = calls.find((c) => c[1] === 'PUT')[2];
    expect(put.paymentMethods).toEqual(['cash', 'debit', 'etransfer']);
    expect(put.bank).toEqual({ bankName: 'TD', accountName: 'Big Mart Inc.', institutionNumber: '004', transitNumber: '12345', accountNumber: '1234567' });
    expect(put.gstHstNumber).toBe('123456789RT0001');
    expect(onStoreChange).toHaveBeenCalled();
  });

  it('shows API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts = {}) =>
        opts.method === 'PUT' ? json(400, { error: 'gstHstNumber must be 9 digits + RT + 4 digits' }) : json(200, { name: 'S', profile: {}, storeTypes: [] }),
      ),
    );
    render(<Business token="t" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('RT');
  });
});

describe('<Categories>', () => {
  it('adds a sub-category and flips the final-sale default', async () => {
    const sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => (sent.push([url, opts.method, JSON.parse(opts.body)]), json(201, {}))),
    );
    const onChanged = vi.fn();
    render(<Categories token="t" categories={cats} onChanged={onChanged} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Cheese');
    await userEvent.selectOptions(screen.getByLabelText('Under'), 'c1');
    await userEvent.click(screen.getByLabelText('Final sale'));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(sent[0]).toEqual(['/api/categories', 'POST', { name: 'Cheese', parentId: 'c1', finalSale: true }]));
    await userEvent.click(screen.getByRole('button', { name: 'Final sale default for Household' }));
    await vi.waitFor(() => expect(sent[1]).toEqual(['/api/categories/c3', 'PATCH', { finalSale: true }]));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});

describe('<Register> with a big catalogue', () => {
  const milk = {
    id: 'p1',
    sku: 'MLK-1',
    barcode: '4006381333931',
    name: 'Milk 2 L',
    category: 'Food',
    subcategory: 'Dairy',
    priceCents: 499,
    taxRateBp: 0,
    stock: 9,
    refundable: false,
  };
  const old = { id: 'p2', sku: 'YOG-1', name: 'Old yogurt', category: 'Food', priceCents: 199, taxRateBp: 0, stock: 3, expiresOn: '2020-01-01' };

  it('pages from the server, filters by sub-category, adds scanned barcodes, blocks expired items', async () => {
    const urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        urls.push(url);
        if (url.startsWith('/api/categories')) return json(200, cats);
        if (url.startsWith('/api/promotions')) return json(200, []);
        if (url.startsWith('/api/products/lookup')) return url.includes('4006381333931') ? json(200, milk) : json(404, { error: 'no product' });
        const offset = Number(new URL(url, 'http://x').searchParams.get('offset'));
        return json(200, { items: offset === 0 ? [milk, old] : [old], total: 60, limit: 48, offset });
      }),
    );
    render(<Register token="t" currency="CAD" />);
    expect(await screen.findByText('1–48 of 60')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('49–60 of 60')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Food' }));
    await userEvent.click(within(screen.getByLabelText('Sub-categories')).getByRole('button', { name: 'Dairy' }));
    await vi.waitFor(() => expect(urls.some((u) => u.includes('category=Food') && u.includes('subcategory=Dairy'))).toBe(true));
    expect(await screen.findByRole('button', { name: 'Add Old yogurt' })).toBeDisabled();
    expect(screen.getByText('Expired 2020-01-01')).toBeInTheDocument();

    const box = screen.getByLabelText('Search products');
    await userEvent.type(box, '4006381333931{Enter}');
    expect(await screen.findByText('Added Milk 2 L')).toBeInTheDocument();
    expect(screen.getByTestId('cart-total')).toHaveTextContent('$4.99');
    await userEvent.type(box, '0000000000000{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('No product with barcode or SKU 0000000000000');
  });
});

describe('<Products> paging and filters', () => {
  it('asks the server for one page with the chosen filters', async () => {
    const urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        urls.push(url);
        if (url.startsWith('/api/categories')) return json(200, cats);
        return json(200, {
          items: [
            {
              id: 'p1',
              sku: 'MLK-1',
              barcode: '4006381333931',
              name: 'Milk',
              category: 'Food',
              subcategory: 'Dairy',
              priceCents: 499,
              taxRateBp: 0,
              stock: 9,
              active: true,
              refundable: false,
              expiresOn: '2020-01-01',
            },
          ],
          total: 120,
        });
      }),
    );
    render(<Products token="t" currency="CAD" />);
    expect(await screen.findByText('1–50 of 120')).toBeInTheDocument();
    expect(screen.getByText('expired 2020-01-01')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Filter by category'), 'Food');
    await userEvent.selectOptions(screen.getByLabelText('Filter by sub-category'), 'Dairy');
    await userEvent.selectOptions(screen.getByLabelText('Filter by expiry'), '7');
    await userEvent.type(screen.getByLabelText('Search the catalogue'), 'milk');
    await vi.waitFor(() => expect(urls.some((u) => /category=Food.*subcategory=Dairy.*expiring=7/.test(u) && u.includes('q=milk'))).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await vi.waitFor(() => expect(urls.at(-1)).toContain('offset=50'));
    await userEvent.click(screen.getByRole('button', { name: 'Categories' }));
    expect(screen.getByRole('dialog', { name: 'Categories' })).toBeInTheDocument();
  });
});

describe('<ImportProducts> in batches', () => {
  it('checks 2,500 rows in 3 batches, imports them, and resumes after a failure', async () => {
    const sheet = [['SKU', 'Name', 'Price'], ...Array.from({ length: 2500 }, (_, i) => [`B-${i}`, `Item ${i}`, 1])];
    let failOnce = true;
    const posts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        const b = JSON.parse(opts.body);
        posts.push({ n: b.rows.length, startRow: b.startRow, dry: Boolean(b.dryRun) });
        if (!b.dryRun && b.startRow === 1002 && failOnce) {
          failOnce = false;
          return json(503, { error: 'service busy' });
        }
        return json(200, {
          created: b.rows.length,
          updated: 0,
          unchanged: 0,
          errors: [],
          rows: b.rows.slice(0, 3).map((r, i) => ({ row: b.startRow + i, sku: r.sku, action: 'create', name: r.name, changed: [] })),
        });
      }),
    );
    const onImported = vi.fn();
    render(<ImportProducts token="t" onClose={vi.fn()} onImported={onImported} read={async () => sheet} />);
    await userEvent.upload(screen.getByLabelText('Excel or CSV file'), new File(['x'], 'big.xlsx'));
    expect(await screen.findByTestId('import-summary')).toHaveTextContent('2,500 new');
    expect(posts.filter((p) => p.dry).map((p) => [p.n, p.startRow])).toEqual([
      [1000, 2],
      [1000, 1002],
      [500, 2002],
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Import 2,500 products' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Press Resume');
    await userEvent.click(screen.getByRole('button', { name: 'Resume import' }));
    expect(await screen.findByText('Imported: 2,500 new, 0 updated.')).toBeInTheDocument();
    expect(posts.filter((p) => !p.dry).map((p) => p.startRow)).toEqual([2, 1002, 1002, 2002]);
    expect(onImported).toHaveBeenCalledWith({ created: 2500, updated: 0 });
  });
});

describe('<CameraScanner>', () => {
  it('reads a barcode from the camera and reports permission problems', async () => {
    const stop = vi.fn();
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = vi.fn(async () => [{ rawValue: '4006381333931' }]);
      },
    );
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
    });
    window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
    const onCode = vi.fn(async () => {});
    const { unmount } = render(<CameraScanner onCode={onCode} onClose={vi.fn()} />);
    await vi.waitFor(() => expect(onCode).toHaveBeenCalledWith('4006381333931'));
    unmount();
    expect(stop).toHaveBeenCalled();

    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))) },
    });
    render(<CameraScanner onCode={onCode} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera permission was refused.');
  });
});
