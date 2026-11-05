import type Stripe from 'stripe';

import type { ClientRow, DocumentRow } from '../db/repository.js';
import type { AppEnv } from '../env.js';

export type CreatedCheckout = { sessionId: string; url: string; stripeCustomerId: string };

/**
 * The amount charged is read from the `documents` row that the caller looked up
 * by id. The request body only ever carries a document id, so a client cannot
 * price their own purchase.
 */
export async function createCheckoutSession(
  stripe: Stripe,
  env: AppEnv,
  input: { client: ClientRow; document: DocumentRow }
): Promise<CreatedCheckout> {
  const { client, document } = input;

  const stripeCustomerId =
    client.stripeCustomerId ??
    (await stripe.customers.create({
      email: client.email,
      metadata: { client_id: client.id },
    })).id;

  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = env.stripePriceId
    ? { price: env.stripePriceId, quantity: 1 }
    : {
      price_data: {
        currency: document.currency,
        unit_amount: document.priceCents,
        product_data: { name: document.title },
      },
      quantity: 1,
    };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    // Stable IDs travel with the payment, so the webhook never has to match on
    // email or name (both mutable, both forgeable).
    client_reference_id: client.id,
    metadata: {
      client_id: client.id,
      document_id: document.id,
      zoho_deal_id: client.zohoDealId ?? '',
    },
    line_items: [lineItem],
    allow_promotion_codes: false,
    billing_address_collection: 'auto',
    // Lock currency to USD so Stripe never shows a local-currency conversion
    // option. Without this, Indian cards see an INR option whose amount_total
    // does not equal document.priceCents (USD cents), which causes the webhook
    // handler to quarantine the event as a price mismatch.
    currency: document.currency,
    success_url: `${env.appBaseUrl}/?payment=completed&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.appBaseUrl}/?payment=cancelled`,
  });

  if (!session.url) throw new Error('stripe checkout session has no url');
  return { sessionId: session.id, url: session.url, stripeCustomerId };
}
