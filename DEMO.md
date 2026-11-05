# Demo Walkthrough — Paid Client Access

This is a step-by-step script for recording or presenting the project live.
Estimated time: 10–15 minutes.

---

## Before you start — checklist

Open three windows side by side:
- **Browser tab 1** — the portal: `http://localhost:5173`
- **Browser tab 2** — Supabase SQL Editor
- **Terminal** — showing `npm run dev` output

Make sure:
- [ ] `npm run dev` is running (server :8787 + portal :5173)
- [ ] `npm run stripe:listen` is running in a second terminal
- [ ] Both terminals show no errors
- [ ] Test card ready: `4242 4242 4242 4242` / `12/29` / `123`

---

## Part 1 — The portal and access control (2 min)

**Step 1 — Show the login page**

Open `http://localhost:5173`. Point out:
- "Paid Client Access" — Stripe test checkout → Supabase entitlement → Zoho CRM
- Two demo accounts: Client A and Client B
- The hint box explaining the password

**Step 2 — Log in as Client A**

Click **Use Client A** → type the password (`TestAccess!234`) → **Sign in**.

Point out the animation: the login card glows green on success.

**Step 3 — Show the portal**

On the portal, point out:
- 11 documents listed in a grid, each showing price, purchase status, CRM sync status
- All documents are **Locked** — no payment yet
- "Status comes straight from Supabase under Row Level Security" at the bottom

> _"The browser never calls my Express server to read this. Four Supabase queries run
> directly from the browser with the user's JWT — Postgres's RLS filters them to
> only this client's rows."_

---

## Part 2 — The purchase flow (3 min)

**Step 4 — Start a purchase**

Click **Buy access for $19.00** on "Sample Client Document".

Point out in the terminal: a POST to `/api/checkout` — the server reads the price
from the database, never from the request body.

**Step 5 — Stripe checkout**

On the Stripe page:
- Point out the document name and amount
- **Important:** Select the **$19.00 USD** option (not INR)
- Fill in: `4242 4242 4242 4242` / `12/29` / `123` / any name
- Click **Pay**

**Step 6 — Watch the webhook**

After payment, the portal shows "Waiting for Stripe to confirm your payment…" with a pulsing animation.

Switch to the terminal — you'll see the webhook events arriving with `[200]`:
```
v1.payment_intent.succeeded
v1.checkout.session.completed   ← this is the one that grants access
v1.charge.updated
```

Point out: **the redirect doesn't grant access — the webhook does**. The portal polls
until it sees a new entitlement row in Supabase.

**Step 7 — Access granted**

The document card pops with a green unlock animation. It now shows:
- Badge: **Unlocked**
- Purchase: paid amount + date
- CRM Sync: Synced to Zoho (or Pending if Zoho is processing)

---

## Part 3 — The database proof (2 min)

Switch to the **Supabase SQL Editor** and run:

```sql
-- The four rows every payment creates
select event_id, type, status from public.stripe_events order by received_at desc limit 3;
select id, amount_cents, currency, paid_at from public.purchases order by paid_at desc limit 2;
select client_id, document_id, granted_at from public.entitlements order by granted_at desc limit 2;
select purchase_id, status, attempts, synced_at from public.crm_sync order by last_attempt_at desc limit 2;
```

Narrate:
- `stripe_events`: one row, status `processed`
- `purchases`: one row with the real amount
- `entitlements`: one row — this is what unlocks the document
- `crm_sync`: one row — either `synced` (Zoho updated) or `pending` (queued for retry)

> _"The entitlement and the CRM outbox row are written in one Postgres transaction.
> Zoho could be down at this exact moment and the customer already has access."_

---

## Part 4 — Idempotency proof (1 min)

In the terminal, resend the same event:

```bash
stripe events resend evt_<id from the listener output>
```

Watch the server log: `duplicate delivery ignored`.

Run the SQL query again — **same row counts**. No second purchase, no second entitlement.

> _"Three gates stop a replay: the event_id primary key, unique stripe_session_id on
> purchases, and unique (client_id, document_id) on entitlements. Any one alone would
> mostly work — the point is that the expensive Zoho call is behind all three."_

---

## Part 5 — Tenant isolation (2 min)

**Step 8 — Sign out and log in as Client B**

