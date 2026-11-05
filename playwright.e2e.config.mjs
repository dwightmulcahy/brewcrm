// Full-app e2e tests against a real PocketBase with fake integrations (tests/e2e/start.mjs).
// Run: PB_BIN=/path/to/pocketbase npm run test:e2e   (collects coverage for pb_public/app.js)
import { defineConfig, devices } from '@playwright/test';
import { E2E } from './tests/e2e/config.mjs';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /\d\d-.*\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-e2e' }]] : 'list',
  use: {
    baseURL: E2E.baseURL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'node tests/e2e/start.mjs',
    url: `${E2E.baseURL}/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
