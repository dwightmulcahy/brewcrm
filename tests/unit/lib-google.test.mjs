import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRuntime, Record, BadRequestError } from './pbfake.mjs';

const place = (id, extra = {}) => ({
  id, displayName: { text: 'Bar ' + id }, formattedAddress: `Calle 5, Escazú, San José Province, Costa Rica`,
  location: { latitude: 9.9, longitude: -84.1 }, primaryType: 'bar', types: ['bar', 'point_of_interest'],
  googleMapsUri: 'https://maps.google.com/?cid=' + id, businessStatus: 'OPERATIONAL', ...extra,
});

describe('Places lead search', () => {
  test('creates leads, skips closed/known places, sends Pro-only field mask, pages', () => {
    const rt = createRuntime({
      env: { GOOGLE_PLACES_API_KEY: 'k', PLACES_BASE_URL: 'http://mock' },
      routes: [{ method: 'POST', match: 'http://mock/v1/places:searchText', reply: (cfg) => {
        const b = JSON.parse(cfg.body);
        if (b.pageToken === 'P2') return { json: { places: [place('p4', { displayName: null, formattedAddress: '', location: null, primaryType: '', types: null, googleMapsUri: '' })] } };
        return { json: { places: [place('p1'), place('p2', { businessStatus: 'CLOSED_PERMANENTLY' }), place('p3')], nextPageToken: 'P2' } };
      } }],
    });
    const crm = rt.lib();
    rt.app.save(new Record(rt.app.findCollectionByNameOrId('accounts'), { name: 'Known', google_place_id: 'p3' }));
    const r1 = crm.placesSearch('bar en Escazú', '', 'u1');
    assert.strictEqual(r1.created, 1);
    assert.strictEqual(r1.skipped, 2);
    assert.strictEqual(r1.nextPageToken, 'P2');
    const call = rt.httpCalls[0];
    assert.strictEqual(call.headers['X-Goog-Api-Key'], 'k');
    assert.doesNotMatch(call.headers['X-Goog-FieldMask'], /phone|website/i);
    assert.deepEqual(JSON.parse(call.body), { textQuery: 'bar en Escazú', regionCode: 'CR', languageCode: 'es', pageSize: 20 });
    const lead = rt.app.rows('leads')[0];
    assert.deepEqual([lead.name, lead.area, lead.primary_type, lead.types, lead.status, lead.query], ['Bar p1', 'Escazú', 'bar', 'bar,point_of_interest', 'new', 'bar en Escazú']);

    const again = crm.placesSearch('bar en Escazú', '', 'u1');
    assert.deepEqual([again.created, again.skipped], [0, 3], 'existing leads are skipped');
    const r2 = crm.placesSearch('bar en Escazú', 'P2', 'u1');
    assert.strictEqual(r2.created, 1);
    assert.strictEqual(r2.nextPageToken, '');
    assert.strictEqual(JSON.parse(rt.httpCalls[2].body).pageToken, 'P2');
    const bare = rt.app.rows('leads').find((l) => l.place_id === 'p4');
    assert.deepEqual([bare.name, bare.area, bare.types, bare.lat], ['(no name)', '', '', undefined]);
    assert.strictEqual(crm.status().places.search_used, 3);
  });

  test('requires a key, enforces the monthly cap, reports HTTP errors', () => {
    assert.throws(() => createRuntime().lib().placesSearch('bar', '', 'u'), /GOOGLE_PLACES_API_KEY is not set/);
    assert.throws(() => createRuntime().lib().placeDetails('p'), /GOOGLE_PLACES_API_KEY is not set/);
    const rt = createRuntime({ env: { GOOGLE_PLACES_API_KEY: 'k', PLACES_SEARCH_MONTHLY_LIMIT: '1' }, routes: [
      { match: /searchText/, reply: (cfg, n) => (n === 1 ? { status: 403, body: 'API key not valid' } : { json: {} }) },
    ] });
    const crm = rt.lib();
    assert.throws(() => crm.placesSearch('bar', '', 'u'), (e) => e instanceof BadRequestError && /POST https:\/\/places.googleapis.com\/v1\/places:searchText -> 403: API key not valid/.test(e.message));
    assert.throws(() => crm.placesSearch('bar', '', 'u'), /Monthly places_search limit reached \(1\/1\)/);
    const rt2 = createRuntime({ env: { GOOGLE_PLACES_API_KEY: 'k' }, routes: [{ match: /searchText/, reply: () => ({ json: null }) }] });
    assert.deepEqual(rt2.lib().placesSearch('bar', '', 'u'), { created: 0, skipped: 0, nextPageToken: '', ids: [] });
    const rt3 = createRuntime({ env: { GOOGLE_PLACES_API_KEY: 'k' } });
    assert.throws(() => rt3.lib().placesSearch('bar', '', 'u'), /Could not reach https:\/\/places.googleapis.com\/v1\/places:searchText: dial tcp/);
  });

  test('place details uses the Enterprise mask and its own cap', () => {
    const rt = createRuntime({ env: { GOOGLE_PLACES_API_KEY: 'k', PLACES_DETAILS_MONTHLY_LIMIT: '1' }, routes: [
      { match: /\/v1\/places\/ChIJ%2Fx/, reply: () => ({ json: { nationalPhoneNumber: '2222-3333' } }) },
    ] });
    const crm = rt.lib();
    assert.deepEqual(crm.placeDetails('ChIJ/x'), { nationalPhoneNumber: '2222-3333' });
    assert.match(rt.httpCalls[0].headers['X-Goog-FieldMask'], /nationalPhoneNumber/);
    assert.throws(() => crm.placeDetails('ChIJ/x'), /places_details limit/);
    const rt2 = createRuntime({ env: { GOOGLE_PLACES_API_KEY: 'k' }, routes: [{ match: /places/, reply: () => ({}) }] });
    assert.deepEqual(rt2.lib().placeDetails('x'), {});
  });

  test('address and type helpers', () => {
    const { areaFromAddress, typeFromPlace } = createRuntime().lib();
    assert.strictEqual(areaFromAddress(''), '');
    assert.strictEqual(areaFromAddress('Av 2, Heredia, Provincia de Heredia, 40101, Costa Rica'), 'Heredia');
    assert.strictEqual(areaFromAddress('Playa, Tamarindo, Costa Rica'), 'Playa');
    assert.strictEqual(areaFromAddress('Tamarindo'), 'Tamarindo');
    assert.strictEqual(areaFromAddress('Costa Rica'), '');
    const cases = [['bar', '', 'bar'], ['', 'lodging', 'hotel'], ['coffee_shop', '', 'cafe'], ['', 'grocery_store', 'supermarket'],
      ['liquor_store', '', 'bar'.replace('bar', 'retail')], ['restaurant', '', 'restaurant'], ['event_venue', '', 'event'], ['gym', 'gym', 'other']];
    for (const [p, t, want] of cases) assert.strictEqual(typeFromPlace(p, t), want, `${p}/${t}`);
  });
});

