import { test, expect, signInAdmin, dialog, toast, E2E } from './fixtures.mjs';

test('settings: integrations configured, Gmail connect → sync → disconnect', async ({ page, api }) => {
  const { account } = await api.account('Gmail Bar');
  await api.create('contacts', { account: account.id, name: 'Owner', email: 'owner@esquina.cr' });
  await signInAdmin(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('.env-warn-summary')).toContainText('1 integration needs setup: Password reset emails');
  await expect(page.locator('.panel.needs-setup')).toHaveCount(1);
  await expect(page.getByText('Configured. Receipts for linked accounts sync every hour.')).toBeVisible();

  // Google's consent screen is replaced by an immediate redirect back to the callback
  await page.route('https://accounts.google.com/**', (r) => {
    const state = new URL(r.request().url()).searchParams.get('state');
    return r.fulfill({ status: 302, headers: { Location: `${E2E.baseURL}/api/crm/google/callback?code=CODE&state=${state}` } });
  });
  await page.getByRole('button', { name: 'Connect Gmail' }).click();
  await expect(toast(page)).toHaveText('Gmail connected');
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByText('Connected as brewer@example.com')).toBeVisible();
  await expect(page.locator('.panel', { hasText: 'Gmail' }).getByText(/Last sync: (?!never)/)).toBeVisible();

  await page.goto(`/#/account/${account.id}`);
  const mail = page.locator('.timeline li', { hasText: 'Samples for your taps' });
  await expect(mail).toContainText('gmail');
  await expect(mail.getByRole('link', { name: 'Open in Gmail' })).toHaveAttribute('href', /mail\.google\.com.*tm1/);
  await expect(mail.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.locator('.timeline li', { hasText: 'Re: Samples' })).toContainText('from them');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sync now' }).first().click();
  await expect(toast(page)).toHaveText('0 new emails logged');
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Connected as brewer@example.com')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: 'Connect Gmail' })).toBeVisible();

  await page.goto('/#/settings?google=access_denied');
  await expect(toast(page)).toHaveText('Gmail: access_denied');
  await expect(toast(page)).toHaveClass(/err/);
});

test('Loyverse: link a customer, import orders, unlink, manual sync', async ({ page, api }) => {
  const { account } = await api.account('Bar La Esquina POS', {}, { stage: 'proposal', title: 'Taps' });
  await signInAdmin(page);
  await page.goto(`/#/account/${account.id}`);
  await page.getByRole('button', { name: 'Link customer' }).click();
  const dlg = dialog(page);
  await expect(dlg.getByPlaceholder('Search by name, email, phone or code')).toHaveValue('Bar La Esquina POS');
  await dlg.getByPlaceholder('Search by name, email, phone or code').fill('nobody');
  await dlg.getByRole('button', { name: 'Search' }).click();
  await expect(dlg.getByText('No matching customers.')).toBeVisible();
  await dlg.getByPlaceholder('Search by name, email, phone or code').fill('esquina');
  await dlg.getByPlaceholder('Search by name, email, phone or code').press('Enter');
  await expect(dlg.locator('.item')).toContainText('B01 · owner@esquina.cr · +506 8888 1234 · 4 visits');
  await dlg.getByRole('button', { name: 'Link' }).click();
  await expect(page.locator('dd', { hasText: 'Linked' })).toBeVisible();
  await expect(page.locator('.kv')).toContainText('2 ·');
  const order = page.locator('.timeline li', { hasText: '1-1001' });
  await expect(order).toContainText('1× Keg IPA (20L)');
  await expect(order.locator('strong')).toBeVisible();
  await expect(page.locator('.stage-pill').first()).toHaveText('Recurring');

  await page.getByRole('button', { name: 'Unlink' }).click();
  await expect(toast(page)).toHaveText('Loyverse customer unlinked');
  await expect(page.getByRole('button', { name: 'Link customer' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.locator('#sqSync').click();
  await expect(toast(page)).toHaveText('No accounts linked to Loyverse customers'.replace('No', 'no'));
  await page.goto('/#/account/' + account.id);
  await page.getByRole('button', { name: 'Link customer' }).click();
  await page.route('**/api/crm/sync/pos', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"status":400,"message":"Loyverse is down.","data":{}}' }));
  await dialog(page).getByPlaceholder('Search by name, email, phone or code').fill('esquina');
  await dialog(page).getByRole('button', { name: 'Search' }).click();
  await dialog(page).getByRole('button', { name: 'Link' }).first().click();
  await expect(toast(page)).toHaveText('Loyverse is down.');
  await expect(page.getByRole('button', { name: 'Unlink' })).toBeVisible(); // re-render finished
  await page.unroute('**/api/crm/sync/pos');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.locator('#sqSync').click();
  await expect(toast(page)).toHaveText(/1 accounts updated, \d+ new receipts/);
});

test('settings when integrations are missing', async ({ page }) => {
  await signInAdmin(page);
  await page.route('**/api/crm/status', async (r) => {
    const res = await r.fetch();
    const s = await res.json();
    s.google.configured = false; s.pos.configured = false; s.places.configured = false;
    s.mail = { configured: true, sender: 'crm@brewery.cr' };
    return r.fulfill({ response: res, json: s });
  });
  await page.goto('/#/settings');
  await expect(page.locator('.env-warn-summary')).toContainText('3 integrations need setup: Gmail, Loyverse POS, Google Maps lead search.');
  await expect(page.getByRole('button', { name: 'Connect Gmail' })).toBeDisabled();
  await expect(page.locator('#sqSync')).toBeDisabled();
  await expect(page.getByText('On. "Forgot password?" emails a reset link from crm@brewery.cr.')).toBeVisible();
  await expect(page.locator('.panel', { hasText: 'Google Maps lead search' }).locator('.env-warn')).toContainText('GOOGLE_PLACES_API_KEY');
  await page.goto('/#/leads');
  await expect(page.locator('.env-warn')).toContainText('search Google Maps for leads');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
