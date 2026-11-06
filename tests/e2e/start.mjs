// Starts the fake integrations and a real PocketBase serving a fresh BrewCRM build.
// PB_BIN must point to a PocketBase binary matching ARG PB_VERSION in the Dockerfile
// (CI downloads and checksum-verifies it; see scripts/fetch-pocketbase.sh).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer } from './mock-server.mjs';
import { E2E } from './config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PB = process.env.PB_BIN;
if (!PB || !fs.existsSync(PB)) {
  console.error('Set PB_BIN to a PocketBase binary (scripts/fetch-pocketbase.sh downloads one).');
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'brewcrm-e2e-'));
const app = path.join(work, 'app');
const data = path.join(work, 'data');
const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), 'web'], { env: { ...process.env, OUT_DIR: app, APP_VERSION: '0.9.0', GIT_SHA: 'abc1234def5678' }, stdio: 'inherit' });
if (built.status !== 0) process.exit(1);

await startMockServer(E2E.mockPort);
const mock = `http://127.0.0.1:${E2E.mockPort}`;
const env = {
  ...process.env,
  APP_URL: E2E.baseURL,
  RATE_LIMITS: '0',
  PB_ADMIN_EMAIL: E2E.admin.email,
  PB_ADMIN_PASSWORD: E2E.admin.password,
  GOOGLE_PLACES_API_KEY: 'e2e',
  PLACES_BASE_URL: mock,
  GOOGLE_CLIENT_ID: 'e2e-client',
  GOOGLE_CLIENT_SECRET: 'e2e-secret',
  GOOGLE_TOKEN_URL: `${mock}/token`,
  GMAIL_BASE_URL: mock,
  LOYVERSE_ACCESS_TOKEN: 'e2e',
  LOYVERSE_BASE_URL: `${mock}/v1.0`,
};
const dirs = [`--dir=${data}`, `--migrationsDir=${app}/pb_migrations`, `--hooksDir=${app}/pb_hooks`, `--publicDir=${app}/pb_public`];
for (const args of [['migrate', 'up', ...dirs], ['superuser', 'upsert', E2E.admin.email, E2E.admin.password, `--dir=${data}`]]) {
  const r = spawnSync(PB, args, { env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
const server = spawn(PB, ['serve', `--http=127.0.0.1:${E2E.port}`, '--hooksWatch=false', ...dirs], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { server.kill('SIGTERM'); fs.rmSync(work, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => process.exit(code ?? 0));
