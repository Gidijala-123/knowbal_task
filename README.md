# Paid Client Access

Stripe test Checkout → Supabase entitlement → Zoho CRM Deal marked paid, with a
two-client portal that proves tenant isolation.

A client buys access to a sample document. The payment is verified by signature,
matched to the client by stable IDs, and turns into an entitlement in Postgres.
The matching Zoho Deal is updated; if Zoho is unreachable the client still gets
access and the sync is queued for retry. The browser reads its own status
directly from Supabase under Row Level Security.

---

## 1. Architecture

```
Browser (React + Supabase anon key)
  │  sign in → Supabase Auth
  │  read status → Supabase RLS (entitlements / purchases / crm_sync)
  │  buy / download → Express server (Bearer JWT)
  │
Express server (:8787)
  ├─ POST /api/checkout   → Stripe Checkout Session (price from DB, never from client)
  ├─ POST /api/webhook    → verify signature → grant_purchase() → syncPurchase()
  ├─ GET  /api/documents/:id/download → verify entitlement → 60s signed URL
  └─ POST /api/admin/retry-crm-sync   → drain pending CRM rows
  │
Supabase (Postgres + Auth + Storage)
  └─ six tables, six migrations, RLS on every table
  │
Zoho CRM
  └─ PUT /Deals/{id} — Stage, Payment_Status, Stripe_Payment_ID, Paid_Amount, Paid_At
```

Three design rules:

1. **The browser decides nothing about money or access.** Secrets live in `server/` only.
2. **Access is granted by Postgres, not by Zoho.** The entitlement and CRM outbox row are written in one transaction; Zoho failure never blocks access.
3. **Every step is idempotent.** A replayed webhook is a no-op, not a second purchase.

---

## 2. Quick start

### Prerequisites

