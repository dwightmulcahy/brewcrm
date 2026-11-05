import { test, expect, signInAdmin, dialog, toast } from './fixtures.mjs';

test('account lifecycle: create, edit, contacts, deals, activity, delete', async ({ page }) => {
  await signInAdmin(page);
  await page.getByRole('link', { name: 'Accounts' }).click();
  await page.getByRole('button', { name: 'New account' }).click();
  const dlg = dialog(page);
  await dlg.getByLabel('Name').fill('Bar La Esquina');
  await dlg.getByLabel('Type').selectOption('restaurant');
  await dlg.getByLabel('Area (canton / town)').fill('Escazú');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);
  await page.getByRole('button', { name: 'New account' }).click();
  await dlg.getByLabel('Name').fill('Bar La Esquina');
  await dlg.getByLabel('Area (canton / town)').fill('Escazú');
  await dlg.getByRole('button', { name: 'Create account' }).click();
  await expect(toast(page)).toHaveText('Account created');
  await expect(page.getByRole('heading', { name: 'Bar La Esquina' })).toBeVisible();
  await expect(page.getByText('No activity yet. Log your first visit')).toBeVisible();
  await expect(page.getByText('None recorded')).toBeVisible();

  // edit details
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await dlg.getByLabel('Address').fill('Calle 5, Escazú');
  await dlg.getByLabel('Phone').fill('8888-1234');
  await dlg.getByLabel('Website').fill('https://esquina.cr');
  await dlg.getByLabel('Notes').fill('Owner prefers IPAs.\nOpen Tue–Sun.');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(page)).toHaveText('Account saved');
  await expect(page.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', 'https://wa.me/50688881234');
  await expect(page.getByRole('link', { name: 'esquina.cr' })).toBeVisible();
  await expect(page.getByText('Owner prefers IPAs.')).toBeVisible();

  // contacts
  await page.getByRole('button', { name: 'Add contact' }).click();
  await dlg.getByLabel('Name').fill('María');
  await dlg.getByLabel('Role').fill('Owner');
  await dlg.getByLabel('Email').fill('owner@esquina.cr');
  await dlg.getByLabel('Phone').fill('8888-0000');
  await dlg.getByLabel('Main contact').check();
  await dlg.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText('María ★')).toBeVisible();
  await page.getByRole('button', { name: 'Add contact' }).click();
  await dlg.getByLabel('Name').fill('Temp Person');
  await dlg.getByLabel('WhatsApp (if different)').fill('7000-1111');
  await dlg.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText('Temp Person')).toBeVisible();
  await page.locator('.contact', { hasText: 'Temp Person' }).getByRole('button', { name: 'Edit' }).click();
  await dlg.getByLabel('Role').fill('Bartender');
  await dlg.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText('Bartender')).toBeVisible();
  await page.locator('.contact', { hasText: 'Temp Person' }).getByRole('button', { name: 'Edit' }).click();
  page.once('dialog', (d) => d.dismiss());
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(dlg).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(toast(page)).toHaveText('Contact deleted');
  await expect(page.getByText('Temp Person')).toHaveCount(0);

  // deals: the automatic draft deal + a new one
  await page.getByRole('button', { name: 'Add deal' }).click();
  await dlg.getByLabel('Title').fill('2 taps');
  await dlg.getByLabel('Stage').selectOption('proposal');
  await dlg.getByLabel(/Value per month/).fill('150000');
  await dlg.getByLabel('Est. liters per month').fill('60');
  await dlg.getByLabel('Next step').fill('Send price list');
  await dlg.getByRole('button', { name: 'Save deal' }).click();
  await expect(toast(page)).toHaveText('Deal saved');
  await expect(page.getByText('60 L/mo · Next: Send price list')).toBeVisible();
  await page.locator('.contact', { hasText: 'Draft placement' }).getByRole('button', { name: 'Edit' }).click();
  await dlg.getByLabel('Stage').selectOption('lost');
  await dlg.getByLabel('Lost reason').fill('Exclusive with a big brand');
  await dlg.getByRole('button', { name: 'Save deal' }).click();
  await expect(page.getByText('Lost: Exclusive with a big brand')).toBeVisible();
  await page.getByRole('button', { name: 'Add deal' }).click();
  await dlg.getByLabel('Title').fill('Throwaway deal');
  await dlg.getByRole('button', { name: 'Save deal' }).click();
  await page.locator('.contact', { hasText: 'Throwaway deal' }).getByRole('button', { name: 'Edit' }).click();
  page.once('dialog', (d) => d.dismiss());
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(dlg).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(toast(page)).toHaveText('Deal deleted');
  await expect(page.getByText('Throwaway deal')).toHaveCount(0);

  // log activity with quick follow-up and contact
  await page.locator('#logHere').click();
  await dlg.getByLabel('Type').selectOption('tasting');
  await dlg.getByLabel('Contact').selectOption({ label: 'María' });
  await dlg.getByLabel('What happened').fill('Tasted the IPA and the lager');
  await dlg.getByRole('button', { name: 'In 2 weeks' }).click();
  await expect(dlg.getByLabel('Next follow-up')).not.toHaveValue('');
  await dlg.getByRole('button', { name: 'Save activity' }).click();
  await expect(toast(page)).toHaveText('Activity saved');
  const item = page.locator('.timeline li', { hasText: 'Tasted the IPA' });
  await expect(item).toContainText('Tasting');
  await expect(item).toContainText('from us');
  await expect(item).toContainText('María');
  await expect(item).toContainText('Follow-up set for');
  await expect(page.locator('.page-head')).toContainText('Follow up');

  page.once('dialog', (d) => d.dismiss());
  await item.getByRole('button', { name: 'Delete' }).click();
  await expect(item).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await item.getByRole('button', { name: 'Delete' }).click();
  await expect(toast(page)).toHaveText('Activity deleted');
  await expect(page.locator('.timeline li', { hasText: 'Tasted the IPA' })).toHaveCount(0);

  // top-bar "Log activity" on an account page targets that account (no picker)
  await page.locator('#quickLog').click();
  await expect(dlg.locator('#tAcc')).toHaveCount(0);
  await dlg.getByLabel('Direction').selectOption('in');
  await dlg.getByLabel('What happened').fill('They called back');
  await dlg.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.locator('.timeline li', { hasText: 'They called back' })).toContainText('from them');
});

