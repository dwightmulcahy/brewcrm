/* BrewCRM front-end: vanilla JS + PocketBase SDK, hash routing. */
"use strict";

const pb = new PocketBase(window.location.origin);
pb.autoCancellation(false);

const STAGES = [
  ["prospect", "Prospect"], ["contacted", "Contacted"], ["sampling", "Sampling"], ["proposal", "Proposal"],
  ["first_order", "First order"], ["recurring", "Recurring"], ["dormant", "Dormant"], ["lost", "Lost"],
];
const DARK_STAGES = new Set(["first_order", "recurring", "proposal"]);
const STAGE_LABEL = Object.fromEntries(STAGES);
const TOUCH_TYPES = [
  ["visit", "Visit"], ["call", "Call"], ["whatsapp", "WhatsApp"], ["email", "Email"],
  ["tasting", "Tasting"], ["event", "Event"], ["order", "Order"], ["other", "Other"],
];
const TOUCH_LABEL = Object.fromEntries(TOUCH_TYPES);
const ACCOUNT_TYPES = ["bar", "restaurant", "hotel", "cafe", "retail", "supermarket", "event", "distributor", "other"];
const LEAD_PRESETS = ["bar", "restaurante", "hotel", "licorera", "cervecería artesanal", "pub", "gastropub", "minisúper"];

let STATUS = { currency: "CRC" };
const app = document.getElementById("app");

// ---------------------------------------------------------------- utils
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const toDate = (s) => (s ? new Date(String(s).replace(" ", "T")) : null);
const fmtDate = (s) => { const d = toDate(s); return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }) : ""; };
const fmtDateTime = (s) => { const d = toDate(s); return d ? d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""; };
const fmtMoney = (n) => {
  if (n === null || n === undefined || n === "") return "";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: STATUS.currency || "CRC", maximumFractionDigits: 0 }).format(n); }
  catch (_) { return String(n); }
};
const isOverdue = (s) => { const d = toDate(s); if (!d) return false; const end = new Date(); end.setHours(23, 59, 59, 999); return d <= end; };
// local datetime-input value <-> PocketBase UTC string
const toLocalInput = (s) => { const d = s ? toDate(s) : new Date(); const off = d.getTimezoneOffset() * 60000; return new Date(d - off).toISOString().slice(0, 16); };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : "");
const stageStyle = (s) => `--stage: var(--s-${s}); --stage-ink: ${DARK_STAGES.has(s) || s === "recurring" ? "#fff" : "var(--ink)"}`;
const waLink = (n) => "https://wa.me/" + String(n).replace(/[^\d]/g, "").replace(/^(?=\d{8}$)/, "506");

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), err ? 6000 : 2600);
}

function errMsg(e) {
  const d = e?.response?.data;
  if (d && typeof d === "object" && Object.keys(d).length) {
    return Object.entries(d).map(([k, v]) => `${k}: ${v.message || v}`).join("; ");
  }
  return e?.response?.message || e?.message || String(e);
}

async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(errMsg(e), true); throw e; } finally { if (btn) btn.disabled = false; }
}

const api = (path, opts = {}) => pb.send("/api/crm" + path, opts);

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") o[el.name] = el.checked;
    else if (el.type === "datetime-local") o[el.name] = fromLocalInput(el.value);
    else if (el.type === "number") o[el.name] = el.value === "" ? null : Number(el.value);
    else o[el.name] = el.value.trim();
  }
  return o;
}

const options = (pairs, sel) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");

// Missing .env setting: same red callout everywhere
function envWarning(vars, purpose) {
  const names = vars.map((v) => `<code>${esc(v)}</code>`).join(vars.length === 2 ? " and " : ", ");
  return `<div class="env-warn" role="alert"><strong>Not set up.</strong> Add ${names} to <code>.env</code> and restart the container to ${esc(purpose)}.</div>`;
}

// ---------------------------------------------------------------- dialog
function openDialog(html, onSubmit) {
  const dlg = $("#dlg");
  dlg.innerHTML = html;
  const form = $("form", dlg);
  $$("[data-close]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));
  if (form && onSubmit) {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = $("button[type=submit]", form);
      try { await busy(btn, () => onSubmit(formData(form), form)); dlg.close(); } catch (_) {}
    });
  }
  dlg.showModal();
  const first = $("input, select, textarea", dlg);
  if (first) first.focus();
  return dlg;
}

// ---------------------------------------------------------------- routing
const routes = {};
function route(name, fn) { routes[name] = fn; }