describe('convert lead', () => {
  test('creates account + prospect deal once, then returns the existing account', () => {
    const rt = createRuntime();
    const crm = rt.lib();
    const lead = new Record(rt.app.findCollectionByNameOrId('leads'), { name: 'Pub Roble', primary_type: 'pub', types: 'bar', area: 'Heredia', place_id: 'pX', lat: 9, lng: -84, status: 'new' });
    rt.app.save(lead);
    const r = crm.convertLead(lead.id, 'u1');
    assert.strictEqual(r.existing, false);
    const acc = rt.app.rows('accounts')[0];
    assert.deepEqual([acc.name, acc.type, acc.google_place_id, acc.owner, acc.lat], ['Pub Roble', 'bar', 'pX', 'u1', 9]);
    const deal = rt.app.rows('deals')[0];
    assert.deepEqual([deal.account, deal.stage, deal.owner], [acc.id, 'prospect', 'u1']);
    assert.deepEqual([rt.app.rows('leads')[0].status, rt.app.rows('leads')[0].account], ['converted', acc.id]);
    assert.deepEqual(crm.convertLead(lead.id, 'u1'), { account: acc.id, existing: true });
    const l2 = new Record(rt.app.findCollectionByNameOrId('leads'), { name: 'No owner', status: 'new' });
    rt.app.save(l2);
    crm.convertLead(l2.id, '');
    assert.strictEqual(rt.app.rows('accounts')[1].owner, undefined);
  });
});

// ---------------------------------------------------------------- Gmail
const gmailEnv = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', APP_URL: 'https://crm.x/', GMAIL_BASE_URL: 'http://g', GOOGLE_TOKEN_URL: 'http://t/token' };

