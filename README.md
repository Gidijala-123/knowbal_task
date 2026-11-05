# Paid Client Access

Stripe test Checkout → Supabase entitlement → Zoho CRM Deal marked paid, with a
two-client portal that proves tenant isolation.

A client buys access to a sample document through Stripe. The payment is verified
by signature, matched to the client by stable IDs, and turns into an entitlement
in Postgres. The matching Zoho Deal is updated; if Zoho is unreachable the client
still gets access and the sync is queued for retry. The browser reads its own
status directly from Supabase under Row Level Security.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Quick Start](#2-quick-start)
3. [Environment Variables](#3-environment-variables)
4. [Zoho Custom Fields](#4-zoho-custom-fields)
5. [Testing](#5-testing)
6. [CRM Retry](#6-crm-retry)
7. [Security Checklist](#7-security-checklist)
8. [Production](#8-production)
9. [Useful Commands](#9-useful-commands)
10. [Demo Walkthrough](#10-demo-walkthrough)
11. [Interview Q&A](#11-interview-qa)
12. [Tradeoffs](#12-tradeoffs)

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

**Three design rules:**

1. **The browser decides nothing about money or access.** Secrets live in `server/` only.
2. **Access is granted by Postgres, not by Zoho.** The entitlement and CRM outbox row are written in one transaction; Zoho failure never blocks access.
3. **Every step is idempotent.** A replayed webhook is a no-op, not a second purchase.

**Flow diagram:**

```
Browser → POST /api/checkout (document id + JWT)
       ← checkoutUrl

Browser → Stripe hosted checkout page
       → Stripe sends POST /api/webhook (raw bytes + signature)

Webhook handler:
  1. Verify signature (400 if bad)
  2. Record event_id (stop if duplicate)
  3. grant_purchase() — purchase + entitlement + crm_sync(pending) in ONE transaction
  4. Return 200 to Stripe
  5. Call Zoho CRM (best-effort, failure stays pending, never 500 to Stripe)

Browser polls Supabase → sees new entitlement → document unlocked

Browser → GET /api/documents/:id/download (JWT)
       → server checks entitlement
       ← 60-second signed URL from private bucket
```

---

## 2. Quick Start

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

Fill in every value — see [Section 3](#3-environment-variables) for where to find each one.

```bash
npm run env:check    # shows what is still a placeholder
```

### Apply database migrations

Paste each file into the Supabase SQL Editor in order, or run:

```bash
npm run db:migrate
```

> **Note:** If `db:migrate` times out (common when port 5432 is blocked by ISP),
> paste each file from `supabase/migrations/` into the Supabase SQL Editor in order: 0001 → 0006.

### Seed demo data

```bash
npm run seed         # creates two auth users + 11 sample documents
```

### Generate Zoho refresh token (one time)

```bash
npm run zoho:bootstrap
# Opens a browser → authorize → prints ZOHO_REFRESH_TOKEN= to paste into .env
```

> **Alternative (Self Client):** If you used a Zoho Self Client instead of a Server-based Application,
> generate a code from the Self Client portal with scope `ZohoCRM.modules.deals.ALL,ZohoCRM.users.READ`,
> then exchange it manually:
> ```bash
> curl -X POST https://accounts.zoho.in/oauth/v2/token \
>   -d "grant_type=authorization_code&client_id=YOUR_ID&client_secret=YOUR_SECRET&redirect_uri=http://localhost:8790/zoho/callback&code=YOUR_CODE"
> ```
> Copy the `refresh_token` from the response into `.env`.

### Run

**Terminal 1 — app:**
```bash
npm run dev          # server :8787 + portal :5173
```

**Terminal 2 — Stripe webhook forwarding:**
```bash
npm run stripe:listen
# Prints: whsec_... → paste into .env as STRIPE_WEBHOOK_SECRET, restart server
```

Open [http://localhost:5173](http://localhost:5173).

Login credentials after seeding:
- `client-a@example.com` / `TestAccess!234`
- `client-b@example.com` / `TestAccess!234`

> **Important:** On the Stripe checkout page, always select the **USD ($19.00)** option.
> Selecting INR causes a currency mismatch and the webhook will quarantine the event.

---

## 3. Environment Variables

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
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → **Publishable key** |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → **Secret key** (click Reveal) |
| `SUPABASE_DB_URL` | Project Settings → Database → Connection string → URI (session pooler) |
| `ZOHO_CLIENT_ID` | [api-console.zoho.in](https://api-console.zoho.in) → Self Client → Client ID |
| `ZOHO_CLIENT_SECRET` | Same page → Client Secret |
| `ZOHO_REFRESH_TOKEN` | Run `npm run zoho:bootstrap` once |
| `ZOHO_ACCOUNTS_URL` | Match your data centre: `.com` / `.eu` / `.in` / `.com.au` |
| `ZOHO_API_URL` | `https://www.zohoapis.in/crm/v2/<your-org-id>` |
| `ZOHO_PAID_STAGE` | Stage picklist value for paid deals — default `Closed Won` |
| `ZOHO_REDIRECT_URI` | `http://localhost:8790/zoho/callback` (must match Self Client exactly) |
| `ZOHO_SIMULATE_FAILURE` | `true` to simulate Zoho outage without touching your org |
| `SEED_CLIENT_PASSWORD` | Password for the two demo accounts |
| `ZOHO_DEAL_ID_CLIENT_A` | Open Deal in Zoho → last number in the URL |
| `ZOHO_DEAL_ID_CLIENT_B` | Same for the second deal |
| `RUN_INTEGRATION` | `1` to run live RLS tests against a real Supabase project |

### Portal (`/web/.env.local`)

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Same as `SUPABASE_ANON_KEY` (publishable — safe to expose) |
| `VITE_API_BASE_URL` | `http://localhost:8787` locally |

> **Note:** Supabase renamed their keys in 2024. The old `anon` key is now called
> **Publishable key** and `service_role` is now **Secret key**. Both old (`eyJ...`)
> and new (`sb_publishable_/sb_secret_`) formats work.

---

## 4. Zoho Custom Fields

Create these four fields on Deals before testing:
**Setup → Customize → Modules and Fields → Deals → Fields**

| Label | API Name | Type |
|---|---|---|
| Payment Status | `Payment_Status` | Single line text |
| Stripe Payment ID | `Stripe_Payment_ID` | Single line text |
| Paid Amount | `Paid_Amount` | Decimal |
| Paid At | `Paid_At` | Date/Time |

The API names must be exact — the server writes these field names directly.

---

## 5. Testing

```bash
npm test                                              # 44 offline tests (no credentials needed)
npm run typecheck                                     # TypeScript check both workspaces
RUN_INTEGRATION=1 npm run test:integration -w server  # live RLS isolation (needs Supabase)
```

### Test a Stripe webhook locally

```bash
# Terminal 1 — forward webhooks
npm run stripe:listen

# Terminal 2 — trigger a test payment
stripe trigger checkout.session.completed

# Prove idempotency — resend the same event, expect {"duplicate":true}, no new DB rows
stripe events resend evt_<id>
```

Test card: `4242 4242 4242 4242` · any future expiry · any CVC

### Verify the database after a payment

Run in the Supabase SQL Editor:

```sql
-- The four rows every payment creates
select event_id, type, status, error from public.stripe_events order by received_at desc limit 5;
select id, amount_cents, currency, paid_at from public.purchases order by paid_at desc limit 3;
select client_id, document_id, granted_at from public.entitlements order by granted_at desc limit 3;
select purchase_id, status, attempts, last_error, synced_at from public.crm_sync order by last_attempt_at desc limit 3;
```

Expected: one `stripe_events` row with status `processed`, one `purchases` row, one `entitlements` row, one `crm_sync` row with status `synced`.

---

## 6. CRM Retry

If Zoho is down, the `crm_sync` row stays `pending` — access is still granted immediately.

```bash
npm run retry-crm-sync -- --list            # show what is owed
npm run retry-crm-sync                      # attempt all pending rows
npm run retry-crm-sync -- --purchase <id>   # retry one specific purchase
```

Via the admin endpoint:

```bash
curl -X POST http://localhost:8787/api/admin/retry-crm-sync \
  -H "x-admin-key: $ADMIN_API_KEY"
```

Simulate a Zoho outage without touching your org:

```bash
ZOHO_SIMULATE_FAILURE=true npm run dev:server
```

Reset a CRM row to pending (for demo purposes):

```sql
update public.crm_sync set status = 'pending', attempts = 0, last_error = null, synced_at = null;
```

---

## 7. Security Checklist

- `.env` and `web/.env.local` are gitignored — only `.env.example` is committed
- Webhook signature verified on **raw bytes** — the raw body router is registered before `express.json()` in `app.ts`
- Charged amount comes from the `documents` table, never from the client request body
- Client identity from `auth.uid()` via Bearer JWT, never from a client-supplied field
- RLS on all six tables; `documents` base table not readable from browser roles — portal uses `documents_public` view (no `storage_path` column)
- No INSERT/UPDATE/DELETE policy for `anon`/`authenticated` on any table
- Downloads are 60-second signed URLs from a private bucket; object key never reaches the browser
- Rate limits: checkout 10/min/user, download 30/min/user, admin 20/min/IP
- CORS locked to `APP_BASE_URL`
- `ADMIN_API_KEY` compared with `timingSafeEqual`
- Logger redacts keys matching secret/token/key/password/authorization/email/card/cvc/pan
- Zoho access tokens cached in memory only, never written to disk or logs

---

## 8. Production

```bash
npm run build        # compiles server to server/dist, builds web/dist
npm ci --omit=dev    # runtime deps only (6 packages)
npm start            # node server/dist/index.js
```

Key differences from local:

| Concern | Action |
|---|---|
| Secrets | Set env vars in platform secret store — no `.env` file |
| Proxy | `TRUST_PROXY=1` behind the platform's single reverse proxy |
| Stripe webhook | Use the Dashboard endpoint secret, not the `stripe listen` one |
| Migrations | Apply out of band (`npm run db:migrate` or SQL Editor) — never at boot |
| Health check | `GET /api/health` — no DB round-trip, safe readiness probe |
| Scaling | One instance only — rate limiter and Zoho token cache are per-process |

---

## 9. Useful Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start server + portal in watch mode |
| `npm run dev:server` | Start server only |
| `npm run stripe:listen` | Forward Stripe webhooks to localhost |
| `npm test` | 44 offline tests |
| `npm run typecheck` | TypeScript check both workspaces |
| `npm run env:check` | Show status of every config value |
| `npm run db:migrate` | Apply SQL migrations |
| `npm run db:migrate -- --status` | Show pending migrations |
| `npm run seed` | Create demo users + 11 sample documents |
| `npm run retry-crm-sync` | Drain pending CRM sync rows |
| `npm run retry-crm-sync -- --list` | Show pending rows without retrying |
| `npm run zoho:bootstrap` | Generate Zoho refresh token |
| `npm run env:make-admin-key` | Generate a random admin key |

---

## 10. Demo Walkthrough

*Estimated time: 10–15 minutes. Have three windows ready: the portal, Supabase SQL Editor, and a terminal.*

### Before you start — checklist

- [ ] `npm run dev` running (server :8787 + portal :5173)
- [ ] `npm run stripe:listen` running in a second terminal
- [ ] Test card ready: `4242 4242 4242 4242` / `12/29` / `123`
- [ ] Supabase SQL Editor open in a browser tab

---

### Part 1 — Portal and access control (2 min)

**Step 1** — Open `http://localhost:5173`. Point out:
- Two demo accounts pre-filled — Client A is active by default
- The hint box explaining both accounts share the same password

**Step 2** — Click **Use Client A** → **Sign in**. The login card glows green on success.

**Step 3** — On the portal, point out:
- 11 documents in a grid, all **Locked**
- Price, purchase status, CRM sync status shown per document
- Footer: "Status comes straight from Supabase under Row Level Security"

> *"The browser never calls my Express server to read this. Four Supabase queries
> run directly with the user's JWT — Postgres RLS filters them to only this client's rows."*

---

### Part 2 — The purchase flow (3 min)

**Step 4** — Click **Buy access for $19.00** on "Sample Client Document".

In the terminal: a POST to `/api/checkout` — the server reads price from DB, never from the request body.

**Step 5** — On Stripe checkout:
- Select **$19.00 USD** (not INR)
- Card: `4242 4242 4242 4242` / `12/29` / `123` / any name → Pay

**Step 6** — Portal shows "Waiting for Stripe to confirm..." with a pulsing banner.

Switch to the terminal — webhook events arrive with `[200]`:
```
v1.payment_intent.succeeded
v1.checkout.session.completed   ← grants access
v1.charge.updated
```

> *"The redirect proves nothing — the webhook grants access. The portal polls
> until it sees a new entitlement row appear in Supabase."*

**Step 7** — Document card pops with a green unlock animation. Shows: **Unlocked**, paid amount, CRM Sync status.

---

### Part 3 — Database proof (2 min)

Run in Supabase SQL Editor:

```sql
select event_id, type, status from public.stripe_events order by received_at desc limit 3;
select id, amount_cents, currency, paid_at from public.purchases order by paid_at desc limit 2;
select client_id, document_id, granted_at from public.entitlements order by granted_at desc limit 2;
select purchase_id, status, attempts, synced_at from public.crm_sync order by last_attempt_at desc limit 2;
```

- `stripe_events` → status `processed`
- `purchases` → one row
- `entitlements` → one row — this is what unlocks the document
- `crm_sync` → status `synced`

> *"The entitlement and CRM outbox row are written in one Postgres transaction.
> Zoho could be down right now and the customer already has access."*

---

### Part 4 — Idempotency proof (1 min)

```bash
stripe events resend evt_<id from the listener output>
```

Server log: `duplicate delivery ignored`. Run SQL again — **same row counts**.

> *"Three gates stop a replay: the event_id PK, unique stripe_session_id on purchases,
> and unique (client_id, document_id) on entitlements. The Zoho call is behind all three."*

---

### Part 5 — Tenant isolation (2 min)

Sign out → log in as `client-b@example.com`.

- Client B sees same documents (shared catalogue)
- "Sample Client Document" still **Locked** — Client A paid, not Client B
- Clicking Buy or attempting download → 403

> *"RLS enforces this in Postgres. Client B's JWT gives `current_client_id()` = B's ID.
> Even an explicit filter for A's ID returns zero rows."*

---

### Part 6 — Zoho outage simulation (2 min)

```bash
# Restart server with outage flag
ZOHO_SIMULATE_FAILURE=true npm run dev:server
```

Reset CRM row in SQL Editor:
```sql
update public.crm_sync set status = 'pending', attempts = 0, last_error = null, synced_at = null;
```

Portal — Client A still **Unlocked**. CRM Sync shows "Pending".

```bash
npm run retry-crm-sync -- --list   # shows what is owed
npm run retry-crm-sync             # simulated failure, attempts++
```

Restart without the flag, retry again → `synced`. Check Zoho — Deal Stage: **Closed Won**.

> *"CRM outbox pattern: access is correct immediately, sync catches up later.
> A Zoho outage lasting hours doesn't leave customers locked out."*

---

### Part 7 — Security edge cases (1 min)

**Forged webhook (no signature):**
```bash
curl -s -X POST http://localhost:8787/api/webhook \
  -H "content-type: application/json" \
  -d '{"type":"checkout.session.completed"}'
# Response: {"error":"missing_stripe_signature"} — 400, no DB work done
```

**Download attempt without entitlement:**
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:8787/api/documents/00000000-0000-4000-8000-000000000001/download \
  -H "authorization: Bearer <Client B token>"
# 403
```

---

### Part 8 — Tests (30 sec)

```bash
npm test
# 44 tests passing:
# webhookSignature    — signature acceptance/rejection (6 tests)
# webhookIdempotency  — 5 concurrent deliveries → exactly 1 purchase (7 tests)
# zohoOutage          — CRM down → access granted, row pending, retry works (16 tests)
# accessIsolation     — Client B can't access Client A's document (11 tests)
# errorHandling       — DB failure → 500, /api/health still 200 (4 tests)
```

---

### Key points to emphasise

1. **Price is never from the client** — Buy sends only a document ID; server reads price from DB
2. **Access is in Postgres** — browser reads its own rows via RLS, no server in the read path
3. **Three idempotency gates** — event_id PK → stripe_session_id unique → (client_id, document_id) unique
4. **CRM failure never blocks access** — entitlement + outbox are one transaction; CRM is best-effort
5. **Tenant isolation is database-enforced** — RLS + SECURITY DEFINER, not application checks

---

### Troubleshooting

| Problem | Fix |
|---|---|
| 500 on Buy button | Check server terminal; likely expired webhook secret — rerun `npm run stripe:listen`, update `.env` |
| Webhook received but stays Locked | Currency mismatch — select USD on Stripe page, not INR |
| CRM sync shows Failed | Check `crm_sync.last_error` in SQL Editor; run `npm run retry-crm-sync` |
| Login fails | Run `npm run seed`; check `SUPABASE_URL` matches in both `.env` and `web/.env.local` |
| Port already in use | `taskkill /F /IM node.exe` then retry |
| "Waiting for payment" banner on login | URL has `?payment=completed` from a previous visit — navigate to `http://localhost:5173` directly |

---

## 11. Interview Q&A

### What is this project about?

A **paid client access system** built as a senior full-stack integration exercise.

A client pays for a document through Stripe test checkout. After payment, they get access to download that document via a portal. The system also updates a Zoho CRM Deal to mark it as paid.

Three systems integrated end-to-end:
- **Stripe** — payment checkout and webhook delivery
- **Supabase** — database, auth, RLS-enforced access control, and file storage
- **Zoho CRM** — CRM Deal updated when a deal is paid

---

### What is required to complete this?

**Accounts:** Stripe test account, Supabase project, Zoho CRM Developer Edition

**Infrastructure:**
- 6 database migrations (tables, RLS policies, stored procedures)
- Private Supabase Storage bucket
- Two Zoho CRM Deals (one per demo client)
- Four custom fields on Zoho Deals

**Code:**
- Express server: checkout creation, webhook verification, download authorization
- Stripe webhook handler with signature verification and three-gate idempotency
- Zoho OAuth2 with token refresh, retry logic, and outage resilience
- React portal reading status directly from Supabase via RLS
- CRM retry script and admin endpoint

**Environment:** 17 env vars, Stripe CLI for local webhook forwarding

---

### What is the problem and my approach?

**Core problem:** Three external systems must stay consistent after a payment — Zoho might be down, a webhook might arrive twice, or the user might return before the webhook lands.

**Approach — three invariants:**

1. **The browser decides nothing about money or access.**
   Request body carries only a document ID. Price comes from the database. JWT comes from Supabase Auth. Nothing security-critical from the client.

2. **Access is granted by Postgres, not by Zoho.**
   Entitlement + CRM outbox row written in one Postgres transaction. Zoho being down at payment time doesn't affect the customer at all. The CRM sync is a retryable queue, not a gate.

3. **Every step is idempotent.**
   Three independent gates:
   - `stripe_events.event_id` PK — stops exact replays
   - Unique `stripe_session_id` on purchases — prevents duplicate purchase rows
   - Unique `(client_id, document_id)` on entitlements — prevents duplicate access grants

   All three must pass before the Zoho call is made.

**One deliberate refinement:** The event gate is three-way (`new` / `retry` / `done`) not binary. If the ledger row was written but the DB grant failed, returning 500 tells Stripe to retry with the same event ID. A naive "seen it → stop" check would eat that retry and leave a paying customer permanently locked out.

---

### What challenges did I face and how did I fix them?

**1. Port 5432 blocked by ISP**
`npm run db:migrate` timed out silently. Port 5432 (PostgreSQL) is blocked by many Indian ISPs.
*Fix:* Pasted all 6 migration files directly into the Supabase SQL Editor, which uses HTTPS.

**2. Stripe CLI `stripe listen` flag missing**
`stripe listen --forward-to localhost:8787/api/webhook` failed: "must specify events".
*Fix:* Added `--all-thin` flag.

**3. Missing `quantity` field on Stripe line items**
Clicking Buy returned 500. Server log: "Quantity is required on line_items[0]".
*Fix:* Added `quantity: 1` to both branches in `server/src/stripe/checkout.ts`.

**4. Zoho Self Client vs Server-based Application**
`zoho:bootstrap` expects a redirect flow. I had a Self Client that generates one-time codes.
*Fix:* Used Self Client's "Generate Code" → manually exchanged via `curl` for a refresh token.

**5. Zoho data centre mismatch**
All Zoho API calls failed silently. My org is on the India data centre (`.in`), not `.com`.
*Fix:* Set `ZOHO_ACCOUNTS_URL=https://accounts.zoho.in` and `ZOHO_API_URL=https://www.zohoapis.in/crm/v2/<org-id>`.

**6. Currency mismatch causing webhook quarantine**
After payment the document stayed Locked. The webhook was received with 200 but nothing was granted. I had selected INR (₹1,867) on Stripe; the handler checks `amount_total` against the document's price (1900 cents = $19.00 USD) — the numbers didn't match, so the event was quarantined.
*Fix:* Always select the USD option on the Stripe checkout page. The check is intentional security.

**7. Supabase renamed API keys**
Dashboard no longer shows "anon" and "service_role". Now shows "Publishable key" and "Secret key".
*Fix:* Publishable key = `SUPABASE_ANON_KEY`, Secret key = `SUPABASE_SERVICE_ROLE_KEY`.

**8. `web/.env.local` pointing to wrong Supabase project**
`env:check` warned that `SUPABASE_URL` and `VITE_SUPABASE_URL` named different projects. The placeholder had a typo in the project ref.
*Fix:* Updated `web/.env.local` to match the server `.env`.

---

### Tradeoffs and design decisions

**No automatic CRM retry scheduler**
The CRM retry is a manual command and admin endpoint — no cron job.
*Why:* A cron adds a moving part to a demo. The outbox pattern ensures no data is lost. A 30-minute cron calling the retry endpoint is the obvious next step.

**Rate limiter and token cache are in-memory**
Two instances would double rate limits and refresh tokens independently.
*Why:* Single-instance demo. Redis would fix both without touching handlers.

**Refund revokes access but does not update Zoho**
`entitlements.revoked_at` is set; access stops. Zoho Deal stage stays Paid.
*Why:* Updating Zoho on refund needs a second outbox pattern and a new field (`Refunded_At`). The access side is correct; the CRM gap is documented.

**`syncing` status added beyond the brief's three values**
The brief says `pending / synced / failed`. I added `syncing`.
*Why:* Without it, two concurrent webhook deliveries both read `pending` and both call Zoho. `syncing` is a database-level lease — a conditional UPDATE only one worker can win. A `syncing` row older than 2 minutes auto-reclaims, so a crashed worker's row self-heals.

**200 when Zoho is down, 500 when our own DB write fails**
*Why:* Two different failure modes. Zoho down = operations problem, not customer problem. Return 200, sync later. DB write failed = customer paid but has no access. Return 500 so Stripe retries with the same event ID.

**Three-way event gate, not binary**
`new` / `retry` / `done` instead of "seen it → stop".
*Why:* If the ledger row was written but the grant failed, we return 500 for a retry. That retry carries the same event ID. Binary duplicate check would eat it, leaving the customer permanently locked out. Only `processed` or `quarantined` events are truly done.

---

## 12. Tradeoffs

### Prioritisation order

1. **Access correctness and security** — a paying customer must get access and nobody else must. Schema, RLS, and the granting transaction came first.
2. **Idempotency** — webhooks are duplicated by design; "grant exactly once" is a correctness property.
3. **CRM resilience** — a sync failure is an operations problem, not a customer problem.
4. **UI polish** — deliberately last.

### What works

| Area | Status |
|---|---|
| Stripe webhook signature verification on raw bytes | ✅ 6 tests |
| Stable-ID matching + quarantine on any mismatch (client, document, deal, price) | ✅ tested |
| One-transaction grant via `grant_purchase()` RPC | ✅ |
| Three-gate idempotency including 5 concurrent deliveries | ✅ 7 tests |
| 500-then-retry when DB write fails | ✅ tested |
| Dependency failure → 500 instead of crashing the process | ✅ 4 tests |
| Zoho OAuth cache, 401 refresh, retryable vs fatal error split | ✅ 16 tests |
| Zoho outage → access granted, row pending, retry command | ✅ tested + `ZOHO_SIMULATE_FAILURE` |
| Refund revokes access | ✅ schema + RPC + handler + test |
| Portal buy → unlock → download flow | ✅ |
| 60-second signed download, storage path never exposed | ✅ tested |
| Tenant isolation (RLS) | ✅ 11 tests + integration test |
| TypeScript strict mode, both workspaces | ✅ |
| Production build boots with `--omit=dev` | ✅ |

### What is deliberately not done

- **No automatic retry scheduler** — manual command/endpoint exists; cron is the missing piece
- **Refund does not update Zoho** — access revoked correctly; CRM update needs a per-refund outbox row
- **No Dockerfile** — `README.md` section 8 covers what any host needs instead
- **Disputes not handled** — fall into safe-ignore; freeze on dispute is the first thing to add
- **No reconciliation job** — data is all present; just needs a read-only query + alert
- **No Playwright UI tests** — logic tests cover the invariants; a broken button is obvious, a broken idempotency guarantee is not

### What I would do next, in order

1. Run migrations and integration tests against a real project; fix any RLS/RPC issues
2. Add cron around `retryDue()` with metric alerting on rows older than N minutes
3. Dispute handling: freeze entitlements on `charge.dispute.created`
4. Nightly reconciliation: Stripe payments vs purchases vs CRM sync rows
5. Move rate limiter + token cache to Redis before running multiple instances
6. Playwright smoke test: buy → unlock → download
