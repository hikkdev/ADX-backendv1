import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot I — the stream's two doors and its wire format.
 *
 * What is pinned: a stream token is single-use, five minutes, bound to one
 * ticket and one person, and a token for another ticket opens nothing; the
 * bearer header still works and takes precedence; the response is
 * `text/event-stream` with a `retry` line, a heartbeat comment on the
 * interval and an `id` on every event the caller may resume from;
 * `Last-Event-ID` is read as the instant it names, and so is
 * `?lastEventId=` (I4-B) because a reconnect on a fresh single-use token
 * cannot carry the header; a grant does not freeze who the person is — a
 * login since deactivated or stripped of the role it was minted with opens
 * no stream.
 */

const { redis, auth, users } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(async () => 'OK'), multi: vi.fn() } },
  auth: { authenticate: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()) },
  users: { findUserSummaries: vi.fn() },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/auth', () => auth);
vi.mock('../../users', () => users);

import {
  HEARTBEAT_MS,
  RETRY_MS,
  STREAM_TOKEN_TTL_SECONDS,
  authenticateStream,
  lastEventInstant,
  mintStreamToken,
  openSse,
  redeemStreamToken,
} from '../live-chat.stream';

const actor = { sub: 'usr_pub', roles: ['PUBLISHER'] };

/** ioredis' MULTI…EXEC answer shape: one `[error, value]` pair per queued command. */
function multiReturning(value: string | null) {
  const chain = { get: vi.fn(() => chain), del: vi.fn(() => chain), exec: vi.fn(async () => [[null, value], [null, 1]]) };
  return chain;
}

/** The account as `users` reports it now: active, holding these roles. */
const account = (id: string, roles: string[], isActive = true) => new Map([[id, { id, name: null, mobile: '+91', email: null, isActive, createdAt: new Date(), roles, role: roles[0] ?? null }]]);

beforeEach(() => {
  vi.clearAllMocks();
  redis.redis.set.mockResolvedValue('OK');
  users.findUserSummaries.mockImplementation(async (ids: string[]) =>
    ids[0] === 'usr_admin' ? account('usr_admin', ['ADMIN']) : account(ids[0]!, ['PUBLISHER']),
  );
});

describe('the stream token', () => {
  it('is 32 random bytes, kept five minutes, and says which ticket and who', async () => {
    const { token, expiresInSec } = await mintStreamToken('tkt_1', actor);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(expiresInSec).toBe(STREAM_TOKEN_TTL_SECONDS);
    expect(redis.redis.set).toHaveBeenCalledWith(
      `support:stream:${token}`,
      JSON.stringify({ ticketId: 'tkt_1', sub: 'usr_pub', roles: ['PUBLISHER'] }),
      'EX',
      300,
    );
  });

  it('is spent on the first read — the GET and the DEL travel together', async () => {
    const chain = multiReturning(JSON.stringify({ ticketId: 'tkt_1', sub: 'usr_pub', roles: ['PUBLISHER'] }));
    redis.redis.multi.mockReturnValue(chain);
    const token = 'a'.repeat(64);
    expect(await redeemStreamToken(token, 'tkt_1')).toEqual({ sub: 'usr_pub', roles: ['PUBLISHER'] });
    expect(chain.get).toHaveBeenCalledWith(`support:stream:${token}`);
    expect(chain.del).toHaveBeenCalledWith(`support:stream:${token}`);
    // The person is read again on redemption — once — rather than trusted from the grant.
    expect(users.findUserSummaries).toHaveBeenCalledTimes(1);
    expect(users.findUserSummaries).toHaveBeenCalledWith(['usr_pub']);
  });

  it('opens nothing for an ADMIN whose role was removed after the token was minted', async () => {
    redis.redis.multi.mockReturnValue(multiReturning(JSON.stringify({ ticketId: 'tkt_1', sub: 'usr_admin', roles: ['ADMIN'] })));
    users.findUserSummaries.mockResolvedValue(account('usr_admin', ['PUBLISHER']));
    expect(await redeemStreamToken('a'.repeat(64), 'tkt_1')).toBeNull();
  });

  it('opens nothing for a login since deactivated, or one that no longer exists', async () => {
    redis.redis.multi.mockReturnValue(multiReturning(JSON.stringify({ ticketId: 'tkt_1', sub: 'usr_pub', roles: ['PUBLISHER'] })));
    users.findUserSummaries.mockResolvedValue(account('usr_pub', ['PUBLISHER'], false));
    expect(await redeemStreamToken('a'.repeat(64), 'tkt_1')).toBeNull();

    redis.redis.multi.mockReturnValue(multiReturning(JSON.stringify({ ticketId: 'tkt_1', sub: 'usr_pub', roles: ['PUBLISHER'] })));
    users.findUserSummaries.mockResolvedValue(new Map());
    expect(await redeemStreamToken('a'.repeat(64), 'tkt_1')).toBeNull();
  });

  it('opens nothing on another ticket, on a token that has expired, or on one that is not a token at all', async () => {
    redis.redis.multi.mockReturnValue(multiReturning(JSON.stringify({ ticketId: 'tkt_1', sub: 'usr_pub', roles: [] })));
    expect(await redeemStreamToken('a'.repeat(64), 'tkt_other')).toBeNull();

    redis.redis.multi.mockReturnValue(multiReturning(null));
    expect(await redeemStreamToken('a'.repeat(64), 'tkt_1')).toBeNull();

    // Not the right shape: refused without a round trip.
    redis.redis.multi.mockClear();
    expect(await redeemStreamToken('../../etc/passwd', 'tkt_1')).toBeNull();
    expect(redis.redis.multi).not.toHaveBeenCalled();
  });
});