async function render() {
  const [path, query] = (location.hash.replace(/^#\/?/, "") || "pipeline").split("?");
  const [name, id] = path.split("/");
  // Pages that work without signing in
  if (name === "forgot") { $("#topbar").hidden = true; return renderForgot(); }
  if (name === "reset") { $("#topbar").hidden = true; return renderReset(id); }
  if (!pb.authStore.isValid) { $("#topbar").hidden = true; return renderLogin(); }
  // A temporary password (set by the admin) must be replaced before anything else
  if (pb.authStore.record?.must_change_password) { $("#topbar").hidden = true; return renderForcedChange(); }
  $("#topbar").hidden = false;
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
  const fn = routes[name] || routes.pipeline;
  app.innerHTML = `<p class="muted">Loading…</p>`;
  try { await fn(id, new URLSearchParams(query || "")); }
  catch (e) {
    if (e?.status === 401) { pb.authStore.clear(); return render(); }
    app.innerHTML = `<div class="panel"><h2>Could not load this page</h2><p>${esc(errMsg(e))}</p><a class="btn" href="#/pipeline">Back to pipeline</a></div>`;
  }
}
window.addEventListener("hashchange", render);

// ---------------------------------------------------------------- login
// ---------------------------------------------------------------- build version
const REPO_URL = "https://github.com/dwightmulcahy/brewcrm";
let BUILD = null;
const buildLabel = (b) => (b.version === "dev" ? "dev" : "v" + b.version) + (b.commit && b.version === "dev" ? " " + b.commit : "");
function showBuildVersion() {
  if (!BUILD) return;
  for (const el of $$("[data-build-version]")) {
    el.textContent = buildLabel(BUILD);
    el.hidden = false;
    el.title = "About this build";
    el.setAttribute("aria-label", `Version ${buildLabel(BUILD)}: show build details`);
    el.onclick = openAbout;
  }
}

// About dialog: public version/commit for everyone; build + server details once signed in
async function openAbout() {
  const signedIn = pb.authStore.isValid;
  let info = { ...BUILD };
  if (signedIn) { try { info = { ...info, ...(await api("/build")) }; } catch (_) { /* show what we have */ } }
  const rows = [
    ["Version", info.version === "dev" ? "dev (local build)" : "v" + info.version],
    ["Commit", info.commit],
    ["Edition", { web: "Web (Docker / server)", offline: "Offline (single computer)" }[info.edition] || info.edition],
    ["PocketBase", info.pocketbase && "v" + info.pocketbase],
    ["Built", info.built_at && fmtDateTime(info.built_at)],
    ["Server up since", info.started_at && fmtDateTime(info.started_at)],
    ["Signed in as", pb.authStore.record?.email],
  ].filter(([, v]) => v);
  const text = ["BrewCRM", ...rows.map(([k, v]) => `${k}: ${v}`), `Browser: ${navigator.userAgent}`].join("\n");
  const notes = info.version === "dev" ? `${REPO_URL}/commits/main` : `${REPO_URL}/releases/tag/v${encodeURIComponent(info.version)}`;
  const dlg = openDialog(`
    <div class="about">
      <h2><img src="logo-mark.svg" alt="" width="28" height="35"> BrewCRM</h2>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${k === "Commit" ? `<a href="${REPO_URL}/commit/${esc(v)}" target="_blank" rel="noopener"><code>${esc(v)}</code></a>` : esc(v)}</dd>`).join("")}</dl>
      ${signedIn ? "" : `<p class="muted small">Sign in to see build and server details.</p>`}
      <p class="about-links"><a href="${notes}" target="_blank" rel="noopener">${info.version === "dev" ? "Recent changes" : "Release notes"}</a> · <a href="${REPO_URL}/issues/new" target="_blank" rel="noopener">Report a problem</a></p>
      <div class="dlg-actions">
        <button type="button" class="btn" data-copy>Copy details</button>
        <button type="button" class="btn btn-primary" data-close>Close</button>
      </div>
    </div>`);
  $("[data-copy]", dlg).addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); toast("Build details copied"); } catch (_) { toast("Couldn't copy. Select the text instead.", true); }
  });
}
fetch("version.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((b) => { if (b && typeof b.version === "string") { BUILD = b; showBuildVersion(); } })
  .catch(() => {});

function renderLogin() {
  app.innerHTML = `
    <form class="login form" id="loginForm">
      <h1>BrewCRM <button type="button" class="build-version" data-build-version hidden></button></h1>
      <p class="muted">Sign in with the account your admin created.</p>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p id="loginErr" class="due small" hidden style="margin:0">Wrong email or password. The admin account from PB_ADMIN_EMAIL works here and at <a href="/_/">/_/</a>.</p>
      <button class="btn btn-primary" type="submit">Sign in</button>
      <a class="small" href="#/forgot">Forgot password?</a>
    </form>`;
  showBuildVersion();
  $("#loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = formData(ev.target);
    try {
      await busy($("button", ev.target), () => pb.collection("users").authWithPassword(f.email.toLowerCase(), f.password));
    } catch (e) {
      const err = $("#loginErr");
      if (e?.status === 429) err.textContent = "Too many sign-in attempts. Wait a minute and try again.";
      err.hidden = false;
      return;
    }
    await loadStatus();
    render();
  });
}

// ---------------------------------------------------------------- passwords
// Same rules as pb_hooks/lib/crm.js passwordProblems (the server enforces them).
let PUBLIC = { password_reset: false, password_min: 12, password_long: 16 };
const publicConfig = fetch("/api/crm/public-config", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null)).then((c) => { if (c) PUBLIC = c; }).catch(() => {});

function passwordChecks(pw, email) {
  const n = Array.from(pw).length;
  const local = String(email || "").toLowerCase().split("@")[0];
  return [
    [`At least ${PUBLIC.password_min} characters`, n >= PUBLIC.password_min],
    ["A letter", /[A-Za-z\u00C0-\u024F]/.test(pw)],
    ["A number", /[0-9]/.test(pw)],
    [`A symbol, or ${PUBLIC.password_long}+ characters`, n >= PUBLIC.password_long || /[^A-Za-z0-9\u00C0-\u024F\s]/.test(pw)],
    ["Doesn't contain your email name", !(local.length >= 4 && pw.toLowerCase().includes(local))],
  ];
}

// New + confirm inputs with a live checklist; returns a validator for submit
function newPasswordFields(form, email) {
  const html = `
    <label>New password<input name="password" type="password" autocomplete="new-password" required data-pw-new></label>
    <ul class="pw-rules" data-pw-rules aria-live="polite"></ul>
    <label>Confirm new password<input name="passwordConfirm" type="password" autocomplete="new-password" required data-pw-confirm></label>
    <p class="due small" data-pw-mismatch hidden style="margin:0">The passwords don't match.</p>`;
  const wire = () => {
    const pw = $("[data-pw-new]", form), confirm = $("[data-pw-confirm]", form), list = $("[data-pw-rules]", form), mismatch = $("[data-pw-mismatch]", form);
    const draw = () => {
      list.innerHTML = passwordChecks(pw.value, email).map(([label, ok]) => `<li class="${ok ? "ok" : ""}">${ok ? "✓" : "•"} ${esc(label)}</li>`).join("");
      mismatch.hidden = !confirm.value || confirm.value === pw.value;
    };
    pw.addEventListener("input", draw); confirm.addEventListener("input", draw); draw();
    return () => {
      const failed = passwordChecks(pw.value, email).filter(([, ok]) => !ok);
      if (failed.length) { toast("Password needs: " + failed.map(([l]) => l.toLowerCase()).join(", "), true); pw.focus(); return false; }
      if (pw.value !== confirm.value) { mismatch.hidden = false; confirm.focus(); return false; }
      return true;
    };
  };
  return { html, wire };
}

// Change own password, then sign in again (PocketBase invalidates old sessions on change)
async function changeOwnPassword(oldPassword, password) {
  const me = pb.authStore.record;
  await pb.collection("users").update(me.id, { oldPassword, password, passwordConfirm: password });
  await pb.collection("users").authWithPassword(me.email, password);
}

function renderForcedChange() {
  const email = pb.authStore.record?.email || "";
  const fields = newPasswordFields(null, email);
  app.innerHTML = `
    <form class="login form" id="forceForm">
      <h1>Choose your password</h1>
      <p class="muted">You signed in with a temporary password from your admin. Pick your own to continue.</p>
      <label>Temporary password<input name="oldPassword" type="password" autocomplete="current-password" required></label>
      ${fields.html}
      <button class="btn btn-primary" type="submit">Save password</button>
      <button class="btn" type="button" id="forceOut">Sign out</button>
    </form>`;
  const form = $("#forceForm");
  const valid = newPasswordFields(form, email).wire();
  $("#forceOut").addEventListener("click", () => { pb.authStore.clear(); location.hash = ""; render(); });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!valid()) return;
    const f = formData(form);
    try { await busy($("button[type=submit]", form), () => changeOwnPassword(f.oldPassword, f.password)); } catch (_) { return; }
    toast("Password saved");
    await loadStatus();
    location.hash = "#/pipeline";
    render();
  });
}

async function renderForgot() {
  await publicConfig;
  if (!PUBLIC.password_reset) {
    app.innerHTML = `
      <div class="login form">
        <h1>Forgot password</h1>
        <p>Password reset emails aren't set up on this BrewCRM yet. Ask your admin to set a temporary password for you in the admin dashboard. You'll choose your own when you sign in.</p>
        <a class="btn" href="#/">Back to sign in</a>
      </div>`;
    return;
  }
  app.innerHTML = `
    <form class="login form" id="forgotForm">
      <h1>Forgot password</h1>
      <p class="muted">Enter your email. If it belongs to a BrewCRM account, we'll send a link to choose a new password.</p>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <button class="btn btn-primary" type="submit">Email me a reset link</button>
      <a class="small" href="#/">Back to sign in</a>
    </form>`;
  $("#forgotForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = formData(ev.target);
    try {
      await busy($("button", ev.target), () => pb.collection("users").requestPasswordReset(f.email.toLowerCase()));
    } catch (e) { if (e?.status !== 429) return; }
    app.innerHTML = `
      <div class="login form">
        <h1>Check your email</h1>
        <p>If <strong>${esc(f.email)}</strong> has a BrewCRM account, a reset link is on its way. It works for 30 minutes.</p>
        <a class="btn" href="#/">Back to sign in</a>
      </div>`;
  });
}

