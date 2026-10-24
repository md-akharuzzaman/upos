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
      await expect(page.getByRole('cell', { name: sku })).toBeVisible();
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

  test('cashier takes a card payment with a terminal approval code', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`casey@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();
    await page.getByRole('button', { name: 'Add Coffee, medium' }).click();
    await page.getByRole('button', { name: /Charge/ }).click();
    await page.getByRole('radio', { name: 'Card' }).click();
    await page.getByLabel('Terminal approval code').fill('AUTH-7731');
    await page.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.getByText('AUTH-7731')).toBeVisible();
  });

  test('manager sees the day in the report and can refund a sale', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Store code').fill(slug);
    await page.getByLabel('E-mail').fill(`erin@${slug}.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).last().click();

    await page.getByRole('button', { name: 'Report' }).click();
    await expect(page.getByTestId('report-count')).toHaveText('2');
    await expect(page.getByTestId('report-gross')).toHaveText('$11.26');

    await page.getByRole('button', { name: 'Sales' }).click();
    await page.getByRole('cell', { name: 'cash', exact: true }).click();
    await page.getByRole('button', { name: 'Refund sale' }).click();
    await expect(page.getByText('refunded', { exact: true })).toBeVisible();
  });
});
