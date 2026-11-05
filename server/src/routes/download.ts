import { Router } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../deps.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireUser, type AuthedRequest } from '../middleware/requireUser.js';
import { rateLimit } from '../middleware/rateLimit.js';

const DOWNLOAD_URL_TTL_SECONDS = 60;

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * The browser never learns the object key, and the bucket is private, so this
 * endpoint is the only door to the file. It derives the client from the JWT and
 * requires an unrevoked entitlement for exactly that client + document pair.
 */
export function createDownloadRouter(deps: AppDeps): Router {
  const router = Router();

  router.get(
    '/api/documents/:id/download',
    rateLimit({ windowMs: 60_000, max: 30, key: 'download' }),
    requireUser(deps.auth),
    asyncHandler(async (req, res) => {
      const user = (req as AuthedRequest).user;
      if (!user) return;

      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_document_id' });
        return;
      }

      const client = await deps.repo.findClientByAuthUserId(user.userId);
      if (!client) {
        res.status(403).json({ error: 'no_client_profile' });
        return;
      }

      const entitlement = await deps.repo.findEntitlementForDownload(client.id, parsed.data.id);
      if (!entitlement) {
        // Same answer for "document does not exist" and "not yours": it is not
        // this client's business which of the two it is.
        deps.log.warn('download refused', { clientId: client.id, documentId: parsed.data.id });
        res.status(403).json({ error: 'not_entitled' });
        return;
      }

      const url = await deps.storage.createDownloadUrl(entitlement.storagePath, DOWNLOAD_URL_TTL_SECONDS);
      res.json({ url, expiresIn: DOWNLOAD_URL_TTL_SECONDS });
    })
  );

  return router;
}
