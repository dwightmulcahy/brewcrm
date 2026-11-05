import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRuntime, Record } from './pbfake.mjs';

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const env = { LOYVERSE_ACCESS_TOKEN: 'tok', LOYVERSE_BASE_URL: 'http://loy/v1.0/' };

function save(rt, col, data) {
  const r = new Record(rt.app.findCollectionByNameOrId(col), data);
  rt.app.save(r);
  return r;
}

describe('Loyverse customers', () => {
  test('pages, filters by any field, maps fields, caps at 50', () => {
    const rt = createRuntime({ env, routes: [{ match: 'http://loy/v1.0/customers', reply: (cfg) => {
      const cursor = new URL(cfg.url).searchParams.get('cursor');
      if (!cursor) return { json: { customers: [{ id: 'C1', name: 'Bar La Esquina', email: 'o@bar.cr', phone_number: '+506 8888', customer_code: 'B01', total_visits: 3, last_visit: '2026-10-01' }], cursor: 'c2' } };
      return { json: { customers: [{ id: 'C2', email: 'ana@x.cr' }, { id: 'C3', customer_code: 'Z9' }, { id: 'C4' }] } };
    } }] });
    const crm = rt.lib();
    assert.deepEqual(crm.loyverseCustomers('esquina'), [{ id: 'C1', label: 'Bar La Esquina', email: 'o@bar.cr', phone: '+506 8888', code: 'B01', total_visits: 3, last_visit: '2026-10-01' }]);
    assert.strictEqual(rt.httpCalls[0].headers.Authorization, 'Bearer tok');
    assert.doesNotMatch(rt.httpCalls[0].url, /cursor=/, 'empty params are dropped');
    const all = crm.loyverseCustomers('');
    assert.deepEqual(all.map((c) => c.label), ['Bar La Esquina', 'ana@x.cr', 'Z9', 'C4']);
    assert.deepEqual(crm.loyverseCustomers('8888').map((c) => c.id), ['C1']);
    assert.deepEqual(crm.loyverseCustomers(null).length, 4);

    const many = createRuntime({ env, routes: [{ match: /customers/, reply: () => ({ json: { customers: Array.from({ length: 60 }, (_, i) => ({ id: 'X' + i, name: 'n' + i })), cursor: 'more' } }) }] });
    assert.strictEqual(many.lib().loyverseCustomers('').length, 50);
    assert.strictEqual(many.httpCalls.length, 1, 'stops paging once 50 are found');
  });

  test('retries 429 with backoff, explains 401/402/other errors and network failures', () => {
    const flaky = createRuntime({ env, routes: [{ match: /customers/, reply: (_c, n) => (n < 3 ? { status: 429 } : { json: { customers: [] } }) }] });
    assert.deepEqual(flaky.lib().loyverseCustomers(''), []);
    assert.deepEqual(flaky.sleeps, [5000, 10000]);
    const limited = createRuntime({ env, routes: [{ match: /customers/, reply: () => ({ status: 429 }) }] });
    assert.throws(() => limited.lib().loyverseCustomers(''), /Loyverse rate limit/);
    assert.strictEqual(limited.httpCalls.length, 4);
    for (const [status, re] of [[401, /rejected the access token \(401\)/], [402, /subscription\/Integrations add-on \(402\)/], [500, /Loyverse \/customers -> 500: oops/]]) {
      const rt = createRuntime({ env, routes: [{ match: /customers/, reply: () => ({ status, body: 'oops' }) }] });
      assert.throws(() => rt.lib().loyverseCustomers(''), re);
    }
    assert.throws(() => createRuntime({ env }).lib().loyverseCustomers(''), /Could not reach Loyverse: dial tcp/);
    assert.throws(() => createRuntime().lib().loyverseCustomers(''), /LOYVERSE_ACCESS_TOKEN is not set/);
    const empty = createRuntime({ env, routes: [{ match: /customers/, reply: () => ({}) }] });
    assert.deepEqual(empty.lib().loyverseCustomers(''), []);
  });
});

