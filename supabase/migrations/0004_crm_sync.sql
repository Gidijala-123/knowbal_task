-- 0004_crm_sync.sql
-- Claiming and finishing a CRM sync. The claim is the concurrency gate: two
-- duplicate webhook deliveries processed at the same instant must not both
-- reach Zoho.

-- Lease default 2 minutes: a 'syncing' row older than that means the previous
-- worker died mid-call, so it becomes claimable again. This is also what makes
-- a stuck row self-heal under a scheduled retry.
create or replace function public.claim_crm_sync(
  p_purchase_id uuid,
  p_lease interval default interval '2 minutes'
)
returns table (zoho_deal_id text, attempts integer)
language sql
security definer
set search_path = public
as $$
  update public.crm_sync
     set status = 'syncing',
         attempts = attempts + 1,
         last_attempt_at = now()
   where purchase_id = p_purchase_id
     and (
       status in ('pending', 'failed')
       or (status = 'syncing' and last_attempt_at < now() - p_lease)
     )
  returning public.crm_sync.zoho_deal_id, public.crm_sync.attempts;
$$;

-- 'synced' rows are never claimable, which is what makes `npm run
-- retry-crm-sync` safe to run over and over.

-- result: 'synced' | 'retry' (transient, go back to pending) | 'fatal' (400/404,
-- needs a human, stop burning attempts).
-- plpgsql rather than a plain sql function: Postgres parses a CHECK on a
-- function parameter and then silently ignores it, so the guard has to live in
-- the body to actually reject a typo like 'syncd'.
create or replace function public.finish_crm_sync(
  p_purchase_id uuid,
  p_result text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_result is null or p_result not in ('synced', 'retry', 'fatal') then
    raise exception 'finish_crm_sync: unexpected result %', p_result;
  end if;

  update public.crm_sync
     set status = case p_result when 'synced' then 'synced'
                                when 'fatal'  then 'failed'
                                else 'pending' end,
         synced_at = case when p_result = 'synced' then now() else synced_at end,
         last_error = case when p_result = 'synced' then null
                           else left(coalesce(p_error, 'unknown error'), 500) end,
         last_attempt_at = now()
   where purchase_id = p_purchase_id
     and status = 'syncing';
end;
$$;

-- Rows the retry command / admin endpoint should work on: never-synced, failed,
-- or abandoned mid-flight.
create or replace function public.list_crm_sync_due(p_limit integer default 50)
returns table (
  purchase_id   uuid,
  zoho_deal_id  text,
  status        text,
  attempts      integer,
  last_error    text,
  last_attempt_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select cs.purchase_id, cs.zoho_deal_id, cs.status, cs.attempts,
         cs.last_error, cs.last_attempt_at
    from public.crm_sync cs
   where cs.status in ('pending', 'failed')
      or (cs.status = 'syncing' and cs.last_attempt_at < now() - interval '2 minutes')
   order by cs.last_attempt_at nulls first
   limit p_limit;
$$;

revoke all on function public.claim_crm_sync(uuid, interval) from public, anon, authenticated;
revoke all on function public.finish_crm_sync(uuid, text, text) from public, anon, authenticated;
revoke all on function public.list_crm_sync_due(integer) from public, anon, authenticated;
grant execute on function public.claim_crm_sync(uuid, interval) to service_role;
grant execute on function public.finish_crm_sync(uuid, text, text) to service_role;
grant execute on function public.list_crm_sync_due(integer) to service_role;
