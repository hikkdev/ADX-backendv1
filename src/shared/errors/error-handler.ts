import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './api-error';
import { reportError } from './error-sink';
import { recordServerError } from './error-rate-alert';
import { logger } from '../logging/logger';

/**
 * A 5xx is logged, then handed to the configured sink and counted towards the
 * rate alert — both fire-and-forget, so neither can delay or fail the response.
 */
function onServerError(err: unknown, req: Request, status: number, code: string): void {
  const context = { requestId: req.requestId, path: req.path, method: req.method, status, code };
  void reportError(err, context);
  void recordServerError({ requestId: req.requestId, path: req.path, status, code });
}

/**
 * E6: an ApiError whose `details.retryAfter` is a number of seconds gets a
 * `Retry-After` header — 503 KYC_PROVIDER_UNAVAILABLE / DEGRADED today,
 * generic on purpose so the next "come back later" refusal needs no route
 * code. Whole seconds, never negative; anything else is left alone.
 */
export function retryAfterSeconds(details: unknown): number | null {
  if (typeof details !== 'object' || details === null) return null;
  const value = (details as { retryAfter?: unknown }).retryAfter;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.ceil(value);
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId;

  if (err instanceof ZodError) {
    logger.warn('Validation failed', {
      requestId,
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
        requestId,
      },
    });
    return;
  }

  if (err instanceof ApiError) {
    const logMeta = {
      requestId,
      method: req.method,
      path: req.path,
      status: err.statusCode,
      code: err.code,
      stack: err.stack,
      details: err.details,
    };

    if (err.statusCode >= 500) {
      logger.error(err.message, logMeta);
      onServerError(err, req, err.statusCode, err.code);
    } else {
      logger.warn(err.message, logMeta);
    }

    const retryAfter = retryAfterSeconds(err.details);
    if (retryAfter !== null) res.set('Retry-After', String(retryAfter));

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
        requestId,
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error(message, {
    requestId,
    method: req.method,
    path: req.path,
    stack: err instanceof Error ? err.stack : undefined,
  });
  onServerError(err, req, 500, 'INTERNAL_ERROR');

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId,
    },
  });
}
