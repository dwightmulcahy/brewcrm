// Shared helpers for BrewCRM hooks.
// NOTE: PocketBase runs each hook handler in an isolated VM, so handlers must
// `require(`${__hooks}/lib/crm.js`)` instead of using top-level functions.

const env = (k, d) => {
  const v = $os.getenv(k);
  return v === "" || v === undefined || v === null ? d : v;
};

// Base URLs (overridable only for testing against mocks)
const placesBase = () => env("PLACES_BASE_URL", "https://places.googleapis.com");
const gmailBase = () => env("GMAIL_BASE_URL", "https://gmail.googleapis.com");
const tokenUrl = () => env("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token");

const nowIso = () => new Date().toISOString();
const monthKey = () => new Date().toISOString().slice(0, 7); // YYYY-MM

// PocketBase date strings look like "2026-11-04 12:00:00.000Z"
const parseDate = (s) => {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------- kv store
function kvGet(key, def) {
  try {
    const r = $app.findFirstRecordByData("kv", "key", key);
    const raw = r.getString("value");
    return raw === "" ? def : JSON.parse(raw);
  } catch (_) {
    return def;
  }
}

function kvSet(key, value) {
  let r;
  try {
    r = $app.findFirstRecordByData("kv", "key", key);
  } catch (_) {
    r = new Record($app.findCollectionByNameOrId("kv"));
    r.set("key", key);
  }
  r.set("value", JSON.stringify(value));
  $app.save(r);
}

function kvDel(key) {
  try { $app.delete($app.findFirstRecordByData("kv", "key", key)); } catch (_) {}
}

// ------------------------------------------------------------- usage caps
function usage(kind) {
  return kvGet(`usage:${kind}:${monthKey()}`, 0);
}

function consume(kind, limit) {
  const used = usage(kind);
  if (used >= limit) {
    throw new BadRequestError(`Monthly ${kind} limit reached (${used}/${limit}). Raise the limit in .env if needed.`);
  }
  kvSet(`usage:${kind}:${monthKey()}`, used + 1);
}

const limits = () => ({
  places_search: parseInt(env("PLACES_SEARCH_MONTHLY_LIMIT", "4500"), 10),
  places_details: parseInt(env("PLACES_DETAILS_MONTHLY_LIMIT", "900"), 10),
});

// ------------------------------------------------------------ HTTP helper
function http(cfg) {
  let res;
  try {
    res = $http.send(Object.assign({ timeout: 30 }, cfg));
  } catch (err) {
    throw new BadRequestError(`Could not reach ${cfg.url.split("?")[0]}: ${String(err.message || err).slice(0, 300)}`);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = toString(res.body, 2000);
    throw new BadRequestError(`${cfg.method || "GET"} ${cfg.url.split("?")[0]} -> ${res.statusCode}: ${msg}`);
  }
  return res.json;
}

const form = (obj) =>
  Object.keys(obj).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])).join("&");

// ------------------------------------------------------------ Places API
function areaFromAddress(addr) {
  if (!addr) return "";
  const parts = addr.split(",").map((s) => s.trim()).filter((s) => s && !/^costa rica$/i.test(s) && !/^\d+$/.test(s));
  // Typical CR address: "..., Escazú, San José Province, Costa Rica"
  const prov = parts.findIndex((p) => /province|provincia/i.test(p));
  if (prov > 0) return parts[prov - 1];
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "";
}

