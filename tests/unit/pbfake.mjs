// In-memory stand-in for the PocketBase JSVM runtime, so pb_hooks/*.js can run under
// Node with c8 coverage. It implements only what BrewCRM's hooks use:
//   $app (records, settings, transactions), $http, $os, $security, $dbx, Record,
//   BadRequestError / ForbiddenError / ValidationError, toString, sleep,
//   and the hook registrars (routerAdd, routerUse, onBootstrap, onRecord*, cronAdd).
// The filter evaluator supports the subset of PocketBase filter syntax the code uses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const HOOKS = path.join(ROOT, 'pb_hooks');

// ---------------------------------------------------------------- errors
class ApiError extends Error {
  constructor(status, message, data) {
    super(message || '');
    this.status = status;
    this.data = data || {};
  }
}
export class BadRequestError extends ApiError { constructor(m, d) { super(400, m, d); } }
export class ForbiddenError extends ApiError { constructor(m, d) { super(403, m, d); } }
export class ValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class NotFound extends Error { constructor(m) { super(m || 'sql: no rows in result set'); } }

// ---------------------------------------------------------------- records
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const pbDate = (v) => (typeof v === 'string' && ISO_DT.test(v) ? v.replace('T', ' ') : v);
let seq = 0;
const newId = () => 'r' + String(++seq).padStart(14, '0');

export class Record {
  constructor(collection, data = {}) {
    this._col = collection;
    this._d = { ...data };
    this.id = data.id || '';
    this._orig = null;
  }
  collection() { return this._col; }
  get(k) { return this._d[k]; }
  set(k, v) { this._d[k] = v; if (k === 'id') this.id = v; }
  getString(k) { const v = this._d[k]; return v === undefined || v === null ? '' : String(v); }
  getBool(k) { return !!this._d[k]; }
  getFloat(k) { const n = Number(this._d[k]); return Number.isFinite(n) ? n : 0; }
  email() { return this.getString('email'); }
  setEmail(v) { this._d.email = v; }
  setPassword(v) { this._d.password = v; }
  setVerified(v) { this._d.verified = !!v; }
  original() { return this._orig || new Record(this._col, {}); }
  // test helper
  data() { return { ...this._d, id: this.id }; }
}

// ---------------------------------------------------------------- filter evaluator
function tokenize(src) {
  const re = /\s*(\|\||&&|!=|>=|<=|=|>|<|~|\(|\)|\{:\w+\}|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[\w.@]+)/gy;
  const out = [];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) out.push(m[1]);
  if (src.slice(re.lastIndex).trim()) throw new Error('filter syntax: ' + src);
  return out;
}

export function compileFilter(src, params = {}) {
  if (!src || !src.trim()) return () => true;
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const take = () => t[i++];
  const value = (tok) => {
    if (tok.startsWith("'") || tok.startsWith('"')) return { lit: tok.slice(1, -1) };
    if (tok.startsWith('{:')) return { lit: params[tok.slice(2, -1)] };
    if (/^-?\d+(\.\d+)?$/.test(tok)) return { lit: Number(tok) };
    if (tok === 'true' || tok === 'false') return { lit: tok === 'true' };
    if (tok === 'null') return { lit: '' };
    return { field: tok };
  };
  const primary = () => {
    if (peek() === '(') { take(); const e = or(); if (take() !== ')') throw new Error('missing )'); return e; }
    const left = value(take());
    const op = take();
    const right = value(take());
    return { op, left, right };
  };
  const and = () => { let e = primary(); while (peek() === '&&') { take(); e = { op: '&&', a: e, b: primary() }; } return e; };
  const or = () => { let e = and(); while (peek() === '||') { take(); e = { op: '||', a: e, b: and() }; } return e; };
  const ast = or();
  if (i !== t.length) throw new Error('filter trailing tokens: ' + src);
  return (rec, resolve) => evalNode(ast, rec, resolve);
}

