/// <reference path="../pb_data/types.d.ts" />
// BrewCRM schema: accounts, contacts, deals, touches, leads, kv.

const AUTH = "@request.auth.id != ''";

function autodates() {
  return [
    { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];
}

function crmRules(c) {
  c.listRule = AUTH;
  c.viewRule = AUTH;
  c.createRule = AUTH;
  c.updateRule = AUTH;
  c.deleteRule = AUTH;
  return c;
}

migrate((app) => {
  // Lock public sign-up: users are created only by the superuser in /_/
  const users = app.findCollectionByNameOrId("users");
  users.createRule = null;
  app.save(users);

  const usersId = users.id;

  // ---------------- accounts ----------------
  const accounts = crmRules(new Collection({
    type: "base",
    name: "accounts",
    fields: [
      { name: "name", type: "text", required: true, max: 200 },
      {
        name: "type", type: "select", maxSelect: 1,
        values: ["bar", "restaurant", "hotel", "cafe", "retail", "supermarket", "event", "distributor", "other"],
      },
      { name: "area", type: "text", max: 120 },
      { name: "address", type: "text", max: 400 },
      { name: "phone", type: "text", max: 60 },
      { name: "website", type: "text", max: 300 },
      { name: "lat", type: "number" },
      { name: "lng", type: "number" },
      { name: "google_place_id", type: "text", max: 200 },
      { name: "maps_url", type: "text", max: 400 },
      { name: "pos_customer_id", type: "text", max: 100 },
      { name: "pos_backfilled", type: "bool" },
      { name: "notes", type: "text", max: 20000 },
      { name: "owner", type: "relation", collectionId: usersId, maxSelect: 1 },
      { name: "last_touch_at", type: "date" },
      { name: "next_followup_at", type: "date" },
      { name: "last_order_at", type: "date" },
      { name: "order_count", type: "number" },
      { name: "order_total", type: "number" },
      ...autodates(),
    ],
    indexes: [
      "CREATE INDEX idx_accounts_name ON accounts (name)",
      "CREATE INDEX idx_accounts_followup ON accounts (next_followup_at)",
    ],
  }));
  app.save(accounts);

  // ---------------- contacts ----------------
  const contacts = crmRules(new Collection({
    type: "base",
    name: "contacts",
    fields: [
      { name: "account", type: "relation", collectionId: accounts.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: "name", type: "text", required: true, max: 200 },
      { name: "role", type: "text", max: 120 },
      { name: "email", type: "text", max: 200 },
      { name: "phone", type: "text", max: 60 },
      { name: "whatsapp", type: "text", max: 60 },
      { name: "is_primary", type: "bool" },
      { name: "notes", type: "text", max: 5000 },
      ...autodates(),
    ],
    indexes: [
      "CREATE INDEX idx_contacts_account ON contacts (account)",
      "CREATE INDEX idx_contacts_email ON contacts (email)",
    ],
  }));
  app.save(contacts);

  // ---------------- deals ----------------
  const deals = crmRules(new Collection({
    type: "base",
    name: "deals",
    fields: [
      { name: "account", type: "relation", collectionId: accounts.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: "title", type: "text", max: 200 },
      {
        name: "stage", type: "select", maxSelect: 1, required: true,
        values: ["prospect", "contacted", "sampling", "proposal", "first_order", "recurring", "dormant", "lost"],
      },
      { name: "est_liters_month", type: "number" },
      { name: "value", type: "number" },
      { name: "next_step", type: "text", max: 500 },
      { name: "next_followup_at", type: "date" },
      { name: "lost_reason", type: "text", max: 500 },
      { name: "owner", type: "relation", collectionId: usersId, maxSelect: 1 },
      { name: "stage_changed_at", type: "date" },
      ...autodates(),
    ],
    indexes: [
      "CREATE INDEX idx_deals_account ON deals (account)",
      "CREATE INDEX idx_deals_stage ON deals (stage)",
    ],
  }));
  app.save(deals);

  // ---------------- touches (activity log) ----------------
  const touches = crmRules(new Collection({
    type: "base",
    name: "touches",
    fields: [
      { name: "account", type: "relation", collectionId: accounts.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: "contact", type: "relation", collectionId: contacts.id, maxSelect: 1 },
      { name: "deal", type: "relation", collectionId: deals.id, maxSelect: 1 },
      {
        name: "type", type: "select", maxSelect: 1, required: true,
        values: ["visit", "email", "call", "whatsapp", "tasting", "event", "order", "other"],
      },
      { name: "direction", type: "select", maxSelect: 1, values: ["out", "in"] },
      { name: "occurred_at", type: "date", required: true },
      { name: "summary", type: "text", max: 2000 },
      { name: "next_followup_at", type: "date" },
      { name: "source", type: "select", maxSelect: 1, values: ["manual", "gmail", "loyverse"] },
      { name: "external_id", type: "text", max: 200 },
      { name: "link", type: "text", max: 500 },
      { name: "amount", type: "number" },
      { name: "user", type: "relation", collectionId: usersId, maxSelect: 1 },
      ...autodates(),
    ],
    indexes: [
      "CREATE INDEX idx_touches_account ON touches (account, occurred_at)",
      "CREATE UNIQUE INDEX idx_touches_ext ON touches (external_id) WHERE external_id != ''",
    ],
  }));
  app.save(touches);

  // ---------------- leads (from Places search) ----------------
  const leads = crmRules(new Collection({
    type: "base",
    name: "leads",
    fields: [
      { name: "name", type: "text", required: true, max: 200 },
      { name: "address", type: "text", max: 400 },
      { name: "area", type: "text", max: 120 },
      { name: "lat", type: "number" },
      { name: "lng", type: "number" },
      { name: "primary_type", type: "text", max: 80 },
      { name: "types", type: "text", max: 1000 },
      { name: "place_id", type: "text", max: 200 },
      { name: "maps_url", type: "text", max: 400 },
      { name: "phone", type: "text", max: 60 },
      { name: "website", type: "text", max: 300 },
      { name: "query", type: "text", max: 300 },
      { name: "status", type: "select", maxSelect: 1, values: ["new", "converted", "dismissed"] },
      { name: "account", type: "relation", collectionId: accounts.id, maxSelect: 1 },
      ...autodates(),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_leads_place ON leads (place_id) WHERE place_id != ''",
      "CREATE INDEX idx_leads_status ON leads (status)",
    ],
  }));
  app.save(leads);

  // ---------------- kv (server-only settings / tokens / counters) ----------------
  const kv = new Collection({
    type: "base",
    name: "kv",
    fields: [
      { name: "key", type: "text", required: true, max: 200 },
      { name: "value", type: "text", max: 100000 },
      ...autodates(),
    ],
    indexes: ["CREATE UNIQUE INDEX idx_kv_key ON kv (key)"],
  });
  // all rules null => superuser only; hooks bypass rules
  app.save(kv);
}, (app) => {
  for (const name of ["kv", "leads", "touches", "deals", "contacts", "accounts"]) {
    try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
  }
  const users = app.findCollectionByNameOrId("users");
  users.createRule = "";
  app.save(users);
});
