import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 hands the error middleware only *synchronous* throws. A rejected
 * promise inside an async handler becomes an unhandledRejection, and Node exits
 * the process. Found by calling the admin endpoint while Supabase was
 * unreachable: the request killed the server instead of answering 500.
 */
export function asyncHandler(route: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    void route(req, res, next).catch(next);
  };
}
