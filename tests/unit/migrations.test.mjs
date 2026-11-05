import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './pbfake.mjs';

// Minimal stand-ins for PocketBase's migration API (Collection, fields, migrate)
class Fields {
  constructor(list = []) { this.list = list.map((f) => ({ ...f })); }
  getByName(n) { return this.list.find((f) => f.name === n); }
  add(f) { this.list.push(f); }
  removeByName(n) { this.list = this.list.filter((f) => f.name !== n); }
}
class Collection {
  constructor(cfg) {
    Object.assign(this, { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, indexes: [] }, cfg);
    this.fields = new Fields(cfg.fields || []);
    this.id = this.id || 'pbc_' + cfg.name;
  }
}
class BoolField { constructor(cfg) { Object.assign(this, { type: 'bool' }, cfg); } }

function makeApp() {
  const cols = new Map();
  const users = new Collection({ name: 'users', type: 'auth', createRule: '', fields: [{ name: 'password', type: 'password', min: 8 }, { name: 'email', type: 'email' }] });
  users.resetPasswordTemplate = { subject: 'Reset your {APP_NAME} password', body: '{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}' };
  cols.set('users', users);
  return {
    cols,
    findCollectionByNameOrId(n) { const c = cols.get(n); if (!c) throw new Error('missing ' + n); return c; },
    save(c) { cols.set(c.name, c); },
    delete(c) { if (!cols.has(c.name)) throw new Error('missing'); cols.delete(c.name); },
  };
}

function loadMigration(file) {
  const steps = {};
  const ctx = vm.createContext({ Collection, BoolField, migrate: (up, down) => { steps.up = up; steps.down = down; } });
  const abs = path.join(ROOT, 'pb_migrations', file);
  vm.compileFunction(fs.readFileSync(abs, 'utf8'), [], { filename: abs, parsingContext: ctx })();
  return steps;
}

const CRM = ['accounts', 'contacts', 'deals', 'touches', 'leads'];
const rules = (c) => [c.listRule, c.viewRule, c.createRule, c.updateRule, c.deleteRule];

describe('migrations', () => {
  test('init: CRM collections need auth, kv is superuser-only, public sign-up closed; down removes them', () => {
    const app = makeApp();
    const m = loadMigration('1730700000_init_crm.js');
    m.up(app);
    assert.strictEqual(app.cols.get('users').createRule, null);
    for (const n of CRM) assert.deepEqual(rules(app.cols.get(n)), Array(5).fill("@request.auth.id != ''"), n);
    assert.deepEqual(rules(app.cols.get('kv')), Array(5).fill(null));
    const deals = app.cols.get('deals');
    assert.deepEqual(deals.fields.getByName('stage').values, ['prospect', 'contacted', 'sampling', 'proposal', 'first_order', 'recurring', 'dormant', 'lost']);
    assert.ok(app.cols.get('touches').indexes.some((i) => /UNIQUE INDEX idx_touches_ext/.test(i)));
    assert.strictEqual(app.cols.get('contacts').fields.getByName('account').cascadeDelete, true);
    m.down(app);
    assert.deepEqual([...app.cols.keys()], ['users']);
    assert.strictEqual(app.cols.get('users').createRule, '');
    assert.doesNotThrow(() => m.down(app), 'down is safe to re-run');
  });

  test('password policy: flag field, 12-char minimum, BrewCRM reset link, CRM locked until changed; down restores', () => {
    const app = makeApp();
    loadMigration('1730700000_init_crm.js').up(app);
    const m = loadMigration('1730800000_password_policy.js');
    m.up(app);
    const users = app.cols.get('users');
    assert.strictEqual(users.fields.getByName('must_change_password').type, 'bool');
    assert.strictEqual(users.fields.getByName('password').min, 12);
    assert.match(users.resetPasswordTemplate.body, /\{APP_URL\}\/#\/reset\/\{TOKEN\}/);
    assert.strictEqual(users.resetPasswordTemplate.subject, 'Reset your BrewCRM password');
    for (const n of CRM) assert.deepEqual(rules(app.cols.get(n)), Array(5).fill("@request.auth.id != '' && @request.auth.must_change_password = false"), n);
    m.up(app);
    assert.strictEqual(users.fields.list.filter((f) => f.name === 'must_change_password').length, 1, 'up is idempotent');
    m.down(app);
    assert.strictEqual(users.fields.getByName('must_change_password'), undefined);
    assert.strictEqual(users.fields.getByName('password').min, 8);
    for (const n of CRM) assert.deepEqual(rules(app.cols.get(n)), Array(5).fill("@request.auth.id != ''"), n);
  });
});
