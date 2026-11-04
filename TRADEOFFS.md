# Tradeoffs

Time budget was ~5 hours including account setup. This is what that bought,
what it did not, and why the order was what it was.

## Prioritisation

The brief's order is the order I followed, and it is the right one:

1. **Access correctness and security** — a paying customer must get access and
   nobody else must. Everything else can be degraded; this cannot. So the
   schema, RLS and the granting transaction came first, before any UI existed.
2. **Idempotency** — webhooks are duplicated by design, so "grant exactly once"
   is a correctness property, not a nicety.
3. **CRM resilience** — a sync failure is an operations problem, not a customer
   problem, provided the outbox never loses the work.
4. **UI polish** — deliberately last. Two screens, no component library, no
   routing.

The consequence: the portal is ugly on purpose and the webhook handler is not.

## What works

| Area | State |
| --- | --- |
| Signature verification on raw bytes | done, 6 tests |
| Stable-ID matching + quarantine on any mismatch (client, document, deal, **price**) | done, tests |
| One-transaction grant via `grant_purchase()` | written; SQL not yet executed here |
| Three-gate idempotency, including concurrent deliveries | done, tests incl. 5 racing deliveries |
| 500-then-retry path when our DB write fails | done, test proves the customer is not stranded |
| Zoho OAuth cache, single 401 refresh, timeout, retryable vs fatal split | done, tests with a fake fetch |
| Outage keeps access granted, row pending, reason stored | done, tests + `ZOHO_SIMULATE_FAILURE` |
| Retry command **and** admin endpoint, both safe to re-run | done |
| Portal status + buy + download, RLS-scoped reads | done, builds; not clicked through yet |
| 60-second signed download, path never exposed | done, tests |
| Refund revokes access | done (schema + RPC + handler), test |
| Live RLS isolation test | written, **skipped without credentials** |
| Docs: README, WALKTHROUGH, TRADEOFFS, `.env.example` | done |

## What is deliberately not done

**No queue or scheduler.** Stuck `pending` rows are drained by a command or an
endpoint, not automatically. A 30-minute cron calling `retryDue()` is the whole
missing piece; I left it out because a cron in a repo someone has to run locally
adds a moving part to a demo without adding evidence.

**Refund does not update Zoho.** Access is revoked, but the Deal still says
Paid. It needs a second field (`Refunded_At`) and an outbox row keyed per refund
rather than per purchase — a schema change, not a few lines. Documented in
`README.md` section 8 rather than half-built.

**Disputes are not handled at all.** `charge.dispute.created` /
`.closed` fall into the "ignore safely" branch. A dispute should freeze access
the way a refund does, and that is the first thing I would add after the queue.

**No reconciliation job.** The brief lists comparing Stripe vs Supabase vs Zoho
as a long-term item; it is not here. The data to do it is all present
(`stripe_session_id`, `stripe_payment_intent_id`, `zoho_deal_id`,
`crm_sync.status`), so the job is a read-only query plus an alert.

**Rate limiting and token cache are per-process.** Fine for one instance, wrong
for several. Redis would replace both without touching the handlers.

**No retries with backoff on the Zoho call.** One attempt per trigger, then the
row waits for the next sweep. Backoff exists implicitly (a sweep only claims a
row whose lease has expired) but there is no exponential delay between sweeps.

**The UI has no tests.** Playwright would be the natural next layer; with the
time left I put the tests on the invariants instead, because a broken button is
obvious and a broken idempotency guarantee is not.

**`documents_public` uses a plain view.** It runs as its owner, which is exactly
why it can expose fewer columns than the base table. If someone later converts
it to `security_invoker`, RLS would apply to the base table and the view would
start returning nothing — a trap worth a comment, and it has one in 0002.

## Honest verification status

The four offline suites pass (40 tests) and both workspaces typecheck, but they
test the *logic* against an in-memory repository that mirrors the unique
constraints and the lease rules. **The five SQL migrations have not been run
against a Postgres instance from this machine** — no Docker, no `psql`. So:

- the DDL, the RLS policies and the four RPC signatures are unverified until
  `supabase db push` is run;
- the live isolation test is skipped, not deleted;
- nothing here has completed a real Stripe redirect or written a real Zoho Deal.

First five minutes on a fresh project: apply migrations → `npm run seed` →
`RUN_INTEGRATION=1 npm run test:integration -w server` → one real test payment.
If any of those fail, the failure is in the SQL or in the Zoho field names, and
`README.md` section 10 maps each symptom to its cause.

## What I would do next, in order

1. Run the migrations and the integration test against a real project; fix any
   policy or RPC signature error.
2. Add a cron/queue around `retryDue()` with a metric on rows older than N
   minutes, so an outage is visible instead of merely recoverable.
3. Dispute handling: freeze entitlements on `charge.dispute.created`.
4. A nightly reconciliation query (Stripe payments vs purchases vs synced rows)
   with a summary notification.
5. Move the limiter and token cache to Redis before running more than one
   instance.
6. Playwright smoke test for buy → unlock → download.

## Things I would change about the design, given more time

- **Make the outbox the only writer of `crm_sync`.** Today the webhook writes
  the row inside the grant transaction and then calls Zoho inline for the happy
  path. Always deferring to the sweeper would make the two paths identical and
  remove a class of "works live, breaks on retry" difference.
- **Store the raw event payload.** The ledger records the verdict and the reason
  but not the body, so a quarantined event cannot be replayed after a fix
  without going back to Stripe. A `jsonb` column plus a redaction step on the
  way in would be worth it.
- **Type the DB layer with generated types.** `supabase gen types typescript`
  would remove the handful of `as unknown as` casts in `supabaseRepository.ts`.
  I kept them to a single file so they are one command away from being deleted.