function gmailRuntime(extraRoutes = [], env = {}) {
  const tokenCalls = [];
  const rt = createRuntime({ env: { ...gmailEnv, ...env }, routes: [
    ...extraRoutes,
    { method: 'POST', match: 'http://t/token', reply: (cfg) => {
      const f = new URLSearchParams(cfg.body);
      tokenCalls.push(Object.fromEntries(f));
      if (f.get('grant_type') === 'authorization_code') return { json: { access_token: 'AT1', refresh_token: f.get('code') === 'NOREFRESH' ? undefined : 'RT1', expires_in: 3600 } };
      return { json: { access_token: 'AT2', expires_in: 3600 } };
    } },
    { match: 'http://g/gmail/v1/users/me/profile', reply: () => ({ json: { emailAddress: 'Brewer@Example.com' } }) },
  ] });
  return { rt, crm: rt.lib(), tokenCalls };
}

describe('Gmail OAuth', () => {
  test('auth URL carries a one-time state; callback stores tokens', () => {
    const { rt, crm, tokenCalls } = gmailRuntime();
    const url = new URL(crm.googleAuthUrl('u1'));
    assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    assert.deepEqual([p.get('client_id'), p.get('redirect_uri'), p.get('scope'), p.get('access_type'), p.get('prompt')],
      ['cid', 'https://crm.x/api/crm/google/callback', 'https://www.googleapis.com/auth/gmail.readonly', 'offline', 'consent']);
    assert.strictEqual(p.get('state').length, 40);
    assert.throws(() => crm.googleCallback('CODE', 'wrong'), /Invalid or expired OAuth state/);
    const url2 = new URL(crm.googleAuthUrl('u1'));
    crm.googleCallback('CODE', url2.searchParams.get('state'));
    assert.strictEqual(tokenCalls[0].code, 'CODE');
    assert.strictEqual(tokenCalls[0].redirect_uri, 'https://crm.x/api/crm/google/callback');
    const t = crm.kvGet('google:tokens', null);
    assert.deepEqual([t.refresh_token, t.access_token, t.email], ['RT1', 'AT1', 'brewer@example.com']);
    assert.ok(t.expires_at > Date.now());
    assert.strictEqual(crm.kvGet('google:oauth_state', null), null, 'state is single-use');
    assert.throws(() => crm.googleCallback('CODE', url2.searchParams.get('state')), /Invalid or expired/);
    assert.ok(rt.httpCalls.some((c) => c.headers.Authorization === 'Bearer AT1'));
  });

  test('expired state, missing client id, and missing refresh token', () => {
    const { crm } = gmailRuntime();
    crm.kvSet('google:oauth_state', { state: 's', exp: Date.now() - 1 });
    assert.throws(() => crm.googleCallback('CODE', 's'), /Invalid or expired/);
    crm.kvSet('google:oauth_state', { state: 's', exp: Date.now() + 10000 });
    assert.throws(() => crm.googleCallback('NOREFRESH', 's'), /did not return a refresh token/);
    assert.throws(() => createRuntime().lib().googleAuthUrl('u'), /GOOGLE_CLIENT_ID is not set/);
  });
});