test('accounts list: search, type filter, log from the list; activity dialog account picker', async ({ page, api }) => {
  const { account } = await api.account('Hotel Montaña Azul', { type: 'hotel', area: 'Santa Ana', last_touch_at: '2026-01-01 10:00:00.000Z', order_count: 2, last_order_at: '2026-10-01 10:00:00.000Z' });
  await api.create('contacts', { account: account.id, name: 'Chef Luis' });
  await signInAdmin(page);
  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page.locator('#alist .item')).toHaveCount(2);
  await page.getByLabel('Search accounts').fill('santa');
  await expect(page.locator('#alist .item')).toHaveCount(1);
  await expect(page.locator('#alist')).toContainText('2 orders, last');
  await page.getByLabel('Search accounts').fill('');
  await page.getByLabel('Type').selectOption('hotel');
  await expect(page.locator('#alist .item')).toHaveCount(1);
  await page.locator('#alist').getByRole('button', { name: 'Log activity' }).click();
  await dialog(page).getByLabel('What happened').fill('Dropped off a sample');
  await dialog(page).getByRole('button', { name: 'Save activity' }).click();
  await expect(toast(page)).toHaveText('Activity saved');
  await expect(page.locator('#alist')).toContainText('Last activity');

  // from the pipeline the dialog shows an account picker that reloads contacts/deals
  await page.getByRole('link', { name: 'Pipeline' }).click();
  await page.locator('#quickLog').click();
  const dlg = dialog(page);
  await expect(dlg.locator('#tAcc')).toBeVisible();
  await dlg.locator('#tAcc').selectOption({ label: 'Hotel Montaña Azul — Santa Ana' });
  await expect(dlg.locator('#tContact')).toContainText('Chef Luis');
  await dlg.locator('#tAcc').selectOption({ index: 0 });
  await expect(dlg.locator('#tContact')).toContainText('María');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

test('saving errors show a message and keep the dialog open', async ({ page }) => {
  await signInAdmin(page);
  await page.getByRole('link', { name: 'Accounts' }).click();
  await page.route('**/api/collections/accounts/records', (r) => (r.request().method() === 'POST'
    ? r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ status: 400, message: 'Failed to create record.', data: { name: { code: 'x', message: 'Name is taken.' } } }) })
    : r.continue()));
  await page.getByRole('button', { name: 'New account' }).click();
  await dialog(page).getByLabel('Name').fill('Dup');
  await dialog(page).getByRole('button', { name: 'Create account' }).click();
  await expect(toast(page)).toHaveText('name: Name is taken.');
  await expect(toast(page)).toHaveClass(/err/);
  await expect(dialog(page)).toBeVisible();
});

test('delete an account', async ({ page, api }) => {
  const { account } = await api.account('Delete Me Bar');
  await signInAdmin(page);
  await page.goto(`/#/account/${account.id}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  page.once('dialog', (d) => d.dismiss());
  await dialog(page).getByRole('button', { name: 'Delete account' }).click();
  await expect(dialog(page)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await dialog(page).getByRole('button', { name: 'Delete account' }).click();
  await expect(toast(page)).toHaveText('Account deleted');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.locator('#alist')).not.toContainText('Delete Me Bar');
});
