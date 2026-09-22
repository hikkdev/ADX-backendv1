import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../shared/auth';
import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { openSse } from '../../shared/http';
import { logger } from '../../shared/logging';
import { liveAgents, liveFingerprint, type LiveFilter } from './agent-locations.service';

/**
 * LT-1: the live map's stream — `GET /agent-locations/stream?t=<token>`.
 *
 * The same arrangement as the live chat's inbox (Lot I): a browser's
 * `EventSource` cannot set an Authorization header, so the console mints a
 * single-use token with its bearer (`POST /agent-locations/stream-token`)
 * and opens the stream with it; the console owns the reconnect. Every
 * `TICK_MS` the server reads the live list and sends a `snapshot` when its
 * fingerprint moved — a marker moved, a state changed, an alert came or
 * went — and a `heartbeat` comment otherwise.
 */
const TOKEN_KEY = (token: string) => `agentloc:stream:${token}`;
export const STREAM_TOKEN_TTL_SECONDS = 5 * 60;
export const TICK_MS = 5000;

type Grant = { sub: string; roles: string[] };

export async function mintLiveStreamToken(sub: string, roles: readonly string[]): Promise<{ token: string; expiresInSec: number }> {
  const token = randomBytes(32).toString('hex');
  await redis.set(TOKEN_KEY(token), JSON.stringify({ sub, roles: [...roles] } satisfies Grant), 'EX', STREAM_TOKEN_TTL_SECONDS);
  return { token, expiresInSec: STREAM_TOKEN_TTL_SECONDS };
}

async function redeem(token: string): Promise<Grant | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const key = TOKEN_KEY(token);
  const results = await redis.multi().get(key).del(key).exec();
  const raw = results?.[0]?.[1];
  if (typeof raw !== 'string') return null;
  try {
    const grant = JSON.parse(raw) as Grant;
    return grant.roles.includes('ADMIN') ? grant : null;
  } catch {
    return null;
  }
}

/** A bearer when there is one; the single-use `?t=` token otherwise. ADMIN either way. */
export function authenticateLiveStream(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization) {
    authenticate(req, res, next);
    return;
  }
  const token = typeof req.query['t'] === 'string' ? req.query['t'] : '';
  if (!token) {
    next(new ApiError(401, 'UNAUTHORIZED', 'Missing authorization header or stream token'));
    return;
  }
  redeem(token)
    .then((grant) => {
      if (!grant) {
        next(new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired stream token'));
        return;
      }
      req.user = { sub: grant.sub, roles: grant.roles as never };
      next();
    })
    .catch(next);
}

export async function liveStreamHandler(req: Request, res: Response): Promise<void> {
  if (!(req.user?.roles ?? []).includes('ADMIN')) throw new ApiError(403, 'FORBIDDEN', 'The live map is the desk’s');
  const filter: LiveFilter = {
    ...(typeof req.query['city'] === 'string' && req.query['city'] ? { city: req.query['city'] } : {}),
    ...(req.query['side'] === 'PUBLISHER' || req.query['side'] === 'ADVERTISER' ? { side: req.query['side'] } : {}),
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  const sse = openSse(req, res, () => {
    if (timer) clearInterval(timer);
  }, { tag: 'Live map' });
  let last = '';
  const tick = async () => {
    if (sse.closed) return;
    try {
      const snapshot = await liveAgents(filter);
      const print = liveFingerprint(snapshot);
      if (print !== last) {
        last = print;
        sse.send('snapshot', snapshot, String(Date.now()));
      } else {
        sse.comment('unchanged');
      }
    } catch (cause) {
      logger.warn('Live map tick failed', { err: cause });
    }
  };
  await tick();
  timer = setInterval(() => void tick(), TICK_MS);
}