function renderReset(token) {
  if (!token) { location.hash = "#/forgot"; return; }
  let email = "";
  try { email = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch (_) {}
  const fields = newPasswordFields(null, email);
  app.innerHTML = `
    <form class="login form" id="resetForm">
      <h1>Choose a new password</h1>
      ${email ? `<p class="muted">For ${esc(email)}</p>` : ""}
      ${fields.html}
      <button class="btn btn-primary" type="submit">Save new password</button>
    </form>`;
  const form = $("#resetForm");
  const valid = newPasswordFields(form, email).wire();
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!valid()) return;
    const f = formData(form);
    try {
      await busy($("button", form), () => pb.collection("users").confirmPasswordReset(token, f.password, f.passwordConfirm));
    } catch (e) {
      if (/token/i.test(errMsg(e))) toast("This reset link has expired or was already used. Request a new one.", true);
      return;
    }
    pb.authStore.clear();
    app.innerHTML = `
      <div class="login form">
        <h1>Password saved</h1>
        <p>Sign in with your new password.</p>
        <a class="btn btn-primary" href="#/">Sign in</a>
      </div>`;
  });
}

async function loadStatus() {
  try { STATUS = await api("/status"); } catch (_) {}
}

// ---------------------------------------------------------------- pipeline
route("pipeline", async () => {
  const deals = await pb.collection("deals").getFullList({ expand: "account", sort: "next_followup_at,-updated" });
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Pipeline</h1><p>Drag a card to move it, or change its stage on the card.</p></div>
      <div class="row">
        <input id="pf" type="search" placeholder="Filter by account or area" aria-label="Filter pipeline" style="width:240px">
        <label class="row small" style="display:flex"><input type="checkbox" id="showLost" style="width:auto;min-height:0"> Show lost</label>
        <button class="btn" id="newDeal" type="button">New deal</button>
      </div>
    </div>
    <div class="board-wrap"><div class="board" id="board"></div></div>`;

  const board = $("#board");
  const draw = () => {
    const q = $("#pf").value.toLowerCase();
    const showLost = $("#showLost").checked;
    board.innerHTML = STAGES.filter(([s]) => showLost || s !== "lost").map(([s, label]) => {
      const items = deals.filter((d) => d.stage === s && (!q || `${d.expand?.account?.name} ${d.expand?.account?.area} ${d.title}`.toLowerCase().includes(q)));
      const total = items.reduce((n, d) => n + (Number(d.value) || 0), 0);
      const liters = items.reduce((n, d) => n + (Number(d.est_liters_month) || 0), 0);
      return `
        <section class="col" data-stage="${s}" style="${stageStyle(s)}" aria-label="${label}">
          <header class="col-head">
            <h3>${label}</h3>
            <div class="meta">${items.length} ${items.length === 1 ? "deal" : "deals"}${total ? " · " + esc(fmtMoney(total)) : ""}${liters ? " · " + liters + " L/mo" : ""}</div>
          </header>
          <div class="col-body">
            ${items.map((d) => `
              <article class="deal" data-id="${d.id}" style="${stageStyle(s)}">
                <a class="name" href="#/account/${d.account}" draggable="false">${esc(d.expand?.account?.name || "—")}</a>
                <div class="sub">${esc(d.title || "")}${d.expand?.account?.area ? " · " + esc(d.expand.account.area) : ""}</div>
                ${d.value || d.est_liters_month ? `<div class="sub">${d.value ? esc(fmtMoney(d.value)) : ""}${d.value && d.est_liters_month ? " · " : ""}${d.est_liters_month ? d.est_liters_month + " L/mo" : ""}</div>` : ""}
                ${d.next_followup_at ? `<div class="sub ${isOverdue(d.next_followup_at) ? "due" : ""}">Follow up ${esc(fmtDate(d.next_followup_at))}</div>` : ""}
                ${d.next_step ? `<div class="sub">Next: ${esc(d.next_step)}</div>` : ""}
                <select aria-label="Stage for ${esc(d.expand?.account?.name || "")}" data-stage-select="${d.id}">${options(STAGES, d.stage)}</select>
              </article>`).join("") || `<p class="muted small" style="padding:4px">No deals here.</p>`}
          </div>
        </section>`;
    }).join("");
  };

  const move = async (id, stage) => {
    const d = deals.find((x) => x.id === id);
    if (!d || d.stage === stage) return;
    let extra = {};
    if (stage === "lost") {
      const reason = prompt("Why was it lost? (optional)");
      if (reason === null) return draw();
      extra.lost_reason = reason;
    }
    const prev = d.stage;
    d.stage = stage; draw();
    try { await pb.collection("deals").update(id, { stage, ...extra }); toast(`Moved to ${STAGE_LABEL[stage]}`); }
    catch (e) { d.stage = prev; draw(); toast(errMsg(e), true); }
  };

  board.addEventListener("change", (ev) => { const id = ev.target.dataset.stageSelect; if (id) move(id, ev.target.value); });
  // Drag cards between columns with pointer events (mouse, touch, pen). HTML5 drag-and-drop
  // doesn't work on phones/tablets. Touch needs a short press first so swipes still scroll.
  let drag = null, eatClick = false;
  const colAt = (x, y) => document.elementFromPoint(x, y)?.closest(".col");
  const highlight = (col) => { $$(".col", board).forEach((c) => c.classList.toggle("drop", c === col)); };
  const onKey = (ev) => { if (ev.key === "Escape") endDrag(null); };
  const endDrag = (ev) => {
    const d = drag; if (!d) return;
    drag = null; clearTimeout(d.timer); d.ghost?.remove(); d.card.classList.remove("dragging");
    document.body.classList.remove("dragging"); highlight(null); window.removeEventListener("keydown", onKey);
    if (!d.active) return;
    eatClick = true; setTimeout(() => { eatClick = false; }, 0);
    const col = ev && colAt(ev.clientX, ev.clientY);
    if (col) move(d.card.dataset.id, col.dataset.stage);
  };
  board.addEventListener("dragstart", (ev) => ev.preventDefault()); // no native link/text drags
  board.addEventListener("pointerdown", (ev) => {
    const card = ev.target.closest(".deal");
    if (!card || drag || ev.button !== 0 || ev.target.closest("select, button, input")) return;
    const touch = ev.pointerType === "touch";
    drag = { card, id: ev.pointerId, x: ev.clientX, y: ev.clientY, armed: !touch, active: false, touch };
    if (touch) drag.timer = setTimeout(() => { if (drag) { drag.armed = true; card.classList.add("dragging"); navigator.vibrate?.(15); } }, 250);
  });
  board.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dist = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y);
    if (!drag.armed) { if (dist > 8) endDrag(null); return; } // a swipe: let it scroll
    if (!drag.active) {
      if (!drag.touch && dist < 5) return;
      const r = drag.card.getBoundingClientRect();
      drag.active = true; drag.dx = drag.x - r.left; drag.dy = drag.y - r.top;
      drag.ghost = Object.assign(drag.card.cloneNode(true), { className: "deal drag-ghost" });
      drag.ghost.style.width = `${r.width}px`; drag.ghost.setAttribute("aria-hidden", "true");
      document.body.append(drag.ghost); drag.card.classList.add("dragging"); document.body.classList.add("dragging");
      board.setPointerCapture?.(ev.pointerId); window.addEventListener("keydown", onKey);
    }
    ev.preventDefault();
    drag.ghost.style.left = `${ev.clientX - drag.dx}px`; drag.ghost.style.top = `${ev.clientY - drag.dy}px`;
    highlight(colAt(ev.clientX, ev.clientY));
  });
  board.addEventListener("pointerup", (ev) => { if (drag && ev.pointerId === drag.id) endDrag(ev); });
  board.addEventListener("pointercancel", () => endDrag(null));
  board.addEventListener("touchmove", (ev) => { if (drag?.armed) ev.preventDefault(); }, { passive: false });
  board.addEventListener("contextmenu", (ev) => { if (drag?.touch) ev.preventDefault(); });
  board.addEventListener("click", (ev) => { if (eatClick) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  $("#pf").addEventListener("input", draw);
  $("#showLost").addEventListener("change", draw);
  $("#newDeal").addEventListener("click", () => dealDialog(null, null, render));
  draw();
});

// ---------------------------------------------------------------- follow-ups
route("followups", async () => {
  const horizon = new Date(); horizon.setDate(horizon.getDate() + 7); horizon.setHours(23, 59, 59);
  const h = horizon.toISOString().replace("T", " ");
  const [accts, deals] = await Promise.all([
    pb.collection("accounts").getFullList({ filter: pb.filter("next_followup_at != '' && next_followup_at <= {:h}", { h }), sort: "next_followup_at" }),
    pb.collection("deals").getFullList({ filter: pb.filter("next_followup_at != '' && next_followup_at <= {:h} && stage != 'lost'", { h }), sort: "next_followup_at", expand: "account" }),
  ]);
  // merge by account, earliest date wins
  const map = new Map();
  for (const a of accts) map.set(a.id, { account: a, at: a.next_followup_at, deal: null });
  for (const d of deals) {
    const cur = map.get(d.account);
    if (!cur || toDate(d.next_followup_at) < toDate(cur.at)) map.set(d.account, { account: d.expand.account, at: d.next_followup_at, deal: d });
    else if (!cur.deal) cur.deal = d;
  }
  const rows = [...map.values()].sort((a, b) => toDate(a.at) - toDate(b.at));
  const stale = await pb.collection("accounts").getList(1, 15, {
    filter: pb.filter("last_touch_at != '' && last_touch_at < {:c}", { c: new Date(Date.now() - 21 * 86400000).toISOString().replace("T", " ") }),
    sort: "last_touch_at",
  });

  app.innerHTML = `
    <div class="page-head"><div><h1>Follow-ups</h1><p>Due now and over the next 7 days.</p></div></div>
    <div class="list">
      ${rows.map((r) => `
        <div class="item">
          <div>
            <a class="title" href="#/account/${r.account.id}">${esc(r.account.name)}</a>
            <div class="small ${isOverdue(r.at) ? "due" : "muted"}">${isOverdue(r.at) ? "Due" : "Scheduled"} ${esc(fmtDateTime(r.at))}</div>
            ${r.deal ? `<div class="small"><span class="stage-pill" style="${stageStyle(r.deal.stage)}">${STAGE_LABEL[r.deal.stage]}</span> ${esc(r.deal.next_step || r.deal.title || "")}</div>` : ""}
          </div>
          <div class="actions">
            ${r.account.phone ? `<a class="btn btn-sm" href="tel:${esc(r.account.phone)}">Call</a>` : ""}
            <button class="btn btn-sm btn-primary" data-log="${r.account.id}">Log activity</button>
          </div>
        </div>`).join("") || `<div class="empty">Nothing due this week. Log an activity with a follow-up date to schedule one.</div>`}
    </div>
    <h2 style="margin:28px 0 10px">Going quiet</h2>
    <p class="muted" style="margin-top:-6px">No activity logged in 3 weeks.</p>
    <div class="list">
      ${stale.items.map((a) => `
        <div class="item">
          <div><a class="title" href="#/account/${a.id}">${esc(a.name)}</a><div class="small muted">Last activity ${esc(fmtDate(a.last_touch_at))}${a.area ? " · " + esc(a.area) : ""}</div></div>
          <div class="actions"><button class="btn btn-sm" data-log="${a.id}">Log activity</button></div>
        </div>`).join("") || `<div class="empty">Every account has recent activity.</div>`}
    </div>`;
  $$("[data-log]").forEach((b) => b.addEventListener("click", () => touchDialog(b.dataset.log, render)));
});

// ---------------------------------------------------------------- accounts list
route("accounts", async (_, qs) => {
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Accounts</h1><p>Bars, restaurants, hotels and shops you sell to or want to.</p></div>
      <button class="btn btn-primary" id="newAcc" type="button">New account</button>
    </div>
    <div class="toolbar">
      <input id="aq" type="search" placeholder="Search name, area, address" value="${esc(qs.get("q") || "")}" aria-label="Search accounts">
      <select id="at" aria-label="Type"><option value="">All types</option>${ACCOUNT_TYPES.map((t) => `<option>${t}</option>`).join("")}</select>
    </div>
    <div class="list" id="alist"></div>`;
  const load = async () => {
    const q = $("#aq").value.trim();
    const t = $("#at").value;
    const parts = [];
    if (q) parts.push(pb.filter("(name ~ {:q} || area ~ {:q} || address ~ {:q})", { q }));
    if (t) parts.push(pb.filter("type = {:t}", { t }));
    const res = await pb.collection("accounts").getList(1, 200, { filter: parts.join(" && "), sort: "name" });
    $("#alist").innerHTML = res.items.map((a) => `
      <div class="item">
        <div>
          <a class="title" href="#/account/${a.id}">${esc(a.name)}</a>
          <div class="small muted">${esc([a.type, a.area].filter(Boolean).join(" · "))}</div>
          <div class="small muted">${a.last_touch_at ? "Last activity " + esc(fmtDate(a.last_touch_at)) : "No activity yet"}${a.order_count ? ` · ${a.order_count} orders, last ${esc(fmtDate(a.last_order_at))}` : ""}</div>
        </div>
        <div class="actions"><button class="btn btn-sm" data-log="${a.id}">Log activity</button></div>
      </div>`).join("") || `<div class="empty">No accounts match. Add one, or convert a lead from the Leads page.</div>`;
    $$("[data-log]", $("#alist")).forEach((b) => b.addEventListener("click", () => touchDialog(b.dataset.log, load)));
  };
  let t;
  $("#aq").addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  $("#at").addEventListener("change", load);
  $("#newAcc").addEventListener("click", () => accountDialog(null, (rec) => (location.hash = "#/account/" + rec.id)));
  await load();
});