function placesSearch(query, pageToken, userId) {
  const key = env("GOOGLE_PLACES_API_KEY", "");
  if (!key) throw new BadRequestError("GOOGLE_PLACES_API_KEY is not set.");
  consume("places_search", limits().places_search);

  const body = {
    textQuery: query,
    regionCode: env("PLACES_REGION", "CR"),
    languageCode: env("PLACES_LANGUAGE", "es"),
    pageSize: 20,
  };
  if (pageToken) body.pageToken = pageToken;

  const data = http({
    method: "POST",
    url: placesBase() + "/v1/places:searchText",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      // Pro-tier fields only (phone/website are Enterprise -> fetched on demand via enrich)
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.googleMapsUri,places.businessStatus,nextPageToken",
    },
    body: JSON.stringify(body),
  }) || {};

  const leadsCol = $app.findCollectionByNameOrId("leads");
  let created = 0, skipped = 0;
  const items = [];
  for (const p of data.places || []) {
    if (p.businessStatus === "CLOSED_PERMANENTLY") { skipped++; continue; }
    const exists =
      $app.countRecords("leads", $dbx.hashExp({ place_id: p.id })) > 0 ||
      $app.countRecords("accounts", $dbx.hashExp({ google_place_id: p.id })) > 0;
    if (exists) { skipped++; continue; }
    const r = new Record(leadsCol);
    r.set("name", (p.displayName && p.displayName.text) || "(no name)");
    r.set("address", p.formattedAddress || "");
    r.set("area", areaFromAddress(p.formattedAddress || ""));
    if (p.location) { r.set("lat", p.location.latitude); r.set("lng", p.location.longitude); }
    r.set("primary_type", p.primaryType || "");
    r.set("types", (p.types || []).join(","));
    r.set("place_id", p.id);
    r.set("maps_url", p.googleMapsUri || "");
    r.set("query", query);
    r.set("status", "new");
    $app.save(r);
    created++;
    items.push(r.id);
  }
  return { created, skipped, nextPageToken: data.nextPageToken || "", ids: items };
}

function placeDetails(placeId) {
  const key = env("GOOGLE_PLACES_API_KEY", "");
  if (!key) throw new BadRequestError("GOOGLE_PLACES_API_KEY is not set.");
  consume("places_details", limits().places_details);
  return http({
    url: placesBase() + "/v1/places/" + encodeURIComponent(placeId),
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "nationalPhoneNumber,internationalPhoneNumber,websiteUri",
    },
  }) || {};
}

const typeFromPlace = (primary, types) => {
  const t = (primary + "," + types).toLowerCase();
  if (/bar|pub|night_club|brewery|brewpub|wine_bar/.test(t)) return "bar";
  if (/hotel|lodging|resort|hostel|inn/.test(t)) return "hotel";
  if (/cafe|coffee/.test(t)) return "cafe";
  if (/supermarket|grocery/.test(t)) return "supermarket";
  if (/liquor|store|market|shop/.test(t)) return "retail";
  if (/restaurant|food/.test(t)) return "restaurant";
  if (/event|venue/.test(t)) return "event";
  return "other";
};

function convertLead(leadId, userId) {
  const lead = $app.findRecordById("leads", leadId);
  if (lead.getString("status") === "converted" && lead.getString("account")) {
    return { account: lead.getString("account"), existing: true };
  }
  let accountId = "";
  $app.runInTransaction((tx) => {
    const acc = new Record(tx.findCollectionByNameOrId("accounts"));
    acc.set("name", lead.getString("name"));
    acc.set("type", typeFromPlace(lead.getString("primary_type"), lead.getString("types")));
    acc.set("area", lead.getString("area"));
    acc.set("address", lead.getString("address"));
    acc.set("phone", lead.getString("phone"));
    acc.set("website", lead.getString("website"));
    acc.set("lat", lead.getFloat("lat"));
    acc.set("lng", lead.getFloat("lng"));
    acc.set("google_place_id", lead.getString("place_id"));
    acc.set("maps_url", lead.getString("maps_url"));
    if (userId) acc.set("owner", userId);
    tx.save(acc);

    const deal = new Record(tx.findCollectionByNameOrId("deals"));
    deal.set("account", acc.id);
    deal.set("title", "Draft placement");
    deal.set("stage", "prospect");
    deal.set("stage_changed_at", nowIso());
    if (userId) deal.set("owner", userId);
    tx.save(deal);

    const l = tx.findRecordById("leads", leadId);
    l.set("status", "converted");
    l.set("account", acc.id);
    tx.save(l);
    accountId = acc.id;
  });
  return { account: accountId, existing: false };
}

// ------------------------------------------------------------ Google OAuth / Gmail
const appUrl = () => env("APP_URL", "http://localhost:8080").replace(/\/+$/, "");
const googleRedirect = () => appUrl() + "/api/crm/google/callback";

