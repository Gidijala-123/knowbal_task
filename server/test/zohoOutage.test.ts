import { beforeEach, describe, expect, it } from 'vitest';

import { createCrmSyncService } from '../src/crm/syncPurchase.js';
import { handleStripeEvent } from '../src/stripe/webhookHandler.js';
import { createZohoTokenProvider, ZohoAuthError } from '../src/zoho/oauth.js';
import { createZohoDealClient, type ZohoOutcome } from '../src/zoho/deals.js';
import { createLogger } from '../src/logger.js';
import type { FetchLike } from '../src/zoho/oauth.js';
import { makeSessionEvent, makeWorld, type World } from './fakes/world.js';

const log = createLogger('test', true);
const FIELDS = { stripePaymentIntentId: 'pi_1', paidAmount: 1900, paidAt: '2026-11-04T10:00:00.000Z' };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function dealClient(responses: Array<Response | Error>, simulateFailure = false) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)] ?? new Error('no fake response configured');
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  const tokens = { getAccessToken: async () => 'access-token' };
  const client = createZohoDealClient(
    { apiUrl: 'https://www.zohoapis.com/crm/v2/12345', paidStage: 'Closed Won', simulateFailure },
    tokens,
    fetchImpl,
    log
  );
  return { client, calls };
}

describe('zoho deal client failure classification', () => {
  it('treats a 503 as retryable', async () => {
    const { client } = dealClient([jsonResponse(503, { message: 'service unavailable' })]);
    expect(await client.markDealPaid('deal-a', FIELDS)).toMatchObject({ kind: 'retry' });
  });

  it('treats a 429 as retryable', async () => {
    const { client } = dealClient([jsonResponse(429, { message: 'rate limit' })]);
    expect(await client.markDealPaid('deal-a', FIELDS)).toMatchObject({ kind: 'retry', reason: /429/ });
  });

  it('treats a missing deal as fatal, because retrying cannot help', async () => {
    const { client } = dealClient([jsonResponse(404, { message: 'not found' })]);
    const outcome = await client.markDealPaid('gone-deal', FIELDS);
    expect(outcome).toMatchObject({ kind: 'fatal', reason: /deal not found/ });
  });

  it('reads the per-record code, because Zoho answers 200 even for bad data', async () => {
    const { client } = dealClient([
      jsonResponse(200, { data: [{ code: 'INVALID_DATA', message: 'Paid_At is not a valid datetime' }] }),
    ]);
    expect(await client.markDealPaid('deal-a', FIELDS)).toMatchObject({ kind: 'fatal', reason: /INVALID_DATA/ });
  });

  it('counts an already-paid record as synced, which makes replays harmless', async () => {
    const { client } = dealClient([jsonResponse(200, { data: [{ code: 'DUPLICATE_DATA' }] })]);
    expect(await client.markDealPaid('deal-a', FIELDS)).toMatchObject({ kind: 'synced' });
  });

  it('refreshes the token exactly once on a 401 and then succeeds', async () => {
    let refreshes = 0;
    const tokens = {
      getAccessToken: async (options?: { forceRefresh?: boolean }) => {
        if (options?.forceRefresh) refreshes += 1;
        return 'access-token';
      },
    };
    const responses = [jsonResponse(401, { message: 'invalid token' }), jsonResponse(200, { data: [{ code: 'SUCCESS' }] })];
    let call = 0;
    const fetchImpl: FetchLike = async () => responses[Math.min(call++, responses.length - 1)] ?? jsonResponse(500, {});

    const client = createZohoDealClient(
      { apiUrl: 'https://www.zohoapis.com/crm/v2/12345', paidStage: 'Closed Won', simulateFailure: false },
      tokens,
      fetchImpl,
      log
    );
    const outcome = await client.markDealPaid('deal-a', FIELDS);

    expect(outcome).toMatchObject({ kind: 'synced' });
    expect(refreshes).toBe(1);
  });

  it('classifies a timeout and a dead connection as retryable', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(await dealClient([timeout]).client.markDealPaid('deal-a', FIELDS)).toMatchObject({ kind: 'retry' });

    const dns = new TypeError('fetch failed');
    expect(await dealClient([dns]).client.markDealPaid('deal-a', FIELDS)).toMatchObject({ kind: 'retry' });
  });

  it('sends the paid fields the README documents, to the deal id from the outbox', async () => {
    const { client, calls } = dealClient([jsonResponse(200, { data: [{ code: 'SUCCESS' }] })]);
    await client.markDealPaid('deal-999', FIELDS);

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(calls[0]?.url).toBe('https://www.zohoapis.com/crm/v2/12345/Deals/deal-999');
    expect(body.data[0]).toMatchObject({
      id: 'deal-999',
      Stage: 'Closed Won',
      Payment_Status: 'Paid',
      Stripe_Payment_ID: 'pi_1',
      Paid_Amount: 19,
      Paid_At: FIELDS.paidAt,
    });
  });

  it('short-circuits every call when the outage switch is on', async () => {
    const { client, calls } = dealClient([jsonResponse(200, { data: [{ code: 'SUCCESS' }] })], true);
    const outcome = await client.markDealPaid('deal-a', FIELDS);

    expect(outcome).toMatchObject({ kind: 'retry', reason: /simulated outage/ });
    expect(calls).toHaveLength(0);
  });
});

