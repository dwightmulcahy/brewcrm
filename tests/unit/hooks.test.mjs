import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRuntime, requestEvent, authUser, Record, BadRequestError, ForbiddenError, HOOKS as HOOKS_DIR } from './pbfake.mjs';

function boot(env = {}, routes = []) {
  const rt = createRuntime({ env, routes });
  const reg = rt.loadHooks();
  const route = (method, p) => {
    const r = reg.routes.find((x) => x.method === method && x.path === p);
    assert.ok(r, `route ${method} ${p}`);
    return r;
  };
  const recordHook = (hook, col) => reg.record.filter((x) => x.hook === hook && x.cols.includes(col)).map((x) => x.fn);
  return { rt, reg, route, recordHook, crm: rt.lib() };
}

describe('registration', () => {
  test('every CRM route except the public ones requires auth', () => {
    const { reg } = boot();
    const open = new Set(['/health', '/api/crm/public-config', '/api/crm/google/callback']);
    for (const r of reg.routes) {
      assert.strictEqual(r.mw.some((m) => m && m.requireAuth), !open.has(r.path), r.path);
    }
    assert.deepEqual(reg.cron.map((c) => [c.name, c.spec]), [['crm_gmail_sync', '*/15 * * * *'], ['crm_pos_sync', '7 * * * *'], ['crm_dormant_sweep', '15 6 * * *']]);
  });
});

describe('bootstrap from .env', () => {
  const admin = { PB_ADMIN_EMAIL: ' Owner@Brewery.CR\r', PB_ADMIN_PASSWORD: 'Brew-pass-2026!x\r' };
  const run = (rt, reg) => { const e = { nextCalls: 0, next() { this.nextCalls++; } }; reg.bootstrap[0](e); return e; };

  test('applies settings and creates the CRM admin once', () => {
    const { rt, reg, crm } = boot({ ...admin, APP_URL: 'https://crm.x' });
    const e = run(rt, reg);
    assert.strictEqual(e.nextCalls, 1);
    assert.strictEqual(rt.app.settings().meta.appURL, 'https://crm.x');
    const u = rt.app.rows('users')[0];
    assert.deepEqual([u.email, u.password, u.verified, u.must_change_password, u.name], ['owner@brewery.cr', 'Brew-pass-2026!x', true, false, 'Admin']);
    assert.ok(crm.kvGet('bootstrap:admin_fingerprint', ''));
    const saves = rt.app.log.saves;
    run(rt, reg);
    assert.strictEqual(rt.app.log.saves, saves, 'unchanged .env does not touch the user');
  });

  test('re-applies a changed .env password but keeps in-app changes otherwise', () => {
    const { rt, reg } = boot(admin);
    run(rt, reg);
    rt.app.rows('users')[0].password = 'changed-in-app-2026';
    run(rt, reg);
    assert.strictEqual(rt.app.rows('users')[0].password, 'changed-in-app-2026');
    rt.env.PB_ADMIN_PASSWORD = 'New-env-pass-2027!';
    run(rt, reg);
    assert.strictEqual(rt.app.rows('users')[0].password, 'New-env-pass-2027!');
    assert.strictEqual(rt.app.rows('users').length, 1);
  });

  test('refuses weak passwords with a JSON error, and skips when unset or before migrations', () => {
    const weak = boot({ PB_ADMIN_EMAIL: 'carlos@x.cr', PB_ADMIN_PASSWORD: 'carlos12' });
    run(weak.rt, weak.reg);
    assert.strictEqual(weak.rt.app.rows('users').length, 0);
    const line = JSON.parse(weak.rt.stdout[0]);
    assert.strictEqual(line.level, 'ERROR');
    assert.match(line.message, /too weak .*needs at least 12 characters.*contains the email name/);

    const none = boot();
    run(none.rt, none.reg);
    assert.strictEqual(none.rt.app.rows('users').length, 0);

    const early = boot(admin);
    const orig = early.rt.app.findCollectionByNameOrId;
    early.rt.app.findCollectionByNameOrId = (n) => { if (n === 'users') throw new Error('no such collection'); return orig(n); };
    assert.doesNotThrow(() => run(early.rt, early.reg));
  });

  test('logs failures instead of crashing startup', () => {
    const { rt, reg } = boot(admin);
    rt.app.settings = () => { throw new Error('settings broken'); };
    rt.app.failNextSave('users');
    run(rt, reg);
    const msgs = rt.stdout.map((l) => JSON.parse(l));
    assert.deepEqual(msgs.map((m) => [m.level, m.message, m.detail]), [
      ['ERROR', 'could not apply settings from .env', 'settings broken'],
      ['ERROR', 'could not create CRM user from PB_ADMIN_EMAIL', 'save failed for users'],
    ]);
  });
});

