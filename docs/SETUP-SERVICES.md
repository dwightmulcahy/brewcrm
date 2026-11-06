# Setting up BrewCRM's outside services

BrewCRM works with no outside services: pipeline, accounts, contacts, activities and follow-ups all run locally. Each integration below is optional and is switched on by putting its keys in `.env` and restarting:

```bash
docker compose up -d          # QNAP: docker compose -f compose.qnap.yaml up -d
```

**Settings** in BrewCRM shows each integration as configured or **needs setup** (in red), so check there after every step.

| Service | What it does in BrewCRM | Cost | `.env` keys |
|---|---|---|---|
| [1. Public URL](#1-public-url-app_url) | The address users and Google use to reach the app | — | `APP_URL` |
| [2. Google Cloud project](#2-google-cloud-project) | Holds the Places key and Gmail client | Free | — |
| [3. Google Places API](#3-google-places-api-lead-search) | **Leads**: search Google Maps for bars, restaurants and hotels | Free under the monthly caps; needs a billing account | `GOOGLE_PLACES_API_KEY` |
| [4. Gmail](#4-gmail-email-logging) | Logs emails with your contacts on each account's timeline | Free | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| [5. Loyverse POS](#5-loyverse-pos-orders) | Imports receipts as orders; moves deals to First order / Recurring | Free | `LOYVERSE_ACCESS_TOKEN` |
| [6. Outgoing email (SMTP)](#6-outgoing-email-smtp-password-reset) | "Forgot password?" reset emails | Free with Gmail | `SMTP_*` |

Do them in this order: Gmail needs the public URL, and both Google items need the project.

---

## 1. Public URL (`APP_URL`)

Set this to the address people type in their browser to reach BrewCRM, with no trailing slash:

```ini
APP_URL=https://crm.yourbrewery.cr
```

- **Through hotpot on the QNAP:** use the HTTPS hostname hotpot serves BrewCRM on.
- **Testing on your own computer:** `APP_URL=http://localhost:8080`. Google accepts plain `http` only for `localhost`, not for `0.0.0.0` or a LAN IP.

Gmail's sign-in sends you back to `APP_URL/api/crm/google/callback`, so `APP_URL` must match exactly what you register in [step 4](#4-gmail-email-logging).

Behind hotpot, also open the admin dashboard at `APP_URL/_/` → **Settings → Application → Trusted proxy → Trusted IP proxy headers**, add `X-Real-IP`, and save. Otherwise every visitor looks like hotpot's IP, and they all share one sign-in rate limit. See the README's hotpot section first: only do this when hotpot is the only way in.

---

## 2. Google Cloud project

One project holds both the Places key and the Gmail client.

1. Sign in at <https://console.cloud.google.com/> with the Google account that will own this. Use the brewery's Workspace account if you have one.
2. Open the project picker (top bar) → **New project** (<https://console.cloud.google.com/projectcreate>).
3. Name it `BrewCRM` → **Create**, then make sure it's selected in the top bar.

---

## 3. Google Places API (lead search)

### 3a. Billing account (required, but stays free under the caps)

Google requires a billing account even for free usage.

1. Go to <https://console.cloud.google.com/billing> → **Create account** (or **Link a billing account** if you already have one) and add a card.
2. Link it to the `BrewCRM` project: <https://console.cloud.google.com/billing/linkedaccount>.

Free usage per month as of November 2026 ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)):

| BrewCRM action | Google SKU | Free per month | After that |
|---|---|---|---|
| **Search** on the Leads page (each page of results) | Text Search Pro | 5,000 | $32 / 1,000 |
| **Get phone** on a lead | Place Details Enterprise | 1,000 | $20 / 1,000 |

BrewCRM stops itself below those caps with `PLACES_SEARCH_MONTHLY_LIMIT=4500` and `PLACES_DETAILS_MONTHLY_LIMIT=900`. Settings shows this month's usage.

### 3b. Enable the API

1. Open <https://console.cloud.google.com/apis/library/places.googleapis.com>.
2. Make sure it says **Places API (New)**, not the legacy "Places API", then click **Enable**.

### 3c. Create and restrict the key

1. Go to **APIs & Services → Credentials**: <https://console.cloud.google.com/apis/credentials>.
2. **+ Create credentials → API key**. Copy the key.
3. Click the new key to edit it:
   - **Name:** `BrewCRM server`
   - **Application restrictions:** *None*. BrewCRM calls Google from the server, so website restrictions don't apply. If your NAS has a fixed public IP, choose *IP addresses* and enter it.
   - **API restrictions:** *Restrict key* → tick only **Places API (New)**.
   - **Save**.
4. Put it in `.env`:

   ```ini
   GOOGLE_PLACES_API_KEY=AIza...
   PLACES_REGION=CR
   PLACES_LANGUAGE=es
   ```

### 3d. Optional safety nets

- **Budget alert:** <https://console.cloud.google.com/billing/budgets> → **Create budget**, for example $5/month with email alerts.
- **Hard daily cap:** <https://console.cloud.google.com/apis/api/places.googleapis.com/quotas> → edit **Text Search requests per day**, for example 300.

**Check:** restart, open **Leads**, and search `cervecería Escazú`.

---

## 4. Gmail (email logging)

BrewCRM asks for read-only Gmail access (`gmail.readonly`). Every 15 minutes it logs messages to and from your contacts' email addresses on their accounts. It never sends or changes mail.

### 4a. Enable the Gmail API

<https://console.cloud.google.com/apis/library/gmail.googleapis.com> → **Enable**.

### 4b. OAuth consent screen (Google Auth Platform)

1. Open <https://console.cloud.google.com/auth/overview> → **Get started**.
2. **App information:** app name `BrewCRM`, user support email = you.
3. **Audience:** choose based on the account that will connect:
   - **Internal**, if that mailbox is on your brewery's **Google Workspace** domain. Recommended: no Google review, and the connection never expires.
   - **External**, if it's a personal `@gmail.com` account. See [External accounts](#external-gmailcom-accounts) below.
4. **Contact information:** your email → **Create**.
5. **Data access** (<https://console.cloud.google.com/auth/scopes>) → **Add or remove scopes**. Paste `https://www.googleapis.com/auth/gmail.readonly` under **Manually add scopes** → **Add to table** → **Update** → **Save**.

#### External (`@gmail.com`) accounts

`gmail.readonly` is a *restricted* scope. Google requires a review only for public apps; for your own mailbox, pick one:

- **Testing (simplest):** **Audience** → **Test users** → **+ Add users** → add the Gmail address. The catch: in Testing, Google expires the connection after **7 days**, so you'd click **Connect Gmail** in Settings again every week.
- **In production, unverified:** **Audience** → **Publish app**. When connecting, Google shows *"Google hasn't verified this app"*: click **Advanced → Go to BrewCRM (unsafe)**. The connection then lasts until you revoke it, and you're limited to 100 users, which is plenty. This is your own app reading your own mailbox; the warning is about the missing Google review.

See [OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).

### 4c. Create the OAuth client

1. **Clients** (<https://console.cloud.google.com/auth/clients>) → **+ Create client**.
2. **Application type:** *Web application*. **Name:** `BrewCRM`.
3. **Authorized redirect URIs** → **+ Add URI** → `APP_URL` + `/api/crm/google/callback`, for example:

   ```
   https://crm.yourbrewery.cr/api/crm/google/callback
   http://localhost:8080/api/crm/google/callback      (only for local testing)
   ```

4. **Create**. Copy the **Client ID** and **Client secret**: Google shows the secret only once, but you can add a new secret later.
5. In `.env`:

   ```ini
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   GMAIL_LOOKBACK_DAYS=30
   ```

### 4d. Connect

Restart BrewCRM, then **Settings → Gmail → Connect Gmail**, sign in with the mailbox, and allow access. You'll land back on Settings with *Connected as you@...*; the first sync imports the last `GMAIL_LOOKBACK_DAYS` days.

| Error from Google | Fix |
|---|---|
| `redirect_uri_mismatch` | The URI in 4c must equal `APP_URL/api/crm/google/callback` exactly: same `https`, host, port, no trailing slash |
| `access_denied` / "app is blocked" | External + Testing: add the address under **Test users**. Internal: sign in with an account on your Workspace domain |
| Disconnected after a week | External app still in **Testing**; publish it (4b) |

To revoke access later: <https://myaccount.google.com/connections>, or **Disconnect** in Settings.

---

## 5. Loyverse POS (orders)

BrewCRM reads customers and receipts, never writes. Hourly it imports receipts for accounts linked to a Loyverse customer, counts orders, and moves deals to **First order** / **Recurring**.

1. Sign in to the **Loyverse Back Office**: <https://r.loyverse.com/> as the owner.
2. Open **Integrations → Access tokens** ([Loyverse guide](https://help.loyverse.com/help/loyverse-api)) → **+ Add access token**.
3. **Name:** `BrewCRM`. **Expires:** leave it empty. An expired token silently stops the sync, so if you do set a date, put a reminder in your calendar to renew it.
4. **Save** and copy the token.
5. In `.env`:

   ```ini
   LOYVERSE_ACCESS_TOKEN=...
   LOYVERSE_LOOKBACK_DAYS=365
   ```

Treat the token like a password: Loyverse tokens can't be limited to read-only and give full API access to the store. If it leaks, delete it in the same screen and create a new one.

**Link accounts:** in Loyverse, record sales to a **customer** (the POS customer button), not as walk-in sales. Then in BrewCRM open an account → **Loyverse → Link customer**, search, and **Link**. Its orders import immediately. **Settings → Loyverse → Sync now** re-runs the import for all linked accounts.

---

## 6. Outgoing email (SMTP, password reset)

Without SMTP, "Forgot password?" tells users to ask an admin, and the admin sets a temporary password instead. To send reset emails from a Gmail or Workspace address:

1. Turn on **2-Step Verification** for that Google account: <https://myaccount.google.com/signinoptions/twosv>.
2. Create an **App password**: <https://myaccount.google.com/apppasswords> → name `BrewCRM` → **Create**. Copy the 16-character password; Google shows it once.
   - If the page says app passwords aren't available, a Workspace admin must allow them (Admin console → Security → Less secure apps / app passwords), or the account is using passkeys/Advanced Protection.
3. In `.env`:

   ```ini
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_TLS=false                      # STARTTLS on 587; use 465 + true for implicit TLS
   SMTP_USERNAME=crm@yourbrewery.cr
   SMTP_PASSWORD='abcd efgh ijkl mnop' # quote it: it contains spaces
   SMTP_SENDER_ADDRESS=crm@yourbrewery.cr
   SMTP_SENDER_NAME=BrewCRM
   ```

   Gmail sends only as the signed-in address or a verified alias, so keep `SMTP_SENDER_ADDRESS` the same as `SMTP_USERNAME`.

**Check:** restart, sign out, **Forgot password?**, and enter your email. Settings shows *On. "Forgot password?" emails a reset link from ...*.

Other providers (Brevo, Mailgun, Amazon SES, your web host) work the same way: copy their SMTP host, port, username and password into the same keys.

---

## After setup

- Back up `.env` somewhere safe outside the NAS, such as a password manager. It holds every key above.
- Never commit `.env`; it's already in `.gitignore`.
- **To rotate a key:** create the new one, update `.env`, restart, then delete the old one.
  - Places: Credentials page.
  - Gmail: client → **Add secret**.
  - Loyverse: Access tokens.
  - SMTP: App passwords.
