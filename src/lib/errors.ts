import type { NextFunction, Request, Response } from 'express';

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'TOO_MANY_REQUESTS'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR'
  | 'EVIDENCE_INCOMPLETE'
  | 'MILESTONES_INCOMPLETE'
  | 'INVALID_QR';

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: ApiErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

export function asyncHandler(handler: AsyncRouteHandler) {
  const wrapped = (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
  // Carry the wrapped handler's name onto the wrapper. Nothing at runtime
  // reads it, but it makes the Express router stack self-describing, which is
  // what lets scripts/route-inventory.ts pin each route to a named handler
  // instead of an indistinguishable '<anon>'.
  Object.defineProperty(wrapped, 'name', { value: handler.name, configurable: true });
  return wrapped;
}