describe('users: password policy hooks', () => {
  const usersRecord = (rt, data) => new Record(rt.app.findCollectionByNameOrId('users'), data);

  test('create: enforces policy and makes the password temporary unless the admin says otherwise', () => {
    const { rt, recordHook } = boot();
    const [create] = recordHook('onRecordCreateRequest', 'users');
    const rec = usersRecord(rt, { email: 'ana@x.cr' });
    assert.throws(() => create(requestEvent({ body: { email: 'ana@x.cr', password: 'short' }, record: rec })), BadRequestError);
    const e = requestEvent({ body: { password: 'Kq7vT2mXpL9wR4nZbH6c' }, record: rec });
    create(e);
    assert.deepEqual([rec.get('must_change_password'), e.nextCalls], [true, 1]);
    const rec2 = usersRecord(rt, { email: 'b@x.cr' });
    create(requestEvent({ body: { email: 'b@x.cr', password: 'Kq7vT2mXpL9wR4nZbH6c', must_change_password: false }, record: rec2 }));
    assert.strictEqual(rec2.get('must_change_password'), undefined, 'explicit choice is kept');
    assert.throws(() => create(requestEvent({ body: null, record: usersRecord(rt, { email: 'c@x.cr' }) })), /Password needs/);
  });

  test('update: admin resets flag the password; self-change clears it; users cannot clear it otherwise', () => {
    const { rt, recordHook } = boot();
    const [update] = recordHook('onRecordUpdateRequest', 'users');
    const existing = authUser(rt.app, { email: 'ana@x.cr', must_change_password: true });
    const fresh = () => rt.app.findRecordById('users', existing.id);

    const self = fresh();
    self.set('must_change_password', false);
    update(requestEvent({ body: { must_change_password: false, name: 'Ana' }, record: self }));
    assert.strictEqual(self.get('must_change_password'), true, 'reverted to the stored value');

    assert.throws(() => update(requestEvent({ body: { password: 'Same-pass-2026!', oldPassword: 'Same-pass-2026!' }, record: fresh() })), /different from the current one/);
    assert.throws(() => update(requestEvent({ body: { password: 'weak', oldPassword: 'x' }, record: fresh() })), /Password needs/);
    const changed = fresh();
    update(requestEvent({ body: { password: 'Mine-own-pass-77', oldPassword: 'Temp-pass-2026!' }, record: changed }));
    assert.strictEqual(changed.get('must_change_password'), false);

    const byAdmin = fresh();
    byAdmin.set('must_change_password', false);
    update(requestEvent({ superuser: true, body: { password: 'Admin-reset-9988' }, record: byAdmin }));
    assert.strictEqual(byAdmin.get('must_change_password'), true);
    const adminChoice = fresh();
    adminChoice.set('must_change_password', false);
    update(requestEvent({ superuser: true, body: { password: 'Admin-reset-9988', must_change_password: false }, record: adminChoice }));
    assert.strictEqual(adminChoice.get('must_change_password'), false);
    const adminEdit = fresh();
    adminEdit.set('must_change_password', false);
    update(requestEvent({ superuser: true, body: { must_change_password: false }, record: adminEdit }));
    assert.strictEqual(adminEdit.get('must_change_password'), false, 'admins may untick the flag');
    const noBody = fresh();
    assert.doesNotThrow(() => update(requestEvent({ body: null, record: noBody })));
  });

  test('confirm reset: enforces policy and clears the flag', () => {
    const { rt, recordHook } = boot();
    const [confirm] = recordHook('onRecordConfirmPasswordResetRequest', 'users');
    const rec = usersRecord(rt, { email: 'ana@x.cr', must_change_password: true });
    assert.throws(() => confirm(requestEvent({ body: { password: 'short' }, record: rec })), BadRequestError);
    assert.throws(() => confirm(requestEvent({ body: null, record: rec })), BadRequestError);
    const e = requestEvent({ body: { password: 'Reset-by-email-42' }, record: rec });
    confirm(e);
    assert.deepEqual([rec.get('must_change_password'), e.nextCalls], [false, 1]);
  });
});

