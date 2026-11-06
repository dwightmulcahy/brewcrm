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
  delete clean.GIT_DIR;
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

  test('dev builds read the commit from GIT_DIR (loose ref, packed ref, detached); GIT_SHA wins', () => {
    const git = fs.mkdtempSync(path.join(os.tmpdir(), 'brewcrm-git-'));
    const sha = (r) => r.json('pb_public/version.json').commit;
    fs.mkdirSync(path.join(git, 'refs/heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(git, 'refs/heads/main'), '35C7C08aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    assert.equal(sha(build('web', { GIT_DIR: git })), '35c7c08');
    assert.equal(sha(build('web', { GIT_DIR: git, GIT_SHA: 'abcdef0' })), 'abcdef0');
    fs.rmSync(path.join(git, 'refs/heads/main'));
    fs.writeFileSync(path.join(git, 'packed-refs'), '# pack-refs with: peeled\n1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/main\n');
    assert.equal(sha(build('web', { GIT_DIR: git })), '1111111');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/other\n');
    assert.equal(sha(build('web', { GIT_DIR: git })), '');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/../../etc/passwd\n');
    assert.equal(sha(build('web', { GIT_DIR: git })), '');
    fs.writeFileSync(path.join(git, 'HEAD'), '2222222cccccccccccccccccccccccccccccccc\n');
    assert.equal(sha(build('web', { GIT_DIR: git })), '2222222');
    assert.equal(sha(build('web', { GIT_DIR: path.join(git, 'missing') })), '');
    const v = build('web', { GIT_DIR: git }).json('pb_public/version.json');
    assert.equal(v.version, 'dev');
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
