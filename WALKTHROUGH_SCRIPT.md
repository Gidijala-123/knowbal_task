# KnowBal — Walkthrough Script

---

## BEFORE YOU HIT RECORD

- [ ] `.env` file closed in editor — no secrets on screen
- [ ] `npm run dev` running (server :8787, portal :5173)
- [ ] `npm run stripe:listen` running in second terminal
- [ ] Supabase SQL Editor open in a tab
- [ ] Zoho CRM Deal open in a tab
- [ ] Test card ready: `4242 4242 4242 4242`, any future date, any CVC

---

## INTRO

"Hi, I'm Bhargava. This is my submission for the Paid Client Access task.

This task is about three systems working together — Stripe, Supabase, and Zoho CRM.

Stripe takes the payment and notifies the server when it succeeds — the client just
sees a checkout page, no credentials involved.

Supabase stores everything and controls who can access what. It handles login,
keeps the purchase records, and enforces that Client A can never see Client B's
data — even if they try.

Zoho CRM gets notified once the payment is confirmed so the sales team knows the
deal is closed and paid. It doesn't control access — that's Supabase's job.
Zoho is just kept in sync.

I'll do a live demo and show you what happens across all three systems in real time."

---

*(show Terminal 1, run `npm run dev`)*

"First I'll start everything with `npm run dev` — this brings up both the Express
server on port 8787 and the React portal on port 5173 at the same time."

*(open Terminal 2, run `npm run stripe:listen`)*

"Now I'll start the Stripe CLI in a second terminal. When a payment completes,
Stripe sends a webhook to notify my server. But my server is running locally —
it doesn't have a public URL that Stripe can reach directly.

So this CLI acts as a bridge — it receives the webhook from Stripe's servers and
forwards it to localhost. You can see it printed the webhook secret and automatically
saved it to the `.env` file, so I don't have to copy-paste it manually every time.

In production this step wouldn't exist — the server would have a real public URL
and Stripe would call it directly. This is just the standard local development setup."

*(point at the terminal showing `[stripe-listen] ✓ STRIPE_WEBHOOK_SECRET updated in .env`)*

"Both are running now — app is live at localhost:5173 and webhooks will come through."

---

## SECTION 1 — THE PORTAL

*(open http://localhost:5173, sign in as client-a@example.com)*

"This is Client A's portal. Eleven documents, all locked. Each card shows the
price, purchase status, and Zoho sync status.

The browser reads all of this directly from Supabase — the Express server isn't
involved in fetching this data. Postgres Row Level Security makes sure each client
only sees their own records."

*(sign out, sign in as client-b@example.com)*

"Client B sees the same documents but separate access. Even if Client A has paid
for something, Client B can't see it as unlocked — this is enforced at the
database level, not just in the UI."

*(sign back in as client-a@example.com)*

---

## SECTION 2 — MAKE A PAYMENT

*(click Buy access on Sample Client Document)*

"When I click Buy, the server reads the price from the database — it's never
taken from what the browser sends — creates a Stripe Checkout Session, and
redirects here."

*(enter card details and pay)*

*(switch to terminal)*

"Three events from Stripe, all returning 200. The one that matters is
`checkout.session.completed` — that's what grants access."

*(switch back to portal)*

"The portal was polling Supabase every two seconds. It found the new entitlement
row and the document flipped to Unlocked."

---

## SECTION 3 — SHOW THE DATA

*(switch to Supabase SQL Editor, run:)*

```sql
select event_id, type, status from public.stripe_events order by received_at desc limit 3;
select id, amount_cents, currency, paid_at from public.purchases order by paid_at desc limit 2;
select client_id, document_id, granted_at from public.entitlements order by granted_at desc limit 2;
select purchase_id, status, attempts, synced_at from public.crm_sync order by last_attempt_at desc limit 2;
```

"Four rows from one payment — the event ledger, the purchase, the entitlement,
and the Zoho sync row. The entitlement and the CRM outbox were written in the
same database transaction, so the customer had access before Zoho was even called."

*(switch to Zoho CRM, open Client A's deal)*

"And here in Zoho — Stage is Closed Won, Payment Status is Paid, Stripe Payment
ID and amount are filled in. This was updated automatically by the webhook."

---

## SECTION 4 — IDEMPOTENCY

*(look at the `stripe:listen` terminal — after the payment you'll see a line like:)*

```
--> checkout.session.completed [evt_test_65Vhox...]
```

*(copy that `evt_test_...` id, then run in the same terminal:)*

```bash
stripe events resend evt_test_65Vhox...
```

"I'm resending the exact same payment event that just came in — same event ID,
same payload. Watch the server log."

*(switch to the server terminal — it will show:)*

```
"message":"duplicate delivery ignored"
```

"The server recognised it as a duplicate and stopped immediately. If I run the
SQL again, same row counts — no second purchase, no second entitlement, no second
Zoho call. Three database constraints stop a double grant: the event ID primary
key, the unique Stripe session ID on purchases, and the unique client + document
pair on entitlements."

---

## SECTION 5 — LIMITATIONS

"A few honest gaps:

The RLS integration test is written but skips without live Supabase credentials —
I haven't run it against the real project yet.

CRM retry is manual — there's a command and an admin endpoint, but no automatic
scheduler. Pending rows don't get lost, they just need a manual trigger.

Refunds revoke access correctly but don't update the Zoho deal stage — that needs
its own outbox row which I haven't built.

During setup I hit a few real issues — my ISP blocks port 5432 so migrations had
to be pasted into the SQL Editor, the Stripe CLI needed an extra flag to work, and
the Zoho API uses .in domains for the India data centre which wasn't obvious.
All of this is documented in the README.

I used AI tools during the build — the brief said that's fine, and I'm happy to
explain or debug any part of this in a follow-up."

---

## OUTRO

"That's it — Stripe takes the payment, Supabase grants and guards access, Zoho
gets updated so the sales side knows the deal is closed. Access is granted in a
single database transaction, duplicate webhooks are handled by three database
constraints, and the browser reads directly from Supabase with RLS enforcing
isolation between clients.

Main gaps are the integration test, the auto-retry, and the Zoho refund update.
Thanks for watching."

---

*End of script.*
