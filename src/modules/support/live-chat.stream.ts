import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../shared/auth';
import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { SSE_HEARTBEAT_MS, SSE_RETRY_MS } from '../../shared/http';
import { findUserSummaries } from '../users';
import type { Actor } from './support.types';

/**
 * The stream's plumbing — Lot I.
 *
 * Two things the SSE routes need that no other route does:
 *
 * 1. **A second way in.** The phones open `GET /tickets/:id/events` with
 *    the bearer header like any route. The console's browser `EventSource`
 *    cannot set headers, so it first mints a stream token
 *    (`POST /tickets/:id/stream-token`, an ordinary authenticated call) and
 *    opens the stream with `?t=<token>`. The token is 32 random bytes, kept
 *    in Redis for five minutes under `support:stream:<token>` with the
 *    ticket and the caller it was minted for, and deleted on first use —
 *    single-use, bound to one ticket, bound to one person. A token on the
 *    wrong ticket, a second use, or one past five minutes is 401. The
 *    grant does not freeze who the person is: on redemption their roles
 *    and status are read again (one `users` query per stream open), and a
 *    login since deactivated, or stripped of a role the grant was minted
 *    with, opens nothing — a stream minted by an ADMIN survives that
 *    ADMIN's removal for at most the token's five minutes, and only unused.
 *
 * 2. **The wire format.** `text/event-stream`, `retry: 3000` up front, a
 *    comment heartbeat every 25 s so proxies keep the socket, and an `id`
 *    on every message event (its `createdAt` in ms) so `Last-Event-ID`
 *    can say where to resume. The same instant is also taken as
 *    `?lastEventId=<ms>`, because the console's reconnect is a fresh
 *    `EventSource` on a fresh single-use token and a browser cannot put
 *    the header on one — the header wins when both are present.
 */

const TOKEN_KEY = (token: string) => `support:stream:${token}`;
export const STREAM_TOKEN_TTL_SECONDS = 5 * 60;
export const HEARTBEAT_MS = SSE_HEARTBEAT_MS;
export const RETRY_MS = SSE_RETRY_MS;

type StreamGrant = { ticketId: string; sub: string; roles: string[] };

export async function mintStreamToken(ticketId: string, actor: Actor): Promise<{ token: string; expiresInSec: number }> {
  const token = randomBytes(32).toString('hex');
  const grant: StreamGrant = { ticketId, sub: actor.sub, roles: actor.roles };
  await redis.set(TOKEN_KEY(token), JSON.stringify(grant), 'EX', STREAM_TOKEN_TTL_SECONDS);
  return { token, expiresInSec: STREAM_TOKEN_TTL_SECONDS };
}

/** Redeems a token — once. Null for unknown, spent, expired, or minted for another ticket. */
export async function redeemStreamToken(token: string, ticketId: string): Promise<Actor | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const key = TOKEN_KEY(token);
  const results = await redis.multi().get(key).del(key).exec();
  const raw = results?.[0]?.[1];
  if (typeof raw !== 'string') return null;
  let grant: StreamGrant;
  try {
    grant = JSON.parse(raw) as StreamGrant;
  } catch {
    return null;
  }
  if (grant.ticketId !== ticketId) return null;
  return currentActorFor({ sub: grant.sub, roles: grant.roles ?? [] });
}

/**
 * The grant as of now, not as of minting: the person must still be active
 * and still hold every role the grant was minted with, else null. Read
 * through `users` — the module's one door to the account — once per open.
 */
async function currentActorFor(minted: Actor): Promise<Actor | null> {
  const user = (await findUserSummaries([minted.sub])).get(minted.sub);
  if (!user || !user.isActive) return null;
  const held = new Set<string>(user.roles);
  if (!minted.roles.every((role) => held.has(role))) return null;
  return { sub: minted.sub, roles: minted.roles };
}

/**
 * The bearer header when it is there (the phones), else `?t=` (the
 * console). Sets `req.user` the way `authenticate` does so the handlers
 * read one shape. Registered ahead of the router-wide `authenticate`, on
 * the stream routes alone.
 */
export function authenticateStream(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization) {
    authenticate(req, res, next);
    return;
  }
  const token = typeof req.query['t'] === 'string' ? req.query['t'] : '';
  if (!token) {
    next(new ApiError(401, 'UNAUTHORIZED', 'Missing authorization header or stream token'));
    return;
  }
  const ticketId = typeof req.params['ticketId'] === 'string' ? req.params['ticketId'] : '';
  redeemStreamToken(token, ticketId || INBOX_TOKEN_TICKET)
    .then((actor) => {
      if (!actor) {
        next(new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired stream token'));
        return;
      }
      req.user = { sub: actor.sub, roles: actor.roles as never };
      next();
    })
    .catch(next);
}

/** The inbox stream has no ticket; its token is minted against this marker. */
export const INBOX_TOKEN_TICKET = '@inbox';

// LT-1: the writer moved to `shared/http/sse.ts` so the ops live map can push the same way; re-exported here for the callers and the test.
export { openSse, type SseWriter } from '../../shared/http';

export function lastEventInstant(req: Request): Date | null {
  const raw = req.headers['last-event-id'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const query = req.query?.['lastEventId'];
  const value = header || (typeof query === 'string' ? query : '');
  if (!value) return null;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}
