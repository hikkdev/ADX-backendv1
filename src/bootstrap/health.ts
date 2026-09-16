import type { Request, Response } from 'express';
import { env } from '../config/env';
import { pingDatabase } from '../shared/database';
import { pingRedis } from '../shared/cache';

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

type Probe = { ok: true; latencyMs: number } | { ok: false; error: string };

export interface ReadinessProbes {
  postgres(): Promise<Probe>;
  redis(): Promise<Probe>;
}

const defaultProbes: ReadinessProbes = {
  postgres: () => pingDatabase(),
  redis: () => pingRedis(),
};

/**
 * Readiness probe: liveness says the process is up, this says it can serve.
 * Both dependencies are pinged in parallel; either failing is a 503 naming the
 * part, so a load balancer stops sending traffic and an operator knows where
 * to look. Also unauthenticated — it is read before anyone can sign in.
 */
export function readyHandlerWith(probes: ReadinessProbes) {
  return async function readyHandler(_req: Request, res: Response): Promise<void> {
    const [postgres, redis] = await Promise.all([probes.postgres(), probes.redis()]);
    const ok = postgres.ok && redis.ok;
    res.status(ok ? 200 : 503).json({
      success: ok,
      data: { ok, postgres, redis, uptime: Math.round(process.uptime()) },
    });
  };
}

export const readyHandler = readyHandlerWith(defaultProbes);
