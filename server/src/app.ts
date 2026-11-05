import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import type { AppDeps } from './deps.js';
import { createAdminRouter } from './routes/admin.js';
import { createCheckoutRouter } from './routes/checkout.js';
import { createDownloadRouter } from './routes/download.js';
import { createWebhookRouter } from './routes/webhook.js';

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // 0 means "trust nothing but the socket", which is the safe default when this
  // process is exposed directly. Set TRUST_PROXY to the number of proxy hops in
  // front of it so the per-IP rate limits see real client addresses.
  app.set('trust proxy', deps.env.trustProxy);

  // Locked to the portal origin. Requests with no Origin header (curl, the
  // Stripe CLI, the webhook itself) are allowed through by cors by default.
  app.use(cors({ origin: deps.env.appBaseUrl, credentials: false }));

  // ORDER MATTERS. The webhook needs the untouched bytes to verify the
  // signature, so its raw parser is registered before the global JSON parser.
  app.use(createWebhookRouter(deps));
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, zohoSimulateFailure: deps.env.zohoSimulateFailure });
  });

  app.use(createCheckoutRouter(deps));
  app.use(createDownloadRouter(deps));
  app.use(createAdminRouter(deps));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Reached when a handler calls next(err) or throws synchronously. An async
  // handler that merely rejects does NOT get here on Express 4, which is why
  // every async route is wrapped in asyncHandler.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.log.error('unhandled request error', {
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
