# BrewCRM

[![CI](https://github.com/dwightmulcahy/brewcrm/actions/workflows/ci.yml/badge.svg)](https://github.com/dwightmulcahy/brewcrm/actions/workflows/ci.yml)
[![Release](https://github.com/dwightmulcahy/brewcrm/actions/workflows/release.yml/badge.svg)](https://github.com/dwightmulcahy/brewcrm/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/dwightmulcahy/brewcrm?sort=semver)](https://github.com/dwightmulcahy/brewcrm/releases/latest)
[![Docker Image Version](https://img.shields.io/docker/v/dwightmulcahy/brewcrm?sort=semver&label=docker)](https://hub.docker.com/r/dwightmulcahy/brewcrm)
[![Docker Pulls](https://img.shields.io/docker/pulls/dwightmulcahy/brewcrm)](https://hub.docker.com/r/dwightmulcahy/brewcrm)
[![Image Size](https://img.shields.io/docker/image-size/dwightmulcahy/brewcrm/latest)](https://hub.docker.com/r/dwightmulcahy/brewcrm)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025e8c?logo=dependabot)](.github/dependabot.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Lightweight, self-hosted sales CRM for a small craft brewery: track visits, calls, WhatsApp, emails and tastings, run a pipeline, and find new accounts on Google Maps. Built for a QNAP NAS in Docker, reachable from the web through Cloudflare Tunnel.

- **Pipeline** board: Prospect → Contacted → Sampling → Proposal → First order → Recurring → Dormant / Lost
- **Activity log**: visits, calls, WhatsApp, email, tastings, events, orders, with follow-up dates
- **Follow-ups**: what's due this week, plus accounts going quiet
- **Leads**: search Google Maps (Places API) for bars, restaurants, hotels, licoreras in any area; convert to accounts
- **Gmail**: emails to and from your contacts are logged automatically (read-only, every 15 min)
- **Loyverse POS**: receipts per account (hourly); deals auto-advance to First order / Recurring and go Dormant after N days without orders

Stack: [PocketBase](https://pocketbase.io) 0.40.6 (single Go binary, SQLite) + JS hooks + vanilla JS front-end.

```
pb_migrations/   schema (accounts, contacts, deals, touches, leads, kv)
pb_hooks/        API routes, Gmail / Loyverse / Places integrations, cron jobs, /health
pb_public/       web app
scripts/build.mjs  packages the web (Docker) and offline editions
tests/           pytest (build + policy) and Playwright smoke tests
```

## Quick start

```bash
cp .env.example .env      # set PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD at minimum
docker compose up -d --build
curl http://localhost:8080/health
```

Open `http://localhost:8080/_/` (admin) → **Collections → users → New record** for each salesperson. Public sign-up is disabled. Sales users sign in at `http://localhost:8080/`.

Both Compose files run with a read-only root filesystem, dropped capabilities, `no-new-privileges`, bounded memory/PIDs, an init process, a graceful shutdown window, and rotated JSON logs. The app runs as uid 1000 and writes only to `/data`.

## QNAP (TS-453, x86_64)

1. App Center → install **Container Station**.
2. Create the folder and data dir, and make the data dir writable by the container user (SSH):
   ```sh
   mkdir -p /share/Container/brewcrm/data
   chown -R 1000:100 /share/Container/brewcrm/data
   ```
3. Put `compose.qnap.yaml` and `.env` (from `.env.example`) in `/share/Container/brewcrm`. Set `IMAGE`, `APP_URL`, `PB_ADMIN_EMAIL`, `PB_ADMIN_PASSWORD`.
4. Start:
   ```sh
   cd /share/Container/brewcrm
   docker compose -f compose.qnap.yaml pull
   docker compose -f compose.qnap.yaml --profile tunnel up -d   # omit --profile tunnel for LAN only
   ```
   Or Container Station → Applications → Create → paste `compose.qnap.yaml`.
5. Open `http://<nas-ip>:8080/_/`.

Upgrade: bump the tag in `IMAGE` (or keep `:latest`), then `pull` + `up -d`. Data in `QNAP_DATA_DIR` survives upgrades.

## Web access: Cloudflare Tunnel (free)

No port forwarding, works behind ISP CGNAT, HTTPS automatic.

1. Add your domain to Cloudflare (free plan).
2. Zero Trust → Networks → Tunnels → **Create tunnel** (Cloudflared) → copy the token into `CLOUDFLARE_TUNNEL_TOKEN`.
3. Public hostname: `crm.yourdomain.com` → Service `HTTP` → `brewcrm:8080`.
4. Set `APP_URL=https://crm.yourdomain.com`; start with `--profile tunnel`.
5. **Recommended:** Zero Trust → Access → Applications → add `crm.yourdomain.com/_/*` with a policy allowing only your email, putting a second login in front of the admin dashboard.
   Do **not** put an Access policy on `/api/crm/google/callback`, or the Gmail connection will fail.
6. Admin → Settings → Application → Trusted proxy → **Trusted IP proxy headers**: `CF-Connecting-IP`.

Do not expose QTS admin ports to the internet.

## Google Maps lead search (Places API New)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project → Billing: attach a billing account (required even for free usage).
2. APIs & Services → Library → enable **Places API (New)**.
3. Credentials → Create API key → restrict it to **Places API (New)** → `GOOGLE_PLACES_API_KEY`.
4. Optional safety net: Places API (New) → Quotas → cap "Text Search requests per day" (e.g. 150).

Searches use only Pro-tier fields (5,000 free/month); phone/website are fetched only when you click **Get phone** (Enterprise tier, 1,000 free/month). The app refuses calls past `PLACES_SEARCH_MONTHLY_LIMIT` / `PLACES_DETAILS_MONTHLY_LIMIT`.

## Gmail

1. Same Google Cloud project → enable **Gmail API**.
2. OAuth consent screen:
   - **Google Workspace account** → User type **Internal**.
   - **@gmail.com account** → User type **External**, add yourself as a test user, then **Publish app** ("In production"). In "Testing" status Google expires the refresh token after 7 days. An "unverified app" warning on connect is expected for a private app.
3. Credentials → Create OAuth client ID → **Web application** → redirect URI `https://crm.yourdomain.com/api/crm/google/callback`.
4. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, restart, then **Settings → Connect Gmail**.

Logged: messages where a contact's email is the sender or a recipient (first sync: last `GMAIL_LOOKBACK_DAYS`). Subject + snippet only; no bodies stored.

## Loyverse POS

1. Loyverse Back Office → **Access tokens** → **+ Add access token** → `LOYVERSE_ACCESS_TOKEN`.
   The API may require the Integrations add-on on your plan; a "402" error in sync means that.
2. Each wholesale buyer must exist under **Customers** and be **added to the ticket** at sale time. Receipts without a customer are ignored.
3. In BrewCRM: account → **Link customer** → search → Link. The last `LOYVERSE_LOOKBACK_DAYS` (default 365) of receipts import immediately.

Hourly at :07 the app pages receipts updated since the last sync (Loyverse has no per-customer filter) and matches them to linked customers. Each receipt becomes an **Order** activity with line items; refunds are negative; cancelled receipts are removed.

## Automations

| Trigger | Effect |
|---|---|
| Outbound activity on a Prospect deal | Deal → Contacted |
| Tasting on Prospect/Contacted | Deal → Sampling |
| Activity with follow-up date | Account + deal follow-up updated |
| Gmail sync (every 15 min) | Email activities created |
| Loyverse sync (hourly) | Order activities, 12-month totals; any order → First order, 2+ → Recurring |
| Daily 06:15 UTC | No order for `DORMANT_DAYS` → Dormant |

## Backups

Admin → Settings → Backups → enable auto backups (e.g. `0 3 * * *`, keep 7). Files land in `QNAP_DATA_DIR/backups`; include that folder in a QNAP Hybrid Backup Sync job for off-NAS copies.

## Offline edition

Runs on one computer without Docker. Download `*-offline.zip` from [Releases](https://github.com/dwightmulcahy/brewcrm/releases), verify with `sha256sum -c *.sha256`, and follow `OFFLINE.md` inside.

## Development

```bash
npm ci
npm run build:web        # -> dist/web
npm run build:offline    # -> dist/offline
pip install -r requirements-dev.txt && pytest
docker compose up -d --build
npx playwright install chromium
BASE_URL=http://localhost:8080 PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... npm run test:smoke
```

The smoke suite checks `/health`, that sign-up and anonymous data access are blocked, and a full sign-in → new account → log visit → pipeline/follow-up flow.

CI pins every external GitHub Action to a commit SHA, pins the Docker base image by version and digest, verifies the PocketBase download against the release checksums, and rejects fixable high/critical image vulnerabilities with Trivy. PocketBase itself is pinned by `ARG PB_VERSION` in the `Dockerfile` and is not tracked by Dependabot.

## Releasing

1. Merge to `main`.
2. `git tag v1.2.3 && git push origin v1.2.3`
3. The Release workflow verifies the tag is on `main`, reruns CI, and publishes the multi-arch image (`linux/amd64`, `linux/arm64`) to Docker Hub, the offline ZIP + SHA-256, and Conventional Commit release notes.

Required settings: repo variables `DOCKERHUB_USERNAME`, `DOCKERHUB_REPO` (`dwightmulcahy/brewcrm`); secret `DOCKERHUB_TOKEN`.

## API (authenticated)

`GET /api/crm/status` · `POST /api/crm/leads/search {query, pageToken}` · `POST /api/crm/leads/{id}/enrich` · `POST /api/crm/leads/{id}/convert` · `POST /api/crm/sync/gmail` · `POST /api/crm/sync/pos` · `GET /api/crm/pos/customers?q=` · plus PocketBase's REST API for all collections.

## License

[MIT](LICENSE)
