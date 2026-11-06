// Runs first: the database has no CRM data yet.
import { test, expect, signIn, signInAdmin, toast, E2E } from './fixtures.mjs';

test('sign-in errors, then empty states everywhere', async ({ page }) => {
  await signIn(page, E2E.admin.email, 'wrong-password-1!');
  await expect(page.locator('#loginErr')).toBeVisible();
  await expect(page.locator('#loginErr')).toContainText('Wrong email or password');

  await page.getByLabel('Password', { exact: true }).fill(E2E.admin.password);
  await page.getByLabel('Email').fill(E2E.admin.email.toUpperCase());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
  await expect(page.locator('.col[data-stage="prospect"]')).toContainText('No deals here.');
  await expect(page.locator('.col[data-stage="lost"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Log activity' }).click();
  await expect(toast(page)).toHaveText('Add an account first.');
  await page.getByRole('button', { name: 'New deal' }).click();
  await expect(toast(page)).toHaveText('Add an account first.');

  await page.getByRole('link', { name: 'Follow-ups' }).click();
  await expect(page.getByText('Nothing due this week.')).toBeVisible();
  await expect(page.getByText('Every account has recent activity.')).toBeVisible();

  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page.getByText('No accounts match.')).toBeVisible();

  await page.getByRole('link', { name: 'Leads' }).click();
  await expect(page.getByText('No new leads. Search above')).toBeVisible();
  await page.locator('#lStatus').selectOption('converted');
  await expect(page.getByText('Nothing here yet.')).toBeVisible();
});

test('unknown pages fall back to the pipeline; missing records show an error', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/#/nope');
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
  await page.goto('/#/account/doesnotexist123');
  await expect(page.getByRole('heading', { name: 'Could not load this page' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to pipeline' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
});

test('rate-limited sign-in explains the wait', async ({ page }) => {
  await page.route('**/api/collections/users/auth-with-password', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: '{"status":429,"message":"Too Many Requests.","data":{}}' }));
  await signIn(page);
  await expect(page.locator('#loginErr')).toHaveText('Too many sign-in attempts. Wait a minute and try again.');
});

test('expired sessions go back to sign-in', async ({ page }) => {
  await signInAdmin(page);
  // token rejected on reload: boot-time refresh fails
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('pocketbase_auth'));
    a.token = a.token.slice(0, -4) + 'xxxx';
    localStorage.setItem('pocketbase_auth', JSON.stringify(a));
  });
  await page.route('**/api/collections/users/auth-refresh', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"status":401,"message":"x","data":{}}' }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // 401 while loading a page also signs out
  await page.unroute('**/api/collections/users/auth-refresh');
  await signInAdmin(page);
  await page.route('**/api/collections/accounts/records*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"status":401,"message":"expired","data":{}}' }));
  await page.goto('/#/accounts');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