// ---------------------------------------------------------------- account detail
route("account", async (id) => {
  const [a, contacts, deals, touches] = await Promise.all([
    pb.collection("accounts").getOne(id),
    pb.collection("contacts").getFullList({ filter: pb.filter("account = {:id}", { id }), sort: "-is_primary,name" }),
    pb.collection("deals").getFullList({ filter: pb.filter("account = {:id}", { id }), sort: "-updated" }),
    pb.collection("touches").getList(1, 100, { filter: pb.filter("account = {:id}", { id }), sort: "-occurred_at", expand: "contact,user" }),
  ]);

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(a.name)}</h1>
        <p>${esc([a.type, a.area].filter(Boolean).join(" · "))}${a.next_followup_at ? ` · <span class="${isOverdue(a.next_followup_at) ? "due" : ""}">Follow up ${esc(fmtDateTime(a.next_followup_at))}</span>` : ""}</p>
      </div>
      <div class="row">
        <button class="btn" id="editAcc">Edit</button>
        <button class="btn btn-primary" id="logHere">Log activity</button>
      </div>
    </div>
    <div class="detail">
      <aside>
        <section class="panel">
          <h3>Details</h3>
          <dl class="kv">
            ${a.address ? `<dt>Address</dt><dd>${esc(a.address)}${a.maps_url ? ` <a href="${esc(a.maps_url)}" target="_blank" rel="noopener">Map</a>` : ""}</dd>` : ""}
            ${a.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(a.phone)}">${esc(a.phone)}</a> · <a href="${esc(waLink(a.phone))}" target="_blank" rel="noopener">WhatsApp</a></dd>` : ""}
            ${a.website ? `<dt>Website</dt><dd><a href="${esc(a.website)}" target="_blank" rel="noopener">${esc(a.website.replace(/^https?:\/\//, ""))}</a></dd>` : ""}
            <dt>Orders (12 mo)</dt><dd>${a.order_count ? `${a.order_count} · ${esc(fmtMoney(a.order_total))} · last ${esc(fmtDate(a.last_order_at))}` : "None recorded"}</dd>
            <dt>Loyverse</dt><dd>${a.pos_customer_id ? `Linked <button class="btn btn-sm" id="unlinkSq">Unlink</button>` : `<button class="btn btn-sm" id="linkSq">Link customer</button>`}</dd>
          </dl>
          ${a.notes ? `<p style="white-space:pre-wrap;margin:12px 0 0">${esc(a.notes)}</p>` : ""}
        </section>
        <section class="panel">
          <div class="row" style="justify-content:space-between"><h3>Contacts</h3><button class="btn btn-sm" id="addContact">Add contact</button></div>
          ${contacts.map((c) => `
            <div class="contact">
              <div class="row" style="justify-content:space-between">
                <strong>${esc(c.name)}${c.is_primary ? " ★" : ""}</strong>
                <span class="row"><button class="btn btn-sm" data-edit-contact="${c.id}">Edit</button></span>
              </div>
              ${c.role ? `<div class="small muted">${esc(c.role)}</div>` : ""}
              <div class="small">
                ${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a><br>` : ""}
                ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> ` : ""}
                ${c.whatsapp || c.phone ? `<a href="${esc(waLink(c.whatsapp || c.phone))}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
              </div>
            </div>`).join("") || `<p class="muted small">Add a contact with an email address so Gmail threads are logged here automatically.</p>`}
        </section>
        <section class="panel">
          <div class="row" style="justify-content:space-between"><h3>Deals</h3><button class="btn btn-sm" id="addDeal">Add deal</button></div>
          ${deals.map((d) => `
            <div class="contact">
              <div class="row" style="justify-content:space-between">
                <span><span class="stage-pill" style="${stageStyle(d.stage)}">${STAGE_LABEL[d.stage]}</span> ${esc(d.title || "")}</span>
                <button class="btn btn-sm" data-edit-deal="${d.id}">Edit</button>
              </div>
              <div class="small muted">${[d.value ? fmtMoney(d.value) : "", d.est_liters_month ? d.est_liters_month + " L/mo" : "", d.next_step ? "Next: " + d.next_step : ""].filter(Boolean).map(esc).join(" · ")}</div>
              ${d.stage === "lost" && d.lost_reason ? `<div class="small muted">Lost: ${esc(d.lost_reason)}</div>` : ""}
            </div>`).join("") || `<p class="muted small">No deals yet.</p>`}
        </section>
      </aside>
      <section class="panel">
        <h3>Activity</h3>
        <ul class="timeline">
          ${touches.items.map((t) => `
            <li>
              <div class="t-type">${esc(TOUCH_LABEL[t.type] || t.type)}<span class="dir">${t.direction === "in" ? "from them" : t.direction === "out" ? "from us" : ""}${t.source && t.source !== "manual" ? " · " + esc(t.source) : ""}</span></div>
              <div>
                <div class="t-when">${esc(fmtDateTime(t.occurred_at))}${t.expand?.contact ? " · " + esc(t.expand.contact.name) : ""}${t.expand?.user ? " · " + esc(t.expand.user.name || t.expand.user.email) : ""}</div>
                <div style="white-space:pre-wrap">${t.type === "order" && t.amount ? "<strong>" + esc(fmtMoney(t.amount)) + "</strong> " : ""}${esc(t.summary || "")}</div>
                ${t.next_followup_at ? `<div class="small muted">Follow-up set for ${esc(fmtDateTime(t.next_followup_at))}</div>` : ""}
                <div class="row small">
                  ${t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">Open in Gmail</a>` : ""}
                  ${t.source === "manual" ? `<button class="btn btn-sm btn-danger" data-del-touch="${t.id}">Delete</button>` : ""}
                </div>
              </div>
            </li>`).join("") || `<li><div></div><div class="muted">No activity yet. Log your first visit, call or tasting.</div></li>`}
        </ul>
      </section>
    </div>`;

  const reload = () => render();
  $("#logHere").addEventListener("click", () => touchDialog(id, reload));
  $("#editAcc").addEventListener("click", () => accountDialog(a, reload));
  $("#addContact").addEventListener("click", () => contactDialog(id, null, reload));
  $$("[data-edit-contact]").forEach((b) => b.addEventListener("click", () => contactDialog(id, contacts.find((c) => c.id === b.dataset.editContact), reload)));
  $("#addDeal").addEventListener("click", () => dealDialog(id, null, reload));
  $$("[data-edit-deal]").forEach((b) => b.addEventListener("click", () => dealDialog(id, deals.find((d) => d.id === b.dataset.editDeal), reload)));
  $$("[data-del-touch]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this activity?")) return;
    await busy(b, () => pb.collection("touches").delete(b.dataset.delTouch));
    toast("Activity deleted"); reload();
  }));
  const link = $("#linkSq");
  if (link) link.addEventListener("click", () => posLinkDialog(a, reload));
  const unlink = $("#unlinkSq");
  if (unlink) unlink.addEventListener("click", async () => { await busy(unlink, () => pb.collection("accounts").update(id, { pos_customer_id: "" })); toast("Loyverse customer unlinked"); reload(); });
});

