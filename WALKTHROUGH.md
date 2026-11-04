# 15-Minute Walkthrough

Preconditions before you start talking:

```bash
npm run dev                 # server :8787, portal :5173
npm run stripe:listen       # separate terminal, keep the whsec_ line visible
# .env: ZOHO_SIMULATE_FAILURE=false, both deal ids filled, migrations applied, npm run seed done
```

Have three windows ready: the portal, the Supabase SQL editor, and a terminal.
Keep a Stripe test card ready: `4242 4242 4242 4242`, any future expiry.

---

### 0:00 – 1:00 — the shape of it

Open `README.md` section 2 and say: three rules — the browser decides nothing
about money or access; Postgres grants access, not Zoho; every step is
idempotent. Then start the flow.

### 1:00 – 2:30 — log in as Client A

Portal → `client-a@example.com` with `SEED_CLIENT_PASSWORD`.

Point at the Network tab: the page issues four PostgREST queries with the anon
key and A's JWT — `documents_public`, `entitlements`, `purchases`, `crm_sync`.
Document shows **Locked**, purchase "No payment recorded", sync "Not applicable".

> "This read never touches my Express server. RLS in Postgres is what decides
> that these are A's rows."

### 2:30 – 5:00 — buy it

Click **Buy access for $19.00**. Before redirecting, show the request:

```bash
curl -s -X POST http://127.0.0.1:8787/api/checkout \
  -H "authorization: Bearer <A's access token>" \
  -H 'content-type: application/json' \
  -d '{"documentId":"00000000-0000-4000-8000-000000000001","amountCents":1}'
```

Say: the body tried to pay one cent. It is ignored — the amount comes from the
`documents` row. On Stripe's page, pay with the test card.

### 5:00 – 7:00 — follow the event through all three systems

Back in the portal: **Unlocked**, and the sync badge may flash Pending — the
page is polling, because the redirect proves nothing, the webhook does.

Terminal:

```bash
stripe events list --limit 3
```

Pick the `checkout.session.completed` id. SQL editor:

```sql
select event_id, type, status, purchase_id, error from stripe_events order by received_at desc limit 5;
select id, stripe_session_id, stripe_payment_intent_id, amount_cents, currency, paid_at from purchases order by paid_at desc limit 2;
select e.client_id, d.title, e.granted_at, e.revoked_at
  from entitlements e join documents d on d.id = e.document_id order by e.granted_at desc limit 2;
select purchase_id, zoho_deal_id, status, attempts, last_error, synced_at from crm_sync order by last_attempt_at desc nulls last limit 2;
```

Narrate: one event row `processed`, one purchase, one entitlement, one outbox row
`synced`. Then open the Zoho Deal — Stage **Closed Won**, Payment Status **Paid**,
Stripe Payment ID and Paid Amount filled.

### 7:00 – 8:30 — prove idempotency

```bash
stripe events resend evt_THE_SAME_ID --events checkout.session.completed
```

Watch the server log line `duplicate delivery ignored`, then re-run the four
queries: **same counts**. Explain the three gates, and that the interesting one
is the atomic claim — two deliveries racing past the first gate still only make
one Zoho call.

Then the harder case, out loud:

> "If the database had been down when the payment landed, we return 500 so
> Stripe retries — and that retry carries the same event id. A naive
> 'seen this id before, stop' check would eat the retry and leave a paying
> customer locked out. So the gate is three-way: new, retry, done."

### 8:30 – 10:30 — simulate a Zoho outage

```bash
# stop the server (Ctrl-C in the dev terminal), then:
ZOHO_SIMULATE_FAILURE=true npm run dev:server
```

Buy nothing new — instead show the retry path on a fresh purchase: in the SQL
editor, force one row back to pending:

```sql
update crm_sync set status = 'pending', attempts = 0, last_error = null, synced_at = null;
```

Run the retry:

```bash
npm run retry-crm-sync -- --list
npm run retry-crm-sync
```

Expected output: `1. retry - simulated outage (ZOHO_SIMULATE_FAILURE=true)` and
`attempted=1 {"retry":1}`. Re-check `crm_sync`: status **pending**, attempts 1,
`last_error` filled. **Then show the portal: Client A is still Unlocked and can
still download.** That is the requirement: the CRM cannot gate access.

Restart without the flag and drain it:

```bash
npm run retry-crm-sync
# 1. synced
```

`crm_sync` now says `synced` with `synced_at`. Run it twice more: the sweep
returns `nothing pending`, and an explicit `-- purchase` retry reports
`skipped`. Re-running is safe.

### 10:30 – 12:30 — tenant isolation

Sign out, sign in as `client-b@example.com`.

- B sees the same document (catalogue metadata is shared) but **Locked**, with no
  purchase and no sync row.
- Try B's download of A's document:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8787/api/documents/00000000-0000-4000-8000-000000000001/download \
  -H "authorization: Bearer <B's access token>"
# 403
```

- Show the same refusal at the database, where it is enforced rather than in my
  code: in the SQL editor, run as B in the portal's session and point out that
  `select * from entitlements` returns only B's rows even with an explicit
  `.eq('client_id', A)`. Or run the live test:

```bash
RUN_INTEGRATION=1 npm run test:integration -w server
```

- Show that `select storage_path from documents;` fails for a browser role, and
  that the portal reads `documents_public` instead — the path exists only
  server-side, and the download is a 60-second signed URL.

### 12:30 – 14:00 — the failure modes on purpose

```bash
curl -s -X POST http://127.0.0.1:8787/api/webhook -H 'content-type: application/json' \
  -d '{"id":"evt_forged","type":"checkout.session.completed","data":{}}'
# {"error":"missing_stripe_signature"}  400
```

> "No signature, no work. And the check runs on raw bytes, which is why the
> webhook router is mounted before the JSON parser — one line of ordering that
> a later refactor can silently break, so there is a test whose only job is to
> keep it."

Then show quarantine, which is the part most implementations skip: in the SQL
editor, temporarily change A's deal id, resend an event, and show
`stripe_events.status = 'quarantined'` with the reason in `error` and **no
entitlement created**. Put the value back.

### 14:00 – 15:00 — tradeoffs

Close on `TRADEOFFS.md`: what is stubbed, what is next, and why the order was
access correctness and security, then idempotency, then CRM resilience, then UI.
Say the one thing that is not yet proven here: the migrations have not run on a
real Postgres instance from this machine, so the first action on a fresh project
is `supabase db push` followed by the integration test.

---

## Cheat sheet

| Want to show | Command / query |
| --- | --- |
| the four rows a payment leaves behind | the SQL block at 5:00 |
| no duplicate on replay | `stripe events resend evt_...` |
| CRM down but access fine | `ZOHO_SIMULATE_FAILURE=true`, then the portal |
| drain the queue | `npm run retry-crm-sync` |
| isolation at the HTTP edge | the two `curl`s at 10:30 |
| isolation in the database | `RUN_INTEGRATION=1 npm run test:integration -w server` |
| forged webhook | the `curl` at 12:30 |
| everything at once | `npm test` (40 tests) |