Click **Sign out** → log in as `client-b@example.com` / `TestAccess!234`.

Point out:
- Client B sees the same documents (catalogue is shared)
- "Sample Client Document" is still **Locked** for Client B — despite Client A having paid

**Step 9 — Try to download Client A's document as Client B**

Try clicking any Buy button for the document Client A already owns. The server
returns 403 — Client B has no entitlement.

> _"RLS in Postgres enforces this. Even if Client B crafted a request with Client A's
> document ID and their own JWT, the `current_client_id()` function in the policy
> returns B's ID — so the entitlement query returns zero rows."_

---

## Part 6 — Zoho outage simulation (2 min)

Stop the server, restart with the outage flag:

```bash
# In the dev terminal: Ctrl+C, then:
ZOHO_SIMULATE_FAILURE=true npm run dev:server
```

Force a CRM row back to pending in the SQL Editor:

```sql
update public.crm_sync set status = 'pending', attempts = 0, last_error = null, synced_at = null;
```

Show the portal — **Client A still has access**, document still Unlocked.

Then check CRM sync status in the portal — it shows "Pending".

Run the retry command:

```bash
npm run retry-crm-sync -- --list   # shows what is owed
npm run retry-crm-sync             # attempts all pending rows
```

Output shows the simulated failure. Re-run `retry-crm-sync` — attempts increments, row stays pending.

Restart without the flag:

```bash
# Ctrl+C, then:
npm run dev:server
npm run retry-crm-sync
```

Now it shows `synced`. Check the SQL — `synced_at` is set. Check Zoho — Deal Stage is **Closed Won**.

> _"The CRM outbox pattern: access is correct immediately, the sync catches up later.
> A Zoho outage lasting hours doesn't leave customers locked out."_

---

## Part 7 — Security edge cases (1 min)

**Forged webhook:**

```bash
curl -s -X POST http://localhost:8787/api/webhook \
  -H "content-type: application/json" \
  -d '{"type":"checkout.session.completed"}'
```

Response: `{"error":"missing_stripe_signature"}` — 400 before any DB work.

**Download without entitlement:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:8787/api/documents/00000000-0000-4000-8000-000000000001/download \
  -H "authorization: Bearer <Client B token>"
