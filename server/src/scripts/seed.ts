/**
 * Seed the two demo clients and the sample document.
 *
 * Auth users are created through the service-role admin API rather than
 * supabase/seed.sql, because SQL seeding would mean writing a password into a
 * committed file. The password here is a fixed test value from the environment
 * (SEED_CLIENT_PASSWORD) and applies to throwaway demo accounts only.
 *
 *   npm run seed
 */
import { loadEnv } from '../env.js';
import { createSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { createLogger } from '../logger.js';
import { DOCUMENTS_BUCKET } from '../runtime.js';

const DOCUMENT = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Sample Client Document',
  storagePath: 'sample-document.pdf',
  priceCents: 1900,
  currency: 'usd',
};

const EXTRA_DOCUMENTS = [
  { id: '00000000-0000-4000-8000-000000000002', title: 'Financial Planning Guide 2026', storagePath: 'sample-document.pdf', priceCents: 2900, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000003', title: 'Investment Strategy Report', storagePath: 'sample-document.pdf', priceCents: 4900, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000004', title: 'Tax Optimisation Handbook', storagePath: 'sample-document.pdf', priceCents: 3500, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000005', title: 'Real Estate Due Diligence Checklist', storagePath: 'sample-document.pdf', priceCents: 1500, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000006', title: 'Business Valuation Framework', storagePath: 'sample-document.pdf', priceCents: 5900, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000007', title: 'Startup Funding Playbook', storagePath: 'sample-document.pdf', priceCents: 3900, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000008', title: 'Risk Management Essentials', storagePath: 'sample-document.pdf', priceCents: 2500, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000009', title: 'Mergers & Acquisitions Primer', storagePath: 'sample-document.pdf', priceCents: 7900, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000010', title: 'Portfolio Diversification Strategies', storagePath: 'sample-document.pdf', priceCents: 3200, currency: 'usd' },
  { id: '00000000-0000-4000-8000-000000000011', title: 'Compliance & Regulatory Overview', storagePath: 'sample-document.pdf', priceCents: 4200, currency: 'usd' },
];

const CLIENTS = [
  { id: '00000000-0000-4000-8000-0000000000a1', email: 'client-a@example.com', label: 'Client A' },
  { id: '00000000-0000-4000-8000-0000000000a2', email: 'client-b@example.com', label: 'Client B' },
];

const env = loadEnv();
const log = createLogger('seed');
const db = createSupabaseAdmin(env);

async function findUserIdByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureAuthUser(email: string): Promise<string> {
  const existing = await findUserIdByEmail(email);
  if (existing) return existing;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: env.seedClientPassword,
    email_confirm: true, // test accounts: skip the confirmation email
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return data.user.id;
}

async function upsertClient(input: { id: string; email: string; authUserId: string; zohoDealId: string }): Promise<void> {
  const { data: existing } = await db.from('clients').select('id').eq('email', input.email).maybeSingle();
  const payload = {
    id: existing?.id ?? input.id,
    email: input.email,
    auth_user_id: input.authUserId,
    zoho_deal_id: input.zohoDealId || null,
  };
  const { error } = await db.from('clients').upsert(payload, { onConflict: 'id' });
  if (error) throw new Error(`upsert client ${input.email} failed: ${error.message}`);
}

async function main(): Promise<void> {
  const { error: docError } = await db.from('documents').upsert(
    {
      id: DOCUMENT.id,
      title: DOCUMENT.title,
      storage_path: DOCUMENT.storagePath,
      price_cents: DOCUMENT.priceCents,
      currency: DOCUMENT.currency,
    },
    { onConflict: 'id' }
  );
  if (docError) throw new Error(`upsert document failed: ${docError.message}`);
  log.info('document ready', { documentId: DOCUMENT.id, priceCents: DOCUMENT.priceCents });

  // Upsert the extra showcase documents
  for (const doc of EXTRA_DOCUMENTS) {
    const { error: extraErr } = await db.from('documents').upsert(
      { id: doc.id, title: doc.title, storage_path: doc.storagePath, price_cents: doc.priceCents, currency: doc.currency },
      { onConflict: 'id' }
    );
    if (extraErr) throw new Error(`upsert document "${doc.title}" failed: ${extraErr.message}`);
    log.info('document ready', { documentId: doc.id, title: doc.title });
  }

  const dealIds: Record<string, string> = {
    'client-a@example.com': env.zohoDealIdClientA,
    'client-b@example.com': env.zohoDealIdClientB,
  };

  for (const client of CLIENTS) {
    const authUserId = await ensureAuthUser(client.email);
    const zohoDealId = dealIds[client.email] ?? '';
    await upsertClient({ id: client.id, email: client.email, authUserId, zohoDealId });
    log.info('client ready', {
      label: client.label,
      email: client.email,
      clientId: client.id,
      authUserId,
      zohoDealId: zohoDealId || '(MISSING - set ZOHO_DEAL_ID_CLIENT_A/B and re-run)',
    });
  }

  process.stdout.write(
    [
      '',
      'Seed complete. Log in at the portal with:',
      `  client-a@example.com / ${env.seedClientPassword}`,
      `  client-b@example.com / ${env.seedClientPassword}`,
      '',
      'Still needed before a purchase can sync:',
      `  1. upload any PDF to the private bucket "${DOCUMENTS_BUCKET}" at key ${DOCUMENT.storagePath}`,
      '  2. put your two Zoho Deal ids in .env (ZOHO_DEAL_ID_CLIENT_A / _B) and re-run npm run seed',
      ''
    ].join('\n')
  );
}

main().catch((err: unknown) => {
  log.error('seed failed', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
