import { test, expect, signInAdmin } from './fixtures.mjs';

const NOTES = { current: '0.9.0', repository: 'dwightmulcahy/brewcrm', releases: [
  { version: '0.9.0', tag: 'v0.9.0', previous: 'v0.8.0', date: '2026-11-24', internal: 2,
    sections: [{ type: 'feat', title: 'Features', items: [{ text: 'follow-up reminders by email (#12)', sha: 'abc1234' }] }] },
  { version: '0.8.0', tag: 'v0.8.0', previous: null, date: '2026-11-01', internal: 0, sections: [] }] };

test("after an upgrade the release notes open once; the header link reopens them", async ({ page }) => {
  await page.route('**/changelog.json', (r) => r.fulfill({ json: NOTES }));
  await page.addInitScript(() => { if (!sessionStorage.seeded) { localStorage.setItem('brewcrm.seenVersion', '0.8.0'); sessionStorage.seeded = '1'; } });
  await page.goto('/');
  const dlg = page.locator('#wn-dlg');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('follow-up reminders by email');
  await expect(dlg).toContainText('2 internal changes');
  await dlg.getByRole('button', { name: 'Got it' }).click();
  await expect(dlg).toBeHidden();
  await signInAdmin(page);
  await expect(page.locator('#wn-dlg[open]')).toHaveCount(0);
  await page.locator('#topbar [data-whats-new]').click();
  await expect(dlg).toBeVisible();
});

test('the build placeholder never opens by itself', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('brewcrm.seenVersion', '0.1.0'));
  await page.goto('/');
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#wn-dlg')).toHaveCount(0);
});
