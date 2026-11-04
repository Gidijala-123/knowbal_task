import Stripe from 'stripe';

import type { AppDeps } from './deps.js';
import { createCrmSyncService } from './crm/syncPurchase.js';
import { createSupabaseRepository, createSupabaseStorage } from './db/supabaseRepository.js';
import type { AppEnv } from './env.js';
import { createSupabaseAdmin } from './lib/supabaseAdmin.js';
import { createSupabaseAuth } from './lib/supabaseAuth.js';
import type { Logger } from './logger.js';
import { createZohoTokenProvider } from './zoho/oauth.js';
import { createZohoDealClient } from './zoho/deals.js';

/** Must match the private bucket you create in the Supabase dashboard. */
export const DOCUMENTS_BUCKET = 'client-documents';

/**
 * One place that assembles the real collaborators, used by the HTTP server and
 * by both CLI scripts. Tests build their own runtime out of fakes instead.
 */
export function createRuntime(env: AppEnv, log: Logger): AppDeps {
  const db = createSupabaseAdmin(env);
  const repo = createSupabaseRepository(db);
  const storage = createSupabaseStorage(db, DOCUMENTS_BUCKET);
  const auth = createSupabaseAuth(db);

  // No apiVersion is pinned: the SDK then uses the version pinned on the Stripe
  // account, which is the one place it should be changed deliberately.
  const stripe = new Stripe(env.stripeSecretKey, {
    appInfo: { name: 'paid-client-access', version: '1.0.0' },
  });

  const zohoTokens = createZohoTokenProvider(
    {
      accountsUrl: env.zohoAccountsUrl,
      clientId: env.zohoClientId,
      clientSecret: env.zohoClientSecret,
      refreshToken: env.zohoRefreshToken,
    },
    globalThis.fetch,
    log
  );
  const zohoDeals = createZohoDealClient(
    { apiUrl: env.zohoApiUrl, paidStage: env.zohoPaidStage, simulateFailure: env.zohoSimulateFailure },
    zohoTokens,
    globalThis.fetch,
    log
  );

  const crm = createCrmSyncService({ repo, zoho: zohoDeals, log });

  return { env, repo, storage, auth, stripe, crm, log };
}
