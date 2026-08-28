import type { Request, Response } from 'express';
import { env } from '../config/env';

/**
 * Liveness probe. Deliberately unauthenticated and owned by bootstrap rather
 * than by a module — it reports on the process, not on any business domain.
 */
export function healthHandler(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: {
      status: 'ok',
      service: 'adx-backend',
      env: env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
}