// ---------------------------------------------------------------- dialogs
async function touchDialog(accountId, done) {
  let accountPicker = "";
  let contacts = [], deals = [];
  if (!accountId) {
    const accts = await pb.collection("accounts").getFullList({ sort: "name", fields: "id,name,area" });
    if (!accts.length) return toast("Add an account first.", true);
    accountPicker = `<label>Account<select name="account" id="tAcc" required>${accts.map((a) => `<option value="${a.id}">${esc(a.name)}${a.area ? " — " + esc(a.area) : ""}</option>`).join("")}</select></label>`;
    accountId = accts[0].id;
  }
  const loadRefs = async (aid) => {
    [contacts, deals] = await Promise.all([
      pb.collection("contacts").getFullList({ filter: pb.filter("account = {:a}", { a: aid }), sort: "-is_primary,name" }),
      pb.collection("deals").getFullList({ filter: pb.filter("account = {:a} && stage != 'lost'", { a: aid }), sort: "-updated" }),
    ]);
  };
  await loadRefs(accountId);
  const refOpts = () => ({
    c: `<option value="">—</option>` + contacts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(""),
    d: `<option value="">—</option>` + deals.map((d, i) => `<option value="${d.id}" ${i === 0 ? "selected" : ""}>${esc(STAGE_LABEL[d.stage])}: ${esc(d.title || "deal")}</option>`).join(""),
  });
  const o = refOpts();
  const dlg = openDialog(`
    <form class="form">
      <h2>Log activity</h2>
      ${accountPicker}
      <div class="grid-3">
        <label>Type<select name="type">${options(TOUCH_TYPES, "visit")}</select></label>
        <label>Direction<select name="direction"><option value="out">We reached out</option><option value="in">They reached out</option></select></label>
        <label>When<input type="datetime-local" name="occurred_at" value="${toLocalInput()}"></label>
      </div>
      <div class="grid-2">
        <label>Contact<select name="contact" id="tContact">${o.c}</select></label>
        <label>Deal<select name="deal" id="tDeal">${o.d}</select></label>
      </div>
      <label>What happened<textarea name="summary" placeholder="Met the owner, left samples of the IPA, wants a quote for 2 taps"></textarea></label>
      <label>Next follow-up<input type="datetime-local" name="next_followup_at"></label>
      <div class="chips" aria-label="Quick follow-up">
        ${[[2, "In 2 days"], [7, "In a week"], [14, "In 2 weeks"], [30, "In a month"]].map(([n, l]) => `<button type="button" class="chip" data-fu="${n}">${l}</button>`).join("")}
      </div>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save activity</button></div>
    </form>`, async (data) => {
    if (!accountPicker) data.account = accountId;
    for (const k of ["contact", "deal", "next_followup_at"]) if (!data[k]) delete data[k];
    await pb.collection("touches").create(data);
    toast("Activity saved");
    done && done();
  });
  $$("[data-fu]", dlg).forEach((b) => b.addEventListener("click", () => {
    const d = new Date(); d.setDate(d.getDate() + Number(b.dataset.fu)); d.setHours(10, 0, 0, 0);
    $("[name=next_followup_at]", dlg).value = toLocalInput(d.toISOString());
  }));
  const sel = $("#tAcc", dlg);
  if (sel) sel.addEventListener("change", async () => {
    await loadRefs(sel.value);
    const o2 = refOpts();
    $("#tContact", dlg).innerHTML = o2.c;
    $("#tDeal", dlg).innerHTML = o2.d;
  });
}

