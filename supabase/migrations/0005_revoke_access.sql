-- 0005_revoke_access.sql
-- Refund / dispute path: money came back, so access goes away. The purchase is
-- kept for accounting; the entitlement is revoked rather than deleted so the
-- grant history stays auditable.

create or replace function public.revoke_access_for_payment_intent(
  p_stripe_payment_intent_id text,
  p_event_id text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.entitlements e
     set revoked_at = now()
    from public.purchases p
   where p.id = e.purchase_id
     and p.stripe_payment_intent_id = p_stripe_payment_intent_id
     and e.revoked_at is null;
  get diagnostics v_count = row_count;

  update public.purchases
     set refunded_at = now()
   where stripe_payment_intent_id = p_stripe_payment_intent_id
     and refunded_at is null;

  update public.stripe_events
     set status = 'processed',
         processed_at = now(),
         error = p_reason
   where event_id = p_event_id;

  return v_count;
end;
$$;

-- A revoked entitlement must not be resurrected by a later duplicate delivery:
-- grant_purchase only inserts for a brand-new purchase, and a refunded session
-- is already present, so the ON CONFLICT path leaves the revocation intact.

revoke all on function public.revoke_access_for_payment_intent(text, text, text)
  from public, anon, authenticated;
grant execute on function public.revoke_access_for_payment_intent(text, text, text)
  to service_role;
