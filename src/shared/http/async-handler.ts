import type { NextFunction, Request, Response } from 'express';

export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/**
 * Forwards a rejected promise to Express's error pipeline. Express 5 handles
 * synchronous throws on its own but still ignores unhandled rejections from
 * async handlers, so every async route is wrapped in this.
 */
export function asyncHandler(handler: AsyncRouteHandler) {
  const wrapped = (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
  // Carry the wrapped handler's name onto the wrapper. Nothing at runtime
  // reads it, but it makes the Express router stack self-describing, which is
  // what lets scripts/collect-routes.ts pin each route to a named handler
  // instead of an indistinguishable '<anon>'.
  Object.defineProperty(wrapped, 'name', { value: handler.name, configurable: true });
  return wrapped;
}