function accountDialog(a, done) {
  a = a || {};
  openDialog(`
    <form class="form">
      <h2>${a.id ? "Edit account" : "New account"}</h2>
      <label>Name<input name="name" required value="${esc(a.name)}"></label>
      <div class="grid-2">
        <label>Type<select name="type">${options(ACCOUNT_TYPES.map((t) => [t, t]), a.type || "bar")}</select></label>
        <label>Area (canton / town)<input name="area" value="${esc(a.area)}"></label>
      </div>
      <label>Address<input name="address" value="${esc(a.address)}"></label>
      <div class="grid-2">
        <label>Phone<input name="phone" type="tel" value="${esc(a.phone)}"></label>
        <label>Website<input name="website" value="${esc(a.website)}"></label>
      </div>
      <label>Notes<textarea name="notes">${esc(a.notes)}</textarea></label>
      <div class="dlg-actions">
        ${a.id ? `<button type="button" class="btn btn-danger" id="delAcc" style="margin-right:auto">Delete account</button>` : ""}
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">${a.id ? "Save changes" : "Create account"}</button>
      </div>
    </form>`, async (data) => {
    const rec = a.id ? await pb.collection("accounts").update(a.id, data) : await pb.collection("accounts").create(data);
    if (!a.id) await pb.collection("deals").create({ account: rec.id, title: "Draft placement", stage: "prospect" });
    toast(a.id ? "Account saved" : "Account created");
    done && done(rec);
  });
  const del = $("#delAcc");
  if (del) del.addEventListener("click", async () => {
    if (!confirm(`Delete ${a.name} with its contacts, deals and activity? This cannot be undone.`)) return;
    await busy(del, () => pb.collection("accounts").delete(a.id));
    $("#dlg").close(); toast("Account deleted"); location.hash = "#/accounts";
  });
}

function contactDialog(accountId, c, done) {
  c = c || {};
  openDialog(`
    <form class="form">
      <h2>${c.id ? "Edit contact" : "Add contact"}</h2>
      <div class="grid-2">
        <label>Name<input name="name" required value="${esc(c.name)}"></label>
        <label>Role<input name="role" placeholder="Owner, bar manager…" value="${esc(c.role)}"></label>
      </div>
      <label>Email<input name="email" type="email" value="${esc(c.email)}"></label>
      <div class="grid-2">
        <label>Phone<input name="phone" type="tel" value="${esc(c.phone)}"></label>
        <label>WhatsApp (if different)<input name="whatsapp" type="tel" value="${esc(c.whatsapp)}"></label>
      </div>
      <label class="row" style="display:flex"><input type="checkbox" name="is_primary" ${c.is_primary ? "checked" : ""} style="width:auto;min-height:0"> Main contact</label>
      <div class="dlg-actions">
        ${c.id ? `<button type="button" class="btn btn-danger" id="delC" style="margin-right:auto">Delete</button>` : ""}
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">Save contact</button>
      </div>
    </form>`, async (data) => {
    data.account = accountId;
    if (c.id) await pb.collection("contacts").update(c.id, data); else await pb.collection("contacts").create(data);
    toast("Contact saved"); done && done();
  });
  const del = $("#delC");
  if (del) del.addEventListener("click", async () => {
    if (!confirm("Delete this contact?")) return;
    await busy(del, () => pb.collection("contacts").delete(c.id));
    $("#dlg").close(); toast("Contact deleted"); done && done();
  });
}

async function dealDialog(accountId, d, done) {
  d = d || {};
  let picker = "";
  if (!accountId) {
    const accts = await pb.collection("accounts").getFullList({ sort: "name", fields: "id,name" });
    if (!accts.length) return toast("Add an account first.", true);
    picker = `<label>Account<select name="account">${accts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></label>`;
  }
  openDialog(`
    <form class="form">
      <h2>${d.id ? "Edit deal" : "New deal"}</h2>
      ${picker}
      <div class="grid-2">
        <label>Title<input name="title" placeholder="2 taps, seasonal rotation" value="${esc(d.title)}"></label>
        <label>Stage<select name="stage">${options(STAGES, d.stage || "prospect")}</select></label>
      </div>
      <div class="grid-2">
        <label>Value per month (${esc(STATUS.currency || "CRC")})<input name="value" type="number" min="0" step="any" value="${d.value ?? ""}"></label>
        <label>Est. liters per month<input name="est_liters_month" type="number" min="0" step="any" value="${d.est_liters_month ?? ""}"></label>
      </div>
      <label>Next step<input name="next_step" value="${esc(d.next_step)}"></label>
      <label>Next follow-up<input type="datetime-local" name="next_followup_at" value="${d.next_followup_at ? toLocalInput(d.next_followup_at) : ""}"></label>
      <label>Lost reason<input name="lost_reason" value="${esc(d.lost_reason)}"></label>
      <div class="dlg-actions">
        ${d.id ? `<button type="button" class="btn btn-danger" id="delD" style="margin-right:auto">Delete</button>` : ""}
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">Save deal</button>
      </div>
    </form>`, async (data) => {
    if (accountId) data.account = accountId;
    if (d.id) await pb.collection("deals").update(d.id, data); else await pb.collection("deals").create(data);
    toast("Deal saved"); done && done();
  });
  const del = $("#delD");
  if (del) del.addEventListener("click", async () => {
    if (!confirm("Delete this deal?")) return;
    await busy(del, () => pb.collection("deals").delete(d.id));
    $("#dlg").close(); toast("Deal deleted"); done && done();
  });
}