describe('Loyverse sync', () => {
  test('skips when not configured or nothing is linked', () => {
    assert.deepEqual(createRuntime().lib().loyverseSync(), { skipped: 'loyverse not configured' });
    assert.deepEqual(createRuntime({ env }).lib().loyverseSync(), { updated: 0, note: 'no accounts linked to Loyverse customers' });
  });

  test('backfills, nets refunds, removes cancelled receipts, moves stages, then syncs incrementally', () => {
    let receipts = [
      { receipt_number: '1-1', receipt_type: 'SALE', customer_id: 'C1', receipt_date: iso(40 * DAY), total_money: 30000, line_items: [{ quantity: 1, item_name: 'Keg IPA', variant_name: '20L' }, { quantity: 2, item_name: 'Cans' }] },
      { receipt_number: '1-2', receipt_type: 'SALE', customer_id: 'C1', receipt_date: iso(10 * DAY), total_money: 45000.555 },
      { receipt_number: '1-3', receipt_type: 'REFUND', customer_id: 'C1', created_at: iso(9 * DAY), total_money: 5000 },
      { receipt_number: '1-4', receipt_type: 'SALE', customer_id: 'OTHER', receipt_date: iso(DAY), total_money: 1 },
      { receipt_number: '1-5', receipt_type: 'SALE', customer_id: null, receipt_date: iso(DAY), total_money: 1 },
      { receipt_number: '1-6', receipt_type: 'SALE', customer_id: 'C1', receipt_date: iso(DAY), total_money: 'x', cancelled_at: iso(0) },
    ];
    const queries = [];
    const rt = createRuntime({ env, routes: [{ match: /\/receipts/, reply: (cfg) => {
      const q = new URL(cfg.url).searchParams;
      queries.push({ from: q.get('updated_at_min'), cursor: q.get('cursor') });
      return q.get('cursor') ? { json: { receipts: receipts.slice(3) } } : { json: { receipts: receipts.slice(0, 3), cursor: 'P2' } };
    } }] });
    const crm = rt.lib();
    const acc = save(rt, 'accounts', { name: 'Bar', pos_customer_id: 'C1', pos_backfilled: false });
    save(rt, 'accounts', { name: 'Unlinked', pos_customer_id: '' });
    const deal = save(rt, 'deals', { account: acc.id, stage: 'proposal' });
    save(rt, 'deals', { account: acc.id, stage: 'lost' });

    const r1 = crm.loyverseSync();
    assert.deepEqual(r1, { updated: 1, created: 3, updatedTouches: 0, removed: 0, scanned: 6, pages: 2, backfill: true });
    const lookbackDays = Math.round((Date.now() - Date.parse(queries[0].from)) / DAY);
    assert.strictEqual(lookbackDays, 365);
    const a = rt.app.rows('accounts')[0];
    assert.deepEqual([a.order_count, a.order_total, a.pos_backfilled], [2, 70000.56, true]);
    assert.ok(a.last_order_at.startsWith(iso(10 * DAY).slice(0, 10)));
    const t = Object.fromEntries(rt.app.rows('touches').map((x) => [x.external_id, x]));
    assert.strictEqual(t['loyverse:1-1'].summary, 'Loyverse receipt #1-1: 1× Keg IPA (20L), 2× Cans');
    assert.deepEqual([t['loyverse:1-3'].summary, t['loyverse:1-3'].amount], ['Refund #1-3', -5000]);
    assert.strictEqual(rt.app.rows('deals').find((d) => d.id === deal.id).stage, 'recurring');
    assert.strictEqual(rt.app.rows('deals').find((d) => d.stage === 'lost').stage, 'lost');

    // 1-2 gets cancelled and 1-1 edited: incremental sync from the watermark (1 h overlap)
    receipts = [{ ...receipts[1], cancelled_at: iso(0) }, { ...receipts[0], total_money: 31000 }, { receipt_number: '9-9', customer_id: 'C1', cancelled_at: iso(0) }];
    const r2 = crm.loyverseSync();
    assert.deepEqual([r2.removed, r2.updatedTouches, r2.created, r2.backfill], [1, 1, 0, false]);
    const overlapMin = (Date.parse(crm.kvGet('loyverse:watermark', '')) - Date.parse(queries.at(-2).from)) / 60000;
    assert.ok(overlapMin >= 60 && overlapMin < 61, 'incremental window overlaps the last run by an hour');
    const a2 = rt.app.rows('accounts')[0];
    assert.deepEqual([a2.order_count, a2.order_total], [1, 26000]);
    assert.strictEqual(rt.app.rows('deals').find((d) => d.id === deal.id).stage, 'recurring', 'no demotion from 2 to 1 order');
    assert.ok(crm.kvGet('loyverse:last_sync', 0) > 0);
  });

  test('stage automation: first order, dormant after DORMANT_DAYS, revive on new order', () => {
    const run = (receipts, stage, dealEnv = {}) => {
      const rt = createRuntime({ env: { ...env, ...dealEnv }, routes: [{ match: /receipts/, reply: () => ({ json: { receipts } }) }] });
      const acc = save(rt, 'accounts', { pos_customer_id: 'C1' });
      const d = save(rt, 'deals', { account: acc.id, stage });
      rt.lib().loyverseSync();
      return rt.app.rows('deals').find((x) => x.id === d.id);
    };
    const sale = (n, daysAgo) => ({ receipt_number: n, customer_id: 'C1', receipt_date: iso(daysAgo * DAY), total_money: 100 });
    assert.strictEqual(run([sale('a', 5)], 'contacted').stage, 'first_order');
    assert.strictEqual(run([sale('a', 60)], 'sampling').stage, 'dormant');
    assert.strictEqual(run([sale('a', 60), sale('b', 50)], 'first_order').stage, 'dormant');
    assert.strictEqual(run([sale('a', 3)], 'dormant').stage, 'recurring');
    assert.strictEqual(run([sale('a', 20)], 'first_order', { DORMANT_DAYS: '10' }).stage, 'dormant');
    assert.strictEqual(run([], 'prospect').stage, 'prospect');
    const d = run([sale('a', 5)], 'contacted');
    assert.ok(d.stage_changed_at);
  });

  test('stops after 400 pages and tolerates empty responses', () => {
    const rt = createRuntime({ env, routes: [{ match: /receipts/, reply: () => ({ json: { cursor: 'again' } }) }] });
    save(rt, 'accounts', { pos_customer_id: 'C1', pos_backfilled: true });
    rt.lib().kvSet('loyverse:watermark', iso(DAY));
    const r = rt.lib().loyverseSync();
    assert.deepEqual([r.pages, r.backfill], [400, false]);
    const rt2 = createRuntime({ env, routes: [{ match: /receipts/, reply: () => ({}) }] });
    save(rt2, 'accounts', { pos_customer_id: 'C1' });
    assert.strictEqual(rt2.lib().loyverseSync().scanned, 0);
  });
});