# 403
```

---

## Part 8 — Tests (30 sec)

```bash
npm test
```

Shows 44 tests passing:
- `webhookSignature` — signature acceptance/rejection
- `webhookIdempotency` — 5 concurrent deliveries → exactly 1 purchase
- `zohoOutage` — CRM down → access still granted, row pending, retry works
- `accessIsolation` — Client B can't access Client A's document
- `errorHandling` — DB failure → 500, server still responds to `/api/health`

---

## Key points to emphasise

1. **Price is never from the client** — the Buy button sends only a document ID; the server reads the price from the database.

2. **Access is in Postgres** — the browser reads its own rows via RLS with no server in the read path.

3. **Three idempotency gates** — event_id PK → stripe_session_id unique → (client_id, document_id) unique — so the Zoho call is behind all of them.

4. **CRM failure never blocks access** — entitlement + CRM outbox row are one transaction; the CRM call is best-effort and retryable.

5. **Tenant isolation is database-enforced** — RLS policies + SECURITY DEFINER function, not application-level checks.

---

## Troubleshooting during the demo

| Problem | Fix |
|---|---|
| Portal shows "Request failed (500)" on Buy | Check server terminal for the error; most likely an expired Stripe webhook secret — run `npm run stripe:listen` again and update `.env` |
| Webhook received but document stays Locked | Currency mismatch — make sure you selected USD on the Stripe page, not INR |
| CRM sync shows Failed | Check `crm_sync.last_error` in SQL Editor; run `npm run retry-crm-sync` |
| Login fails | Run `npm run seed` to ensure users exist; check `SUPABASE_URL` matches in both `.env` and `web/.env.local` |
| Port already in use on `npm run dev` | Run `taskkill /F /IM node.exe` then retry |


---

## Interview Q&A

### What is this project about?

This is a **paid client access system** built as a take-home engineering exercise.

The scenario: a client pays for a document through Stripe. After payment, they get access to download that document through a portal. The system also updates a Zoho CRM Deal to mark it as paid.

Three systems are integrated end-to-end:
- **Stripe** — handles the payment and sends a webhook after success
- **Supabase** — stores client entitlements and enforces access control via Row Level Security
- **Zoho CRM** — gets updated when a deal is paid

The portal is a React frontend that lets clients sign in, see their documents, buy access, and download once unlocked.

---

### What things are required to complete this?

**Accounts and credentials:**
- Stripe account (test mode) — for checkout and webhooks
- Supabase project — for the database, auth, and file storage
- Zoho CRM Developer Edition — for the CRM integration

**Infrastructure:**
- 6 database migrations defining tables, RLS policies, and stored procedures
- A private Supabase Storage bucket for the documents
- Two Zoho CRM Deals (one per demo client)
- Four custom fields added to Zoho Deals (Payment Status, Stripe Payment ID, Paid Amount, Paid At)

**Code:**
- Express server handling checkout creation, webhook verification, and download authorization
- Stripe webhook handler with signature verification and idempotency
- Zoho OAuth2 integration with token refresh and retry logic
- React portal reading status directly from Supabase via RLS
- CRM retry script for when Zoho is unavailable

**Environment setup:**
- 17 environment variables across the server and frontend
- Stripe CLI for local webhook forwarding

---

### What is the problem and my approach?

**The core problem** is that three external systems (Stripe, Supabase, Zoho) must stay consistent after a payment, even when things go wrong — Zoho might be down, a webhook might be delivered twice, or the user might return to the portal before the webhook arrives.

**My approach was built around three invariants:**

1. **The browser decides nothing about money or access.**
   The checkout request body only carries a document ID — the server reads the price from the database. The download request only carries a JWT — the server checks the entitlement. Nothing security-critical comes from the client.

2. **Access is granted by Postgres, not by Zoho.**
   The entitlement and the CRM outbox row are written in a single Postgres transaction. This means: if Zoho is down when a payment lands, the customer still gets access immediately. The CRM sync is a queue that catches up later — it can never block or revoke access.

3. **Every step is idempotent.**
   Webhooks are designed to be retried by Stripe. A duplicate delivery must produce exactly the same outcome as the first. I built three independent gates:
   - The `stripe_events.event_id` primary key stops exact replays at the database level
   - The unique `stripe_session_id` on purchases prevents a second purchase row
   - The unique `(client_id, document_id)` on entitlements prevents a second entitlement

   All three must pass before the Zoho call is made, so even concurrent duplicate deliveries racing past the first gate still result in only one Zoho update.

---

### What challenges did I face and how did I fix them?

**Challenge 1 — Port 5432 blocked by ISP**

Running `npm run db:migrate` to apply migrations kept timing out with no error message. After investigation, I found that the PostgreSQL port (5432) is blocked by many Indian ISPs at the network level.

*Fix:* Applied all 6 migration files manually by pasting them into the Supabase SQL Editor, which works over HTTPS and doesn't require a direct Postgres connection.

**Challenge 2 — Stripe CLI `stripe listen` failing**

Running `stripe listen --forward-to localhost:8787/api/webhook` failed with "must specify events to forward using --events, --all-snapshot, or --all-thin".

*Fix:* Added the `--all-thin` flag: `stripe listen --forward-to localhost:8787/api/webhook --all-thin`

**Challenge 3 — Missing `quantity` field in Stripe checkout**

Clicking Buy caused a 500 error. The server log showed: `"Quantity is required. Add 'quantity' to line_items[0]"`. The Stripe API requires a `quantity` field on every line item, even when it's always 1.

*Fix:* Added `quantity: 1` to both branches of the `lineItem` object in `server/src/stripe/checkout.ts`.

**Challenge 4 — Zoho OAuth: Self Client vs Server-based Application**

The `npm run zoho:bootstrap` script expects a Server-based Application OAuth client (with a redirect URI). I had created a Self Client, which generates one-time authorization codes instead of handling redirects.

*Fix:* Used the Self Client's "Generate Code" feature to get a one-time auth code, then manually exchanged it for a refresh token via `curl` against the Zoho token endpoint.

**Challenge 5 — Zoho data centre mismatch**

The `.env.example` defaulted to `accounts.zoho.com` and `zohoapis.com`, but my Zoho account is on the India data centre. All Zoho API calls were failing silently.

*Fix:* Updated both `ZOHO_ACCOUNTS_URL=https://accounts.zoho.in` and `ZOHO_API_URL=https://www.zohoapis.in/crm/v2/<org-id>` to use the `.in` domain.

