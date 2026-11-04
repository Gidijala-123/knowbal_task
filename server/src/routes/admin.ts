import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../deps.js';
import { rateLimit } from '../middleware/rateLimit.js';

function requireAdmin(deps: AppDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = String(req.headers['x-admin-key'] ?? '');
    if (!constantTimeEquals(provided, deps.env.adminApiKey)) {
      deps.log.warn('admin request refused', { path: req.path });
      res.status(401).json({ error: 'invalid_admin_key' });
      return;
    }
    next();
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const bodySchema = z.object({ purchaseId: z.string().uuid().optional() });

/**
 * Retry is idempotent by construction: `claim_crm_sync` refuses 'synced' rows,
 * so re-running this endpoint can only ever re-attempt work that is still open,
 * and Zoho treats a PUT of identical values as a no-op.
 */
export function createAdminRouter(deps: AppDeps): Router {
  const router = Router();
  const guard = requireAdmin(deps);
  const limiter = rateLimit({ windowMs: 60_000, max: 20, key: 'admin' });

  router.post('/api/admin/retry-crm-sync', guard, limiter, async (req, res) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const outcomes = await deps.crm.retryDue({ purchaseId: parsed.data.purchaseId });
    const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.status] = (acc[o.status] ?? 0) + 1;
      return acc;
    }, {});
    res.json({ attempted: outcomes.length, summary, outcomes });
  });

  router.get('/api/admin/crm-sync', guard, limiter, async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ due: await deps.repo.listCrmSyncDue(limit) });
  });

  return router;
}
