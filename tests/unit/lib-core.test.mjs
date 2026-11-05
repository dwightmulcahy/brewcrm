import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRuntime, Record, BadRequestError, ForbiddenError } from './pbfake.mjs';

describe('passwords', () => {
  const { passwordProblems, assertPassword } = createRuntime().lib();

  test('accepts strong passwords', () => {
    assert.deepEqual(passwordProblems('Brew-pass-2026!', 'owner@x.cr'), []);
    assert.deepEqual(passwordProblems('Kq7vT2mXpL9wR4nZbH6c', 'a@b.c'), [], '16+ chars needs no symbol');
    assert.deepEqual(passwordProblems('Cerveza-fría-26', 'x@y.z'), [], 'accented letters count');
  });

  test('lists every missing requirement', () => {
    assert.deepEqual(passwordProblems('', ''), ['at least 12 characters', 'a letter', 'a number', 'a symbol (or make it 16+ characters)']);
    assert.deepEqual(passwordProblems('abcdefghijkl', ''), ['a number', 'a symbol (or make it 16+ characters)']);
    assert.deepEqual(passwordProblems('123456789012!', ''), ['a letter']);
    assert.ok(passwordProblems('a1!' + 'x'.repeat(70), '').includes('at most 71 characters'));
    assert.deepEqual(passwordProblems(undefined, undefined).length, 4);
  });

  test('rejects the email name only when it is 4+ characters', () => {
    assert.deepEqual(passwordProblems('carlos-brew-2026', 'Carlos@brewery.cr'), ['EMAIL']);
    assert.deepEqual(passwordProblems('rep-brew-2026!', 'rep@brewery.cr'), []);
  });

  test('assertPassword builds readable messages', () => {
    assert.throws(() => assertPassword('short', 'a@b.c'), (e) => {
      assert.ok(e instanceof BadRequestError);
      assert.match(e.message, /^Password needs at least 12 characters, a number, a symbol/);
      assert.strictEqual(e.data.password.code, 'validation_weak_password');
      return true;
    });
    assert.throws(() => assertPassword('carlos-brew-2026', 'carlos@x.cr'), { message: "It can't contain your email name." });
    assert.throws(() => assertPassword('carlos', 'carlos@x.cr'), /Password needs .*\. It can't contain your email name\./);
    assert.doesNotThrow(() => assertPassword('Brew-pass-2026!', 'a@b.c'));
  });

  test('requireActive blocks only flagged CRM users', () => {
    const rt = createRuntime();
    const { requireActive } = rt.lib();
    const users = rt.app.findCollectionByNameOrId('users');
    const supers = rt.app.defineCollection('_superusers');
    assert.doesNotThrow(() => requireActive({ auth: null }));
    assert.doesNotThrow(() => requireActive({ auth: new Record(users, { must_change_password: false }) }));
    assert.doesNotThrow(() => requireActive({ auth: new Record(supers, { must_change_password: true }) }));
    assert.throws(() => requireActive({ auth: new Record(users, { must_change_password: true }) }), ForbiddenError);
  });
});

describe('settings from .env', () => {
  test('applies APP_URL, SMTP and rate limits, then is idempotent', () => {
    const rt = createRuntime({ env: { APP_URL: 'https://crm.example.cr///', SMTP_HOST: 'smtp.gmail.com', SMTP_USERNAME: 'crm@x.cr', SMTP_PASSWORD: 'pw' } });
    const crm = rt.lib();
    const s = rt.app.settings();
    crm.applyEnvSettings(rt.app);
    assert.strictEqual(s.meta.appURL, 'https://crm.example.cr');
    assert.strictEqual(s.meta.appName, 'BrewCRM');
    assert.deepEqual([s.smtp.enabled, s.smtp.host, s.smtp.port, s.smtp.tls], [true, 'smtp.gmail.com', 587, false]);
    assert.strictEqual(s.meta.senderAddress, 'crm@x.cr', 'sender defaults to the SMTP username');
    assert.strictEqual(s.meta.senderName, 'BrewCRM');
    assert.strictEqual(s.rateLimits.enabled, true);
    assert.deepEqual(s.rateLimits.rules.map((r) => r.label), ['*:authWithPassword', '*:requestPasswordReset', '*:confirmPasswordReset', '*:create', '/api/batch', '/api/']);
    assert.strictEqual(rt.app.log.settingsSaves, 1);
    crm.applyEnvSettings(rt.app);
    assert.strictEqual(rt.app.log.settingsSaves, 1, 'no save when nothing changed');
    assert.strictEqual(crm.mailConfigured(), true);
  });

  test('port 465 implies implicit TLS; explicit values win; RATE_LIMITS=0 disables', () => {
    const rt = createRuntime({ env: { SMTP_HOST: 'mail.x', SMTP_PORT: '465', SMTP_SENDER_ADDRESS: 'noreply@x', SMTP_SENDER_NAME: 'Brew', RATE_LIMITS: '0', APP_NAME: 'Cerve' } });
    rt.lib().applyEnvSettings(rt.app);
    const s = rt.app.settings();
    assert.deepEqual([s.smtp.port, s.smtp.tls, s.meta.senderAddress, s.meta.senderName, s.meta.appName, s.rateLimits.enabled], [465, true, 'noreply@x', 'Brew', 'Cerve', false]);
  });

  test('without SMTP_HOST mail settings are left alone', () => {
    const rt = createRuntime();
    const crm = rt.lib();
    crm.applyEnvSettings(rt.app);
    assert.strictEqual(rt.app.settings().smtp.enabled, false);
    assert.strictEqual(rt.app.settings().meta.appURL, 'http://localhost:8090', 'APP_URL unset keeps existing value');
    assert.strictEqual(crm.mailConfigured(), false);
    rt.app.settings = () => { throw new Error('boom'); };
    assert.strictEqual(crm.mailConfigured(), false);
  });
});

describe('kv store and status', () => {
  test('get/set/delete with defaults and bad JSON', () => {
    const rt = createRuntime();
    const crm = rt.lib();
    assert.strictEqual(crm.kvGet('missing', 42), 42);
    crm.kvSet('a', { x: 1 });
    crm.kvSet('a', { x: 2 });
    assert.deepEqual(crm.kvGet('a', null), { x: 2 });
    assert.strictEqual(rt.app.rows('kv').length, 1, 'updates in place');
    rt.app.save(new Record(rt.app.findCollectionByNameOrId('kv'), { key: 'empty', value: '' }));
    assert.strictEqual(crm.kvGet('empty', 'def'), 'def');
    rt.app.save(new Record(rt.app.findCollectionByNameOrId('kv'), { key: 'bad', value: '{nope' }));
    assert.strictEqual(crm.kvGet('bad', 'def'), 'def');
    crm.kvDel('a');
    crm.kvDel('a');
    assert.strictEqual(crm.kvGet('a', null), null);
  });

  test('status reports integrations, usage and defaults', () => {
    const rt = createRuntime({ env: { GOOGLE_CLIENT_ID: 'cid', LOYVERSE_ACCESS_TOKEN: 't', PLACES_SEARCH_MONTHLY_LIMIT: '10', CURRENCY: 'USD', DORMANT_DAYS: '30' } });
    const crm = rt.lib();
    crm.kvSet('google:tokens', { email: 'me@x.cr' });
    rt.app.settings().meta.senderAddress = 'crm@x.cr';
    const s = crm.status();
    assert.deepEqual(s.google, { configured: true, connected: true, email: 'me@x.cr', last_sync: 0 });
    assert.strictEqual(s.places.configured, false);
    assert.strictEqual(s.places.search_limit, 10);
    assert.strictEqual(s.places.details_limit, 900);
    assert.match(s.places.month, /^\d{4}-\d{2}$/);
    assert.deepEqual(s.pos, { name: 'Loyverse', configured: true, last_sync: 0 });
    assert.deepEqual(s.mail, { configured: false, sender: 'crm@x.cr' });
    assert.deepEqual([s.dormant_days, s.currency, s.app_url], [30, 'USD', 'http://localhost:8080']);
    rt.app.settings = () => { throw new Error('x'); };
    assert.strictEqual(crm.status().mail.sender, '');
    assert.strictEqual(createRuntime().lib().status().google.email, '');
  });
});

describe('logging', () => {
  test('writes raw JSON lines to a pipe and keeps details', () => {
    const rt = createRuntime();
    const crm = rt.lib();
    crm.log('INFO', 'gmail sync', { created: 1 });
    crm.log('ERROR', 'failed', new Error('boom'));
    crm.log('ERROR', 'go error', { message: 'sql: no rows' });
    crm.log('WARNING', 'plain');
    const lines = rt.stdout.map((l) => { assert.ok(l.endsWith('\n')); return JSON.parse(l); });
    assert.deepEqual(lines.map((l) => [l.level, l.message, l.detail]), [
      ['INFO', 'gmail sync', { created: 1 }], ['ERROR', 'failed', 'boom'], ['ERROR', 'go error', 'sql: no rows'], ['WARNING', 'plain', undefined],
    ]);
    assert.ok(lines.every((l) => !Number.isNaN(Date.parse(l.timestamp))));
  });

  test('falls back to console.log when stdout is a file or stat fails, and never throws', () => {
    for (const mode of [true, 'throw']) {
      const rt = createRuntime({ stdoutIsFile: mode });
      rt.lib().writeJsonLine({ a: 1 });
      assert.deepEqual(rt.consoleLines, ['{"a":1}']);
      assert.strictEqual(rt.stdout.length, 0);
    }
    const rt = createRuntime();
    rt.ctx.$os.writeFile = () => { throw new Error('closed'); };
    assert.doesNotThrow(() => rt.lib().log('INFO', 'x'));
  });
});
