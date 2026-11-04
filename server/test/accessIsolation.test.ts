import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import {
  CLIENT_A,
  CLIENT_B,
  DOCUMENT,
  makeWorld,
  withServer,
  type World,
} from './fakes/world.js';
import type { EntitlementRow } from './fakes/memoryRepository.js';

const OWNED_BY_A: EntitlementRow[] = [
  { clientId: CLIENT_A.id, documentId: DOCUMENT.id, purchaseId: 'purchase-seeded', revokedAt: null },
];

function api(baseUrl: string, path: string, init?: RequestInit & { token?: string; adminKey?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  if (init?.adminKey) headers['x-admin-key'] = init.adminKey;
  return fetch(`${baseUrl}${path}`, { ...init, headers }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  }));
}

describe('checkout creation', () => {
  it('refuses to start a payment for an anonymous caller', async () => {
    const world = makeWorld();
    await withServer(world.deps, async (baseUrl) => {
      const result = await api(baseUrl, '/api/checkout', {
        method: 'POST',
        body: JSON.stringify({ documentId: DOCUMENT.id }),
      });
      expect(result.status).toBe(401);
      expect(world.createdCheckouts).toHaveLength(0);
    });
  });

  it('refuses a token Supabase did not issue', async () => {
    const world = makeWorld();
    await withServer(world.deps, async (baseUrl) => {
      const result = await api(baseUrl, '/api/checkout', {
        method: 'POST',
        token: 'not-a-real-token',
        body: JSON.stringify({ documentId: DOCUMENT.id }),
      });
      expect(result.status).toBe(401);
    });
  });

  it('builds the price from the documents row, never from the request body', async () => {
    const world = makeWorld();
    await withServer(world.deps, async (baseUrl) => {
      // A hostile body tries to buy the document for one cent in euro.
      const result = await api(baseUrl, '/api/checkout', {
        method: 'POST',
        token: 'token-a',
        body: JSON.stringify({ documentId: DOCUMENT.id, amountCents: 1, currency: 'eur' }),
      });

      expect(result.status).toBe(200);
      const params = world.createdCheckouts[0]?.params as Stripe.Checkout.SessionCreateParams & {
        line_items?: Array<{ price_data?: { unit_amount?: number; currency?: string } }>;
      };
      expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(DOCUMENT.priceCents);
      expect(params.line_items?.[0]?.price_data?.currency).toBe('usd');
      expect(params.client_reference_id).toBe(CLIENT_A.id);
      expect(params.metadata).toMatchObject({
        client_id: CLIENT_A.id,
        document_id: DOCUMENT.id,
        zoho_deal_id: 'deal-a',
      });
    });
  });

  it('gives each client their own stable ids on the session', async () => {
    const world = makeWorld();
    await withServer(world.deps, async (baseUrl) => {
      await api(baseUrl, '/api/checkout', {
        method: 'POST',
        token: 'token-b',
        body: JSON.stringify({ documentId: DOCUMENT.id }),
      });

      const params = world.createdCheckouts[0]?.params as Stripe.Checkout.SessionCreateParams;
      expect(params.client_reference_id).toBe(CLIENT_B.id);
      expect(params.metadata).toMatchObject({ client_id: CLIENT_B.id, zoho_deal_id: 'deal-b' });
    });
  });

  it('blocks a second purchase of a document the client already owns', async () => {
    const world = makeWorld({ entitlements: OWNED_BY_A });
    await withServer(world.deps, async (baseUrl) => {
      const result = await api(baseUrl, '/api/checkout', {
        method: 'POST',
        token: 'token-a',
        body: JSON.stringify({ documentId: DOCUMENT.id }),
      });

      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: 'already_owned' });
      expect(world.createdCheckouts).toHaveLength(0);
    });
  });

  it('rejects a malformed document id before touching Stripe', async () => {
    const world = makeWorld();
    await withServer(world.deps, async (baseUrl) => {
      const result = await api(baseUrl, '/api/checkout', {
        method: 'POST',
        token: 'token-a',
        body: JSON.stringify({ documentId: '../../etc/passwd' }),
      });
      expect(result.status).toBe(400);
      expect(world.createdCheckouts).toHaveLength(0);
    });
  });
});

describe('document download', () => {
  it('lets the entitled client download and refuses everyone else', async () => {
    const world = makeWorld({ entitlements: OWNED_BY_A });
    await withServer(world.deps, async (baseUrl) => {
      const owner = await api(baseUrl, `/api/documents/${DOCUMENT.id}/download`, { token: 'token-a' });
      expect(owner.status).toBe(200);
      expect(String(owner.body.url)).toContain('signed-for-60s');
      expect(owner.body.expiresIn).toBe(60);

      const stranger = await api(baseUrl, `/api/documents/${DOCUMENT.id}/download`, { token: 'token-b' });
      expect(stranger.status).toBe(403);
      expect(stranger.body).toEqual({ error: 'not_entitled' });
    });
  });

  it('never leaks the bucket path in a refusal', async () => {
    const world = makeWorld({ entitlements: OWNED_BY_A });
    await withServer(world.deps, async (baseUrl) => {
      const stranger = await api(baseUrl, `/api/documents/${DOCUMENT.id}/download`, { token: 'token-b' });
      expect(JSON.stringify(stranger.body)).not.toContain('storage_path');
      expect(JSON.stringify(stranger.body)).not.toContain('sample-document.pdf');
      // The refusal happens before the bucket is ever touched.
      expect(world.downloadCalls).toHaveLength(0);
    });
  });

  it('refuses a revoked entitlement', async () => {
    const world = makeWorld({
      entitlements: [{ ...(OWNED_BY_A[0] as EntitlementRow), revokedAt: '2026-11-04T10:00:00.000Z' }],
    });
    await withServer(world.deps, async (baseUrl) => {
      const result = await api(baseUrl, `/api/documents/${DOCUMENT.id}/download`, { token: 'token-a' });
      expect(result.status).toBe(403);
      expect(world.downloadCalls).toHaveLength(0);
    });
  });
});

describe('admin retry endpoint', () => {
  it('refuses a request without the admin key', async () => {
    const world = makeWorld();
    await withServer(world.deps, async (baseUrl) => {
      const result = await api(baseUrl, '/api/admin/retry-crm-sync', { method: 'POST', body: '{}' });
      expect(result.status).toBe(401);
    });
  });

  it('accepts the admin key and reports what it attempted', async () => {
    const world: World = makeWorld();
    await withServer(world.deps, async (baseUrl) => {
      const result = await api(baseUrl, '/api/admin/retry-crm-sync', {
        method: 'POST',
        adminKey: 'test-admin-key-1234',
        body: '{}',
      });

      expect(result.status).toBe(200);
      expect(result.body.attempted).toBe(0); // nothing owed in a fresh world
    });
  });
});