describe('access log middleware', () => {
  const mw = (env = {}) => { const b = boot(env); return { ...b, use: b.reg.middlewares[0] }; };
  test('one logwatch JSON line per request with level by status', () => {
    const { rt, use } = mw();
    for (const [status, level] of [[200, 'INFO'], [404, 'WARNING'], [503, 'ERROR'], [0, 'INFO']]) {
      const e = requestEvent({ method: 'GET', path: '/x', status, headers: { 'User-Agent': 'UA' }, ip: '198.51.100.9' });
      use(e);
      const line = JSON.parse(rt.stdout.at(-1));
      assert.deepEqual([line.level, line.status_code, line.path, line.client, line.user_agent, line.method, line.api_key], [level, status || 200, '/x', '198.51.100.9', 'UA', 'GET', null]);
      assert.ok(line.duration_ms >= 0);
    }
  });
  test('logs thrown errors with their status and rethrows; ACCESS_LOG=0 is silent', () => {
    const { rt, use } = mw();
    const goErr = Object.assign(new Error('wrapped'), { value: { status: 401 } });
    for (const [err, want] of [[goErr, 401], [new ForbiddenError('no'), 403], [new Error('boom'), 500]]) {
      const e = requestEvent({ path: '/api/crm/status' });
      e.next = () => { throw err; };
      assert.throws(() => use(e), (x) => x === err);
      assert.strictEqual(JSON.parse(rt.stdout.at(-1)).status_code, want);
    }
    const broken = requestEvent();
    broken.realIP = () => { throw new Error('no ip'); };
    assert.doesNotThrow(() => use(broken));
    const quiet = mw({ ACCESS_LOG: '0' });
    const e = requestEvent();
    quiet.use(e);
    assert.deepEqual([quiet.rt.stdout.length, e.nextCalls], [0, 1]);
  });
});