**Challenge 6 — Currency mismatch causing webhook quarantine**

After completing a Stripe payment, the portal kept showing "Payment looks complete but the receipt has not been processed yet." The webhook was received with 200 but the document stayed Locked.

The webhook handler checks `amount_total` against the document's price in cents (1900 = $19.00 USD). I had selected the INR option on the Stripe checkout page, which charged ₹1,867 — a different number entirely, so the event was quarantined.

*Fix:* Always select the USD option on the Stripe checkout page. The check is intentional — it prevents a tampered checkout session from granting access at an unexpected price.

**Challenge 7 — Supabase new API key format**

The Supabase dashboard no longer shows `anon` and `service_role` keys by those names. The new UI shows "Publishable key" and "Secret key" respectively.

*Fix:* Identified the mapping: Publishable key = `SUPABASE_ANON_KEY`, Secret key = `SUPABASE_SERVICE_ROLE_KEY`. Both formats (old `eyJ...` JWT and new `sb_publishable_/sb_secret_` format) work the same way.

**Challenge 8 — `web/.env.local` pointing to a wrong Supabase project**

The `env:check` script warned that `SUPABASE_URL` and `VITE_SUPABASE_URL` named different projects. The placeholder in `web/.env.local` had a slightly different project ref than the real one.

*Fix:* Updated `web/.env.local` to use the same project URL and anon key as the server `.env`.

---

### Tradeoffs and design decisions

**Tradeoff 1 — No automatic CRM retry scheduler**

The CRM retry is a manual command (`npm run retry-crm-sync`) and an admin endpoint. There is no cron job or message queue that runs it automatically.

*Why:* A cron adds a moving part to a local demo that the reviewer has to run. The outbox pattern is in place — the data is never lost. Adding a scheduler is the next step, not a missing requirement.

*What I'd do next:* A 30-minute cron calling the retry endpoint, with a metric alert on rows older than N minutes.

**Tradeoff 2 — Rate limiter and Zoho token cache are in-memory**

Both live in the process. Two instances would double the rate limits and refresh tokens independently.

*Why:* The brief is for a single-instance demo. Redis would be the right fix but adds infrastructure overhead that's not appropriate for this scope.

**Tradeoff 3 — Refund does not update Zoho**

When a refund is issued, `entitlements.revoked_at` is set and access stops immediately. But the Zoho Deal stage is not updated back.

*Why:* It needs a second outbox pattern — an outbox row per refund rather than per purchase, plus a new Zoho field (`Refunded_At`). That's a schema change worth designing carefully. The access side is correct; the CRM side is documented as a known gap.

**Tradeoff 4 — `syncing` status added beyond the brief's three values**

The brief specifies `pending / synced / failed`. I added a fourth state: `syncing`.

*Why:* Without it, two concurrent webhook deliveries could both read `pending` and both call Zoho simultaneously. `syncing` acts as a lease — it's a conditional UPDATE that only one worker can win. A `syncing` row older than 2 minutes automatically becomes claimable again, so a crashed worker's row self-heals.

**Tradeoff 5 — Webhook returns 200 when Zoho is down, but 500 when our own DB write fails**

*Why:* These are two different failure modes. A Zoho failure is an operations problem — the customer has paid, they should get access, and the CRM catches up later. A database failure means the entitlement was never written — the customer is locked out even though they paid. Returning 500 in the second case tells Stripe to retry, which is exactly the queue we want. Returning 500 in the first case would cause a retry storm against a CRM that's already down.

**Tradeoff 6 — Three-way event gate instead of simple duplicate check**

The event gate has three states: `new`, `retry`, `done` — not just "seen it before, stop".

*Why:* If the ledger row was written but the database grant then failed, I return 500 so Stripe retries. That retry carries the same event ID. A naive "seen it before → stop" check would eat that retry and leave a paying customer permanently locked out. Only an event that reached `processed` or `quarantined` is treated as truly done.
