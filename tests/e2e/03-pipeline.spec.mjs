import { test, expect, signInAdmin, dialog, toast } from './fixtures.mjs';

const soon = (days) => new Date(Date.now() + days * 86400000).toISOString().replace('T', ' ');

test('pipeline: filter, show lost, move by select, drag and drop, lost reason prompt', async ({ page, api }) => {
  await api.account('Pipe Alpha', { area: 'Heredia' }, { stage: 'sampling', title: 'Kegs', value: 90000, est_liters_month: 40, next_step: 'Call back', next_followup_at: soon(-1) });
  await api.account('Pipe Beta', { area: 'Liberia' }, { stage: 'proposal', title: 'Bottles', next_followup_at: soon(3) });
  await api.account('Pipe Gamma', {}, { stage: 'lost', title: 'Gone' });
  await signInAdmin(page);
  const col = (s) => page.locator(`.col[data-stage="${s}"]`);
  await expect(col('sampling')).toContainText('Pipe Alpha');
  await expect(col('sampling').locator('.meta')).toContainText('40 L/mo');
  await expect(col('sampling').locator('.due')).toContainText('Follow up');
  await expect(col('sampling')).toContainText('Next: Call back');

  await page.getByLabel('Filter pipeline').fill('liberia');
  await expect(page.locator('.deal')).toHaveCount(1);
  await page.getByLabel('Filter pipeline').fill('');
  await expect(col('lost')).toHaveCount(0);
  await page.getByLabel('Show lost').check();
  await expect(col('lost')).toContainText('Pipe Gamma');
  await page.getByLabel('Show lost').uncheck();

  await page.getByLabel('Stage for Pipe Beta').selectOption('first_order');
  await expect(toast(page)).toHaveText('Moved to First order');
  await expect(col('first_order')).toContainText('Pipe Beta');

  await page.locator('.deal', { hasText: 'Pipe Alpha' }).dragTo(col('proposal'));
  await expect(col('proposal')).toContainText('Pipe Alpha');
  await expect(toast(page)).toHaveText('Moved to Proposal');
  // dropping on the same column is a no-op
  await page.locator('.deal', { hasText: 'Pipe Alpha' }).dragTo(col('proposal'));
  await expect(col('proposal')).toContainText('Pipe Alpha');

  // lost: cancelling the prompt keeps the stage; accepting stores the reason
  page.once('dialog', (d) => d.dismiss());
  await page.getByLabel('Stage for Pipe Alpha').selectOption('lost');
  await expect(col('proposal')).toContainText('Pipe Alpha');
  page.once('dialog', (d) => d.accept('Price'));
  await page.getByLabel('Stage for Pipe Alpha').selectOption('lost');
  await expect(toast(page)).toHaveText('Moved to Lost');
  const lost = (await api.list('deals', "title = 'Kegs'")).items[0];
  expect([lost.stage, lost.lost_reason]).toEqual(['lost', 'Price']);
});

test('a failed move reverts the card', async ({ page, api }) => {
  await api.account('Pipe Delta', {}, { stage: 'contacted', title: 'Revert me' });
  await signInAdmin(page);
  await page.route('**/api/collections/deals/records/*', (r) => (r.request().method() === 'PATCH'
    ? r.fulfill({ status: 403, contentType: 'application/json', body: '{"status":403,"message":"Not allowed.","data":{}}' })
    : r.continue()));
  await page.getByLabel('Stage for Pipe Delta').selectOption('recurring');
  await expect(toast(page)).toHaveText('Not allowed.');
  await expect(page.locator('.col[data-stage="contacted"]')).toContainText('Pipe Delta');
});

test('new deal from the pipeline picks an account', async ({ page }) => {
  await signInAdmin(page);
  await page.getByRole('button', { name: 'New deal' }).click();
  const dlg = dialog(page);
  await dlg.getByLabel('Account').selectOption({ label: 'Pipe Delta' });
  await dlg.getByLabel('Title').fill('Seasonal rotation');
  await dlg.getByRole('button', { name: 'Save deal' }).click();
  await expect(toast(page)).toHaveText('Deal saved');
  await expect(page.locator('.col[data-stage="prospect"]')).toContainText('Seasonal rotation');
});
