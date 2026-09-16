import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot I — the fan-out.
 *
 * What is pinned: an event is delivered locally AND published to Redis, so
 * a node keeps chatting through an outage; the same event arriving back
 * from Redis is not delivered twice (the `eid` is what says so); a
 * subscription is one Redis SUBSCRIBE however many sockets are listening,
 * and the last listener leaving unsubscribes; a publish that Redis refuses
 * still reaches the listeners on this node.
 */

const { redis, logging, subscriber } = vi.hoisted(() => {
  const handlers = new Map<string, (channel: string, raw: string) => void>();
  const sub = {
    on: vi.fn((event: string, handler: (channel: string, raw: string) => void) => handlers.set(event, handler)),
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 1),
    deliver: (channel: string, raw: string) => handlers.get('message')?.(channel, raw),
  };
  return {
    subscriber: sub,
    redis: { redis: { publish: vi.fn(async (_channel: string, _payload: string) => 1), duplicate: vi.fn(() => sub) } },
    logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  };
});

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/logging', () => logging);

import { INBOX_CHANNEL, publish, resetBusForTests, subscribe, ticketChannel } from '../live-chat.bus';

beforeEach(() => {
  vi.clearAllMocks();
  resetBusForTests();
  redis.redis.publish.mockResolvedValue(1);
});

describe('publishing', () => {
  it('delivers on this node and fans out to the others, stamping an id', async () => {
    const heard: unknown[] = [];
    subscribe(ticketChannel('tkt_1'), (event) => heard.push(event));

    await publish(ticketChannel('tkt_1'), { type: 'seen', who: 'agent', at: '2026-09-14T06:30:00.000Z' });

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ type: 'seen', who: 'agent' });
    expect((heard[0] as { eid: string }).eid).toMatch(/[0-9a-f-]{36}/);
    expect(redis.redis.publish).toHaveBeenCalledWith('support:ticket:tkt_1', expect.stringContaining('"type":"seen"'));
  });

  it('does not deliver the same event twice when Redis hands it back', async () => {
    const heard: unknown[] = [];
    subscribe(INBOX_CHANNEL, (event) => heard.push(event));

    await publish(INBOX_CHANNEL, { type: 'breach', ticketId: 'tkt_1', displayId: null, assignedAdminUserId: null, waitedSec: 300 });
    const sent = String(redis.redis.publish.mock.calls[0]![1]);
    subscriber.deliver(INBOX_CHANNEL, sent);

    expect(heard).toHaveLength(1);
  });

  it('still reaches the listeners on this node when Redis refuses the publish', async () => {
    redis.redis.publish.mockRejectedValueOnce(new Error('connection reset'));
    const heard: unknown[] = [];
    subscribe(ticketChannel('tkt_2'), (event) => heard.push(event));

    await publish(ticketChannel('tkt_2'), { type: 'typing', who: 'requester', typing: true });

    expect(heard).toHaveLength(1);
    expect(logging.logger.warn).toHaveBeenCalled();
  });

  it('delivers an event that arrived only from another instance', async () => {
    const heard: unknown[] = [];
    subscribe(ticketChannel('tkt_3'), (event) => heard.push(event));
    subscriber.deliver(ticketChannel('tkt_3'), JSON.stringify({ type: 'status', status: 'CLOSED', channel: 'LIVE_CHAT', eid: 'from-elsewhere' }));
    expect(heard).toEqual([{ type: 'status', status: 'CLOSED', channel: 'LIVE_CHAT', eid: 'from-elsewhere' }]);
  });
});

describe('subscribing', () => {
  it('subscribes on Redis once per channel and unsubscribes when the last socket leaves', () => {
    const offA = subscribe(ticketChannel('tkt_1'), () => {});
    const offB = subscribe(ticketChannel('tkt_1'), () => {});
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

    offA();
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    offB();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('support:ticket:tkt_1');
  });

  it('stops delivering to a listener that has gone', async () => {
    const heard: unknown[] = [];
    const off = subscribe(ticketChannel('tkt_1'), (event) => heard.push(event));
    off();
    await publish(ticketChannel('tkt_1'), { type: 'typing', who: 'agent', typing: false });
    expect(heard).toHaveLength(0);
  });
});
