-- seed.sql
-- SQL alternative to `npm run seed` (which also creates the two Supabase Auth
-- users, something SQL should not do because it would put passwords in a file).
-- Run AFTER the migrations. Idempotent.
--
-- After this, link each auth user to its client row: in the Supabase dashboard
-- open Authentication > Users, copy each User UID, and run the UPDATE at the
-- bottom. `npm run seed` does that step for you.

-- The sample document. storage_path must match the object key you upload into
-- the PRIVATE bucket `client-documents`.
insert into public.documents (id, title, storage_path, price_cents, currency)
values ('00000000-0000-4000-8000-000000000001',
        'Sample Client Document',
        'sample-document.pdf',
        1900,
        'usd')
on conflict (id) do update
  set title = excluded.title,
      storage_path = excluded.storage_path,
      price_cents = excluded.price_cents,
      currency = excluded.currency;

insert into public.clients (id, email, zoho_contact_id, zoho_deal_id)
values
  ('00000000-0000-4000-8000-0000000000a1', 'client-a@example.com', null, 'REPLACE_WITH_ZOHO_DEAL_ID_A'),
  ('00000000-0000-4000-8000-0000000000a2', 'client-b@example.com', null, 'REPLACE_WITH_ZOHO_DEAL_ID_B')
on conflict (id) do update
  set email = excluded.email,
      zoho_deal_id = excluded.zoho_deal_id;

-- Paste your real User UIDs here (UUIDs from Authentication > Users).
-- update public.clients set auth_user_id = '<uid-of-client-a>' where id = '00000000-0000-4000-8000-0000000000a1';
-- update public.clients set auth_user_id = '<uid-of-client-b>' where id = '00000000-0000-4000-8000-0000000000a2';
