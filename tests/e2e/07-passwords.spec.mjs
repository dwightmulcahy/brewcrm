import { test, expect, signIn, signInAdmin, toast, E2E } from './fixtures.mjs';

const fakeToken = (email) => ['e30', Buffer.from(JSON.stringify({ email })).toString('base64url'), 'sig'].join('.');

test('first sign-in with a temporary password forces a change', async ({ page, api }) => {
  await api.newUser('rosa.e2e@brewery.cr', 'Kq7vT2mXpL9wR4nZbH6c');
  await signIn(page, 'rosa.e2e@brewery.cr', 'Kq7vT2mXpL9wR4nZbH6c');
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await expect(page.locator('#topbar')).toBeHidden();
  const newPw = page.getByLabel('New password', { exact: true });
  await newPw.fill('Short-pass');
  await expect(page.locator('.pw-rules li:not(.ok)')).toContainText(['At least 12 characters', 'A number']);
  await newPw.fill('rosa.e2e-short-pass');
  await expect(page.locator('.pw-rules li:not(.ok)')).toHaveText(["• Doesn't contain your email name"]);
  await page.getByLabel('Temporary password', { exact: true }).fill('Kq7vT2mXpL9wR4nZbH6c');
  await page.getByLabel('Confirm new password', { exact: true }).fill('rosa.e2e-short-pass');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(toast(page)).toHaveText("Password needs: doesn't contain your email name");
  await expect(newPw).toBeFocused();
  await newPw.fill('Cerveza-fria-2026');
  await page.getByLabel('Confirm new password', { exact: true }).fill('Cerveza-fria-2027');
  await expect(page.locator('[data-pw-mismatch]')).toBeVisible();
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByLabel('Confirm new password', { exact: true })).toBeFocused();
  await page.getByLabel('Confirm new password', { exact: true }).fill('Cerveza-fria-2026');
  await expect(page.locator('[data-pw-mismatch]')).toBeHidden();
  await page.getByLabel('Temporary password', { exact: true }).fill('wrong-temporary-1!');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(toast(page)).toHaveClass(/err/);
  await page.getByLabel('Temporary password', { exact: true }).fill('Kq7vT2mXpL9wR4nZbH6c');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(toast(page)).toHaveText('Password saved');
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
  await expect(page.locator('#topbar')).toBeVisible();
});

test('a flagged user can sign out from the forced-change screen', async ({ page, api }) => {
  await api.newUser('leo.e2e@brewery.cr', 'Kq7vT2mXpL9wR4nZbH6d');
  await signIn(page, 'leo.e2e@brewery.cr', 'Kq7vT2mXpL9wR4nZbH6d');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('change your own password in Settings', async ({ page, api }) => {
  await api.newUser('sofia.e2e@brewery.cr', 'Start-pass-2026!x', { must_change_password: false });
  await signIn(page, 'sofia.e2e@brewery.cr', 'Start-pass-2026!x');
  await page.getByRole('link', { name: 'Settings' }).click();
  const form = page.locator('#pwForm');
  await form.getByLabel('Current password', { exact: true }).fill('Start-pass-2026!x');
  await form.getByLabel('New password', { exact: true }).fill('Next-pass-2026!y');
  await form.getByLabel('Confirm new password', { exact: true }).fill('Next-pass-2026!z');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.locator('[data-pw-mismatch]')).toBeVisible();
  await form.getByLabel('Confirm new password', { exact: true }).fill('Next-pass-2026!y');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(toast(page)).toHaveText('Password changed');
  await expect(form.getByLabel('Current password', { exact: true })).toHaveValue('');
  await expect(form.locator('.pw-rules li.ok')).toHaveCount(1);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'sofia.e2e@brewery.cr', 'Next-pass-2026!y');
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
});

