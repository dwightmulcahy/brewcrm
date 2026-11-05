/// <reference path="../pb_data/types.d.ts" />
// BrewCRM routes, hooks and scheduled jobs.

// ---------------------------------------------------------------- bootstrap CRM user from .env
// PB_ADMIN_EMAIL/PASSWORD create the PocketBase superuser (/_/) in the entrypoint.
// The CRM sign-in page uses the regular "users" collection, so mirror the same
// credentials there; .env stays the source of truth on every start.
onBootstrap((e) => {
  e.next(); // DB + collections are ready after this
  const email = ($os.getenv("PB_ADMIN_EMAIL") || "").replace(/\r/g, "").trim().toLowerCase();
  const password = ($os.getenv("PB_ADMIN_PASSWORD") || "").replace(/\r/g, "");
  if (!email || !password) return;
  let users;
  try { users = $app.findCollectionByNameOrId("users"); } catch (_) { return; } // first-ever migrate run
  try {
    let user;
    try {
      user = $app.findAuthRecordByEmail("users", email);
    } catch (_) {
      user = new Record(users);
      user.setEmail(email);
      user.set("name", "Admin");
    }
    user.setPassword(password);
    user.setVerified(true);
    $app.save(user);
  } catch (err) {
    require(`${__hooks}/lib/crm.js`).log("ERROR", "could not create CRM user from PB_ADMIN_EMAIL", err);
  }
});

// ---------------------------------------------------------------- JSON access log (stdout, for logwatch)
// One JSON object per request; set ACCESS_LOG=0 to disable. Behind hotpot, the real client IP
// comes from X-Real-IP once Settings > Application > Trusted proxy lists that header.
routerUse((e) => {
  if ($os.getenv("ACCESS_LOG") === "0") return e.next();
  const started = Date.now();
  let status = 0, failure = null;
  try {
    e.next();
  } catch (err) {
    failure = err;
    // thrown Go ApiErrors are wrapped: the HTTP status lives on err.value
    status = (err && err.value && err.value.status) || (err && err.status) || 500;
  }
  try {
    if (!status) status = e.status() || 200;
    const path = e.request.url.path;
    const line = {
      timestamp: new Date().toISOString(),
      level: status >= 500 ? "ERROR" : status >= 400 ? "WARNING" : "INFO",
      method: e.request.method,
      path: path,
      status_code: status,
      duration_ms: Date.now() - started,
      client: e.realIP(),
      user_agent: e.request.header.get("User-Agent") || "",
      api_key: null,
    };
    require(`${__hooks}/lib/crm.js`).writeJsonLine(line);
  } catch (_) {}
  if (failure) throw failure;
});

// ---------------------------------------------------------------- health (container/CI probe)
routerAdd("GET", "/health", (e) => {
  $app.countRecords("kv"); // touches the DB so a broken data dir fails the probe
  return e.json(200, { status: "ok" });
});

// ---------------------------------------------------------------- status
routerAdd("GET", "/api/crm/status", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  return e.json(200, crm.status());
}, $apis.requireAuth());

// ---------------------------------------------------------------- leads
routerAdd("POST", "/api/crm/leads/search", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  const body = e.requestInfo().body || {};
  const query = String(body.query || "").trim();
  if (query.length < 3) throw new BadRequestError("Query too short.");
  return e.json(200, crm.placesSearch(query, String(body.pageToken || ""), e.auth.id));
}, $apis.requireAuth());

routerAdd("POST", "/api/crm/leads/{id}/enrich", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  const lead = $app.findRecordById("leads", e.request.pathValue("id"));
  const d = crm.placeDetails(lead.getString("place_id"));
  lead.set("phone", d.nationalPhoneNumber || d.internationalPhoneNumber || "");
  lead.set("website", d.websiteUri || "");
  $app.save(lead);
  return e.json(200, { phone: lead.getString("phone"), website: lead.getString("website") });
}, $apis.requireAuth());

routerAdd("POST", "/api/crm/leads/{id}/convert", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  return e.json(200, crm.convertLead(e.request.pathValue("id"), e.auth.id));
}, $apis.requireAuth());

