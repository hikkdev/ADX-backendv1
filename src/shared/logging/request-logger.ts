import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';
import { recordRequestLatency } from './request-latency';
import { recordRequestOutcome } from './request-counters';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    logger.info('HTTP request completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
    });
    // Lot G (Q130): the minute's latencies, for the API's own health sample.
    recordRequestLatency(durationMs);
    // G13-B: the hour's requests and 5xx answers, for the region's error rate.
    recordRequestOutcome(res.statusCode);
  });

  next();
}