function posLinkDialog(a, done) {
  const dlg = openDialog(`
    <form class="form">
      <h2>Link Loyverse customer</h2>
      <p class="muted" style="margin:0">Receipts in Loyverse with this customer attached will update order history and move the deal stage.</p>
      <div class="row"><input id="sqq" placeholder="Search by name, email, phone or code" value="${esc(a.name)}" style="flex:1"><button type="button" class="btn" id="sqgo">Search</button></div>
      <div class="list" id="sqres"><div class="empty">Search to see matches.</div></div>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Close</button></div>
    </form>`);
  const go = async () => {
    const res = await busy($("#sqgo", dlg), () => api("/pos/customers?q=" + encodeURIComponent($("#sqq", dlg).value)));
    $("#sqres", dlg).innerHTML = res.map((c) => `
      <div class="item"><div><strong>${esc(c.label)}</strong><div class="small muted">${esc([c.code, c.email, c.phone, c.total_visits ? c.total_visits + " visits" : ""].filter(Boolean).join(" · "))}</div></div>
      <div class="actions"><button type="button" class="btn btn-sm btn-primary" data-sq="${esc(c.id)}">Link</button></div></div>`).join("") || `<div class="empty">No matching customers. Add the customer in Loyverse Back Office → Customers first.</div>`;
    $$("[data-sq]", dlg).forEach((b) => b.addEventListener("click", async () => {
      await busy(b, () => pb.collection("accounts").update(a.id, { pos_customer_id: b.dataset.sq }));
      dlg.close(); toast("Loyverse customer linked. Importing receipts…");
      try { await api("/sync/pos", { method: "POST" }); } catch (e) { toast(errMsg(e), true); }
      done && done();
    }));
  };
  $("#sqgo", dlg).addEventListener("click", go);
  $("form", dlg).addEventListener("submit", (ev) => { ev.preventDefault(); go(); });
}

// ---------------------------------------------------------------- leads
route("leads", async (_, qs) => {
  await loadStatus();
  const p = STATUS.places || {};
  const status = qs.get("status") || "new";
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Leads</h1><p>Find bars, restaurants and shops near you on Google Maps, then turn the good ones into accounts.</p></div>
    </div>
    <section class="panel" style="margin-bottom:16px">
      ${p.configured ? "" : envWarning(["GOOGLE_PLACES_API_KEY"], "search Google Maps for leads")}
      <form id="lsForm" class="form">
        <div class="grid-2">
          <label>What<input id="lsWhat" placeholder="bar, restaurante, licorera…" required></label>
          <label>Where<input id="lsWhere" placeholder="Escazú, Heredia, Tamarindo…"></label>
        </div>
        <div class="chips">${LEAD_PRESETS.map((t) => `<button type="button" class="chip" data-preset="${esc(t)}">${esc(t)}</button>`).join("")}</div>
        <div class="row">
          <button class="btn btn-primary" type="submit">Search Google Maps</button>
          <button class="btn" type="button" id="lsMore" hidden>Load 20 more</button>
          <span class="small muted" id="lsUsage" style="margin-left:auto">${p.search_used ?? 0} of ${p.search_limit ?? "—"} searches used in ${esc(p.month || "")}</span>
        </div>
        <div class="meter" aria-hidden="true"><span id="lsMeter" style="width:${Math.min(100, ((p.search_used || 0) / (p.search_limit || 1)) * 100)}%"></span></div>
      </form>
    </section>
    <div class="toolbar">
      <select id="lStatus" aria-label="Lead status">${options([["new", "New"], ["converted", "Converted"], ["dismissed", "Dismissed"]], status)}</select>
      <input id="lFilter" type="search" placeholder="Filter by name, area or type" aria-label="Filter leads">
    </div>
    <div class="list" id="llist"></div>`;

  let nextToken = "", lastQuery = "";
  const load = async () => {
    const st = $("#lStatus").value;
    const q = $("#lFilter").value.trim();
    const parts = [pb.filter("status = {:s}", { s: st })];
    if (q) parts.push(pb.filter("(name ~ {:q} || area ~ {:q} || primary_type ~ {:q} || address ~ {:q})", { q }));
    const res = await pb.collection("leads").getList(1, 200, { filter: parts.join(" && "), sort: "-created" });
    $("#llist").innerHTML = res.items.map((l) => `
      <div class="item">
        <div>
          <strong>${esc(l.name)}</strong> <span class="small muted">${esc((l.primary_type || "").replace(/_/g, " "))}</span>
          <div class="small muted">${esc(l.address)}</div>
          <div class="small row">
            ${l.maps_url ? `<a href="${esc(l.maps_url)}" target="_blank" rel="noopener">Map</a>` : ""}
            ${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a> <a href="${esc(waLink(l.phone))}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
            ${l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener">Website</a>` : ""}
            ${l.account ? `<a href="#/account/${l.account}">Open account</a>` : ""}
          </div>
        </div>
        <div class="actions">
          ${l.status === "new" ? `
            ${!l.phone && !l.website ? `<button class="btn btn-sm" data-enrich="${l.id}" title="Uses 1 of ${p.details_limit} monthly detail lookups">Get phone</button>` : ""}
            <button class="btn btn-sm" data-dismiss="${l.id}">Dismiss</button>
            <button class="btn btn-sm btn-primary" data-convert="${l.id}">Add as account</button>` : ""}
          ${l.status === "dismissed" ? `<button class="btn btn-sm" data-restore="${l.id}">Restore</button>` : ""}
        </div>
      </div>`).join("") || `<div class="empty">${st === "new" ? "No new leads. Search above to find places in your area." : "Nothing here yet."}</div>`;
  };

  const search = async (pageToken) => {
    const what = $("#lsWhat").value.trim();
    const where = $("#lsWhere").value.trim();
    const query = pageToken ? lastQuery : [what, where].filter(Boolean).join(" en ");
    const btn = pageToken ? $("#lsMore") : $("#lsForm button[type=submit]");
    const res = await busy(btn, () => api("/leads/search", { method: "POST", body: { query, pageToken: pageToken || "" } }));
    lastQuery = query; nextToken = res.nextPageToken;
    $("#lsMore").hidden = !nextToken;
    toast(`${res.created} new ${res.created === 1 ? "lead" : "leads"}${res.skipped ? `, ${res.skipped} already known or closed` : ""}`);
    $("#lStatus").value = "new";
    await load();
    await loadStatus();
    const u = STATUS.places || {};
    $("#lsUsage").textContent = `${u.search_used} of ${u.search_limit} searches used in ${u.month}`;
    $("#lsMeter").style.width = Math.min(100, (u.search_used / (u.search_limit || 1)) * 100) + "%";
  };

  $("#lsForm").addEventListener("submit", (ev) => { ev.preventDefault(); search(); });
  $("#lsMore").addEventListener("click", () => nextToken && search(nextToken));
  $$("[data-preset]").forEach((b) => b.addEventListener("click", () => { $("#lsWhat").value = b.dataset.preset; $("#lsWhere").focus(); }));
  $("#lStatus").addEventListener("change", load);
  let t; $("#lFilter").addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  $("#llist").addEventListener("click", async (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.convert) {
      const r = await busy(b, () => api(`/leads/${b.dataset.convert}/convert`, { method: "POST" }));
      toast("Account created"); location.hash = "#/account/" + r.account;
    } else if (b.dataset.dismiss) {
      await busy(b, () => pb.collection("leads").update(b.dataset.dismiss, { status: "dismissed" })); load();
    } else if (b.dataset.restore) {
      await busy(b, () => pb.collection("leads").update(b.dataset.restore, { status: "new" })); load();
    } else if (b.dataset.enrich) {
      const r = await busy(b, () => api(`/leads/${b.dataset.enrich}/enrich`, { method: "POST" }));
      toast(r.phone || r.website ? "Contact details added" : "Google has no phone or website for this place"); load();
    }
  });
  await load();
});

// ---------------------------------------------------------------- settings
route("settings", async (_, qs) => {
  await loadStatus();
  const s = STATUS;
  const g = qs.get("google");
  if (g) { toast(g === "connected" ? "Gmail connected" : "Gmail: " + g, g !== "connected"); history.replaceState(null, "", "#/settings"); }
  const ago = (ms) => (ms ? new Date(ms).toLocaleString() : "never");
  const missing = [
    !s.google?.configured && "Gmail",
    !s.pos?.configured && "Loyverse POS",
    !s.places?.configured && "Google Maps lead search",
    !s.mail?.configured && "Password reset emails",
  ].filter(Boolean);
  const setupClass = (ok) => (ok ? "panel" : "panel needs-setup");
  app.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Signed in as ${esc(pb.authStore.record?.email || "")}</p></div>
      <button class="btn" id="logout">Sign out</button></div>
    ${missing.length ? `<div class="env-warn env-warn-summary" role="alert"><strong>${missing.length} ${missing.length === 1 ? "integration needs" : "integrations need"} setup:</strong> ${esc(missing.join(", "))}. Each one is marked below.</div>` : ""}
    <div class="grid-2" style="align-items:start">
      <section class="${setupClass(s.google?.configured)}">
        <h3>Gmail</h3>
        ${s.google?.configured ? "" : envWarning(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], "log emails with your contacts")}
        <p>${s.google?.connected ? `Connected as <strong>${esc(s.google.email)}</strong>. Emails to and from your contacts are logged every 15 minutes.` : "Not connected. Connect to log emails with your contacts automatically (read-only access)."}</p>
        <p class="small muted">Last sync: ${esc(ago(s.google?.last_sync))}</p>
        <div class="row">
          ${s.google?.connected
            ? `<button class="btn" id="gSync">Sync now</button><button class="btn btn-danger" id="gDisc">Disconnect</button>`
            : `<button class="btn btn-primary" id="gConn" ${s.google?.configured ? "" : "disabled"}>Connect Gmail</button>`}
        </div>
      </section>
      <section class="${setupClass(s.pos?.configured)}">
        <h3>Loyverse POS</h3>
        ${s.pos?.configured ? `<p>Configured. Receipts for linked accounts sync every hour.</p>` : envWarning(["LOYVERSE_ACCESS_TOKEN"], "pull order history")}
        <p class="small muted">Last sync: ${esc(ago(s.pos?.last_sync))} · Deals go dormant after ${s.dormant_days} days without an order.</p>
        <button class="btn" id="sqSync" ${s.pos?.configured ? "" : "disabled"}>Sync now</button>
      </section>
      <section class="${setupClass(s.places?.configured)}">
        <h3>Google Maps lead search</h3>
        ${s.places?.configured ? `<p>Configured.</p>` : envWarning(["GOOGLE_PLACES_API_KEY"], "search Google Maps for leads")}
        <p class="small">Searches this month: ${s.places?.search_used} of ${s.places?.search_limit}<br>Phone lookups this month: ${s.places?.details_used} of ${s.places?.details_limit}</p>
        <p class="small muted">Caps stay below Google's free monthly allowance. Change them in .env.</p>
      </section>
      <section class="panel">
        <h3>Your password</h3>
        <form class="form" id="pwForm">
          <label>Current password<input name="oldPassword" type="password" autocomplete="current-password" required></label>
          ${newPasswordFields(null, pb.authStore.record?.email).html}
          <div><button class="btn btn-primary" type="submit">Change password</button></div>
        </form>
      </section>
      <section class="${setupClass(s.mail?.configured)}">
        <h3>Password reset emails</h3>
        ${s.mail?.configured
          ? `<p>On. "Forgot password?" emails a reset link from <strong>${esc(s.mail.sender || "your mail server")}</strong>.</p>`
          : envWarning(["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"], "email password-reset links") + `<p class="small muted">Or set up mail in the <a href="/_/#/settings/mail" target="_blank" rel="noopener">admin dashboard</a>. Until then, reset a password by setting a temporary one for the user in the admin dashboard.</p>`}
      </section>
      <section class="panel">
        <h3>Users and backups</h3>
        <p>Add sales users, export data and schedule backups in the <a href="/_/" target="_blank" rel="noopener">admin dashboard</a>.</p>
        <p class="small muted">New users and passwords you set there are temporary: the user picks their own at the next sign-in. Passwords need ${PUBLIC.password_min}+ characters with a letter and a number, plus a symbol unless they're ${PUBLIC.password_long}+ characters. The dashboard's "Generate" button makes a password that meets this (rarely it won't have a number; just generate again).</p>
      </section>
    </div>`;
  const pwForm = $("#pwForm");
  const pwValid = newPasswordFields(pwForm, pb.authStore.record?.email).wire();
  pwForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!pwValid()) return;
    const f = formData(pwForm);
    try { await busy($("button[type=submit]", pwForm), () => changeOwnPassword(f.oldPassword, f.password)); } catch (_) { return; }
    pwForm.reset(); $("[data-pw-new]", pwForm).dispatchEvent(new Event("input"));
    toast("Password changed");
  });
  $("#logout").addEventListener("click", () => { pb.authStore.clear(); location.hash = ""; render(); });
  const conn = $("#gConn");
  if (conn) conn.addEventListener("click", async () => { const r = await busy(conn, () => api("/google/auth-url")); location.href = r.url; });
  const gs = $("#gSync");
  if (gs) gs.addEventListener("click", async () => { const r = await busy(gs, () => api("/sync/gmail", { method: "POST" })); toast(`${r.created ?? 0} new emails logged`); render(); });
  const gd = $("#gDisc");
  if (gd) gd.addEventListener("click", async () => { if (!confirm("Disconnect Gmail?")) return; await busy(gd, () => api("/google/disconnect", { method: "POST" })); render(); });
  const sq = $("#sqSync");
  if (sq) sq.addEventListener("click", async () => { const r = await busy(sq, () => api("/sync/pos", { method: "POST" })); toast(r.note || r.skipped || `${r.updated} accounts updated, ${r.created} new receipts`); render(); });
});