function evalNode(n, rec, resolve) {
  if (n.op === '&&') return evalNode(n.a, rec, resolve) && evalNode(n.b, rec, resolve);
  if (n.op === '||') return evalNode(n.a, rec, resolve) || evalNode(n.b, rec, resolve);
  const get = (side) => (side.field ? resolve(rec, side.field) : side.lit);
  let a = get(n.left), b = get(n.right);
  const norm = (v) => (v === undefined || v === null ? '' : typeof v === 'boolean' ? v : pbDate(v));
  a = norm(a); b = norm(b);
  if (typeof a === 'number' || typeof b === 'number') { a = Number(a || 0); b = Number(b || 0); }
  switch (n.op) {
    case '=': return a === b || String(a) === String(b);
    case '!=': return !(a === b || String(a) === String(b));
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '~': return String(a).toLowerCase().includes(String(b).toLowerCase());
    default: throw new Error('op ' + n.op);
  }
}

// ---------------------------------------------------------------- app
export function createApp() {
  const tables = new Map();
  const collections = new Map();
  const relations = { account: 'accounts', contact: 'contacts', deal: 'deals' };
  const settings = {
    meta: { appURL: 'http://localhost:8090', appName: 'Acme', senderAddress: '', senderName: '' },
    smtp: { enabled: false, host: '', port: 0, username: '', password: '', tls: false },
    rateLimits: { enabled: false, rules: [{ label: '*:auth', maxRequests: 2, duration: 3 }] },
    _isSettings: true,
  };
  const log = { saves: 0, deletes: 0 };
  const failSave = new Set();
  const storeMap = new Map();
  const store = { get: (k) => storeMap.get(k), set: (k, v) => { storeMap.set(k, v); } };

  const col = (name) => {
    if (!collections.has(name)) throw new NotFound(`collection ${name} not found`);
    return collections.get(name);
  };
  const rows = (name) => { col(name); return tables.get(name); };
  const clone = (c, row) => {
    const r = new Record(c, row);
    r._orig = new Record(c, row);
    return r;
  };
  const resolve = (rec, field) => {
    const parts = field.split('.');
    let cur = rec;
    for (let k = 0; k < parts.length; k++) {
      const v = cur.getString ? cur.get(parts[k]) : undefined;
      if (k === parts.length - 1) return v;
      const target = relations[parts[k]];
      const found = target && rows(target).find((r) => r.id === v);
      if (!found) return '';
      cur = new Record(col(target), found);
    }
    return undefined;
  };
  const sortRows = (list, sort) => {
    if (!sort) return list;
    const desc = sort.startsWith('-');
    const key = sort.replace(/^[-+]/, '');
    return [...list].sort((x, y) => {
      const a = String(x[key] ?? ''), b = String(y[key] ?? '');
      return desc ? b.localeCompare(a) : a.localeCompare(b);
    });
  };

  const app = {
    defineCollection(name, opts = {}) {
      const c = { name, id: 'pbc_' + name, ...opts };
      collections.set(name, c);
      tables.set(name, []);
      return c;
    },
    failNextSave(name) { failSave.add(name); },
    rows,
    log,
    settings() { return settings; },
    store() { return store; },
    findCollectionByNameOrId(name) { return col(name); },
    save(model) {
      if (model && model._isSettings) { log.settingsSaves = (log.settingsSaves || 0) + 1; return; }
      const c = model.collection();
      if (failSave.has(c.name)) { failSave.delete(c.name); throw new Error(`save failed for ${c.name}`); }
      const list = rows(c.name);
      const now = new Date().toISOString().replace('T', ' ');
      if (!model.id) model.set('id', newId());
      const data = {};
      for (const [k, v] of Object.entries(model._d)) data[k] = pbDate(v);
      data.id = model.id;
      for (const u of c.unique || []) {
        if (data[u] && list.some((r) => r.id !== model.id && r[u] === data[u])) throw new Error(`UNIQUE constraint failed: ${c.name}.${u}`);
      }
      const idx = list.findIndex((r) => r.id === model.id);
      if (idx >= 0) { list[idx] = { ...list[idx], ...data, updated: now }; }
      else list.push({ created: now, updated: now, ...data });
      Object.assign(model._d, data);
      model._orig = new Record(c, { ...data });
      log.saves++;
    },
    delete(model) {
      const list = rows(model.collection().name);
      const idx = list.findIndex((r) => r.id === model.id);
      if (idx < 0) throw new NotFound();
      list.splice(idx, 1);
      log.deletes++;
    },
    findRecordById(name, id) {
      const row = rows(name).find((r) => r.id === id);
      if (!row) throw new NotFound();
      return clone(col(name), row);
    },
    findFirstRecordByData(name, field, value) {
      const row = rows(name).find((r) => r[field] === value);
      if (!row) throw new NotFound();
      return clone(col(name), row);
    },
    findAuthRecordByEmail(name, email) {
      const row = rows(name).find((r) => String(r.email || '').toLowerCase() === String(email).toLowerCase());
      if (!row) throw new NotFound();
      return clone(col(name), row);
    },
    countRecords(name, exp) {
      const list = rows(name);
      if (!exp) return list.length;
      return list.filter((r) => Object.entries(exp.hash).every(([k, v]) => r[k] === v)).length;
    },
    findRecordsByFilter(name, filter, sort, limit, offset, params) {
      const c = col(name);
      const pred = compileFilter(filter, params || {});
      const matched = sortRows(rows(name), sort).filter((row) => pred(new Record(c, row), resolve));
      return matched.slice(offset || 0, (offset || 0) + (limit || matched.length)).map((row) => clone(c, row));
    },
    runInTransaction(fn) { fn(app); },
  };
  return app;
}

