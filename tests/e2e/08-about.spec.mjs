import { test, expect, signInAdmin, dialog, toast, E2E } from './fixtures.mjs';

test('version label opens build details; more once signed in; copy details', async ({ page, context }) => {
  await page.goto('/');
  const label = page.locator('.login [data-build-version]');
  await expect(label).toHaveText('v0.9.0');
  await label.click();
  const dlg = dialog(page);
  await expect(dlg.getByRole('heading', { name: 'BrewCRM' })).toBeVisible();
  await expect(dlg.locator('.kv')).toContainText('Versionv0.9.0');
  await expect(dlg.getByRole('link', { name: 'abc1234' })).toHaveAttribute('href', 'https://github.com/dwightmulcahy/brewcrm/commit/abc1234');
  await expect(dlg).toContainText('Sign in to see build and server details.');
  await expect(dlg).not.toContainText('PocketBase');
  await expect(dlg.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', /releases\/tag\/v0\.9\.0$/);
  await dlg.getByRole('button', { name: 'Close' }).click();
  await expect(dlg).toBeHidden();

  await signInAdmin(page);
  await page.locator('#topbar [data-build-version]').click();
  const kv = dlg.locator('.kv');
  await expect(kv).toContainText('EditionWeb (Docker / server)');
  await expect(kv).toContainText(/PocketBasev\d+\.\d+\.\d+/);
  await expect(kv).toContainText('Built');
  await expect(kv).toContainText('Server up since');
  await expect(kv).toContainText(`Signed in as${E2E.admin.email}`);
  await expect(dlg).not.toContainText('Sign in to see');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await dlg.getByRole('button', { name: 'Copy details' }).click();
  await expect(toast(page)).toHaveText('Build details copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Version: v0.9.0');
  expect(copied).toContain('Commit: abc1234');
  expect(copied).toMatch(/Browser: Mozilla/);
});

test('about dialog: dev build, server info unavailable, copy blocked', async ({ page }) => {
  await page.route('**/version.json', (r) => r.fulfill({ json: { version: 'dev', commit: '' } }));
  await page.route('**/api/crm/build', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"status":500,"message":"x","data":{}}' }));
  await signInAdmin(page);
  const label = page.locator('#topbar [data-build-version]');
  await expect(label).toHaveText('dev');
  await label.click();
  const dlg = dialog(page);
  await expect(dlg.locator('.kv')).toContainText('Versiondev (local build)');
  await expect(dlg.locator('.kv')).not.toContainText('Commit');
  await expect(dlg.getByRole('link', { name: 'Recent changes' })).toHaveAttribute('href', /commits\/main$/);
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
  await dlg.getByRole('button', { name: 'Copy details' }).click();
  await expect(toast(page)).toHaveText("Couldn't copy. Select the text instead.");
});
