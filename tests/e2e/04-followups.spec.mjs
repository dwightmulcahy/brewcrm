import { test, expect, signInAdmin, dialog, toast } from './fixtures.mjs';

const at = (days) => new Date(Date.now() + days * 86400000).toISOString().replace('T', ' ');

test('follow-ups: due and scheduled items, deal context, going quiet, log from the list', async ({ page, api }) => {
  await api.account('Follow Overdue', { phone: '2222-1111', next_followup_at: at(-2) }, { title: 'Overdue deal', next_followup_at: at(-3), next_step: 'Bring kegs' });
  const { account: later } = await api.account('Follow Later', { next_followup_at: at(5) });
  await api.create('deals', { account: later.id, title: 'Second deal', stage: 'proposal', next_followup_at: at(6) });
  await api.account('Follow DealOnly', {}, { title: 'Only deal', next_followup_at: at(2) });
  await api.account('Follow Far', { next_followup_at: at(30) });
  await api.account('Quiet Pub', { area: 'Cartago', last_touch_at: at(-40) });

  await signInAdmin(page);
  await page.getByRole('link', { name: 'Follow-ups' }).click();
  const row = (name) => page.locator('.item', { hasText: name });
  await expect(row('Follow Overdue')).toContainText('Due');
  await expect(row('Follow Overdue')).toContainText('Bring kegs');
  await expect(row('Follow Overdue').getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:2222-1111');
  await expect(row('Follow Later')).toContainText('Scheduled');
  await expect(row('Follow Later')).toContainText('Second deal');
  await expect(row('Follow DealOnly')).toContainText('Only deal');
  await expect(page.locator('.list').first()).not.toContainText('Follow Far');
  await expect(row('Quiet Pub')).toContainText('Cartago');

  await row('Follow Later').getByRole('button', { name: 'Log activity' }).click();
  await dialog(page).getByLabel('What happened').fill('Confirmed the order');
  await dialog(page).getByRole('button', { name: 'Save activity' }).click();
  await expect(toast(page)).toHaveText('Activity saved');
  await row('Quiet Pub').getByRole('button', { name: 'Log activity' }).click();
  await dialog(page).getByRole('button', { name: 'In 2 days' }).click();
  await dialog(page).getByRole('button', { name: 'Save activity' }).click();
  await expect(row('Quiet Pub').first()).toContainText('Scheduled');
});