// ---------------------------------------------------------------- Google / Gmail
routerAdd("GET", "/api/crm/google/auth-url", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  return e.json(200, { url: crm.googleAuthUrl(e.auth.id) });
}, $apis.requireAuth());

// Browser redirect target from Google (no PB auth header available here; protected by one-time state)
routerAdd("GET", "/api/crm/google/callback", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  const q = e.request.url.query();
  if (q.get("error")) return e.redirect(302, "/#/settings?google=" + encodeURIComponent(q.get("error")));
  try {
    crm.googleCallback(q.get("code"), q.get("state"));
    try { crm.gmailSync(); } catch (err) { crm.log("ERROR", "initial gmail sync failed", err); }
    return e.redirect(302, "/#/settings?google=connected");
  } catch (err) {
    return e.redirect(302, "/#/settings?google=" + encodeURIComponent(String(err.message || err).slice(0, 200)));
  }
});

routerAdd("POST", "/api/crm/google/disconnect", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  crm.kvDel("google:tokens");
  crm.kvDel("gmail:last_sync");
  return e.json(200, { ok: true });
}, $apis.requireAuth());

routerAdd("POST", "/api/crm/sync/gmail", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  return e.json(200, crm.gmailSync());
}, $apis.requireAuth());

// ---------------------------------------------------------------- Loyverse POS
routerAdd("GET", "/api/crm/pos/customers", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  return e.json(200, crm.loyverseCustomers(e.request.url.query().get("q")));
}, $apis.requireAuth());

routerAdd("POST", "/api/crm/sync/pos", (e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  return e.json(200, crm.loyverseSync());
}, $apis.requireAuth());

// ---------------------------------------------------------------- record hooks
onRecordCreate((e) => {
  if (!e.record.getString("source")) e.record.set("source", "manual");
  if (!e.record.getString("occurred_at")) e.record.set("occurred_at", new Date().toISOString());
  e.next();
}, "touches");

onRecordCreateRequest((e) => {
  if (e.auth && !e.record.getString("user")) e.record.set("user", e.auth.id);
  e.next();
}, "touches");

onRecordAfterCreateSuccess((e) => {
  const crm = require(`${__hooks}/lib/crm.js`);
  try { crm.onTouchCreated(e.app, e.record); } catch (err) { crm.log("ERROR", "touch side-effects failed", err); }
  e.next();
}, "touches");

onRecordCreate((e) => {
  if (!e.record.getString("stage")) e.record.set("stage", "prospect");
  e.record.set("stage_changed_at", new Date().toISOString());
  e.next();
}, "deals");

onRecordUpdate((e) => {
  const before = e.record.original().getString("stage");
  if (before !== e.record.getString("stage")) e.record.set("stage_changed_at", new Date().toISOString());
  e.next();
}, "deals");

// Re-linking an account to a different POS customer triggers a history backfill
onRecordUpdate((e) => {
  if (e.record.original().getString("pos_customer_id") !== e.record.getString("pos_customer_id")) {
    e.record.set("pos_backfilled", false);
  }
  e.next();
}, "accounts");

onRecordCreateRequest((e) => {
  if (e.auth && !e.record.getString("owner")) e.record.set("owner", e.auth.id);
  e.next();
}, "accounts", "deals");

// ---------------------------------------------------------------- cron
cronAdd("crm_gmail_sync", "*/15 * * * *", () => {
  const crm = require(`${__hooks}/lib/crm.js`);
  try { crm.log("INFO", "gmail sync", crm.gmailSync()); } catch (err) { crm.log("ERROR", "gmail sync failed", err); }
});

cronAdd("crm_pos_sync", "7 * * * *", () => {
  const crm = require(`${__hooks}/lib/crm.js`);
  try { crm.log("INFO", "loyverse sync", crm.loyverseSync()); } catch (err) { crm.log("ERROR", "loyverse sync failed", err); }
});

cronAdd("crm_dormant_sweep", "15 6 * * *", () => {
  const crm = require(`${__hooks}/lib/crm.js`);
  try { crm.log("INFO", "dormant sweep", crm.dormantSweep()); } catch (err) { crm.log("ERROR", "dormant sweep failed", err); }
});
