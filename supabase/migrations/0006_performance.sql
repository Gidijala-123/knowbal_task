-- 0006_performance.sql
-- Indexes for the query shapes this application actually issues, plus the
-- statistics the planner needs to use them. Each entry names the query it
-- serves: an index nobody can attribute is permanent write cost.
--
-- Honest caveat: at demo row counts every one of these is invisible. They are
-- here because the shapes are right, not because a number can be quoted.

-- 1) Refunds. revoke_access_for_payment_intent() joins the two tables:
--      update entitlements e ... from purchases p
--        where p.id = e.purchase_id and p.stripe_payment_intent_id = $1
--    `p` is reached through the unique stripe_payment_intent_id index, but the
--    other side had no index at all, so Postgres would read every entitlement
--    row to find the two or three belonging to that purchase. This also serves
--    ON DELETE CASCADE from purchases.
create index if not exists entitlements_purchase_idx on public.entitlements (purchase_id);

-- 2) The download authorization check asks for one client + document pair that
--    is not revoked. UNIQUE(client_id, document_id) already gives the leading
--    two columns, and revoked_at is a filter on the single matched row. Adding a
--    third-column index would not change the plan — recorded as a deliberate
--    non-change.

-- 3) The CRM sweeper. list_crm_sync_due() wants rows that are owed:
--      status in ('pending','failed')
--      or (status = 'syncing' and last_attempt_at < now() - interval '2 minutes')
--    ordered by last_attempt_at nulls first, limit 50.
--    The old composite (status, last_attempt_at) indexed every already-synced
--    row forever and matched neither half of that OR exactly. Two partial
--    indexes each cover one branch, so the planner can BitmapOr them and skip
--    the synced majority. 'asc nulls first' is written out because fresh rows
--    have last_attempt_at NULL and the function asks for NULLS FIRST: a plain
--    btree stores NULLs last, which would leave that ordering to a sort.
--    What remains is a sort to merge the two branches into one ordering, which
--    the LIMIT still has to pay for; cheap at this size, and worth saying so.
create index if not exists crm_sync_due_idx
  on public.crm_sync (last_attempt_at asc nulls first)
  where status in ('pending', 'failed');

create index if not exists crm_sync_lease_idx
  on public.crm_sync (last_attempt_at asc nulls first)
  where status = 'syncing';

-- claim_crm_sync() looks a row up by purchase_id, which the UNIQUE constraint
-- on crm_sync.purchase_id already indexes.
drop index if exists public.crm_sync_status_idx;

-- 4) Portal reads filter purchases and entitlements by client_id.
--    purchases_client_idx (0001) is the only index that can serve that filter,
--    so it stays. On entitlements it is redundant: UNIQUE(client_id,
--    document_id) already builds a btree whose leading column is client_id.
--    It is left in place anyway, because dropping it would make the RLS read
--    path depend on a constraint that could be redefined later, and one small
--    secondary index on a table this write-scarce is not worth that coupling.
--    The portal does not sort in SQL — it builds Maps from four short lists in
--    memory — so no (client_id, paid_at) composite is added. If a later screen
--    orders history newest-first, that is the moment to add it.

-- 5) stripe_events keeps (status, received_at) for operator queries such as
--    "what did we quarantine today". No application query uses it; the webhook
--    path reads by event_id (the primary key). Low write volume, kept on purpose.

-- 6) The RLS predicates call public.current_client_id(), declared
--    `language sql stable` in 0002. Stable is the right class for a value that
--    cannot change inside one statement, and it is already what the migration
--    says — this note exists to record the limit of what was verified here:
--    whether Postgres evaluates such a predicate once per statement or once per
--    scanned row is a planner decision, and there is no database on this machine
--    to EXPLAIN against. If a real project ever shows the portal reads are slow,
--    EXPLAIN that query first; the usual fix is hoisting the lookup into a
--    `with` clause rather than touching the policy's meaning.

-- 7) Considered and rejected: one RPC that json-aggregates documents,
--    entitlements, purchases and crm_sync so the portal makes one HTTP call
--    instead of four. The four calls are issued with Promise.all, so they
--    already overlap in a single round trip; collapsing them trades a readable
--    RLS-scoped query per table for a SECURITY DEFINER function whose own
--    policies have to be re-derived. No latency win to buy that with.

-- Give the planner real row counts. These tables start empty and are written
-- only by webhooks, so without this the first sweep is planned from defaults.
analyze public.entitlements;
analyze public.crm_sync;
analyze public.purchases;