describe('Gmail sync', () => {
  const contact = (rt, email, account = 'acc1') => {
    const c = new Record(rt.app.findCollectionByNameOrId('contacts'), { name: 'C', email, account });
    rt.app.save(c);
    return c;
  };

  test('skips when not connected or no contacts have email', () => {
    const { crm, rt } = gmailRuntime();
    assert.deepEqual(crm.gmailSync(), { skipped: 'gmail not connected' });
    crm.kvSet('google:tokens', { refresh_token: 'RT', access_token: 'AT', expires_at: Date.now() + 1e6, email: 'me@x.cr' });
    contact(rt, '');
    assert.deepEqual(crm.gmailSync(), { created: 0, note: 'no contacts with email' });
  });

  test('logs inbound and outbound mail with contacts, dedupes, pages, refreshes the token', () => {
    const headers = {
      m1: [['From', 'Brewer <brewer@example.com>'], ['To', 'Owner <OWNER@bar.cr>'], ['Subject', 'Samples']],
      m2: [['From', 'owner@bar.cr'], ['To', 'brewer@example.com']],
      m3: [['From', 'spam@x.com'], ['To', 'brewer@example.com'], ['Subject', 'nope']],
      m4: [['From', 'brewer@example.com'], ['To', 'nobody@x.cr'], ['Cc', 'chef@bar.cr'], ['Subject', 'cc only']],
    };
    const lists = [];
    const { crm, rt, tokenCalls } = gmailRuntime([
      { match: (c) => c.url.startsWith('http://g/gmail/v1/users/me/messages?'), reply: (cfg) => {
        const q = new URL(cfg.url).searchParams;
        lists.push({ q: q.get('q'), pageToken: q.get('pageToken') });
        return q.get('pageToken') ? { json: { messages: [{ id: 'm4' }] } } : { json: { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], nextPageToken: 'NP' } };
      } },
      { match: /\/messages\/m\d/, reply: (cfg) => {
        const id = cfg.url.match(/messages\/(m\d)/)[1];
        const msg = { id, threadId: 't' + id, internalDate: String(Date.UTC(2026, 10, 1, 12)), payload: { headers: headers[id].map(([name, value]) => ({ name, value })) } };
        if (id === 'm1') msg.snippet = 'x'.repeat(250);
        if (id === 'm4') delete msg.payload;
        return { json: id === 'm4' ? { ...msg, payload: { headers: headers.m4.map(([name, value]) => ({ name, value })) } } : msg };
      } },
    ]);
    crm.kvSet('google:tokens', { refresh_token: 'RT', access_token: 'OLD', expires_at: Date.now() - 1, email: 'brewer@example.com' });
    contact(rt, 'Owner@Bar.cr', 'accA');
    contact(rt, 'chef@bar.cr', 'accA');
    const r = crm.gmailSync();
    assert.deepEqual(r, { created: 3, seen: 4 });
    assert.strictEqual(tokenCalls[0].grant_type, 'refresh_token');
    assert.strictEqual(crm.kvGet('google:tokens', null).access_token, 'AT2');
    assert.match(lists[0].q, /^after:\d+ \{from:owner@bar.cr to:owner@bar.cr cc:owner@bar.cr from:chef@bar.cr/);
    assert.strictEqual(lists[1].pageToken, 'NP');
    const touches = rt.app.rows('touches');
    const by = Object.fromEntries(touches.map((t) => [t.external_id, t]));
    assert.deepEqual([by['gmail:m1'].direction, by['gmail:m2'].direction, by['gmail:m4'].direction], ['out', 'in', 'out']);
    assert.strictEqual(by['gmail:m1'].summary, 'Samples — ' + 'x'.repeat(200));
    assert.strictEqual(by['gmail:m2'].summary, '(no subject)');
    assert.strictEqual(by['gmail:m1'].link, 'https://mail.google.com/mail/u/0/#all/tm1');
    assert.strictEqual(by['gmail:m1'].occurred_at, '2026-11-01 12:00:00.000Z');
    assert.strictEqual(by['gmail:m1'].account, 'accA');
    assert.ok(crm.kvGet('gmail:last_sync', 0) > 0);

    const again = crm.gmailSync();
    assert.deepEqual(again, { created: 0, seen: 4 }, 'already-logged messages are skipped');
    assert.match(lists.at(-1).q, /^after:\d+/);
  });

  test('chunks long contact lists 15 addresses per query', () => {
    let queries = 0;
    const { crm, rt } = gmailRuntime([{ match: (c) => c.url.includes('/messages?'), reply: () => { queries++; return { json: {} }; } }]);
    crm.kvSet('google:tokens', { access_token: 'AT', expires_at: Date.now() + 1e6, email: 'me@x.cr' });
    for (let i = 0; i < 31; i++) contact(rt, `c${i}@bar.cr`);
    assert.deepEqual(crm.gmailSync(), { created: 0, seen: 0 });
    assert.strictEqual(queries, 3);
  });

  test('handles a message with no payload headers', () => {
    const { crm, rt } = gmailRuntime([
      { match: (c) => c.url.includes('/messages?'), reply: () => ({ json: { messages: [{ id: 'm9' }] } }) },
      { match: /messages\/m9/, reply: () => ({ json: { id: 'm9', internalDate: '0' } }) },
    ]);
    crm.kvSet('google:tokens', { access_token: 'AT', expires_at: Date.now() + 1e6, email: 'me@x.cr' });
    contact(rt, 'a@bar.cr');
    assert.deepEqual(crm.gmailSync(), { created: 0, seen: 1 });
  });
});