describe('zoho token provider caching', () => {
  it('reuses a valid cached token and refreshes concurrently only once', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, { access_token: 'tok', expires_in: 3599 }) as Response;
    };
    const provider = createZohoTokenProvider(
      { accountsUrl: 'https://accounts.zoho.com', clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      fetchImpl,
      log
    );

    const tokens = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(new Set(tokens).size).toBe(1);
    expect(calls).toBe(1);
  });

  it('reports a revoked refresh token as fatal, with the fix in the message', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(400, { error: 'invalid_grant' }) as Response;
    const provider = createZohoTokenProvider(
      { accountsUrl: 'https://accounts.zoho.com', clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      fetchImpl,
      log
    );

    await expect(provider.getAccessToken()).rejects.toMatchObject({ fatal: true } as ZohoAuthError);
  });
});

describe('crm sync when Zoho is down', () => {
  let world: World;

  beforeEach(() => {
    world = makeWorld();
  });

  it('still grants access, keeps the row pending, and stores why', async () => {
    world.setZohoOutcomes({ kind: 'retry', reason: 'http_503 zoho server error' });

    const outcome = await handleStripeEvent(makeSessionEvent({ eventId: 'evt_outage' }), world.deps);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toMatchObject({ granted: true });
    expect(world.repo.state.entitlements).toHaveLength(1);

    const row = [...world.repo.state.crm.values()][0];
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('503');
  });

  it('syncs on the later retry command and then refuses to touch it again', async () => {
    world.setZohoOutcomes({ kind: 'retry', reason: 'http_503 zoho server error' });
    await handleStripeEvent(makeSessionEvent({ eventId: 'evt_outage2' }), world.deps);
    const purchaseId = [...world.repo.state.purchases.keys()][0] as string;

    world.setZohoOutcomes({ kind: 'synced' });
    const first = await world.deps.crm.retryDue();
    const second = await world.deps.crm.retryDue();
    const explicit = await world.deps.crm.syncPurchase(purchaseId);

    expect(first[0]).toMatchObject({ status: 'synced' });
    // A sweep finds nothing owed; an explicit retry of the same purchase is
    // refused by the claim. Either way Zoho is not called a third time.
    expect(second).toEqual([]);
    expect(explicit).toMatchObject({ status: 'skipped' });
    expect(world.zohoCalls).toHaveLength(2);
    expect([...world.repo.state.crm.values()][0]?.status).toBe('synced');
  });

  it('stops retrying a deal Zoho permanently rejected', async () => {
    world.setZohoOutcomes({ kind: 'fatal', reason: 'http_404 deal not found in this org' });
    await handleStripeEvent(makeSessionEvent({ eventId: 'evt_dead_deal' }), world.deps);

    const row = [...world.repo.state.crm.values()][0];
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toContain('404');

    // 'failed' is still claimable by an explicit retry, which is the point:
    // after fixing the deal id the operator can push it through.
    world.setZohoOutcomes({ kind: 'synced' });
    expect((await world.deps.crm.retryDue())[0]).toMatchObject({ status: 'synced' });
  });

  it('never lets two concurrent attempts reach Zoho for one purchase', async () => {
    const crm = world.deps.crm;
    const purchaseId = (await world.repo.grantPurchase({
      clientId: '11111111-1111-4111-8111-111111111111',
      documentId: '33333333-3333-4333-8333-333333333333',
      stripeSessionId: 'cs_lease',
      stripePaymentIntentId: 'pi_lease',
      amountCents: 1900,
      currency: 'usd',
      paidAt: new Date(),
      zohoDealId: 'deal-a',
      eventId: 'evt_lease',
    })).purchaseId;

    const outcomes = await Promise.all([crm.syncPurchase(purchaseId), crm.syncPurchase(purchaseId)]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['skipped', 'synced']);
    expect(world.zohoCalls).toHaveLength(1);
  });

  it('reclaims the lease of a worker that died mid-call', async () => {
    const crm = createCrmSyncService({ repo: world.repo, zoho: { async markDealPaid(): Promise<ZohoOutcome> { return { kind: 'synced' }; } }, log });
    const grant = await world.repo.grantPurchase({
      clientId: '11111111-1111-4111-8111-111111111111',
      documentId: '33333333-3333-4333-8333-333333333333',
      stripeSessionId: 'cs_crash',
      stripePaymentIntentId: 'pi_crash',
      amountCents: 1900,
      currency: 'usd',
      paidAt: new Date(),
      zohoDealId: 'deal-a',
      eventId: 'evt_crash',
    });

    // First attempt claims, then the process would have died before finishing.
    await world.repo.claimCrmSync(grant.purchaseId);
    expect((await crm.syncPurchase(grant.purchaseId)).status).toBe('skipped');

    world.repo.expireLeases();
    expect((await crm.syncPurchase(grant.purchaseId)).status).toBe('synced');
  });
});