function googleAuthUrl(userId) {
  const clientId = env("GOOGLE_CLIENT_ID", "");
  if (!clientId) throw new BadRequestError("GOOGLE_CLIENT_ID is not set.");
  const state = $security.randomString(40);
  kvSet("google:oauth_state", { state, user: userId, exp: Date.now() + 10 * 60 * 1000 });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + form({
    client_id: clientId,
    redirect_uri: googleRedirect(),
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
}

function googleCallback(code, state) {
  const saved = kvGet("google:oauth_state", null);
  kvDel("google:oauth_state");
  if (!saved || saved.state !== state || Date.now() > saved.exp) {
    throw new BadRequestError("Invalid or expired OAuth state. Start the connection again.");
  }
  const tok = http({
    method: "POST",
    url: tokenUrl(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      code,
      client_id: env("GOOGLE_CLIENT_ID", ""),
      client_secret: env("GOOGLE_CLIENT_SECRET", ""),
      redirect_uri: googleRedirect(),
      grant_type: "authorization_code",
    }),
  });
  if (!tok.refresh_token) throw new BadRequestError("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and retry.");
  const profile = http({
    url: gmailBase() + "/gmail/v1/users/me/profile",
    headers: { Authorization: "Bearer " + tok.access_token },
  });
  kvSet("google:tokens", {
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    expires_at: Date.now() + (tok.expires_in - 60) * 1000,
    email: (profile.emailAddress || "").toLowerCase(),
  });
}

function googleAccessToken() {
  const t = kvGet("google:tokens", null);
  if (!t) return null;
  if (t.access_token && Date.now() < t.expires_at) return t;
  const tok = http({
    method: "POST",
    url: tokenUrl(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      client_id: env("GOOGLE_CLIENT_ID", ""),
      client_secret: env("GOOGLE_CLIENT_SECRET", ""),
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  t.access_token = tok.access_token;
  t.expires_at = Date.now() + (tok.expires_in - 60) * 1000;
  kvSet("google:tokens", t);
  return t;
}

const extractEmails = (s) => (String(s || "").toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/g) || []);

function gmailSync() {
  const t = googleAccessToken();
  if (!t) return { skipped: "gmail not connected" };

  // contact email -> {contact, account}
  const map = {};
  const contacts = $app.findRecordsByFilter("contacts", "email != ''", "", 2000, 0);
  for (const c of contacts) {
    for (const em of extractEmails(c.getString("email"))) {
      map[em] = { contact: c.id, account: c.getString("account") };
    }
  }
  const emails = Object.keys(map);
  if (!emails.length) return { created: 0, note: "no contacts with email" };

  const lookbackDays = parseInt(env("GMAIL_LOOKBACK_DAYS", "30"), 10);
  const last = kvGet("gmail:last_sync", 0);
  const afterSec = Math.floor((last ? last - 3600 * 1000 : Date.now() - lookbackDays * 86400000) / 1000);
  const startedAt = Date.now();
  const auth = { Authorization: "Bearer " + t.access_token };
  const touchesCol = $app.findCollectionByNameOrId("touches");
  let created = 0, seen = 0;

  for (let i = 0; i < emails.length; i += 15) {
    const chunk = emails.slice(i, i + 15);
    const q = `after:${afterSec} {${chunk.map((e) => `from:${e} to:${e} cc:${e}`).join(" ")}}`;
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
      const list = http({
        url: gmailBase() + "/gmail/v1/users/me/messages?" +
          form(Object.assign({ q, maxResults: 100 }, pageToken ? { pageToken } : {})),
        headers: auth,
      });
      for (const m of list.messages || []) {
        seen++;
        const ext = "gmail:" + m.id;
        if ($app.countRecords("touches", $dbx.hashExp({ external_id: ext })) > 0) continue;
        const msg = http({
          url: `${gmailBase()}/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`,
          headers: auth,
        });
        const h = {};
        for (const x of (msg.payload && msg.payload.headers) || []) h[x.name.toLowerCase()] = x.value;
        const from = extractEmails(h.from)[0] || "";
        const outbound = from === t.email;
        const candidates = outbound ? extractEmails((h.to || "") + "," + (h.cc || "")) : [from];
        const hit = candidates.map((e) => map[e]).find(Boolean);
        if (!hit) continue;
        const r = new Record(touchesCol);
        r.set("account", hit.account);
        r.set("contact", hit.contact);
        r.set("type", "email");
        r.set("direction", outbound ? "out" : "in");
        r.set("occurred_at", new Date(parseInt(msg.internalDate, 10)).toISOString());
        r.set("summary", (h.subject || "(no subject)").slice(0, 300) + (msg.snippet ? " — " + msg.snippet.slice(0, 200) : ""));
        r.set("source", "gmail");
        r.set("external_id", ext);
        r.set("link", "https://mail.google.com/mail/u/0/#all/" + msg.threadId);
        $app.save(r);
        created++;
      }
      pageToken = list.nextPageToken || "";
      if (!pageToken) break;
    }
  }
  kvSet("gmail:last_sync", startedAt);
  return { created, seen };
}

// ------------------------------------------------------------ Loyverse POS
// API: https://api.loyverse.com/v1.0 (Bearer access token from Back Office > Access tokens)
// Receipts can't be filtered by customer server-side, so we page receipts by
// updated_at and match customer_id locally. Money values are decimals (not cents).
const loyBase = () => env("LOYVERSE_BASE_URL", "https://api.loyverse.com/v1.0").replace(/\/+$/, "");

function loyHeaders() {
  const tok = env("LOYVERSE_ACCESS_TOKEN", "");
  if (!tok) throw new BadRequestError("LOYVERSE_ACCESS_TOKEN is not set.");
  return { Authorization: "Bearer " + tok, Accept: "application/json" };
}

// GET with retry on 429 (Loyverse: 300 requests / 300 s per account)
function loyGet(path, params) {
  const clean = {};
  for (const k of Object.keys(params || {})) {
    if (params[k] !== "" && params[k] !== undefined && params[k] !== null) clean[k] = params[k];
  }
  const url = loyBase() + path + (Object.keys(clean).length ? "?" + form(clean) : "");
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = $http.send({ url, headers: loyHeaders(), timeout: 30 });
    } catch (err) {
      throw new BadRequestError(`Could not reach Loyverse: ${String(err.message || err).slice(0, 300)}`);
    }
    if (res.statusCode === 429) { sleep(5000 * (attempt + 1)); continue; }
    if (res.statusCode === 401) throw new BadRequestError("Loyverse rejected the access token (401). Check LOYVERSE_ACCESS_TOKEN.");
    if (res.statusCode === 402) throw new BadRequestError("Loyverse API requires an active subscription/Integrations add-on (402).");
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new BadRequestError(`Loyverse ${path} -> ${res.statusCode}: ${toString(res.body, 500)}`);
    }
    return res.json || {};
  }
  throw new BadRequestError("Loyverse rate limit: try again in a few minutes.");
}

