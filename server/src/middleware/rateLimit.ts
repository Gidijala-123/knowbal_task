import type { NextFunction, Request, Response } from 'express';

import type { AuthedRequest } from './requireUser.js';

type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window limiter kept in memory: enough to blunt a scripted flood on the
 * two sensitive surfaces (checkout creation, admin retry) without pulling in a
 * dependency. Not shared across instances — a Redis-backed limiter is listed
 * under "next steps".
 */
export function rateLimit(options: { windowMs: number; max: number; key: string }) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const userId = (req as AuthedRequest).user?.userId;
    const identity = userId ? `${options.key}:${userId}` : `${options.key}:${req.ip}`;
    const bucket = buckets.get(identity);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(identity, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader('retry-after', Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}
