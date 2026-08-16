import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    logger.warn('Validation failed', {
      method: req.method,
      path: req.path,
      issues: err.issues,
    });
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: err.issues,
      },
    });
    return;
  }

  if (err instanceof ApiError) {
    const logMeta = {
      method: req.method,
      path: req.path,
      status: err.statusCode,
      code: err.code,
      stack: err.stack,
      details: err.details,
    };

    if (err.statusCode >= 500) logger.error(err.message, logMeta);
    else logger.warn(err.message, logMeta);

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error(message, {
    method: req.method,
    path: req.path,
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
}
