// Fake Google Places, Google OAuth token endpoint, Gmail and Loyverse APIs for e2e tests.
import http from 'node:http';

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const place = (id, name, types, extra = {}) => ({
  id, displayName: { text: name }, formattedAddress: `Calle ${id}, Escazú, San José Province, Costa Rica`,
  location: { latitude: 9.91, longitude: -84.14 }, primaryType: types[0], types, googleMapsUri: `https://maps.google.com/?cid=${id}`,
  businessStatus: 'OPERATIONAL', ...extra,
});

const gmailHeaders = {
  m1: [['From', 'Brewer <brewer@example.com>'], ['To', 'owner@esquina.cr'], ['Subject', 'Samples for your taps']],
  m2: [['From', 'owner@esquina.cr'], ['To', 'brewer@example.com'], ['Subject', 'Re: Samples']],
};

export function startMockServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = (status, obj) => {
      const b = obj === undefined ? '' : JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(b);
    };
    const p = url.pathname;

    if (req.method === 'POST' && p === '/v1/places:searchText') {
      const q = JSON.parse(body || '{}');
      if (q.pageToken === 'P2') return send(200, { places: [place('e2e-p4', 'Licorera Sol', ['liquor_store'])] });
      return send(200, {
        places: [
          place('e2e-p1', 'Bar Escazú Uno', ['bar', 'point_of_interest']),
          place('e2e-p2', 'Pub Cerrado', ['bar'], { businessStatus: 'CLOSED_PERMANENTLY' }),
          place('e2e-p3', 'Hotel Montaña', ['hotel', 'lodging']),
        ],
        nextPageToken: 'P2',
      });
    }
    if (req.method === 'GET' && p.startsWith('/v1/places/')) {
      return send(200, p.endsWith('e2e-p1') ? { nationalPhoneNumber: '2222-3333', websiteUri: 'https://baruno.cr' } : {});
    }
    if (req.method === 'POST' && p === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') return send(200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
      return send(200, { access_token: 'AT2', expires_in: 3600 });
    }
    if (p === '/gmail/v1/users/me/profile') return send(200, { emailAddress: 'brewer@example.com' });
    if (p === '/gmail/v1/users/me/messages') {
      return send(200, (url.searchParams.get('q') || '').includes('owner@esquina.cr') ? { messages: [{ id: 'm1' }, { id: 'm2' }] } : {});
    }
    const m = p.match(/^\/gmail\/v1\/users\/me\/messages\/(m\d)$/);
    if (m) {
      return send(200, {
        id: m[1], threadId: 't' + m[1], internalDate: String(Date.now() - 3600000), snippet: 'See you Thursday',
        payload: { headers: gmailHeaders[m[1]].map(([name, value]) => ({ name, value })) },
      });
    }
    if (p === '/v1.0/customers') {
      return send(200, { customers: [
        { id: 'LC1', name: 'Bar La Esquina', email: 'owner@esquina.cr', phone_number: '+506 8888 1234', customer_code: 'B01', total_visits: 4 },
        { id: 'LC2', name: 'Ana Mora' },
      ] });
    }
    if (p === '/v1.0/receipts') {
      return send(200, { receipts: [
        { receipt_number: '1-1001', receipt_type: 'SALE', customer_id: 'LC1', receipt_date: iso(40 * DAY), total_money: 30000, line_items: [{ quantity: 1, item_name: 'Keg IPA', variant_name: '20L' }] },
        { receipt_number: '1-1002', receipt_type: 'SALE', customer_id: 'LC1', receipt_date: iso(5 * DAY), total_money: 45000 },
        { receipt_number: '1-1003', receipt_type: 'SALE', customer_id: 'OTHER', receipt_date: iso(DAY), total_money: 1000 },
      ] });
    }
    send(404, { error: `mock: no route for ${req.method} ${p}` });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
