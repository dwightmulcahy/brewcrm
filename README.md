# BrewCRM

[![CI](https://github.com/dwightmulcahy/brewcrm/actions/workflows/ci.yml/badge.svg)](https://github.com/dwightmulcahy/brewcrm/actions/workflows/ci.yml)
[![Release](https://github.com/dwightmulcahy/brewcrm/actions/workflows/release.yml/badge.svg)](https://github.com/dwightmulcahy/brewcrm/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/dwightmulcahy/brewcrm?sort=semver)](https://github.com/dwightmulcahy/brewcrm/releases/latest)
[![Docker Image Version](https://img.shields.io/docker/v/dwightmulcahy/brewcrm?sort=semver&label=docker)](https://hub.docker.com/r/dwightmulcahy/brewcrm)
[![Docker Pulls](https://img.shields.io/docker/pulls/dwightmulcahy/brewcrm)](https://hub.docker.com/r/dwightmulcahy/brewcrm)
[![Image Size](https://img.shields.io/docker/image-size/dwightmulcahy/brewcrm/latest)](https://hub.docker.com/r/dwightmulcahy/brewcrm)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025e8c?logo=dependabot)](.github/dependabot.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Lightweight, self-hosted sales CRM for a small craft brewery: track visits, calls, WhatsApp, emails and tastings, run a pipeline, and find new accounts on Google Maps. Built for a QNAP NAS in Docker, designed to run behind [hotpot](https://github.com/dwightmulcahy/hotpot) with [logwatch](https://github.com/dwightmulcahy/logwatch) reports.

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

Sign in at `http://localhost:8080/` with `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD`. The same credentials open the admin dashboard at `/_/` (type the email in lowercase there). They are re-applied from `.env` on every start, so change the password in `.env`, not in the UI.

Add salespeople in `/_/` → **Collections → users → New record**. Public sign-up is disabled.

The version next to "BrewCRM" is the release tag (e.g. `v1.2.0`) for published images, or `dev` for local builds. To include the commit in a local build: `GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build`.

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
   docker compose -f compose.qnap.yaml up -d
   ```
   Or Container Station → Applications → Create → paste `compose.qnap.yaml`.
5. Open `http://<nas-ip>:8080/_/`.

Upgrade: bump the tag in `IMAGE` (or keep `:latest`), then `pull` + `up -d`. Data in `QNAP_DATA_DIR` survives upgrades.

## Behind hotpot and logwatch

[hotpot](https://github.com/dwightmulcahy/hotpot) is the only thing exposed to the internet; BrewCRM stays on the Docker network. [logwatch](https://github.com/dwightmulcahy/logwatch) reads BrewCRM's container logs nightly.

```text
Internet -> host port -> hotpot -> http://brewcrm:8080
                                       ^
                logwatch (TARGET_CONTAINER=brewcrm) reads docker logs
```

1. In `compose.qnap.yaml`, replace the `ports:` block of `brewcrm` with `expose: ["8080"]` and attach it to hotpot's network, so nobody can reach BrewCRM without going through hotpot:
   ```yaml
   services:
     brewcrm:
       expose: ["8080"]
       networks: [hotpot_backend]
   networks:
     hotpot_backend:
       external: true   # created by the hotpot stack
   ```
2. hotpot: `HOTPOT_UPSTREAM=http://brewcrm:8080`, publish the public port on hotpot.
3. BrewCRM admin (`/_/`) → Settings → Application → Trusted proxy → **Trusted IP proxy headers**: `X-Real-IP`. Without this, every visitor is logged as hotpot's IP. Only do this when step 1 is in place.
4. Set `APP_URL` to the public URL users open (it's used for the Gmail OAuth redirect).
5. logwatch: `TARGET_CONTAINER=brewcrm`, `APP_NAME=BrewCRM`.

BrewCRM writes one JSON line per request to stdout in logwatch's format (`timestamp`, `level`, `method`, `path`, `status_code`, `duration_ms`, `client`, `user_agent`). `/health` probes are included for logwatch's uptime and latency checks. PocketBase prints three plain-text "Server started" lines on each container start; those are the only non-JSON lines. Set `ACCESS_LOG=0` to turn the access log off.

Do not expose QTS admin ports to the internet.

## Users and passwords

- **Adding a salesperson:** `/_/` → Collections → users → New record. Enter their email and a password (the **Generate** button makes a 20-character one and copies it), then send it to them yourself. That password is **temporary**: at first sign-in BrewCRM makes them choose their own, and CRM data stays locked until they do.
- **Resetting a password as admin:** set a new one for the user in `/_/`. It becomes temporary again. To skip the forced change, untick **must_change_password** on the user.
- **Users** change their own password under **Settings → Your password** (current password required).
- **Forgot password?** on the sign-in page emails a reset link (valid 30 minutes) once outgoing mail is set up: either `SMTP_*` in `.env` (Gmail: `smtp.gmail.com`, port 587, an [App Password](https://myaccount.google.com/apppasswords)) or `/_/` → Settings → Mail. `APP_URL` must be the address users open, since it's used in the link. Without mail, the page tells users to ask you for a temporary password.
- **Rules,** enforced by the server: 12+ characters with a letter and a number, plus a symbol unless it's 16+ characters, and it can't contain the email name. Passwords are stored as bcrypt hashes.
- **The `.env` admin** (`PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD`) is never forced to change. Its CRM password is re-applied only when the `.env` value changes, so a password changed in BrewCRM survives restarts. A `PB_ADMIN_PASSWORD` under 12 characters stops the container with a clear log message.
- **Rate limits** (per client IP): 10 sign-ins per minute and 3 reset emails per 5 minutes. Behind hotpot, set Trusted proxy → `X-Real-IP` (see above) or the whole team shares one limit. `RATE_LIMITS=0` turns them off.

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
```

### Tests and coverage

| Suite | Command | Covers | Gate |
|---|---|---|---|
| Unit | `npm run test:unit` | `pb_hooks/`, `pb_migrations/`, `scripts/build.mjs`, run in Node against an in-memory PocketBase fake (`tests/unit/pbfake.mjs`) | 90% lines (`.c8rc.json`) |
| E2E | `PB_BIN=$(scripts/fetch-pocketbase.sh) npm run test:e2e` | Every screen and dialog in `pb_public/app.js`, against a real PocketBase with fake Places/Gmail/OAuth/Loyverse servers (`tests/e2e/`) | 90% lines of `app.js` (Chromium V8 coverage) |
| Python | `pytest --cov=scripts --cov=.github/actions/release-notes --cov-fail-under=90` | Build, config/policy checks, release notes against a real git repo | 90% |
| Smoke | `BASE_URL=http://localhost:8080 PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... npm run test:smoke` | The built Docker image: health, auth, sign-in → account → visit | — |

`scripts/fetch-pocketbase.sh` downloads the PocketBase version pinned in the `Dockerfile` and verifies it against the release checksums. CI runs all four suites; reports are uploaded as the `coverage-unit` and `coverage-e2e` artifacts.

CI pins every external GitHub Action to a commit SHA, pins the Docker base image by version and digest, verifies the PocketBase download against the release checksums, and rejects fixable high/critical image vulnerabilities with Trivy. PocketBase itself is pinned by `ARG PB_VERSION` in the `Dockerfile` and is not tracked by Dependabot.

See [docs/ROADMAP.md](docs/ROADMAP.md) for planned improvements.

## Releasing

1. Merge to `main`.
2. `git tag v1.2.3 && git push origin v1.2.3`
3. The Release workflow verifies the tag is on `main`, reruns CI, and publishes the multi-arch image (`linux/amd64`, `linux/arm64`) to Docker Hub, the offline ZIP + SHA-256, and Conventional Commit release notes.

Required settings: repo variables `DOCKERHUB_USERNAME`, `DOCKERHUB_REPO` (`dwightmulcahy/brewcrm`); secret `DOCKERHUB_TOKEN`.

## API (authenticated)

`GET /api/crm/status` · `POST /api/crm/leads/search {query, pageToken}` · `POST /api/crm/leads/{id}/enrich` · `POST /api/crm/leads/{id}/convert` · `POST /api/crm/sync/gmail` · `POST /api/crm/sync/pos` · `GET /api/crm/pos/customers?q=` · plus PocketBase's REST API for all collections.

## License

[MIT](LICENSE)
