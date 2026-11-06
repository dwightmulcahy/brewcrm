// Playwright fixtures: Chromium JS coverage for pb_public/app.js (written in the V8 format
// c8 reads), API helpers that talk to PocketBase directly, and a UI sign-in helper.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E } from './config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const COV_DIR = path.join(ROOT, 'coverage', 'e2e-tmp');
const APP_JS = pathToFileURL(path.join(ROOT, 'pb_public', 'app.js')).href;
let n = 0;

class Api {
  constructor(request) { this.request = request; this.tokens = {}; }
  async login(coll, email, password) {
    const r = await this.request.post(`/api/collections/${coll}/auth-with-password`, { data: { identity: email, password } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).token;
  }
  async token(kind = 'user') {
    if (!this.tokens[kind]) this.tokens[kind] = await this.login(kind === 'super' ? '_superusers' : 'users', E2E.admin.email, E2E.admin.password);
    return this.tokens[kind];
  }
  async call(method, url, data, kind = 'user') {
    const r = await this.request.fetch(url, { method, data, headers: { Authorization: await this.token(kind) } });
    const text = await r.text();
    expect(r.ok(), `${method} ${url}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : {};
  }
  create(coll, data) { return this.call('POST', `/api/collections/${coll}/records`, data); }
  update(coll, id, data) { return this.call('PATCH', `/api/collections/${coll}/records/${id}`, data); }
  list(coll, filter = '') { return this.call('GET', `/api/collections/${coll}/records?perPage=200&filter=${encodeURIComponent(filter)}`); }
  async account(name, extra = {}, deal = {}) {
    const a = await this.create('accounts', { name, type: 'bar', ...extra });
    const d = await this.create('deals', { account: a.id, title: 'Draft placement', stage: 'prospect', ...deal });
    return { account: a, deal: d };
  }
  newUser(email, password, extra = {}) {
    return this.call('POST', '/api/collections/users/records', { email, password, passwordConfirm: password, name: email.split('@')[0], ...extra }, 'super');
  }
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = (await page.coverage.stopJSCoverage()).filter((e) => new URL(e.url).pathname === '/app.js');
    if (entries.length) {
      fs.mkdirSync(COV_DIR, { recursive: true });
      const result = entries.map((e) => ({ scriptId: String(e.scriptId), url: APP_JS, functions: e.functions }));
      fs.writeFileSync(path.join(COV_DIR, `coverage-${process.pid}-${++n}.json`), JSON.stringify({ result }));
    }
  },
  api: async ({ request }, use) => { await use(new Api(request)); },
});

export async function signIn(page, email = E2E.admin.email, password = E2E.admin.password) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function signInAdmin(page) {
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
}

export const dialog = (page) => page.locator('dialog[open]');
export const toast = (page) => page.locator('#toast');
export { expect, E2E };