function loyverseCustomers(q) {
  const needle = String(q || "").toLowerCase().trim();
  const out = [];
  let cursor = "";
  for (let i = 0; i < 40; i++) {
    const data = loyGet("/customers", { limit: 250, cursor });
    for (const c of data.customers || []) {
      const hay = [c.name, c.email, c.phone_number, c.customer_code].filter(Boolean).join(" ").toLowerCase();
      if (!needle || hay.indexOf(needle) >= 0) {
        out.push({
          id: c.id,
          label: c.name || c.email || c.customer_code || c.id,
          email: c.email || "",
          phone: c.phone_number || "",
          code: c.customer_code || "",
          total_visits: c.total_visits || 0,
          last_visit: c.last_visit || "",
        });
      }
    }
    cursor = data.cursor || "";
    if (!cursor || out.length >= 50) break;
  }
  return out.slice(0, 50);
}

// Stage automation based on order history
function applyOrderStage(tx, accountId, orderCount, lastOrder) {
  const dormantDays = parseInt(env("DORMANT_DAYS", "45"), 10);
  const lastMs = lastOrder ? lastOrder.getTime() : 0;
  const stale = lastMs && Date.now() - lastMs > dormantDays * 86400000;
  const deals = tx.findRecordsByFilter("deals", "account = {:a} && stage != 'lost'", "-updated", 50, 0, { a: accountId });
  for (const d of deals) {
    const s = d.getString("stage");
    let next = s;
    if (orderCount >= 1 && ["prospect", "contacted", "sampling", "proposal"].indexOf(s) >= 0) next = "first_order";
    if (orderCount >= 2 && (s === "first_order" || next === "first_order")) next = "recurring";
    if (stale && (next === "first_order" || next === "recurring")) next = "dormant";
    if (!stale && s === "dormant" && orderCount >= 1) next = "recurring";
    if (next !== s) {
      d.set("stage", next);
      d.set("stage_changed_at", nowIso());
      tx.save(d);
    }
  }
}

