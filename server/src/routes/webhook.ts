import express, { Router } from 'express';
import type Stripe from 'stripe';

import type { AppDeps } from '../deps.js';
import { handleStripeEvent } from '../stripe/webhookHandler.js';

/**
 * Stripe signs the exact bytes it sent, so this route must receive a Buffer.
 * It is mounted before app.use(express.json()) — once a JSON parser has touched
 * the request, the raw bytes are gone and every signature check fails.
 */
export function createWebhookRouter(deps: AppDeps): Router {
  const router = Router();

  router.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      deps.log.warn('webhook rejected: no stripe-signature header');
      res.status(400).json({ error: 'missing_stripe_signature' });
      return;
    }

    let event: Stripe.Event;
    try {
      // Read the secret at request time rather than once at startup so that
      // restarting `stripe listen` (which prints a new whsec_) auto-updates
      // without requiring a server restart. STRIPE_WEBHOOK_SECRET in the
      // environment is patched by the `stripe:listen` npm script.
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? deps.env.stripeWebhookSecret;
      event = deps.stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
    } catch (err) {
      // Tampered body, wrong secret, or a replay outside the tolerance window.
      deps.log.warn('webhook signature verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    try {
      const outcome = await handleStripeEvent(event, deps);
      res.status(outcome.httpStatus).json(outcome.body);
    } catch (err) {
      deps.log.error('webhook handler threw', {
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
      });
      res.status(500).json({ error: 'webhook_processing_failed' });
    }
  });

  return router;
}
