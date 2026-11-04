-- 0003_grant_purchase.sql
-- The whole grant happens in ONE Postgres transaction: a single RPC call is one
-- implicit transaction, so if any statement below fails nothing is written and
-- the webhook returns 500, which makes Stripe retry the delivery.

create or replace function public.grant_purchase(
  p_client_id             uuid,
  p_document_id           uuid,
  p_stripe_session_id     text,
  p_stripe_payment_intent_id text,
  p_amount_cents          integer,
  p_currency              text,
  p_paid_at               timestamptz,
  p_zoho_deal_id          text,
  p_event_id              text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase_id  uuid;
  v_is_new       boolean := false;
begin
  -- Re-check existence server-side even though the handler already validated:
  -- this function is the last line of defence before access is granted.
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'unknown client %', p_client_id;
  end if;
  if not exists (select 1 from public.documents where id = p_document_id) then
    raise exception 'unknown document %', p_document_id;
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount %', p_amount_cents;
  end if;

  -- Defence layer 2: unique stripe_session_id. A replay gets no RETURNING row,
  -- so we fall through to the existing purchase instead of creating a second.
  insert into public.purchases as pu
    (client_id, document_id, stripe_session_id, stripe_payment_intent_id,
     amount_cents, currency, paid_at)
  values
    (p_client_id, p_document_id, p_stripe_session_id, p_stripe_payment_intent_id,
     p_amount_cents, lower(p_currency), coalesce(p_paid_at, now()))
  on conflict (stripe_session_id) do nothing
  returning pu.id into v_purchase_id;

  if v_purchase_id is null then
    select id into v_purchase_id
      from public.purchases
     where stripe_session_id = p_stripe_session_id;
  else
    v_is_new := true;
  end if;

  -- Defence layer 3: unique (client_id, document_id). Paying twice for the same
  -- document (e.g. a second Checkout that slipped past the guard) cannot create
  -- a second entitlement.
  if v_is_new then
    insert into public.entitlements (client_id, document_id, purchase_id)
    values (p_client_id, p_document_id, v_purchase_id)
    on conflict (client_id, document_id) do nothing;
  end if;

  -- The CRM outbox row is written here, not after the Zoho call: access is
  -- already correct and the sync is guaranteed to be retried later.
  if v_is_new then
    insert into public.crm_sync (purchase_id, zoho_deal_id, status)
    values (v_purchase_id, p_zoho_deal_id, 'pending')
    on conflict (purchase_id) do nothing;
  end if;

  update public.stripe_events
     set status = 'processed', processed_at = now(), purchase_id = v_purchase_id
   where event_id = p_event_id;

  return jsonb_build_object(
    'purchase_id', v_purchase_id,
    'is_new',      v_is_new,
    'granted',     true
  );
end;
$$;

-- Service role only: this function grants access, so no browser may call it.
revoke all on function public.grant_purchase(
  uuid, uuid, text, text, integer, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.grant_purchase(
  uuid, uuid, text, text, integer, text, timestamptz, text, text
) to service_role;
