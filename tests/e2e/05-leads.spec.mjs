import { test, expect, signInAdmin, toast } from './fixtures.mjs';

test('leads: search, load more, enrich, dismiss, restore, filter, convert', async ({ page }) => {
  await signInAdmin(page);
  await page.getByRole('link', { name: 'Leads' }).click();
  await expect(page.locator('.env-warn')).toHaveCount(0);
  await expect(page.locator('#lsUsage')).toContainText('0 of 4500 searches used');

  await page.getByRole('button', { name: 'cervecería artesanal' }).click();
  await expect(page.locator('#lsWhat')).toHaveValue('cervecería artesanal');
  await expect(page.locator('#lsWhere')).toBeFocused();
  await page.getByRole('button', { name: 'bar', exact: true }).click();
  await page.locator('#lsWhere').fill('Escazú');
  await page.getByRole('button', { name: 'Search Google Maps' }).click();
  await expect(toast(page)).toHaveText('2 new leads, 1 already known or closed');
  await expect(page.locator('#lsUsage')).toContainText('1 of 4500');
  await expect(page.locator('#llist .item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Load 20 more' }).click();
  await expect(toast(page)).toHaveText('1 new lead');
  await expect(page.locator('#lsMore')).toBeHidden();
  await expect(page.locator('#llist .item')).toHaveCount(3);
  await expect(page.locator('#llist')).toContainText('liquor store');

  const row = (name) => page.locator('#llist .item', { hasText: name });
  await row('Bar Escazú Uno').getByRole('button', { name: 'Get phone' }).click();
  await expect(toast(page)).toHaveText('Contact details added');
  await expect(row('Bar Escazú Uno').getByRole('link', { name: '2222-3333' })).toBeVisible();
  await expect(row('Bar Escazú Uno').getByRole('link', { name: 'Website' })).toBeVisible();
  await expect(row('Bar Escazú Uno').getByRole('button', { name: 'Get phone' })).toHaveCount(0);
  await row('Hotel Montaña').getByRole('button', { name: 'Get phone' }).click();
  await expect(toast(page)).toHaveText('Google has no phone or website for this place');

  await page.getByLabel('Filter leads').fill('licorera');
  await expect(page.locator('#llist .item')).toHaveCount(1);
  await page.getByLabel('Filter leads').fill('');
  await row('Licorera Sol').getByRole('button', { name: 'Dismiss' }).click();
  await expect(row('Licorera Sol')).toHaveCount(0);
  await page.getByLabel('Lead status').selectOption('dismissed');
  await row('Licorera Sol').getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#llist')).toContainText('Nothing here yet.');
  await page.getByLabel('Lead status').selectOption('new');

  await row('Hotel Montaña').getByRole('button', { name: 'Add as account' }).click();
  await expect(toast(page)).toHaveText('Account created');
  await expect(page.getByRole('heading', { name: 'Hotel Montaña' })).toBeVisible();
  await expect(page.locator('.page-head')).toContainText('hotel');
  await page.goto('/#/leads?status=converted');
  await expect(row('Hotel Montaña').getByRole('link', { name: 'Open account' })).toBeVisible();

  // server-side validation surfaces as a toast
  await page.goto('/#/leads');
  await page.locator('#lsWhat').fill('ab');
  await page.getByRole('button', { name: 'Search Google Maps' }).click();
  await expect(toast(page)).toHaveText('Query too short.');
});
