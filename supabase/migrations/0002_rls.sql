-- 0002_rls.sql
-- Row Level Security: the browser talks to Supabase directly with the anon key
-- + the user's JWT, and RLS is what makes tenant isolation real.
-- Every table has RLS enabled. With no INSERT/UPDATE/DELETE policy defined,
-- writes are denied for anon/authenticated by default (service role only).

alter table public.clients      enable row level security;
alter table public.documents    enable row level security;
alter table public.purchases    enable row level security;
alter table public.entitlements enable row level security;
alter table public.crm_sync     enable row level security;
alter table public.stripe_events enable row level security;

-- auth.uid() -> the clients.id that belongs to the logged-in user.
-- SECURITY DEFINER so policies on purchases/entitlements/crm_sync can read
-- clients without recursing into that table's own policy.
create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.clients where auth_user_id = auth.uid();
$$;

revoke all on function public.current_client_id() from public;
grant execute on function public.current_client_id() to authenticated;

-- A user may see their own client row (email, deal ids). Nobody may write it.
create policy clients_select_own on public.clients
  for select to authenticated
  using (auth_user_id = auth.uid());

-- Catalogue metadata is readable, but through a column-narrowing view:
-- a plain (non security_invoker) view runs as its owner, so RLS on `documents`
-- does not apply, while storage_path simply is not part of the view.
create or replace view public.documents_public as
  select id, title, price_cents, currency
  from public.documents;

grant select on public.documents_public to anon, authenticated;

-- Belt and braces: no role other than service_role touches the base tables.
revoke all on public.documents      from anon, authenticated;
revoke all on public.stripe_events  from anon, authenticated;
revoke all on public.clients        from anon;
revoke all on public.purchases      from anon;
revoke all on public.entitlements   from anon;
revoke all on public.crm_sync       from anon;
revoke insert, update, delete on public.clients      from authenticated;
revoke insert, update, delete on public.purchases    from authenticated;
revoke insert, update, delete on public.entitlements from authenticated;
revoke insert, update, delete on public.crm_sync     from authenticated;

-- The three client-visible tables: own rows only, read-only.
create policy purchases_select_own on public.purchases
  for select to authenticated
  using (client_id = public.current_client_id());

create policy entitlements_select_own on public.entitlements
  for select to authenticated
  using (client_id = public.current_client_id());

-- crm_sync has no client_id; scope it through the purchase it belongs to.
create policy crm_sync_select_own on public.crm_sync
  for select to authenticated
  using (
    exists (
      select 1 from public.purchases p
      where p.id = crm_sync.purchase_id
        and p.client_id = public.current_client_id()
    )
  );

-- stripe_events intentionally has NO authenticated policy: it is an internal
-- ledger, and it carries no client_id, so nobody can read it from the browser.
