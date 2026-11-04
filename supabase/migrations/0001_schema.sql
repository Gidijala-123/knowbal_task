-- 0001_schema.sql
-- Tables only. RLS lives in 0002, RPCs in 0003-0005.
-- Run with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

create extension if not exists pgcrypto;

-- One row per paying client. auth_user_id is the link to Supabase Auth, so the
-- browser's JWT can be resolved to a client without trusting any client input.
create table if not exists public.clients (
  id                  uuid primary key default gen_random_uuid(),
  auth_user_id        uuid unique references auth.users (id) on delete cascade,
  email               text not null unique,
  zoho_contact_id     text,
  zoho_deal_id        text,
  stripe_customer_id  text,
  created_at          timestamptz not null default now()
);

-- The product being sold. price_cents is the ONLY source of the charged amount
-- (the checkout request body carries a document id, never an amount).
-- storage_path is server-only: authenticated roles cannot SELECT this table
-- directly, they read public.documents_public instead (see 0002).
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  storage_path  text not null,
  price_cents   integer not null check (price_cents > 0),
  currency      text not null default 'usd' check (currency ~* '^[a-z]{3}$'),
  created_at    timestamptz not null default now()
);

-- One row per successful payment. Both Stripe ids are unique so a replayed
-- webhook can never create a second purchase.
create table if not exists public.purchases (
  id                         uuid primary key default gen_random_uuid(),
  client_id                  uuid not null references public.clients (id) on delete cascade,
  document_id                uuid not null references public.documents (id) on delete restrict,
  stripe_session_id          text not null unique,
  stripe_payment_intent_id   text not null unique,
  amount_cents               integer not null check (amount_cents >= 0),
  currency                   text not null,
  paid_at                    timestamptz not null default now(),
  refunded_at                timestamptz,
  created_at                 timestamptz not null default now()
);

-- What a client is allowed to read. UNIQUE(client_id, document_id) is the
-- idempotency guard: N webhook deliveries of the same payment => 1 entitlement.
create table if not exists public.entitlements (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  document_id  uuid not null references public.documents (id) on delete restrict,
  purchase_id  uuid not null references public.purchases (id) on delete cascade,
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (client_id, document_id)
);

-- Delivery ledger. event_id as PK is the first idempotency gate: a duplicate
-- delivery fails the insert and the handler returns 200 without side effects.
create table if not exists public.stripe_events (
  event_id     text primary key,
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  status       text not null default 'received'
               check (status in ('received', 'processed', 'duplicate', 'quarantined', 'failed')),
  purchase_id  uuid references public.purchases (id) on delete set null,
  error        text
);

-- CRM outbox. One row per purchase; the webhook commits 'pending' in the same
-- transaction as the entitlement, so a Zoho outage can never lose the sync.
-- 'syncing' is a leased in-flight state (see 0004) — deliberate addition to the
-- brief's three statuses, needed to make concurrent deliveries truly exclusive.
create table if not exists public.crm_sync (
  id               uuid primary key default gen_random_uuid(),
  purchase_id      uuid not null unique references public.purchases (id) on delete cascade,
  zoho_deal_id     text not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'syncing', 'synced', 'failed')),
  attempts         integer not null default 0,
  last_error       text,
  last_attempt_at  timestamptz,
  synced_at        timestamptz
);

create index if not exists entitlements_client_idx on public.entitlements (client_id);
create index if not exists purchases_client_idx    on public.purchases (client_id);
create index if not exists crm_sync_status_idx     on public.crm_sync (status, last_attempt_at);
create index if not exists stripe_events_status_idx on public.stripe_events (status, received_at);
