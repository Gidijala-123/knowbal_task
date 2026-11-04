import { beforeEach, describe, expect, it } from 'vitest';

import { handleStripeEvent } from '../src/stripe/webhookHandler.js';
import { CLIENT_A, DOCUMENT, makeSessionEvent, makeWorld, type World } from './fakes/world.js';

let world: World;

beforeEach(() => {
  world = makeWorld();
});

function counts(w: World) {
  return {
    purchases: w.repo.state.purchases.size,
    entitlements: w.repo.state.entitlements.length,
    crmRows: w.repo.state.crm.size,
    zohoCalls: w.zohoCalls.length,
  };
}

describe('webhook idempotency', () => {
  it('grants once for the same event id delivered twice', async () => {
    const event = makeSessionEvent();

    const first = await handleStripeEvent(event, world.deps);
    const second = await handleStripeEvent(event, world.deps);

    expect(first.body).toMatchObject({ granted: true, isNewPurchase: true });
    expect(second.body).toEqual({ duplicate: true });
    expect(counts(world)).toEqual({ purchases: 1, entitlements: 1, crmRows: 1, zohoCalls: 1 });
  });

  it('survives five concurrent deliveries of one event', async () => {
    const event = makeSessionEvent({ eventId: 'evt_racing' });

    const results = await Promise.all(Array.from({ length: 5 }, () => handleStripeEvent(event, world.deps)));

    // Every delivery gets a 200 - none of them may make Stripe retry. Exactly
    // one of them created anything; the other four are idempotent no-ops that
    // lose the claim race and never reach Zoho.
    expect(results.every((r) => r.httpStatus === 200)).toBe(true);
    expect(results.filter((r) => r.body.isNewPurchase === true)).toHaveLength(1);
    expect(counts(world)).toEqual({ purchases: 1, entitlements: 1, crmRows: 1, zohoCalls: 1 });
  });

  it('treats completed + async_payment_succeeded for one session as one purchase', async () => {
    const completed = makeSessionEvent({ eventId: 'evt_a', sessionId: 'cs_same', paymentIntentId: 'pi_same' });
    const asyncSucceeded = makeSessionEvent({
      eventId: 'evt_b',
      sessionId: 'cs_same',
      paymentIntentId: 'pi_same',
      type: 'checkout.session.async_payment_succeeded',
    });

    await handleStripeEvent(completed, world.deps);
    const second = await handleStripeEvent(asyncSucceeded, world.deps);

    expect(second.body).toMatchObject({ granted: true, isNewPurchase: false });
    expect(counts(world)).toEqual({ purchases: 1, entitlements: 1, crmRows: 1, zohoCalls: 1 });
  });

  it('returns 500 when the database write fails, then completes on the retry', async () => {
    const event = makeSessionEvent({ eventId: 'evt_db_blip' });
    world.repo.failNextGrant(new Error('could not serialize transaction'));

    const failed = await handleStripeEvent(event, world.deps);

    expect(failed.httpStatus).toBe(500);
    expect(failed.body).toEqual({ error: 'grant_failed' });
    expect(counts(world)).toEqual({ purchases: 0, entitlements: 0, crmRows: 0, zohoCalls: 0 });
    expect(world.repo.state.events.get('evt_db_blip')?.status).toBe('failed');

    // Stripe redelivers the *same* event id. A naive "seen it before" gate
    // would stop here and leave a paying customer without access.
    const retried = await handleStripeEvent(event, world.deps);

    expect(retried.httpStatus).toBe(200);
    expect(retried.body).toMatchObject({ granted: true });
    expect(counts(world)).toEqual({ purchases: 1, entitlements: 1, crmRows: 1, zohoCalls: 1 });
  });

  it('quarantines without granting when the ids do not line up', async () => {
    const cases = [
      { label: 'missing metadata', event: makeSessionEvent({ eventId: 'evt_q1', zohoDealId: null }) },
      { label: 'unknown client', event: makeSessionEvent({ eventId: 'evt_q2', clientId: '00000000-0000-4000-8000-000000000000' }) },
      { label: 'unknown document', event: makeSessionEvent({ eventId: 'evt_q3', documentId: '00000000-0000-4000-8000-000000000000' }) },
      { label: 'deal mismatch', event: makeSessionEvent({ eventId: 'evt_q4', zohoDealId: 'deal-someone-else' }) },
      { label: 'amount mismatch', event: makeSessionEvent({ eventId: 'evt_q5', amountTotal: 50 }) },
      { label: 'unpaid session', event: makeSessionEvent({ eventId: 'evt_q6', paymentStatus: 'unpaid' }) },
    ];

    for (const { event } of cases) {
      const outcome = await handleStripeEvent(event, world.deps);
      expect(outcome.httpStatus).toBe(200);
    }

    expect(counts(world)).toEqual({ purchases: 0, entitlements: 0, crmRows: 0, zohoCalls: 0 });
    const quarantined = [...world.repo.state.events.values()].filter((e) => e.status === 'quarantined');
    expect(quarantined).toHaveLength(5); // the unpaid session is recorded as processed, not quarantined
    expect(world.repo.state.events.get('evt_q6')?.status).toBe('processed');
  });

  it('records the stable ids it matched on, so a quarantine is explainable', async () => {
    const event = makeSessionEvent({ eventId: 'evt_trace', sessionId: 'cs_trace', zohoDealId: 'deal-wrong' });

    await handleStripeEvent(event, world.deps);

    const row = world.repo.state.events.get('evt_trace');
    expect(row?.status).toBe('quarantined');
    expect(row?.error).toContain('zoho_deal_id');
    expect(CLIENT_A.zohoDealId).toBe('deal-a');
    expect(DOCUMENT.priceCents).toBe(1900);
  });

  it('revokes access on a refund and leaves the entitlement history intact', async () => {
    const purchaseEvent = makeSessionEvent({ eventId: 'evt_buy', paymentIntentId: 'pi_refund_me' });
    await handleStripeEvent(purchaseEvent, world.deps);
    expect(world.repo.state.entitlements[0]?.revokedAt).toBeNull();

    const refund = {
      id: 'evt_refund',
      type: 'charge.refunded',
      created: 1_700_000_100,
      data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_refund_me' } },
    } as unknown as import('stripe').Stripe.Event;

    const outcome = await handleStripeEvent(refund, world.deps);

    expect(outcome.body).toEqual({ revoked: 1 });
    expect(world.repo.state.entitlements[0]?.revokedAt).not.toBeNull();
    expect(world.repo.state.purchases.get('purchase-1')?.refundedAt).not.toBeNull();
  });
});