function loyverseSync() {
  if (!env("LOYVERSE_ACCESS_TOKEN", "")) return { skipped: "loyverse not configured" };
  const accounts = $app.findRecordsByFilter("accounts", "pos_customer_id != ''", "", 2000, 0);
  if (!accounts.length) return { updated: 0, note: "no accounts linked to Loyverse customers" };

  const byCust = {};
  let needBackfill = false;
  for (const a of accounts) {
    byCust[a.getString("pos_customer_id")] = a.id;
    if (!a.getBool("pos_backfilled")) needBackfill = true;
  }

  const lookbackDays = parseInt(env("LOYVERSE_LOOKBACK_DAYS", "365"), 10);
  const backfillFrom = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const watermark = kvGet("loyverse:watermark", "");
  // new links need a scan of the full lookback window; otherwise only changes since last sync (1h overlap)
  const from = needBackfill || !watermark
    ? backfillFrom
    : new Date(new Date(watermark).getTime() - 3600 * 1000).toISOString();
  const startedAt = new Date().toISOString();

  const touchesCol = $app.findCollectionByNameOrId("touches");
  let created = 0, updatedTouches = 0, removed = 0, scanned = 0, pages = 0;
  const touchedAccounts = {};
  let cursor = "";
  do {
    const data = loyGet("/receipts", { updated_at_min: from, limit: 250, cursor });
    pages++;
    for (const r of data.receipts || []) {
      scanned++;
      const accId = r.customer_id && byCust[r.customer_id];
      if (!accId) continue;
      const ext = "loyverse:" + r.receipt_number;
      let t = null;
      try { t = $app.findFirstRecordByData("touches", "external_id", ext); } catch (_) {}
      if (r.cancelled_at) {
        if (t) { $app.delete(t); removed++; touchedAccounts[accId] = true; }
        continue;
      }
      const refund = r.receipt_type === "REFUND";
      const amt = Math.round((Number(r.total_money) || 0) * 100) / 100 * (refund ? -1 : 1);
      const isNew = !t;
      if (isNew) t = new Record(touchesCol);
      t.set("account", accId);
      t.set("type", "order");
      t.set("direction", "in");
      t.set("occurred_at", new Date(r.receipt_date || r.created_at).toISOString());
      t.set("summary", `${refund ? "Refund" : "Loyverse receipt"} #${r.receipt_number}` +
        (r.line_items && r.line_items.length
          ? ": " + r.line_items.slice(0, 6).map((li) => `${li.quantity}× ${li.item_name}${li.variant_name ? " (" + li.variant_name + ")" : ""}`).join(", ")
          : ""));
      t.set("amount", amt);
      t.set("source", "loyverse");
      t.set("external_id", ext);
      $app.save(t);
      if (isNew) created++; else updatedTouches++;
      touchedAccounts[accId] = true;
    }
    cursor = data.cursor || "";
  } while (cursor && pages < 400);

  // Recompute 12-month order stats + stages for every linked account
  const since = new Date(Date.now() - 365 * 86400000).toISOString().replace("T", " ");
  let updated = 0;
  $app.runInTransaction((tx) => {
    for (const a0 of accounts) {
      const a = tx.findRecordById("accounts", a0.id);
      const orders = tx.findRecordsByFilter(
        "touches", "account = {:a} && source = 'loyverse' && type = 'order' && occurred_at >= {:s}",
        "-occurred_at", 5000, 0, { a: a.id, s: since },
      );
      let count = 0, total = 0, last = null;
      for (const o of orders) {
        const amt = o.getFloat("amount");
        total += amt;
        if (amt > 0) {
          count++;
          const d = parseDate(o.getString("occurred_at"));
          if (d && (!last || d > last)) last = d;
        }
      }
      a.set("order_count", count);
      a.set("order_total", Math.round(total * 100) / 100);
      a.set("last_order_at", last ? last.toISOString() : "");
      a.set("pos_backfilled", true);
      tx.save(a);
      applyOrderStage(tx, a.id, count, last);
      updated++;
    }
  });
  kvSet("loyverse:watermark", startedAt);
  kvSet("loyverse:last_sync", Date.now());
  return { updated, created, updatedTouches, removed, scanned, pages, backfill: needBackfill || !watermark };
}

