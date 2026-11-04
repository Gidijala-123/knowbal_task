/**
 * Row Level Security proof against a real Supabase project.
 *
 * It is skipped unless both conditions hold, so `npm test` stays green on a
 * machine with no credentials:
 *   1. a usable .env at the repo root (SUPABASE_URL, keys, seed password)
 *   2. RUN_INTEGRATION=1
 *
 *   RUN_INTEGRATION=1 npm run test:integration -w server
 *
 * Prerequisite: `npm run seed` has been run, so both demo logins exist.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadEnv, type AppEnv } from '../src/env.js';
import { createLogger } from '../src/logger.js';
import { createRuntime } from '../src/runtime.js';
import { startTestServer } from './fakes/world.js';

function tryLoadEnv(): AppEnv | null {
  if (process.env.RUN_INTEGRATION !== '1') return null;
  try {
    return loadEnv();
  } catch {
    return null;
  }
}

const env = tryLoadEnv();

describe.skipIf(env === null)('RLS tenant isolation (live Supabase project)', () => {
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let clientARowId = '';
  let documentId = '';

  beforeAll(async () => {
    if (!env) throw new Error('integration env disappeared');
    clientA = createClient(env.supabaseUrl, env.supabaseAnonKey);
    clientB = createClient(env.supabaseUrl, env.supabaseAnonKey);

    const a = await clientA.auth.signInWithPassword({ email: 'client-a@example.com', password: env.seedClientPassword });
    const b = await clientB.auth.signInWithPassword({ email: 'client-b@example.com', password: env.seedClientPassword });
    if (!a.data.session || !b.data.session) {
      throw new Error('Could not sign in as the seeded clients. Run `npm run seed` first.');
    }

    const { data: ownClient, error } = await clientA.from('clients').select('id').single();
    if (error || !ownClient) throw new Error(`clients row unreadable: ${error?.message}`);
    clientARowId = String(ownClient.id);

    const { data: documents } = await clientA.from('documents_public').select('id').limit(1);
    documentId = String((documents?.[0] as { id: string } | undefined)?.id);
  });

  it('gives each client only their own entitlement rows', async () => {
    const { data: asOwner, error: ownerError } = await clientA.from('entitlements').select('client_id');
    const { data: asStranger, error: strangerError } = await clientB
      .from('entitlements')
      .select('client_id')
      .eq('client_id', clientARowId); // an explicit attempt to read A's rows

    expect(ownerError).toBeNull();
    expect(strangerError).toBeNull();
    expect(asStranger).toHaveLength(0);
    for (const row of asOwner ?? []) {
      expect(row.client_id).toBe(clientARowId);
    }
  });

  it('hides purchases and crm_sync from the other client', async () => {
    const { data: purchases } = await clientB.from('purchases').select('id').eq('client_id', clientARowId);
    const { data: crm } = await clientB.from('crm_sync').select('purchase_id');

    expect(purchases).toHaveLength(0);
    expect(crm ?? []).toHaveLength(0);
  });

  it('denies any read of the base documents table, where storage_path lives', async () => {
    const { data, error } = await clientB.from('documents').select('storage_path');

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('serves catalogue metadata without the storage path', async () => {
    const { data, error } = await clientB.from('documents_public').select('*').limit(1);

    expect(error).toBeNull();
    expect(JSON.stringify(data)).not.toContain('storage_path');
  });

  it('denies the download URL through the real server, not only the fake', async () => {
    if (!env) throw new Error('integration env disappeared');
    const runtime = createRuntime(env, createLogger('integration', true));
    const server = await startTestServer(runtime);

    try {
      const { data } = await clientB.auth.getSession();
      const response = await fetch(`${server.baseUrl}/api/documents/${documentId}/download`, {
        headers: { authorization: `Bearer ${data.session?.access_token ?? ''}` },
      });

      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('refuses to let a browser call the granting function directly', async () => {
    const { error } = await clientA.rpc('grant_purchase', {
      p_client_id: clientARowId,
      p_document_id: documentId,
      p_stripe_session_id: 'cs_forged_from_browser',
      p_stripe_payment_intent_id: 'pi_forged_from_browser',
      p_amount_cents: 1,
      p_currency: 'usd',
      p_paid_at: new Date().toISOString(),
      p_zoho_deal_id: 'whatever',
      p_event_id: 'evt_forged',
    });

    expect(error).not.toBeNull();
  });
});
