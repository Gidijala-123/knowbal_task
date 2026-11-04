/**
 * Shared test world: real handler code, fake collaborators. Nothing here needs
 * credentials or network access.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import Stripe from 'stripe';

import { createApp } from '../../src/app.js';
import { createCrmSyncService } from '../../src/crm/syncPurchase.js';
import type { AppDeps } from '../../src/deps.js';
import type { AuthPort, ClientRow, DocumentRow, StoragePort } from '../../src/db/repository.js';
import type { AppEnv } from '../../src/env.js';
import { createLogger } from '../../src/logger.js';
import type { PaidDealFields, ZohoDealClient, ZohoOutcome } from '../../src/zoho/deals.js';
import { createMemoryRepository, type EntitlementRow, type MemoryRepository } from './memoryRepository.js';

export const CLIENT_A: ClientRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'client-a@example.com',
  zohoDealId: 'deal-a',
  stripeCustomerId: 'cus_a',
};

export const CLIENT_B: ClientRow = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client-b@example.com',
  zohoDealId: 'deal-b',
  stripeCustomerId: 'cus_b',
};

export const DOCUMENT: DocumentRow = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Sample Client Document',
  priceCents: 1900,
  currency: 'usd',
};

export const WEBHOOK_SECRET = 'whsec_test_signature_secret';

export function makeTestEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    port: 8787,
    appBaseUrl: 'http://localhost:5173',
    adminApiKey: 'test-admin-key-1234',
    stripeSecretKey: 'sk_test_dummy_key_for_offline_tests',
    stripeWebhookSecret: WEBHOOK_SECRET,
    stripePriceId: '',
    supabaseUrl: 'http://localhost:54321',
    supabaseAnonKey: 'anon-key-placeholder-value',
    supabaseServiceRoleKey: 'service-role-placeholder-value',
    zohoClientId: 'zoho-client-id',
    zohoClientSecret: 'zoho-client-secret',
    zohoRefreshToken: 'zoho-refresh-token',
    zohoAccountsUrl: 'https://accounts.zoho.com',
    zohoApiUrl: 'https://www.zohoapis.com/crm/v2/12345678',
    zohoPaidStage: 'Closed Won',
    zohoRedirectUri: 'http://localhost:8790/zoho/callback',
    zohoSimulateFailure: false,
    seedClientPassword: 'TestAccess!234',
    zohoDealIdClientA: 'deal-a',
    zohoDealIdClientB: 'deal-b',
    ...overrides,
  };
}

export type ZohoCall = { dealId: string; fields: PaidDealFields };

export type World = {
  env: AppEnv;
  deps: AppDeps;
  repo: MemoryRepository;
  zohoCalls: ZohoCall[];
  downloadCalls: string[];
  /** Queue the verdicts the fake Zoho should return, in order. */
  setZohoOutcomes(...outcomes: ZohoOutcome[]): void;
  createdCheckouts: Array<{ params: Stripe.Checkout.SessionCreateParams }>;
};

export function makeWorld(options?: {
  clients?: ClientRow[];
  entitlements?: EntitlementRow[];
}): World {
  const env = makeTestEnv();
  const log = createLogger('test', true);
  const repo = createMemoryRepository({
    clients: options?.clients ?? [CLIENT_A, CLIENT_B],
    documents: [DOCUMENT],
    entitlements: options?.entitlements,
    logins: { 'auth-user-a': CLIENT_A.id, 'auth-user-b': CLIENT_B.id },
  });

  const zohoCalls: ZohoCall[] = [];
  let outcomes: ZohoOutcome[] = [];

  const zoho: ZohoDealClient = {
    async markDealPaid(dealId, fields) {
      zohoCalls.push({ dealId, fields });
      const next = outcomes.shift();
      return next ?? { kind: 'synced', detail: 'test default' };
    },
  };

  const createdCheckouts: Array<{ params: Stripe.Checkout.SessionCreateParams }> = [];
  // A real Stripe instance, so signature verification is the genuine one, with
  // the two network-calling namespaces replaced by offline fakes.
  const stripe = Object.assign(new Stripe('sk_test_offline_no_network_calls'), {
    customers: {
      create: async () => ({ id: 'cus_generated' }),
    },
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          createdCheckouts.push({ params });
          return { id: 'cs_test_generated', url: 'https://checkout.stripe.com/pay/cs_test_generated' };
        },
      },
    },
  }) as unknown as Stripe;

  const downloadCalls: string[] = [];
  const storage: StoragePort = {
    async createDownloadUrl(storagePath) {
      downloadCalls.push(storagePath);
      return `https://fake-bucket.local/${storagePath}?token=signed-for-60s`;
    },
  };

  const auth: AuthPort = {
    async verifyAccessToken(token) {
      if (token === 'token-a') return { userId: 'auth-user-a', email: CLIENT_A.email };
      if (token === 'token-b') return { userId: 'auth-user-b', email: CLIENT_B.email };
      return null;
    },
  };

  const crm = createCrmSyncService({ repo, zoho, log });

  const deps: AppDeps = { env, repo, storage, auth, stripe, crm, log };

  return {
    env,
    deps,
    repo,
    zohoCalls,
    downloadCalls,
    createdCheckouts,
    setZohoOutcomes(...next) {
      outcomes = [...next];
    },
  };
}

/** A paid checkout.session.completed event, shaped like Stripe's. */
export function makeSessionEvent(input: {
  eventId?: string;
  sessionId?: string;
  paymentIntentId?: string;
  clientId?: string;
  documentId?: string;
  zohoDealId?: string | null;
  amountTotal?: number | null;
  paymentStatus?: string;
  type?: string;
} = {}): Stripe.Event {
  const metadata: Record<string, string> = {
    client_id: input.clientId ?? CLIENT_A.id,
    document_id: input.documentId ?? DOCUMENT.id,
    zoho_deal_id: input.zohoDealId === null ? '' : (input.zohoDealId ?? CLIENT_A.zohoDealId ?? ''),
  };

  const session = {
    id: input.sessionId ?? 'cs_test_one',
    object: 'checkout.session',
    client_reference_id: metadata.client_id,
    metadata,
    payment_status: input.paymentStatus ?? 'paid',
    payment_intent: input.paymentIntentId ?? 'pi_test_one',
    amount_total: input.amountTotal === null ? undefined : (input.amountTotal ?? DOCUMENT.priceCents),
    currency: DOCUMENT.currency,
    created: 1_700_000_000,
  };

  return {
    id: input.eventId ?? 'evt_test_one',
    object: 'event',
    api_version: '2024-11-20.acacia',
    created: 1_700_000_000,
    type: (input.type ?? 'checkout.session.completed') as Stripe.Event.Type,
    data: { object: session } as unknown as Stripe.Event['data'],
  } as unknown as Stripe.Event;
}

export async function startTestServer(deps: AppDeps): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app = createApp(deps);
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      // fetch() keeps sockets alive, which would otherwise make close() hang
      // until the idle timeout.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** Run one test against a throwaway server on a random port. */
export async function withServer<T>(deps: AppDeps, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startTestServer(deps);
  try {
    return await run(server.baseUrl);
  } finally {
    await server.close();
  }
}