describe('dormant sweep', () => {
  test('moves only stale first-order/recurring deals', () => {
    const rt = createRuntime({ env: { DORMANT_DAYS: '45' } });
    const stale = save(rt, 'accounts', { last_order_at: iso(60 * DAY) });
    const fresh = save(rt, 'accounts', { last_order_at: iso(5 * DAY) });
    const never = save(rt, 'accounts', {});
    const d1 = save(rt, 'deals', { account: stale.id, stage: 'recurring' });
    const d2 = save(rt, 'deals', { account: stale.id, stage: 'first_order' });
    const d3 = save(rt, 'deals', { account: stale.id, stage: 'proposal' });
    const d4 = save(rt, 'deals', { account: fresh.id, stage: 'recurring' });
    const d5 = save(rt, 'deals', { account: never.id, stage: 'recurring' });
    assert.deepEqual(rt.lib().dormantSweep(), { dormant: 2 });
    const st = (d) => rt.app.rows('deals').find((x) => x.id === d.id).stage;
    assert.deepEqual([st(d1), st(d2), st(d3), st(d4), st(d5)], ['dormant', 'dormant', 'proposal', 'recurring', 'recurring']);
  });
});

describe('activity side effects', () => {
  const setup = () => {
    const rt = createRuntime();
    const acc = save(rt, 'accounts', { name: 'Bar', last_touch_at: iso(5 * DAY) });
    return { rt, crm: rt.lib(), acc };
  };
  const touch = (rt, data) => new Record(rt.app.findCollectionByNameOrId('touches'), data);

  test('outbound visit moves prospect -> contacted, sets follow-ups and last touch', () => {
    const { rt, crm, acc } = setup();
    const d = save(rt, 'deals', { account: acc.id, stage: 'prospect' });
    crm.onTouchCreated(rt.app, touch(rt, { account: acc.id, type: 'visit', direction: 'out', occurred_at: iso(0), next_followup_at: '2026-12-01 15:00:00.000Z', source: 'manual' }));
    const a = rt.app.rows('accounts')[0], dd = rt.app.rows('deals').find((x) => x.id === d.id);
    assert.strictEqual(a.next_followup_at, '2026-12-01 15:00:00.000Z');
    assert.ok(a.last_touch_at > iso(DAY).replace('T', ' '));
    assert.deepEqual([dd.stage, dd.next_followup_at], ['contacted', '2026-12-01 15:00:00.000Z']);
  });

  test('tasting jumps to sampling; inbound does not mark contacted; order type does not set last touch', () => {
    const { rt, crm, acc } = setup();
    const d = save(rt, 'deals', { account: acc.id, stage: 'prospect' });
    crm.onTouchCreated(rt.app, touch(rt, { account: acc.id, type: 'call', direction: 'in', occurred_at: iso(0) }));
    assert.strictEqual(rt.app.rows('deals')[0].stage, 'prospect');
    const before = rt.app.rows('accounts')[0].last_touch_at;
    crm.onTouchCreated(rt.app, touch(rt, { account: acc.id, type: 'order', direction: 'in', occurred_at: iso(-DAY), deal: d.id }));
    assert.strictEqual(rt.app.rows('accounts')[0].last_touch_at, before, 'a newer order must not count as a sales touch');
    crm.onTouchCreated(rt.app, touch(rt, { account: acc.id, type: 'tasting', direction: 'out', occurred_at: iso(6 * DAY), deal: d.id }));
    assert.strictEqual(rt.app.rows('deals')[0].stage, 'sampling');
  });

  test('older activity keeps the newer last-touch date; Loyverse orders never nudge stages; missing deal is ignored', () => {
    const { rt, crm, acc } = setup();
    save(rt, 'deals', { account: acc.id, stage: 'prospect' });
    const saves = rt.app.log.saves;
    crm.onTouchCreated(rt.app, touch(rt, { account: acc.id, type: 'visit', occurred_at: iso(30 * DAY), source: 'loyverse' }));
    assert.strictEqual(rt.app.log.saves, saves, 'nothing to save');
    assert.strictEqual(rt.app.rows('deals')[0].stage, 'prospect');
    crm.onTouchCreated(rt.app, touch(rt, { account: acc.id, type: 'visit', occurred_at: '', deal: 'gone' }));
    assert.strictEqual(rt.app.rows('deals')[0].stage, 'prospect');
    const fresh = save(rt, 'accounts', { name: 'New' });
    crm.onTouchCreated(rt.app, touch(rt, { account: fresh.id, type: 'email', occurred_at: 'not a date' }));
    assert.strictEqual(rt.app.rows('accounts').find((x) => x.id === fresh.id).last_touch_at, undefined);
  });
});