test('forgot password without mail explains the admin route', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.locator('.login')).toContainText('Ask your admin to set a temporary password');
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('forgot password with mail sends a link (same answer for unknown emails)', async ({ page }) => {
  await page.route('**/api/crm/public-config', (r) => r.fulfill({ json: { password_reset: true, password_min: 12, password_long: 16 } }));
  await page.route('**/api/collections/users/request-password-reset', (r) => r.fulfill({ status: 204 }));
  await page.goto('/#/forgot');
  await page.getByLabel('Email').fill('Nobody@Example.com');
  await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.locator('.login')).toContainText('Nobody@Example.com');

  await page.unroute('**/api/collections/users/request-password-reset');
  await page.route('**/api/collections/users/request-password-reset', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: '{"status":429,"message":"Too Many Requests.","data":{}}' }));
  await page.goto('/#/');
  await page.goto('/#/forgot');
  await page.getByLabel('Email').fill('a@b.cr');
  await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.unroute('**/api/collections/users/request-password-reset');
  await page.route('**/api/collections/users/request-password-reset', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"status":400,"message":"Bad email.","data":{}}' }));
  await page.goto('/#/');
  await page.goto('/#/forgot');
  await page.getByLabel('Email').fill('a@b.cr');
  await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await expect(toast(page)).toHaveText('Bad email.');
  await expect(page.getByRole('heading', { name: 'Forgot password' })).toBeVisible();
});

test('reset page: missing, expired and valid tokens', async ({ page }) => {
  await page.goto('/#/reset');
  await expect(page.getByRole('heading', { name: 'Forgot password' })).toBeVisible();

  await page.goto('/#/reset/not-a-jwt');
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('Brand-new-pass-2026');
  await page.getByLabel('Confirm new password', { exact: true }).fill('Brand-new-pass-2026');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(toast(page)).toHaveText('This reset link has expired or was already used. Request a new one.');

  await page.route('**/api/collections/users/confirm-password-reset', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"status":400,"message":"Something else.","data":{}}' }));
  await page.goto(`/#/reset/${fakeToken('maria@brewery.cr')}`);
  await expect(page.locator('.login')).toContainText('For maria@brewery.cr');
  await page.getByLabel('New password', { exact: true }).fill('weak');
  await page.getByLabel('Confirm new password', { exact: true }).fill('weak');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(toast(page)).toContainText('Password needs: at least 12 characters, a number');
  await page.getByLabel('New password', { exact: true }).fill('Brand-new-pass-2026');
  await page.getByLabel('Confirm new password', { exact: true }).fill('Brand-new-pass-2026');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(toast(page)).toHaveText('Something else.');

  await page.unroute('**/api/collections/users/confirm-password-reset');
  await page.route('**/api/collections/users/confirm-password-reset', (r) => r.fulfill({ status: 204 }));
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Password saved' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('the .env admin is never forced to change and keeps working', async ({ page }) => {
  await signInAdmin(page);
  await expect(page.getByText('Choose your password')).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(`Signed in as ${E2E.admin.email}`)).toBeVisible();
});

test('password fields have a Show/Hide toggle that resets after saving', async ({ page, api }) => {
  await page.goto('/');
  const signInPw = page.getByLabel('Password', { exact: true });
  await signInPw.fill('secret-value-1');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(signInPw).toHaveAttribute('type', 'text');
  await expect(signInPw).toBeFocused();
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(signInPw).toHaveAttribute('type', 'password');

  await api.newUser('toggle.e2e@brewery.cr', 'Start-pass-2026!t', { must_change_password: false });
  await signIn(page, 'toggle.e2e@brewery.cr', 'Start-pass-2026!t');
  await page.getByRole('link', { name: 'Settings' }).click();
  const form = page.locator('#pwForm');
  for (const name of ['current password', 'new password', 'confirm new password']) {
    await form.getByRole('button', { name: `Show ${name}`, exact: true }).click();
    const btn = form.getByRole('button', { name: `Hide ${name}`, exact: true });
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveText('Hide');
  }
  await expect(form.locator('input[type=password]')).toHaveCount(0);
  await form.getByLabel('Current password', { exact: true }).fill('Start-pass-2026!t');
  await form.getByLabel('New password', { exact: true }).fill('Next-pass-2026!u');
  await form.getByLabel('Confirm new password', { exact: true }).fill('Next-pass-2026!u');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(toast(page)).toHaveText('Password changed');
  await expect(form.locator('input[type=password]')).toHaveCount(3);
});