describe('authenticating a stream', () => {
  const res = {} as never;

  it('takes the bearer header when the phone sends one', () => {
    const next = vi.fn();
    authenticateStream({ headers: { authorization: 'Bearer x' }, query: {}, params: {} } as never, res, next);
    expect(auth.authenticate).toHaveBeenCalled();
  });

  it('falls back to ?t= for the console, whose EventSource cannot set a header', async () => {
    redis.redis.multi.mockReturnValue(multiReturning(JSON.stringify({ ticketId: 'tkt_1', sub: 'usr_admin', roles: ['ADMIN'] })));
    const req = { headers: {}, query: { t: 'a'.repeat(64) }, params: { ticketId: 'tkt_1' } } as never as { user?: unknown };
    await new Promise<void>((resolve) => authenticateStream(req as never, res, () => resolve()));
    expect(req.user).toEqual({ sub: 'usr_admin', roles: ['ADMIN'] });
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('is 401 with neither', async () => {
    const error = await new Promise<unknown>((resolve) =>
      authenticateStream({ headers: {}, query: {}, params: {} } as never, res, resolve as never),
    );
    expect(error).toMatchObject({ statusCode: 401 });
  });

  it('is 401 on a token minted by an ADMIN whose role has since been removed — the grant is not the person', async () => {
    redis.redis.multi.mockReturnValue(multiReturning(JSON.stringify({ ticketId: '@inbox', sub: 'usr_admin', roles: ['ADMIN'] })));
    users.findUserSummaries.mockResolvedValue(account('usr_admin', []));
    const req = { headers: {}, query: { t: 'a'.repeat(64) }, params: {} } as never as { user?: unknown };
    const error = await new Promise<unknown>((resolve) => authenticateStream(req as never, res, resolve as never));
    expect(error).toMatchObject({ statusCode: 401 });
    expect(req.user).toBeUndefined();
  });
});

describe('the wire format', () => {
  function fakeResponse() {
    const written: string[] = [];
    const handlers = new Map<string, () => void>();
    const res = {
      written,
      status: vi.fn(() => res),
      setHeader: vi.fn(() => res),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => written.push(chunk)),
      end: vi.fn(),
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      headers: {} as Record<string, string>,
      fire: (event: string) => handlers.get(event)?.(),
    };
    return res;
  }

  it('sets the event-stream headers, opens with retry, and heartbeats on the interval', () => {
    vi.useFakeTimers();
    const req = { on: vi.fn() } as never;
    const res = fakeResponse();
    const onClose = vi.fn();
    const stream = openSse(req, res as never, onClose);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(res.written[0]).toBe(`retry: ${RETRY_MS}\n\n`);

    stream.send('message', { id: 'msg_1' }, '1757830000000');
    expect(res.written[1]).toBe('event: message\nid: 1757830000000\ndata: {"id":"msg_1"}\n\n');

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(res.written[2]).toMatch(/^: ping /);

    stream.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalled();
    // A closed stream writes nothing more, and closing twice is not two closes.
    stream.send('message', { id: 'msg_2' });
    stream.close();
    expect(res.written).toHaveLength(3);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('reads Last-Event-ID as the instant it names, and ignores anything else', () => {
    expect(lastEventInstant({ headers: { 'last-event-id': '1757830000000' }, query: {} } as never)?.getTime()).toBe(1757830000000);
    expect(lastEventInstant({ headers: {}, query: {} } as never)).toBeNull();
    expect(lastEventInstant({ headers: { 'last-event-id': 'nonsense' }, query: {} } as never)).toBeNull();
  });

  it('takes ?lastEventId= when the header is absent, and the header when both are there', () => {
    // A reconnect on a fresh single-use token is a fresh EventSource, which cannot set the header.
    expect(lastEventInstant({ headers: {}, query: { lastEventId: '1757830000000' } } as never)?.getTime()).toBe(1757830000000);
    expect(lastEventInstant({ headers: { 'last-event-id': '1757830005000' }, query: { lastEventId: '1757830000000' } } as never)?.getTime()).toBe(
      1757830005000,
    );
    expect(lastEventInstant({ headers: {}, query: { lastEventId: 'nonsense' } } as never)).toBeNull();
    expect(lastEventInstant({ headers: {}, query: { lastEventId: ['1', '2'] } } as never)).toBeNull();
  });
});
