import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { WEBHOOK_SECRET, makeSessionEvent, makeWorld, withServer } from './fakes/world.js';

// The Stripe SDK signs and verifies entirely locally: no network, no sandbox.
const stripe = new Stripe('sk_test_offline_signature_checks_only');

function sign(payload: string, secret = WEBHOOK_SECRET): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function post(world = makeWorld(), payload: string, signature?: string) {
  return withServer(world.deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'stripe-signature': signature } : {}),
      },
      body: payload,
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      world,
    };
  });
}

describe('POST /api/webhook signature verification', () => {
  it('accepts a correctly signed event and grants access', async () => {
    const payload = JSON.stringify(makeSessionEvent({ eventId: 'evt_signed_ok' }));
    const result = await post(undefined, payload, sign(payload));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ granted: true });
    expect(result.world.repo.state.entitlements).toHaveLength(1);
  });

  it('rejects a body that was changed after signing with 400', async () => {
    const original = JSON.stringify(makeSessionEvent({ eventId: 'evt_tampered' }));
    // The classic attack: keep the signature, quietly change the amount.
    const tampered = original.replace('"amount_total":1900', '"amount_total":1');

    const result = await post(undefined, tampered, sign(original));

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid_signature' });
    expect(result.world.repo.state.entitlements).toHaveLength(0);
    expect(result.world.repo.state.events.has('evt_tampered')).toBe(false);
  });

  it('rejects a signature made with a different webhook secret', async () => {
    const payload = JSON.stringify(makeSessionEvent({ eventId: 'evt_wrong_secret' }));
    const result = await post(undefined, payload, sign(payload, 'whsec_a_completely_different_secret'));

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid_signature' });
  });

  it('rejects a request with no stripe-signature header', async () => {
    const payload = JSON.stringify(makeSessionEvent({ eventId: 'evt_no_header' }));
    const result = await post(undefined, payload);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'missing_stripe_signature' });
  });

  it('answers 200 and does nothing for an unrelated event type', async () => {
    const payload = JSON.stringify(makeSessionEvent({ eventId: 'evt_unrelated', type: 'customer.created' }));
    const result = await post(undefined, payload, sign(payload));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ignored: 'customer.created' });
    expect(result.world.repo.state.entitlements).toHaveLength(0);
  });

  it('proves the raw body survives: a JSON-parsed webhook would fail every check', async () => {
    // If express.json() ran first, constructEvent would receive an object and
    // throw, so this passing test is itself the ordering assertion.
    const payload = JSON.stringify(makeSessionEvent({ eventId: 'evt_raw_order' }));
    const result = await post(undefined, payload, sign(payload));
    expect(result.status).toBe(200);
  });
});
