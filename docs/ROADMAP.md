# BrewCRM roadmap

Prioritized from a review of the code, the deployment (QNAP + hotpot + logwatch) and how a small brewery sells. Effort: **S** about a day or less, **M** a few days, **L** a week or more.

## P0: before relying on it in production

| # | Improvement | Why | Effort |
|---|---|---|---|
| 1 | **Cut the first release**: tag `v0.1.0` (publishes to GHCR unless Docker Hub is configured) | There's no image for the NAS to pull yet | S |
| 2 | **Restrict the admin dashboard (`/_/`)** to LAN/VPN addresses (`ADMIN_ALLOW_CIDRS`) and turn on PocketBase MFA for superusers | Through hotpot, `/_/` is reachable from the internet and protected only by a password | S |
| 3 | **Trusted proxy header from `.env`** (`TRUSTED_PROXY_HEADERS=X-Real-IP`) applied at startup | Today it's a manual `/_/` step. Without it, rate limits and logwatch see every visitor as hotpot's IP | S |
| 4 | **Encrypt secrets at rest.** Run PocketBase with `--encryptionEnv` (encrypts settings, e.g. the SMTP password) and encrypt the Gmail refresh token stored in `kv` | Anyone with a copy of `pb_data` or a backup can read the mailbox token | M |
| 5 | **Off-NAS backups**: scheduled PocketBase backups to S3/Backblaze configured from `.env`, plus a tested restore procedure | A NAS failure or ransomware currently loses everything | S |
| 6 | **Self-host the fonts and add security headers** (CSP, `X-Frame-Options`, `Referrer-Policy`) | Removes the Google Fonts call (privacy, works offline) and hardens against injected content | S |
| 7 | **Plan the PocketBase upgrade path.** The 0.40.6 changelog says later releases won't be on GitHub; Dependabot can't track it | The Dockerfile and `fetch-pocketbase.sh` download URLs will need to change; add a scheduled check that opens an issue for new versions | S |

## P1: biggest gains for selling beer

| # | Improvement | Why | Effort |
|---|---|---|---|
| 8 | **Daily follow-up email** per user: due today, overdue, going quiet | Mail is now configured; most CRM value comes from not missing follow-ups | S |
| 9 | **Spanish UI** (es/en toggle) | Sales staff and buyers in Costa Rica work in Spanish | M |
| 10 | **CSV import/export** of accounts and contacts | Load the existing customer list on day one; export for the accountant or a backup | M |
| 11 | **Keg tracking** per account: kegs out, deposits, returns, overdue kegs | Lost kegs are a real cost for a small brewery, and the account page is the natural place for it | M |
| 12 | **Capacity check**: committed L/month from active deals vs. brewhouse output (7 bbl ≈ 820 L/brew; 20 brews/yr ≈ 1,370 L/month) | Warns before the pipeline promises more beer than you can brew | S |
| 13 | **Products and tap lists per account**, using Loyverse items as the catalog | Shows which beers each account pours and when to pitch a rotation | M |
| 14 | **Map of accounts and leads, with visit routes** by area | Plan a day of visits in Escazú or Heredia instead of working from a list | M |
| 15 | **Google Calendar** events for follow-ups | You already use Google Workspace; reminders show up where you look | M |
| 16 | **Per-user Gmail** connections | Today one mailbox is connected for the whole team, so other reps' emails aren't logged | M |
| 17 | **Loyverse match suggestions**: propose the customer whose email or phone matches a contact | Linking customers is manual today | S |
| 18 | **"Near me" lead search** (Places location bias / radius) | Better leads than a text query when you're out on visits | S |
| 19 | **Offline visit logging** (installable PWA with queued writes) | Coverage is patchy outside the Central Valley | L |

## P2: polish and scale

| # | Improvement | Why | Effort |
|---|---|---|---|
| 20 | Reports: pipeline value by stage, win rate, days per stage (`stage_changed_at` exists), monthly orders/liters from Loyverse | Answers "is it working?" | M |
| 21 | Pagination and server-side search beyond 200 accounts/leads | Lists load the first 200 rows only | S |
| 22 | "My accounts" view, owner assignment and reassignment | Useful once there's more than one rep | S |
| 23 | Activity history of edits (who moved a deal, when) | Accountability with multiple users | S |
| 24 | Duplicate detection and merge for accounts (name + area) | Manual entry and lead conversion can create duplicates | M |
| 25 | Attachments (menu photos, price sheets) using PocketBase file fields | Common in field sales | S |
| 26 | USD support per deal | Hotels often buy in dollars | S |
| 27 | Accessibility: focus trap in dialogs, toasts announced to screen readers | Basics are in place; finish the job | S |
| 28 | WhatsApp Business API logging | Most buyer conversations happen there; logging is manual | L |

## Engineering

| # | Improvement | Why | Effort |
|---|---|---|---|
| 29 | Split `pb_hooks/lib/crm.js` (~730 lines) into places / gmail / loyverse / auth modules | Easier to change one integration safely | S |
| 30 | `// @ts-check` with PocketBase's generated `types.d.ts`, plus ESLint | Catches API misuse before runtime | S |
| 31 | Run the e2e suite against the built Docker image too | Smoke tests cover the image; the full suite runs against the bare binary | S |
| 32 | Contract samples for Places, Gmail and Loyverse responses | Keeps the test fakes honest when the APIs change | M |
| 33 | Remove the unused `.github/actions/release-notes` copy (template-only) | Dead code inherited from repo-template | S |

## Testing (done in this change)

- **Unit:** `npm run test:unit` covers `pb_hooks/` (routes, hooks, cron, all integrations), `pb_migrations/` and `scripts/build.mjs` against an in-memory PocketBase fake (`tests/unit/pbfake.mjs`). Gate: 90% lines/functions, 85% branches.
- **E2E:** `npm run test:e2e` runs 23 Playwright flows against a real PocketBase with fake Places/Gmail/OAuth/Loyverse servers and measures `pb_public/app.js` from Chromium's V8 coverage. Gate: 90% lines/functions, 85% branches.
- **Python:** release-notes scripts tested against a real temporary git repo. Gate: 90%.
