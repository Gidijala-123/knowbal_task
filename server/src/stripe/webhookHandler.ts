import type Stripe from 'stripe';
import { z } from 'zod';

import type { AppDeps } from '../deps.js';

export type WebhookOutcome = { httpStatus: number; body: Record<string, unknown> };

const metadataSchema = z.object({
  client_id: z.string().uuid(),
  document_id: z.string().uuid(),
  zoho_deal_id: z.string().min(1),
});

type HandlerDeps = Pick<AppDeps, 'repo' | 'crm' | 'log'>;

/**
 * Status codes are a deliberate contract with Stripe:
 *   200  we handled it, or we decided it is permanently unhandleable
 *        (quarantine) — a retry would produce the same verdict
 *   400  signature verification failed (set in the route, before this runs)
 *   500  our own database write failed — retry, because the payment is real
 *        and the entitlement has not been written yet
 */
export async function handleStripeEvent(event: Stripe.Event, deps: HandlerDeps): Promise<WebhookOutcome> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status === 'paid') return grantFromSession(session, event, deps);
      // Bank transfers / wallets arrive as unpaid here and settle later via
      // checkout.session.async_payment_succeeded. Record the visit, grant nothing.
      const delivery = await deps.repo.recordEvent({ eventId: event.id, type: event.type });
      if (delivery === 'done') return { httpStatus: 200, body: { duplicate: true } };
      await deps.repo.markEvent({
        eventId: event.id,
        status: 'processed',
        error: `deferred: payment_status=${session.payment_status}`,
      });
      deps.log.info('session completed but not paid yet', { eventId: event.id, paymentStatus: session.payment_status });
      return { httpStatus: 200, body: { ignored: 'not_paid' } };
    }

    case 'checkout.session.async_payment_succeeded':
      return grantFromSession(event.data.object as Stripe.Checkout.Session, event, deps);

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? '';
      const delivery = await deps.repo.recordEvent({ eventId: event.id, type: event.type });
      if (delivery === 'done') return { httpStatus: 200, body: { duplicate: true } };
      if (!paymentIntentId) return quarantine(event, deps, 'refund without a payment intent id');

      const revoked = await deps.repo.revokeAccess(paymentIntentId, event.id, 'refunded');
      deps.log.info('access revoked after refund', { eventId: event.id, entitlementsRevoked: revoked });
      // Marking the Zoho Deal as refunded is not implemented (see TRADEOFFS.md):
      // it needs a second custom field and a sync row per refund, not per purchase.
      return { httpStatus: 200, body: { revoked } };
    }

    case 'checkout.session.expired': {
      const delivery = await deps.repo.recordEvent({ eventId: event.id, type: event.type });
      if (delivery === 'done') return { httpStatus: 200, body: { duplicate: true } };
      await deps.repo.markEvent({
        eventId: event.id,
        status: 'processed',
        error: 'checkout expired before payment',
      });
      return { httpStatus: 200, body: { ignored: 'session_expired' } };
    }

    default:
      // Not recorded in the ledger: the ledger is a record of events that were
      // acted on or quarantined, so `stripe_events` stays readable by eye.
      deps.log.info('ignoring unrelated event', { eventId: event.id, type: event.type });
      return { httpStatus: 200, body: { ignored: event.type } };
  }
}

async function grantFromSession(
  session: Stripe.Checkout.Session,
  event: Stripe.Event,
  deps: HandlerDeps
): Promise<WebhookOutcome> {
  // Gate 1: the event id ledger. A delivery we already finished stops here; a
  // delivery that was recorded but never completed continues, because the
  // grant below is idempotent and this customer has already paid.
  const delivery = await deps.repo.recordEvent({ eventId: event.id, type: event.type });
  if (delivery === 'done') {
    deps.log.info('duplicate delivery ignored', { eventId: event.id });
    return { httpStatus: 200, body: { duplicate: true } };
  }

  const meta = metadataSchema.safeParse(session.metadata ?? {});
  if (!meta.success) return quarantine(event, deps, 'metadata missing or malformed');
  if (session.client_reference_id !== meta.data.client_id) {
    return quarantine(event, deps, 'client_reference_id does not match metadata.client_id');
  }

  const client = await deps.repo.findClientById(meta.data.client_id);
  if (!client) return quarantine(event, deps, 'client_id not found');
  const document = await deps.repo.findDocumentById(meta.data.document_id);
  if (!document) return quarantine(event, deps, 'document_id not found');
  if (client.zohoDealId !== meta.data.zoho_deal_id) {
    return quarantine(event, deps, 'zoho_deal_id does not match the stored deal for this client');
  }

  const amountTotal = session.amount_total;
  const currency = (session.currency ?? '').toLowerCase();
  const documentCurrency = document.currency.toLowerCase();

  // Allow currency conversion (e.g. INR for Indian cards) — the session was
  // created server-side so the document_id in metadata is the tamper-proof
  // price anchor. We verify the session charged *something* positive, not
  // the exact USD cent amount, because Stripe converts to the customer's
  // local currency when the account supports it.
  if (!amountTotal || amountTotal <= 0) {
    return quarantine(event, deps, `charged amount is zero or missing: ${amountTotal}`);
  }
  // Only enforce exact amount match when currencies are the same.
  if (currency === documentCurrency && amountTotal !== document.priceCents) {
    return quarantine(event, deps, `same-currency mismatch: charged ${amountTotal} ${currency}, catalogue says ${document.priceCents} ${documentCurrency}`);
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!paymentIntentId) return quarantine(event, deps, 'paid session without a payment intent id');

  // Gates 2 + 3: purchase / entitlement / crm_sync in one Postgres transaction.
  let grant: { purchaseId: string; isNew: boolean };
  try {
    grant = await deps.repo.grantPurchase({
      clientId: client.id,
      documentId: document.id,
      stripeSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      amountCents: amountTotal ?? document.priceCents,
      currency,
      paidAt: new Date(event.created * 1000),
      zohoDealId: meta.data.zoho_deal_id,
      eventId: event.id,
    });
  } catch (err) {
    await safeMarkFailed(event, deps, err);
    deps.log.error('entitlement transaction failed, asking Stripe to retry', {
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { httpStatus: 500, body: { error: 'grant_failed' } };
  }

  // Best effort, outside the response path: CRM trouble must never block access
  // or make Stripe retry a payment we have already honoured.
  try {
    const outcome = await deps.crm.syncPurchase(grant.purchaseId);
    deps.log.info('crm sync attempted', { purchaseId: grant.purchaseId, status: outcome.status, detail: outcome.detail });
  } catch (err) {
    deps.log.error('crm sync threw unexpectedly', {
      purchaseId: grant.purchaseId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    httpStatus: 200,
    body: { granted: true, purchaseId: grant.purchaseId, isNewPurchase: grant.isNew },
  };
}

async function quarantine(event: Stripe.Event, deps: HandlerDeps, reason: string): Promise<WebhookOutcome> {
  deps.log.warn('event quarantined, no access granted', { eventId: event.id, type: event.type, reason });
  await deps.repo.markEvent({ eventId: event.id, status: 'quarantined', error: reason });
  return { httpStatus: 200, body: { quarantined: true, reason } };
}

/** The 500 path must still report the failure even if that bookkeeping throws. */
async function safeMarkFailed(event: Stripe.Event, deps: HandlerDeps, cause: unknown): Promise<void> {
  try {
    await deps.repo.markEvent({
      eventId: event.id,
      status: 'failed',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  } catch {
    deps.log.error('could not mark event failed', { eventId: event.id });
  }
}