- Node 20+
- Stripe CLI ([install guide](https://stripe.com/docs/stripe-cli))
- A Supabase project, a Stripe test account, and a Zoho CRM Developer Edition org

### Install

```bash
git clone <repo> && cd KnowBal
npm install          # installs both server/ and web/ workspaces
```

### Configure

```bash
cp .env.example .env
cp web/.env.example web/.env.local
```

Fill in every value marked `>>> REPLACE` — see section 3 for where to find each one.

```bash
npm run env:check    # shows what is still a placeholder
```

### Apply database migrations

Paste each file into the Supabase SQL Editor in order, or run:

```bash
npm run db:migrate
```

> If `db:migrate` times out (common when port 5432 is blocked by ISP), use the
> SQL Editor in the Supabase dashboard and paste each file from
> `supabase/migrations/` in order: 0001 → 0006.

### Seed demo data

```bash
npm run seed         # creates two auth users + 11 sample documents
```

### Generate Zoho refresh token (one time)

```bash
npm run zoho:bootstrap
# Opens a browser → authorize → prints ZOHO_REFRESH_TOKEN= to paste into .env
```

### Run

**Terminal 1 — app:**
```bash
npm run dev          # server :8787 + portal :5173
```

**Terminal 2 — Stripe webhook forwarding:**
```bash
npm run stripe:listen
# Prints: whsec_... → paste into .env as STRIPE_WEBHOOK_SECRET
```

Open [http://localhost:5173](http://localhost:5173).

Login credentials after seeding:
- `client-a@example.com` / `TestAccess!234`
- `client-b@example.com` / `TestAccess!234`

**Important:** On the Stripe checkout page, always select the **USD ($19.00)** option. Selecting INR causes a currency mismatch and the webhook will quarantine the event.

---

## 3. Environment variables

### Server (`/.env`)

| Variable | Where to find it |
|---|---|
| `PORT` | Leave as `8787` |
| `APP_BASE_URL` | Leave as `http://localhost:5173` locally |
| `ADMIN_API_KEY` | Any string 8+ chars; generate with `npm run env:make-admin-key` |
| `TRUST_PROXY` | `0` locally, `1` behind a reverse proxy in production |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Test mode → Developers → API keys → Secret key |
| `STRIPE_WEBHOOK_SECRET` | Printed by `npm run stripe:listen` (not the Dashboard secret) |
| `STRIPE_PRICE_ID` | Optional — leave empty; price is read from the `documents` table |
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → Publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → Secret key (reveal it) |
| `SUPABASE_DB_URL` | Project Settings → Database → Connection string → URI (session pooler) |
| `ZOHO_CLIENT_ID` | [api-console.zoho.in](https://api-console.zoho.in) → Self Client → Client ID |
| `ZOHO_CLIENT_SECRET` | Same page → Client Secret |
| `ZOHO_REFRESH_TOKEN` | Run `npm run zoho:bootstrap` once |
| `ZOHO_ACCOUNTS_URL` | Match your data centre: `.com` / `.eu` / `.in` / `.com.au` |
| `ZOHO_API_URL` | `https://www.zohoapis.in/crm/v2/<your-org-id>` |
| `ZOHO_PAID_STAGE` | The Stage picklist value for paid deals — default `Closed Won` |
| `ZOHO_REDIRECT_URI` | `http://localhost:8790/zoho/callback` (must match Self Client exactly) |
| `ZOHO_SIMULATE_FAILURE` | `true` to simulate Zoho outage without touching your org |
| `SEED_CLIENT_PASSWORD` | Password for the two demo accounts |
| `ZOHO_DEAL_ID_CLIENT_A` | URL of the Deal in Zoho → last number segment |
| `ZOHO_DEAL_ID_CLIENT_B` | Same for the second deal |
| `RUN_INTEGRATION` | `1` to run live RLS tests against a real Supabase project |

### Portal (`/web/.env.local`)

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Same as `SUPABASE_ANON_KEY` (publishable — safe to expose) |
| `VITE_API_BASE_URL` | `http://localhost:8787` locally |

---

## 4. Zoho custom fields

Create these four fields on Deals in your Zoho org before testing:
**Setup → Customize → Modules and Fields → Deals → Fields**

| Label | API Name | Type |
|---|---|---|
| Payment Status | `Payment_Status` | Single line text |
| Stripe Payment ID | `Stripe_Payment_ID` | Single line text |
| Paid Amount | `Paid_Amount` | Decimal |
| Paid At | `Paid_At` | Date/Time |

---

## 5. Testing

```bash
npm test                                              # 44 offline tests (no credentials)
npm run typecheck                                     # both workspaces
RUN_INTEGRATION=1 npm run test:integration -w server  # live RLS isolation (needs Supabase)
```

### Test a Stripe webhook locally

```bash
# Terminal 1
npm run stripe:listen

# Terminal 2 — trigger a test payment event
stripe trigger checkout.session.completed

# Verify idempotency — resend the same event, expect duplicate:true, no new rows
stripe events resend evt_<id>
```

Test card: `4242 4242 4242 4242` · any future expiry · any CVC

### Verify the database after a payment

Paste in the Supabase SQL Editor:

```sql
select event_id, type, status, error from public.stripe_events order by received_at desc limit 5;
select id, amount_cents, currency, paid_at from public.purchases order by paid_at desc limit 3;
select client_id, document_id, granted_at from public.entitlements order by granted_at desc limit 3;
select purchase_id, status, attempts, last_error, synced_at from public.crm_sync order by last_attempt_at desc limit 3;
```

---

## 6. CRM retry

If Zoho is down or returns an error, the `crm_sync` row stays `pending` and access is still granted.

```bash
npm run retry-crm-sync -- --list       # show what is owed
npm run retry-crm-sync                 # attempt all pending rows
npm run retry-crm-sync -- --purchase <id>  # retry one purchase
```

Or via the admin endpoint:

```bash
curl -X POST http://localhost:8787/api/admin/retry-crm-sync \
  -H "x-admin-key: $ADMIN_API_KEY"
```

Simulate a Zoho outage without touching your org:

```bash
ZOHO_SIMULATE_FAILURE=true npm run dev:server
```

---

## 7. Security checklist

- `.env` and `web/.env.local` are gitignored; only `.env.example` is committed
- Webhook signature verified on raw bytes — the raw body router is registered before `express.json()` in `app.ts`
- Charged amount comes from the `documents` table, never from the client request body
- Client identity from `auth.uid()` via the Bearer JWT, never from a client-supplied field
- RLS on all six tables; `documents` base table not readable from browser roles — portal uses `documents_public` view (no `storage_path` column)
- No INSERT/UPDATE/DELETE policy for `anon`/`authenticated` on any table
- Downloads are 60-second signed URLs from a private bucket; the object key never reaches the browser
- Rate limits: checkout 10/min/user, download 30/min/user, admin 20/min/IP
- CORS locked to `APP_BASE_URL`
- `ADMIN_API_KEY` compared with `timingSafeEqual`
- Logger redacts keys matching secret/token/key/password/authorization/email/card/cvc/pan

---

## 8. Production

```bash
npm run build        # compiles server to server/dist, builds web/dist
npm ci --omit=dev    # runtime deps only
npm start            # node server/dist/index.js
```

Key differences from local:
- Set env vars in the platform secret store (no `.env` file)
- `TRUST_PROXY=1` behind the platform's reverse proxy
- `STRIPE_WEBHOOK_SECRET` must be the Dashboard endpoint secret, not the `stripe listen` one
- Apply migrations out of band (`npm run db:migrate` or SQL Editor) — never at boot
- `GET /api/health` is the readiness probe (no DB round-trip, so Supabase outage doesn't cause restarts)
- One instance only — the rate limiter and Zoho token cache are per-process

---

## 9. Useful commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start server + portal in watch mode |
| `npm run stripe:listen` | Forward Stripe webhooks to localhost |
| `npm test` | 44 offline tests |
| `npm run typecheck` | TypeScript check both workspaces |
| `npm run env:check` | Show status of every config value |
| `npm run db:migrate` | Apply SQL migrations |
| `npm run db:migrate -- --status` | Show pending migrations |
| `npm run seed` | Create demo users + documents |
| `npm run retry-crm-sync` | Drain pending CRM sync rows |
| `npm run zoho:bootstrap` | Generate Zoho refresh token |
| `npm run env:make-admin-key` | Generate a random admin key |