// Schema mirrors pb_migrations (only what the hooks touch)
export function defineSchema(app) {
  app.defineCollection('users', { auth: true });
  app.defineCollection('accounts');
  app.defineCollection('contacts');
  app.defineCollection('deals');
  app.defineCollection('touches', { unique: ['external_id'] });
  app.defineCollection('leads', { unique: ['place_id'] });
  app.defineCollection('kv', { unique: ['key'] });
  return app;
}

// ---------------------------------------------------------------- runtime
export function createRuntime({ env = {}, routes = [], stdoutIsFile = false, files = {} } = {}) {
  const app = defineSchema(createApp());
  const stdout = [];
  const consoleLines = [];
  const httpCalls = [];
  const sleeps = [];
  const registry = { routes: [], middlewares: [], bootstrap: [], record: [], cron: [] };

  // HTTP: first matching route wins; route = {method?, match: RegExp|string|fn, reply(cfg, n) -> {status, json, body} | throw}
  const http = {
    send(cfg) {
      const method = (cfg.method || 'GET').toUpperCase();
      httpCalls.push({ ...cfg, method });
      const r = routes.find((x) => (!x.method || x.method === method) &&
        (typeof x.match === 'function' ? x.match(cfg) : x.match instanceof RegExp ? x.match.test(cfg.url) : cfg.url.startsWith(x.match)));
      if (!r) throw new Error('dial tcp: no route for ' + method + ' ' + cfg.url);
      r.calls = (r.calls || 0) + 1;
      const res = r.reply(cfg, r.calls) || {};
      const status = res.status ?? 200;
      const body = res.body ?? (res.json !== undefined ? JSON.stringify(res.json) : '');
      return { statusCode: status, json: res.json, body };
    },
  };

  const g = {
    $app: app,
    $http: http,
    $os: {
      getenv: (k) => (env[k] === undefined ? '' : String(env[k])),
      stat: (p) => {
        if (p !== '/dev/stdout') throw new Error('stat ' + p);
        if (stdoutIsFile === 'throw') throw new Error('no stat');
        return { mode: () => ({ isRegular: () => stdoutIsFile === true }) };
      },
      readFile: (p) => {
        const key = Object.keys(files).find((f) => path.resolve(p) === path.resolve(f));
        if (key === undefined) throw new Error('open ' + p + ': no such file');
        return files[key];
      },
      writeFile: (p, data) => { if (p !== '/dev/stdout') throw new Error('writeFile ' + p); stdout.push(String(data)); },
    },
    $security: {
      randomString: (n) => crypto.randomBytes(n).toString('base64url').slice(0, n),
      sha256: (s) => crypto.createHash('sha256').update(String(s)).digest('hex'),
    },
    $dbx: { hashExp: (obj) => ({ hash: obj }) },
    $apis: { requireAuth: () => ({ requireAuth: true }) },
    Record,
    BadRequestError,
    ForbiddenError,
    ValidationError,
    toString: (b, max) => String(b ?? '').slice(0, max ?? undefined),
    sleep: (ms) => { sleeps.push(ms); },
    console: { log: (...a) => consoleLines.push(a.join(' ')) },
    routerAdd: (method, p, handler, ...mw) => registry.routes.push({ method, path: p, handler, mw }),
    routerUse: (fn) => registry.middlewares.push(fn),
    onBootstrap: (fn) => registry.bootstrap.push(fn),
    cronAdd: (name, spec, fn) => registry.cron.push({ name, spec, fn }),
  };
  for (const hook of ['onRecordCreate', 'onRecordUpdate', 'onRecordCreateRequest', 'onRecordUpdateRequest',
    'onRecordAfterCreateSuccess', 'onRecordConfirmPasswordResetRequest']) {
    g[hook] = (fn, ...cols) => registry.record.push({ hook, fn, cols });
  }

  const ctx = vm.createContext({ ...g, Date, JSON, Math, Number, String, Object, Array, RegExp, Error, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat });
  const cache = new Map();
  const load = (file) => {
    const abs = path.resolve(file);
    if (cache.has(abs)) return cache.get(abs).exports;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const fn = vm.compileFunction(fs.readFileSync(abs, 'utf8'), ['module', 'exports', 'require', '__hooks'], { filename: abs, parsingContext: ctx });
    fn(mod, mod.exports, load, HOOKS);
    return mod.exports;
  };
  ctx.require = load;
  ctx.__hooks = HOOKS;

  const lib = () => load(path.join(HOOKS, 'lib', 'crm.js'));
  const loadHooks = () => { load(path.join(HOOKS, 'crm.pb.js')); return registry; };
  return { app, env, stdout, consoleLines, httpCalls, sleeps, registry, lib, loadHooks, ctx };
}

// ---------------------------------------------------------------- request events
export function requestEvent({ auth = null, body = {}, pathValues = {}, query = {}, superuser = false,
  path: urlPath = '/', method = 'GET', headers = {}, ip = '203.0.113.7', status = 0, record = null, app = null } = {}) {
  const res = { status: 0, body: undefined, redirect: undefined };
  return {
    auth,
    record,
    app,
    res,
    request: {
      method,
      pathValue: (k) => pathValues[k] ?? '',
      url: { path: urlPath, query: () => ({ get: (k) => query[k] ?? '' }) },
      header: { get: (k) => headers[k] ?? '' },
    },
    requestInfo: () => ({ body }),
    hasSuperuserAuth: () => superuser,
    realIP: () => ip,
    status: () => status || res.status,
    json(s, obj) { res.status = s; res.body = obj; return res; },
    redirect(s, url) { res.status = s; res.redirect = url; return res; },
    nextCalls: 0,
    next() { this.nextCalls++; },
  };
}

export function authUser(app, data = {}) {
  const r = new Record(app.findCollectionByNameOrId('users'), { email: 'rep@example.com', must_change_password: false, ...data });
  app.save(r);
  return r;
}
