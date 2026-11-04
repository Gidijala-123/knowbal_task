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
  //
  // timeout/maxNetworkRetries are set explicitly rather than left at the SDK
  // defaults. Verified against the installed stripe@17.7.0 (esm/stripe.core.js):
  // the default timeout is 80_000 ms and the default retries is 2, so a hung
  // connection could occupy a checkout request for four minutes. 15 s x 3 is a
  // far saner ceiling for a synchronous "give me a redirect URL" call.
  // Connections are already reused: Node's https.globalAgent has keepAlive=true
  // (verified on Node 24), and passing a custom agent would only swap the SDK
  // onto its raw-socket client, so no httpAgent is set here.
  // POST retries are safe: the SDK attaches a `stripe-node-retry-*`
  // Idempotency-Key to every POST when maxNetworkRetries > 0
  // (esm/RequestSender.js:_defaultIdempotencyKey), so a retry re-delivers the
  // same Checkout Session instead of creating a second one.
  const stripe = new Stripe(env.stripeSecretKey, {
    appInfo: { name: 'paid-client-access', version: '1.0.0' },
    timeout: 15_000,
    maxNetworkRetries: 2,
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
