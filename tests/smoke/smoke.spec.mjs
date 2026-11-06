import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
// Temporary password set by the admin, then the rep's own one chosen at first sign-in
const REP = { email: `rep-${Date.now()}@example.com`, password: 'Temp-from-admin-4821', own: 'My-own-choice-9137' };

// Ignore third-party font loading failures (fonts are progressive enhancement)
const isIgnorable = (text) => /fonts\.(googleapis|gstatic)\.com/.test(text);

test.describe.configure({ mode: 'serial' });

test('health endpoint', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('build version is shown next to BrewCRM', async ({ page, request }) => {
  const res = await request.get('/version.json');
  expect(res.ok()).toBeTruthy();
  const { version, commit } = await res.json();
  const label = version === 'dev' ? `dev${commit ? ' ' + commit : ''}` : `v${version}`;
  await page.goto('/');
  await expect(page.locator('.login [data-build-version]')).toHaveText(label);
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

test('.env admin signs in to the CRM (mixed-case email typed)', async ({ page }) => {
  test.skip(!ADMIN_EMAIL, 'PB_ADMIN_EMAIL not set');
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.PB_ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
});

test('wrong password shows a clear message', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#loginErr')).toBeVisible();
});

test('anonymous CRM status is logged as 401', async ({ request }) => {
  expect((await request.get('/api/crm/status')).status()).toBe(401);
});

test('weak passwords are rejected by the server', async ({ request }) => {
  test.skip(!ADMIN_EMAIL, 'PB_ADMIN_EMAIL not set');
  const { token } = await (await request.post('/api/collections/_superusers/auth-with-password', {
    data: { identity: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })).json();
  const res = await request.post('/api/collections/users/records', {
    headers: { Authorization: token },
    data: { email: `weak-${Date.now()}@example.com`, password: 'short1!', passwordConfirm: 'short1!' },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).message).toContain('12 characters');
});

test('forgot-password page explains resets when mail is not set up', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Forgot password' })).toBeVisible();
  await expect(page.locator('.login')).toContainText('temporary password');
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
  await page.getByLabel('Password', { exact: true }).fill(REP.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // First sign-in with an admin-set password: must choose their own
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await page.goto('/#/accounts'); // navigation is blocked until the password is changed
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await page.getByLabel('Temporary password').fill(REP.password);
  await page.getByLabel('New password', { exact: true }).fill('short');
  await expect(page.locator('.pw-rules li.ok')).toHaveCount(2); // letter + no email name
  await page.getByLabel('New password', { exact: true }).fill(REP.own);
  await page.getByLabel('Confirm new password').fill(REP.own);
  await expect(page.locator('.pw-rules li:not(.ok)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save password' }).click();
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

  // All stages fit the viewport (they wrap; no horizontal scrolling)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Loyverse POS' })).toBeVisible();
  // CI configures no integrations: every one gets the same red warning, plus a summary
  await expect(page.locator('.panel.needs-setup .env-warn')).toHaveCount(4);
  await expect(page.locator('.env-warn-summary')).toContainText('4 integrations need setup');

  expect(errors).toEqual([]);
});

test('anonymous requests cannot read CRM data that exists', async ({ request }) => {
  test.skip(!ADMIN_EMAIL, 'PB_ADMIN_EMAIL not set');
  for (const c of ['accounts', 'deals', 'touches']) {
    const res = await request.get(`/api/collections/${c}/records`);
    expect((await res.json()).totalItems).toBe(0);
  }
});
