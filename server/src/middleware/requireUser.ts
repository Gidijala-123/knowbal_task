import type { NextFunction, Request, Response } from 'express';

import type { AuthPort } from '../db/repository.js';

export type AuthedRequest = Request & { user?: { userId: string; email: string } };

/**
 * Bearer token -> Supabase user id. Everything downstream derives the client
 * from that id via the `clients` table, so a browser can never claim to be a
 * different client by sending a client_id in a body.
 */
export function requireUser(auth: AuthPort) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
  };
}
