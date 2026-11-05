import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
const REP = { email: `rep-${Date.now()}@example.com`, password: 'smoke-rep-password-123' };

// Ignore third-party font loading failures (fonts are progressive enhancement)
const isIgnorable = (text) => /fonts\.(googleapis|gstatic)\.com/.test(text);

test.describe.configure({ mode: 'serial' });

test('health endpoint', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('public sign-up is disabled', async ({ request }) => {
  const res = await request.post('/api/collections/users/records', {
    data: { email: 'intruder@example.com', password: 'x'.repeat(12), passwordConfirm: 'x'.repeat(12) },
  });
  expect(res.status()).toBe(403);
});

test('CRM API requires auth', async ({ request }) => {
  expect((await request.get('/api/crm/status')).status()).toBe(401);
  // List rules act as filters in PocketBase: anonymous requests get an empty list
  for (const c of ['accounts', 'contacts', 'deals', 'touches', 'leads']) {
    const res = await request.get(`/api/collections/${c}/records`);
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).totalItems).toBe(0);
  }
  expect((await request.get('/api/collections/kv/records')).status()).toBe(403);
  const create = await request.post('/api/collections/accounts/records', { data: { name: 'x' } });
  expect(create.status()).toBe(400);
});

test('admin creates a sales user', async ({ request }) => {
  test.skip(!ADMIN_EMAIL, 'PB_ADMIN_EMAIL not set');
  const auth = await request.post('/api/collections/_superusers/auth-with-password', {
    data: { identity: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(auth.ok()).toBeTruthy();
  const { token } = await auth.json();
  const res = await request.post('/api/collections/users/records', {
    headers: { Authorization: token },
    data: { ...REP, passwordConfirm: REP.password, name: 'Smoke Rep' },
  });
  expect(res.ok()).toBeTruthy();
});

test('sales user signs in, adds an account and logs a visit', async ({ page }) => {
  test.skip(!ADMIN_EMAIL, 'PB_ADMIN_EMAIL not set');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !isIgnorable(m.text() + (m.location()?.url ?? '')) && errors.push(m.text()));
  page.on('requestfailed', () => {}); // font failures are tolerated

  await page.goto('/');
  await page.getByLabel('Email').fill(REP.email);
  await page.getByLabel('Password').fill(REP.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

  await page.goto('/#/accounts');
  await page.getByRole('button', { name: 'New account' }).click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Name').fill('Smoke Test Bar');
  await dlg.getByLabel('Area (canton / town)').fill('Escazú');
  await dlg.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Smoke Test Bar' })).toBeVisible();

  await page.locator('#logHere').click();
  await dlg.getByLabel('What happened').fill('Dropped off IPA samples');
  await dlg.getByRole('button', { name: 'In a week' }).click();
  await dlg.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.locator('.timeline')).toContainText('Dropped off IPA samples');

  // Outbound activity on a Prospect deal moves it to Contacted
  await page.goto('/#/pipeline');
  const contacted = page.locator('.col[data-stage="contacted"]');
  await expect(contacted).toContainText('Smoke Test Bar');

  await page.goto('/#/followups');
  await expect(page.locator('.list').first()).toContainText('Smoke Test Bar');

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Loyverse POS' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('anonymous requests cannot read CRM data that exists', async ({ request }) => {
  test.skip(!ADMIN_EMAIL, 'PB_ADMIN_EMAIL not set');
  for (const c of ['accounts', 'deals', 'touches']) {
    const res = await request.get(`/api/collections/${c}/records`);
    expect((await res.json()).totalItems).toBe(0);
  }
});
