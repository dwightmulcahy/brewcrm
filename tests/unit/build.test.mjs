import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './pbfake.mjs';

const build = (edition, env = {}) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'brewcrm-build-'));
  const clean = { ...process.env };
  delete clean.APP_VERSION;
  delete clean.GIT_SHA;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), ...(edition ? [edition] : [])], {
    cwd: ROOT, env: { ...clean, OUT_DIR: out, ...env }, encoding: 'utf8',
  });
  return { ...r, out, json: (f) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) };
};

describe('scripts/build.mjs', () => {
  test('web edition: app dirs, build.json, public version.json', () => {
    const r = build('web', { APP_VERSION: 'v1.4.2', GIT_SHA: 'ABCDEF0123456789' });
    assert.equal(r.status, 0, r.stderr);
    for (const p of ['pb_public/index.html', 'pb_hooks/crm.pb.js', 'pb_hooks/lib/crm.js', 'pb_migrations/1730800000_password_policy.js']) {
      assert.ok(fs.existsSync(path.join(r.out, p)), p);
    }
    const meta = r.json('build.json');
    assert.equal(meta.edition, 'web');
    assert.equal(meta.version, '1.4.2');
    assert.equal(meta.commit, 'abcdef0');
    assert.match(meta.pocketbase, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(r.json('pb_public/version.json'), { version: '1.4.2', commit: 'abcdef0' });
    assert.ok(!fs.existsSync(path.join(r.out, 'start.sh')));
    assert.match(r.stdout, /built web ->/);
  });

  test('offline edition adds start scripts and instructions naming the PocketBase version', () => {
    const r = build('offline');
    assert.equal(r.status, 0, r.stderr);
    const meta = r.json('build.json');
    assert.deepEqual([meta.version, meta.commit], ['dev', '']);
    const sh = fs.readFileSync(path.join(r.out, 'start.sh'), 'utf8');
    assert.match(sh, /pocketbase serve --http=127\.0\.0\.1:\$\{PORT:-8080\}/);
    assert.ok(fs.statSync(path.join(r.out, 'start.sh')).mode & 0o100, 'start.sh is executable');
    assert.match(fs.readFileSync(path.join(r.out, 'start.cmd'), 'utf8'), /pocketbase\.exe serve/);
    assert.ok(fs.readFileSync(path.join(r.out, 'OFFLINE.md'), 'utf8').includes(meta.pocketbase));
  });

  test('invalid version/commit fall back to dev; unknown edition fails', () => {
    const r = build('web', { APP_VERSION: '<script>', GIT_SHA: 'zzz' });
    assert.deepEqual(r.json('pb_public/version.json'), { version: 'dev', commit: '' });
    const pre = build('web', { APP_VERSION: '2.0.0-rc.1' });
    assert.equal(pre.json('pb_public/version.json').version, '2.0.0-rc.1');
    const bad = build('bogus');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /edition must be "web" or "offline"/);
    assert.notEqual(build('').status, 0);
  });
});