// ---------------------------------------------------------------- password show/hide
// Adds a Show/Hide button to every password field as it appears. The button sits outside the
// <label> so the field's accessible name stays exactly the label text.
function addPasswordToggle(input) {
  const label = input.closest("label");
  if (!label || input.dataset.pwToggle) return;
  input.dataset.pwToggle = "1";
  const name = (label.firstChild?.textContent || "password").trim().toLowerCase();
  const wrap = document.createElement("div");
  wrap.className = "pw-field";
  label.replaceWith(wrap);
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "pw-toggle";
  const set = (show) => {
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", `${show ? "Hide" : "Show"} ${name}`);
    btn.setAttribute("aria-pressed", String(show));
  };
  set(false);
  btn.addEventListener("click", () => { set(input.type === "password"); input.focus(); });
  wrap.append(label, btn);
  input.form?.addEventListener("reset", () => set(false)); // after re-attaching: detached inputs have no form
}
new MutationObserver(() => $$("input[type=password]:not([data-pw-toggle])").forEach(addPasswordToggle))
  .observe(document.body, { childList: true, subtree: true });
$$("input[type=password]").forEach(addPasswordToggle);

// ---------------------------------------------------------------- boot
$("#quickLog").addEventListener("click", () => {
  const m = location.hash.match(/^#\/account\/(\w+)/);
  touchDialog(m ? m[1] : null, render);
});

(async () => {
  await publicConfig;
  if (pb.authStore.isValid) {
    try { await pb.collection("users").authRefresh(); } catch (_) { pb.authStore.clear(); }
    await loadStatus();
  }
  render();
})();
