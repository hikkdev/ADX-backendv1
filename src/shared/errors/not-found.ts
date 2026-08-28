import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './api-error';

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
}
