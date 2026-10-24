// End-to-end: a store opens, stocks its shelf, hires a cashier, and the cashier
// rings up sales in the browser. Runs against the test environment in CD.
import { expect, test } from '@playwright/test';

const tag = `${(process.env.GITHUB_RUN_ID || 'local').slice(-6)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
const PASSWORD = 'E2e-Test-Pass-2026';

test.describe.configure({ mode: 'serial' });

test.describe('eURC POS', () => {
  let slug;
  let managerToken;

  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(({}, info) => {
    slug = `e2e-${info.project.name.slice(0, 4)}-${tag}`;
  });

  test.afterAll(async ({ request }) => {
    if (!managerToken) return;
    const r = await request.delete('/api/stores/current', {
      headers: { authorization: `Bearer ${managerToken}` },
      data: { confirm: slug },
    });
    expect(r.status()).toBe(204);
  });

  test('home page shows the environment badge and sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('env-badge')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' }).last()).toBeVisible();
  });

  test('manager creates a store, adds products and a cashier', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Create a store' }).click();
    await page.getByLabel('Store name').fill('E2E Corner Café');
    await page.getByLabel('Your name').fill('Erin Manager');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`erin@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create store' }).click();
    await expect(page.getByText('E2E Corner Café')).toBeVisible();
    managerToken = await page.evaluate(() => JSON.parse(sessionStorage.getItem('eurc.session')).token);

    await page.getByRole('button', { name: 'Products' }).click();
    const form = page.getByRole('form', { name: 'Add product' });
    for (const [sku, name, price, tax, stock] of [
      ['COF-001', 'Coffee, medium', '2.45', '13', '20'],
      ['BAK-002', 'Blueberry muffin', '2.95', '0', '1'],
    ]) {
      await form.getByLabel('SKU').fill(sku);
      await form.getByLabel('Name').fill(name);
      await form.getByLabel('Price').fill(price);
      await form.getByLabel('Tax %').fill(tax);
      await form.getByLabel('Stock').fill(stock);
      await form.getByRole('button', { name: 'Add product' }).click();
      await expect(page.getByRole('cell', { name: sku, exact: true })).toBeVisible();
    }

    await page.getByRole('button', { name: 'Staff' }).click();
    const staff = page.getByRole('form', { name: 'Add staff member' });
    await staff.getByLabel('Name').fill('Casey Cashier');
    await staff.getByLabel('E-mail').fill(`casey@${slug}.test`);
    await staff.getByLabel('Temporary password').fill(PASSWORD);
    await staff.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('cell', { name: 'Casey Cashier' })).toBeVisible();
  });

  test('cashier rings up a cash sale and gets the right change', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`casey@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();
    await expect(page.getByRole('button', { name: 'Products' })).toHaveCount(0); // cashier has no manager tabs

    await page.getByRole('button', { name: 'Add Coffee, medium' }).click();
    await page.getByRole('button', { name: 'Add Coffee, medium' }).click();
    await page.getByRole('button', { name: 'Add Blueberry muffin' }).click();
    await expect(page.getByTestId('cart-total')).toHaveText('$8.49');

    await page.getByRole('button', { name: /Charge/ }).click();
    await page.getByLabel('Cash received').fill('10');
    await expect(page.getByText('Change due $1.51')).toBeVisible();
    await page.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.getByTestId('receipt-change')).toHaveText('$1.51');
    await page.getByRole('button', { name: 'New sale' }).click();

    // the muffin sold out: tile disabled
    await expect(page.getByRole('button', { name: 'Add Blueberry muffin' })).toBeDisabled();
  });

  test('cashier takes a debit payment with a terminal approval code', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`casey@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();
    await page.getByRole('button', { name: 'Add Coffee, medium' }).click();
    await page.getByRole('button', { name: /Charge/ }).click();
    await page.getByRole('radio', { name: 'Debit' }).click();
    await page.getByLabel('Terminal approval code').fill('AUTH-7731');
    await page.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.getByText('AUTH-7731')).toBeVisible();
    await expect(page.getByText('Debit (Interac)')).toBeVisible();
  });

  test('manager sees the day in the report, refunds one item, then the rest', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`erin@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();

    await page.getByRole('button', { name: 'Report' }).click();
    await expect(page.getByTestId('report-count')).toHaveText('2');
    await expect(page.getByTestId('report-gross')).toHaveText('$11.26');

    await page.getByRole('button', { name: 'Sales' }).click();
    await page.getByRole('cell', { name: 'Cash', exact: true }).click();
    // v2.1: give back one coffee only ($2.45 + 32 ¢ HST)
    await page.getByRole('button', { name: 'Refund items' }).click();
    await page.getByLabel('Refund quantity for Coffee, medium').fill('1');
    await expect(page.getByTestId('refund-total')).toHaveText('$2.77');
    await page.getByRole('button', { name: 'Refund $2.77' }).click();
    await expect(page.getByText('PARTLY REFUNDED')).toBeVisible();
    await expect(page.getByTestId('receipt-net')).toHaveText('$5.72');
    await page.getByRole('button', { name: 'Refund the rest' }).click();
    await expect(page.getByText('refunded', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Report' }).click();
    await expect(page.getByTestId('report-refunds')).toHaveText('2');
    await expect(page.getByTestId('report-net')).toHaveText('$2.77'); // only the card sale is left
  });

  test('manager runs a promotion and the register applies it (v2.2)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`erin@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();

    await page.getByRole('button', { name: 'Promotions' }).click();
    await page.getByLabel('Name', { exact: true }).fill('E2E coffee half price');
    await page.getByLabel('Percent', { exact: true }).fill('50');
    await page.getByLabel('Applies to').selectOption('skus');
    await page.getByLabel('Search SKUs').fill('COF');
    await page.getByRole('option', { name: /COF-001/ }).click();
    await page.getByRole('button', { name: 'Create promotion' }).click();
    await expect(page.getByText('running', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Register' }).click();
    await page.getByRole('button', { name: 'Add Coffee, medium' }).click();
    // 2.45 - 50 % (1.23) = 1.22, HST 13 % = 0.16
    await expect(page.getByTestId('cart-savings')).toHaveText('−$1.23');
    await expect(page.getByTestId('cart-total')).toHaveText('$1.38');
    await page.getByRole('button', { name: /Charge/ }).click();
    await page.getByLabel('Cash received').fill('2');
    await page.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.getByTestId('receipt-savings')).toHaveText('$1.23');
    await expect(page.getByTestId('receipt-policy')).toContainText('Refunds within 30 days');
  });

  test('manager gives a product a barcode; the register adds it on scan (v2.3)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`erin@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();
    await page.getByRole('button', { name: 'Products' }).click();
    await page.getByRole('button', { name: 'Edit price and tax of COF-001' }).click();
    await page.getByLabel('Barcode for COF-001').fill('4006381333931');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('4006381333931')).toBeVisible();

    await page.getByRole('button', { name: 'Register' }).click();
    // a USB scanner types the digits and presses Enter
    await page.getByLabel('Search products').fill('4006381333931');
    await page.getByLabel('Search products').press('Enter');
    await expect(page.getByText('Added Coffee, medium')).toBeVisible();
    await expect(page.getByRole('list').getByText('Coffee, medium')).toBeVisible();
  });

  test('manager opens the GST/HST report for the month (v2.4)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`erin@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();
    await page.getByRole('button', { name: 'GST/HST' }).click();
    await expect(page.getByRole('heading', { name: 'GST/HST report' })).toBeVisible();
    // the day's coffees were sold at 13 % HST
    await expect(page.getByRole('table', { name: 'By tax rate' }).getByText('HST 13 %')).toBeVisible();
    await expect(page.getByTestId('tax-line103')).toHaveText(/^\$\d+\.\d{2}$/);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export to Excel' }).click();
    expect((await download).suggestedFilename()).toMatch(/^gst-hst-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});