// Daily: mark accounts with stale orders dormant even without new POS data
function dormantSweep() {
  const dormantDays = parseInt(env("DORMANT_DAYS", "45"), 10);
  const cutoff = new Date(Date.now() - dormantDays * 86400000).toISOString().replace("T", " ");
  const deals = $app.findRecordsByFilter(
    "deals",
    "(stage = 'recurring' || stage = 'first_order') && account.last_order_at != '' && account.last_order_at < {:c}",
    "", 1000, 0, { c: cutoff },
  );
  for (const d of deals) {
    d.set("stage", "dormant");
    d.set("stage_changed_at", nowIso());
    $app.save(d);
  }
  return { dormant: deals.length };
}

// ------------------------------------------------------------ touch side effects
function onTouchCreated(app, touch) {
  const acc = app.findRecordById("accounts", touch.getString("account"));
  const occurred = parseDate(touch.getString("occurred_at"));
  const lastTouch = parseDate(acc.getString("last_touch_at"));
  let dirty = false;
  if (occurred && (!lastTouch || occurred > lastTouch) && touch.getString("type") !== "order") {
    acc.set("last_touch_at", occurred.toISOString());
    dirty = true;
  }
  const fu = touch.getString("next_followup_at");
  if (fu) { acc.set("next_followup_at", fu); dirty = true; }
  if (dirty) app.save(acc);

  // nudge stage forward on manual activity
  if (touch.getString("source") === "loyverse") return;
  const type = touch.getString("type");
  let deals = [];
  if (touch.getString("deal")) {
    try { deals = [app.findRecordById("deals", touch.getString("deal"))]; } catch (_) {}
  } else {
    deals = app.findRecordsByFilter("deals", "account = {:a} && stage != 'lost'", "-updated", 1, 0, { a: acc.id });
  }
  for (const d of deals) {
    const s = d.getString("stage");
    let next = s;
    if (s === "prospect" && touch.getString("direction") !== "in") next = "contacted";
    if (type === "tasting" && (s === "prospect" || s === "contacted")) next = "sampling";
    if (fu) d.set("next_followup_at", fu);
    if (next !== s) { d.set("stage", next); d.set("stage_changed_at", nowIso()); }
    if (next !== s || fu) app.save(d);
  }
}

function status() {
  const g = kvGet("google:tokens", null);
  const l = limits();
  return {
    google: {
      configured: !!env("GOOGLE_CLIENT_ID", ""),
      connected: !!g,
      email: g ? g.email : "",
      last_sync: kvGet("gmail:last_sync", 0),
    },
    places: {
      configured: !!env("GOOGLE_PLACES_API_KEY", ""),
      month: monthKey(),
      search_used: usage("places_search"),
      search_limit: l.places_search,
      details_used: usage("places_details"),
      details_limit: l.places_details,
    },
    pos: {
      name: "Loyverse",
      configured: !!env("LOYVERSE_ACCESS_TOKEN", ""),
      last_sync: kvGet("loyverse:last_sync", 0),
    },
    dormant_days: parseInt(env("DORMANT_DAYS", "45"), 10),
    currency: env("CURRENCY", "CRC"),
    app_url: appUrl(),
  };
}

module.exports = {
  env, kvGet, kvSet, kvDel, placesSearch, placeDetails, convertLead,
  googleAuthUrl, googleCallback, gmailSync, loyverseCustomers, loyverseSync,
  dormantSweep, onTouchCreated, status, appUrl, areaFromAddress, typeFromPlace,
};