describe('routes', () => {
  test('health and public config', () => {
    const { route, rt } = boot({ SMTP_HOST: 'x' });
    assert.deepEqual(route('GET', '/health').handler(requestEvent()).body, { status: 'ok' });
    rt.app.settings().smtp.enabled = true;
    assert.deepEqual(route('GET', '/api/crm/public-config').handler(requestEvent()).body, { password_reset: true, password_min: 12, password_long: 16 });
  });

  test('status, and temporary-password users are blocked from every guarded route', () => {
    const { route, rt, reg } = boot();
    const flagged = authUser(rt.app, { must_change_password: true });
    assert.strictEqual(route('GET', '/api/crm/status').handler(requestEvent({ auth: flagged })).status, 200);
    const guarded = reg.routes.filter((r) => r.path.startsWith('/api/crm/') && !['/api/crm/status', '/api/crm/build', '/api/crm/public-config', '/api/crm/google/callback'].includes(r.path));
    assert.strictEqual(guarded.length, 8);
    for (const r of guarded) assert.throws(() => r.handler(requestEvent({ auth: flagged })), ForbiddenError, r.path);
  });

  test('build info: build.json fields + server start time; tolerates missing/garbled files', () => {
    const buildJson = path.resolve(HOOKS_DIR, '..', 'build.json');
    const rt = createRuntime({ files: { [buildJson]: JSON.stringify({ edition: 'web', version: '1.2.0', commit: 'abc1234', pocketbase: '0.40.6', builtAt: '2026-11-06T10:00:00.000Z' }) } });
    const reg = rt.loadHooks();
    reg.bootstrap[0]({ next() {} });
    const get = () => reg.routes.find((r) => r.path === '/api/crm/build').handler(requestEvent({ auth: authUser(rt.app) })).body;
    const info = get();
    assert.match(info.started_at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual({ ...info, started_at: '' }, { version: '1.2.0', commit: 'abc1234', edition: 'web', pocketbase: '0.40.6', built_at: '2026-11-06T10:00:00.000Z', started_at: '' });
    for (const raw of [undefined, 'not json', 'null', JSON.stringify({ version: 7, commit: 1, edition: [], pocketbase: {}, builtAt: 0 })]) {
      const r2 = createRuntime({ files: raw === undefined ? {} : { [buildJson]: raw } });
      const info2 = r2.lib().buildInfo();
      assert.deepEqual(info2, { version: 'dev', commit: '', edition: '', pocketbase: '', built_at: '', started_at: '' });
    }
    const r3 = createRuntime();
    r3.app.store = () => { throw new Error('no store'); };
    assert.doesNotThrow(() => r3.lib().markStarted());
    assert.strictEqual(r3.lib().buildInfo().started_at, '');
  });

  test('leads: search, enrich, convert', () => {
    const { route, rt } = boot({ GOOGLE_PLACES_API_KEY: 'k' }, [
      { match: /searchText/, reply: () => ({ json: { places: [{ id: 'p1', displayName: { text: 'Bar' }, formattedAddress: 'A, Escazú, Costa Rica' }] } }) },
      { match: /\/v1\/places\/p1/, reply: () => ({ json: { internationalPhoneNumber: '+506 2222', websiteUri: 'https://bar.cr' } }) },
    ]);
    const me = authUser(rt.app);
    assert.throws(() => route('POST', '/api/crm/leads/search').handler(requestEvent({ auth: me, body: { query: ' ab ' } })), /Query too short/);
    assert.throws(() => route('POST', '/api/crm/leads/search').handler(requestEvent({ auth: me, body: null })), /Query too short/);
    const s = route('POST', '/api/crm/leads/search').handler(requestEvent({ auth: me, body: { query: 'bar en Escazú', pageToken: null } }));
    assert.strictEqual(s.body.created, 1);
    const leadId = rt.app.rows('leads')[0].id;
    const en = route('POST', '/api/crm/leads/{id}/enrich').handler(requestEvent({ auth: me, pathValues: { id: leadId } }));
    assert.deepEqual(en.body, { phone: '+506 2222', website: 'https://bar.cr' });
    const cv = route('POST', '/api/crm/leads/{id}/convert').handler(requestEvent({ auth: me, pathValues: { id: leadId } }));
    assert.strictEqual(cv.body.existing, false);
    assert.strictEqual(rt.app.rows('accounts')[0].phone, '+506 2222');
    const rt2 = boot({ GOOGLE_PLACES_API_KEY: 'k' }, [{ match: /\/v1\/places\//, reply: () => ({ json: {} }) }]);
    const lead = new Record(rt2.rt.app.findCollectionByNameOrId('leads'), { place_id: 'p2' });
    rt2.rt.app.save(lead);
    assert.deepEqual(rt2.route('POST', '/api/crm/leads/{id}/enrich').handler(requestEvent({ auth: authUser(rt2.rt.app), pathValues: { id: lead.id } })).body, { phone: '', website: '' });
  });

  test('google: auth url, callback outcomes, disconnect, sync', () => {
    const env = { GOOGLE_CLIENT_ID: 'cid', GMAIL_BASE_URL: 'http://g', GOOGLE_TOKEN_URL: 'http://t' };
    const { route, rt, crm } = boot(env, [
      { method: 'POST', match: 'http://t', reply: () => ({ json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }) },
      { match: 'http://g/gmail/v1/users/me/profile', reply: () => ({ json: { emailAddress: 'me@x.cr' } }) },
    ]);
    const me = authUser(rt.app);
    const url = new URL(route('GET', '/api/crm/google/auth-url').handler(requestEvent({ auth: me })).body.url);
    const cb = route('GET', '/api/crm/google/callback').handler;
    assert.strictEqual(cb(requestEvent({ query: { error: 'access_denied' } })).redirect, '/#/settings?google=access_denied');
    assert.match(cb(requestEvent({ query: { code: 'C', state: 'bad' } })).redirect, /^\/#\/settings\?google=Invalid%20or%20expired/);
    crm.googleAuthUrl('u');
    const ok = cb(requestEvent({ query: { code: 'C', state: crm.kvGet('google:oauth_state', {}).state } }));
    assert.strictEqual(ok.redirect, '/#/settings?google=connected');
    assert.ok(url.searchParams.get('state'));
    // the initial sync fails (contacts exist, no messages route) and is logged, not fatal
    rt.app.save(new Record(rt.app.findCollectionByNameOrId('contacts'), { email: 'a@bar.cr', account: 'x' }));
    crm.googleAuthUrl('u');
    const ok2 = cb(requestEvent({ query: { code: 'C', state: crm.kvGet('google:oauth_state', {}).state } }));
    assert.strictEqual(ok2.redirect, '/#/settings?google=connected');
    assert.strictEqual(JSON.parse(rt.stdout.find((l) => l.includes('initial gmail sync failed'))).level, 'ERROR');
    assert.throws(() => route('POST', '/api/crm/sync/gmail').handler(requestEvent({ auth: me })), /Could not reach/);
    assert.deepEqual(route('POST', '/api/crm/google/disconnect').handler(requestEvent({ auth: me })).body, { ok: true });
    assert.strictEqual(crm.kvGet('google:tokens', null), null);
    assert.deepEqual(route('POST', '/api/crm/sync/gmail').handler(requestEvent({ auth: me })).body, { skipped: 'gmail not connected' });
    const plainErr = boot(env);
    plainErr.crm.kvSet('google:oauth_state', { state: 's', exp: Date.now() + 1e5 });
    const r = plainErr.route('GET', '/api/crm/google/callback').handler(requestEvent({ query: { code: 'C', state: 's' } }));
    assert.match(r.redirect, /google=Could%20not%20reach/);
  });

  test('pos: customers and sync', () => {
    const { route, rt } = boot({ LOYVERSE_ACCESS_TOKEN: 't' }, [{ match: /customers/, reply: () => ({ json: { customers: [{ id: 'C1', name: 'Bar' }] } }) }]);
    const me = authUser(rt.app);
    assert.strictEqual(route('GET', '/api/crm/pos/customers').handler(requestEvent({ auth: me, query: { q: 'bar' } })).body[0].id, 'C1');
    assert.deepEqual(route('POST', '/api/crm/sync/pos').handler(requestEvent({ auth: me })).body, { updated: 0, note: 'no accounts linked to Loyverse customers' });
  });
});

describe('record hooks', () => {
  test('touches: defaults, user stamp, side effects (errors logged)', () => {
    const { rt, recordHook } = boot();
    const t = new Record(rt.app.findCollectionByNameOrId('touches'), {});
    recordHook('onRecordCreate', 'touches')[0](requestEvent({ record: t }));
    assert.strictEqual(t.get('source'), 'manual');
    assert.ok(t.get('occurred_at'));
    const t2 = new Record(rt.app.findCollectionByNameOrId('touches'), { source: 'gmail', occurred_at: 'x' });
    recordHook('onRecordCreate', 'touches')[0](requestEvent({ record: t2 }));
    assert.deepEqual([t2.get('source'), t2.get('occurred_at')], ['gmail', 'x']);

    const me = authUser(rt.app);
    const stamp = recordHook('onRecordCreateRequest', 'touches')[0];
    const t3 = new Record(rt.app.findCollectionByNameOrId('touches'), {});
    stamp(requestEvent({ auth: me, record: t3 }));
    assert.strictEqual(t3.get('user'), me.id);
    const t4 = new Record(rt.app.findCollectionByNameOrId('touches'), { user: 'other' });
    stamp(requestEvent({ auth: me, record: t4 }));
    stamp(requestEvent({ auth: null, record: t4 }));
    assert.strictEqual(t4.get('user'), 'other');

    const after = recordHook('onRecordAfterCreateSuccess', 'touches')[0];
    const acc = new Record(rt.app.findCollectionByNameOrId('accounts'), { name: 'Bar' });
    rt.app.save(acc);
    const e = requestEvent({ record: new Record(rt.app.findCollectionByNameOrId('touches'), { account: acc.id, type: 'visit', occurred_at: new Date().toISOString() }), app: rt.app });
    after(e);
    assert.ok(rt.app.rows('accounts')[0].last_touch_at);
    after(requestEvent({ record: new Record(rt.app.findCollectionByNameOrId('touches'), { account: 'missing' }), app: rt.app }));
    assert.match(rt.stdout.at(-1), /touch side-effects failed/);
  });

  test('deals: default stage and stage_changed_at only when the stage changes', () => {
    const { rt, recordHook } = boot();
    const d = new Record(rt.app.findCollectionByNameOrId('deals'), {});
    recordHook('onRecordCreate', 'deals')[0](requestEvent({ record: d }));
    assert.strictEqual(d.get('stage'), 'prospect');
    const d2 = new Record(rt.app.findCollectionByNameOrId('deals'), { stage: 'proposal' });
    recordHook('onRecordCreate', 'deals')[0](requestEvent({ record: d2 }));
    assert.strictEqual(d2.get('stage'), 'proposal');
    rt.app.save(d2);
    const upd = recordHook('onRecordUpdate', 'deals')[0];
    const same = rt.app.findRecordById('deals', d2.id);
    same.set('stage_changed_at', 'KEEP');
    upd(requestEvent({ record: same }));
    assert.strictEqual(same.get('stage_changed_at'), 'KEEP');
    const moved = rt.app.findRecordById('deals', d2.id);
    moved.set('stage', 'lost');
    upd(requestEvent({ record: moved }));
    assert.notStrictEqual(moved.get('stage_changed_at'), d2.get('stage_changed_at'));
  });

  test('accounts: relinking POS resets backfill; owner stamp for accounts and deals', () => {
    const { rt, recordHook } = boot();
    const a = new Record(rt.app.findCollectionByNameOrId('accounts'), { pos_customer_id: 'C1', pos_backfilled: true });
    rt.app.save(a);
    const upd = recordHook('onRecordUpdate', 'accounts')[0];
    const same = rt.app.findRecordById('accounts', a.id);
    upd(requestEvent({ record: same }));
    assert.strictEqual(same.get('pos_backfilled'), true);
    const relinked = rt.app.findRecordById('accounts', a.id);
    relinked.set('pos_customer_id', 'C2');
    upd(requestEvent({ record: relinked }));
    assert.strictEqual(relinked.get('pos_backfilled'), false);

    const owner = recordHook('onRecordCreateRequest', 'accounts')[0];
    assert.strictEqual(recordHook('onRecordCreateRequest', 'deals')[0], owner);
    const me = authUser(rt.app);
    const n = new Record(rt.app.findCollectionByNameOrId('accounts'), {});
    owner(requestEvent({ auth: me, record: n }));
    assert.strictEqual(n.get('owner'), me.id);
    const kept = new Record(rt.app.findCollectionByNameOrId('accounts'), { owner: 'x' });
    owner(requestEvent({ auth: me, record: kept }));
    owner(requestEvent({ record: kept }));
    assert.strictEqual(kept.get('owner'), 'x');
  });
});

describe('cron jobs', () => {
  test('log results as INFO and failures as ERROR', () => {
    const { rt, reg } = boot({ LOYVERSE_ACCESS_TOKEN: 't' });
    rt.app.save(new Record(rt.app.findCollectionByNameOrId('accounts'), { pos_customer_id: 'C1' }));
    for (const c of reg.cron) c.fn();
    const lines = rt.stdout.map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.level, l.message]), [['INFO', 'gmail sync'], ['ERROR', 'loyverse sync failed'], ['INFO', 'dormant sweep']]);
    assert.deepEqual(lines[0].detail, { skipped: 'gmail not connected' });
    rt.app.findRecordsByFilter = () => { throw new Error('db locked'); };
    reg.cron[2].fn();
    assert.deepEqual(JSON.parse(rt.stdout.at(-1)).detail, 'db locked');
    reg.cron[0].fn();
    assert.strictEqual(JSON.parse(rt.stdout.at(-1)).message, 'gmail sync');
    rt.lib().kvSet('google:tokens', { access_token: 'AT', expires_at: Date.now() + 1e6 });
    reg.cron[0].fn();
    assert.strictEqual(JSON.parse(rt.stdout.at(-1)).message, 'gmail sync failed');
  });
});
