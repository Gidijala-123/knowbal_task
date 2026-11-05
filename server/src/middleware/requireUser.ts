import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AuthPort } from '../db/repository.js';
import { asyncHandler } from './asyncHandler.js';

export type AuthedRequest = Request & { user?: { userId: string; email: string } };

/**
 * Bearer token -> Supabase user id. Everything downstream derives the client
 * from that id via the `clients` table, so a browser can never claim to be a
 * different client by sending a client_id in a body.
 *
 * Wrapped because verifyAccessToken reaches Supabase: if that call rejects, the
 * request must answer 500 rather than take the process down with it.
 */
export function requireUser(auth: AuthPort): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }
    const user = await auth.verifyAccessToken(token);
    if (!user) {
      res.status(401).json({ error: 'invalid_or_expired_token' });
      return;
    }
    (req as AuthedRequest).user = user;
    next();
  });
}
