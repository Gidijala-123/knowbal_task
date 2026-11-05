import { Router } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../deps.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireUser, type AuthedRequest } from '../middleware/requireUser.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { createCheckoutSession } from '../stripe/checkout.js';

const bodySchema = z.object({ documentId: z.string().uuid() });

export function createCheckoutRouter(deps: AppDeps): Router {
  const router = Router();

  router.post(
    '/api/checkout',
    rateLimit({ windowMs: 60_000, max: 10, key: 'checkout' }),
    requireUser(deps.auth),
    asyncHandler(async (req, res) => {
      const user = (req as AuthedRequest).user;
      if (!user) return; // requireUser already answered

      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues.map((i) => i.path.join('.')) });
        return;
      }

      const client = await deps.repo.findClientByAuthUserId(user.userId);
      if (!client) {
        // A valid login that is not a provisioned client: no row in `clients`.
        res.status(403).json({ error: 'no_client_profile' });
        return;
      }

      const document = await deps.repo.findDocumentById(parsed.data.documentId);
      if (!document) {
        res.status(404).json({ error: 'document_not_found' });
        return;
      }

      if (await deps.repo.hasActiveEntitlement(client.id, document.id)) {
        res.status(409).json({ error: 'already_owned' });
        return;
      }

      // Without a deal id the webhook could not match the payment to a CRM
      // record, so it would have to be quarantined. Better to refuse the sale.
      if (!client.zohoDealId) {
        deps.log.warn('checkout refused: client has no zoho deal id', { clientId: client.id });
        res.status(409).json({ error: 'client_not_provisioned' });
        return;
      }

      const created = await createCheckoutSession(deps.stripe, deps.env, { client, document });
      if (!client.stripeCustomerId) await deps.repo.setStripeCustomerId(client.id, created.stripeCustomerId);

      deps.log.info('checkout session created', {
        sessionId: created.sessionId,
        documentId: document.id,
        amountCents: document.priceCents,
      });
      res.json({ checkoutUrl: created.url, sessionId: created.sessionId });
    })
  );

  return router;
}
