import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../../shared/cache';
import { logger } from '../../shared/logging';

/**
 * The live-chat event bus — Lot I.
 *
 * Every instance publishes and every instance subscribes, so a message
 * written on one node reaches a stream held open on another: Redis pub/sub,
 * one channel per ticket (`support:ticket:<id>`) and one for the desk's
 * inbox (`support:inbox`). Redis down, the bus still works within the
 * process — a local EventEmitter is always the delivery point — so a single
 * node keeps chatting through an outage.
 *
 * An event is emitted locally AND published to Redis, and Redis hands it
 * back to the same node; the `eid` on every event and a short memory of
 * the ones already delivered are what stop it arriving twice. That is the
 * price of not having to know whether Redis is up before deciding where to
 * send.
 *
 * The subscriber is a second connection (`redis.duplicate()`): an ioredis
 * client in subscriber mode can issue nothing else, and the shared client
 * is what everything else reads through.
 */

export const INBOX_CHANNEL = 'support:inbox';
export const ticketChannel = (ticketId: string): string => `support:ticket:${ticketId}`;

/** What the ticket stream sends. `mine` and the internal-note filter are the stream's, decided per viewer. */
export type TicketEvent =
  | {
      type: 'message';
      id: string;
      authorId: string;
      authorName: string;
      kind: 'TEXT' | 'ATTACHMENT' | 'SYSTEM';
      message: string;
      attachment: { fileId: string; name: string } | null;
      internal: boolean;
      createdAt: string;
    }
  | { type: 'typing'; who: 'requester' | 'agent'; typing: boolean }
  | { type: 'seen'; who: 'requester' | 'agent'; at: string }
  | { type: 'status'; status: string; channel: string }
  | { type: 'assigned'; name: string | null; adminUserId: string | null };

/** What the desk's inbox stream sends. */
export type InboxEvent =
  | { type: 'chat'; ticketId: string; displayId: string | null; requesterName: string | null; assignedAdminUserId: string | null; preview: string }
  | { type: 'message'; ticketId: string; displayId: string | null; assignedAdminUserId: string | null; authorName: string; preview: string }
  | { type: 'breach'; ticketId: string; displayId: string | null; assignedAdminUserId: string | null; waitedSec: number };

export type BusEvent = (TicketEvent | InboxEvent) & { eid?: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const SEEN_LIMIT = 2_000;
const seen = new Set<string>();
function remember(eid: string): boolean {
  if (seen.has(eid)) return false;
  seen.add(eid);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

function deliver(channel: string, event: BusEvent): void {
  if (event.eid && !remember(event.eid)) return;
  emitter.emit(channel, event);
}

let subscriber: Redis | null = null;
const subscribed = new Map<string, number>();

function getSubscriber(): Redis | null {
  if (subscriber) return subscriber;
  try {
    subscriber = redis.duplicate();
    subscriber.on('message', (channel: string, raw: string) => {
      try {
        deliver(channel, JSON.parse(raw) as BusEvent);
      } catch (err) {
        logger.warn('Live-chat event unreadable', { channel, reason: err instanceof Error ? err.message : String(err) });
      }
    });
    subscriber.on('error', (err: Error) => logger.warn('Live-chat subscriber error', { reason: err.message }));
    return subscriber;
  } catch (err) {
    logger.warn('Live-chat subscriber unavailable; local delivery only', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Emits locally and to every other instance. Never throws: a bus that cannot reach Redis is a bus of one node. */
export async function publish(channel: string, event: BusEvent): Promise<void> {
  const stamped: BusEvent = { ...event, eid: event.eid ?? randomUUID() };
  deliver(channel, stamped);
  try {
    await redis.publish(channel, JSON.stringify(stamped));
  } catch (err) {
    logger.warn('Live-chat event not fanned out; delivered locally only', { channel, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** Listens on a channel until the returned function is called. The Redis subscription is shared per channel, counted. */
export function subscribe(channel: string, handler: (event: BusEvent) => void): () => void {
  emitter.on(channel, handler);
  const count = (subscribed.get(channel) ?? 0) + 1;
  subscribed.set(channel, count);
  if (count === 1) {
    getSubscriber()
      ?.subscribe(channel)
      .catch((err: unknown) => logger.warn('Live-chat channel not subscribed on Redis', { channel, reason: err instanceof Error ? err.message : String(err) }));
  }
  return () => {
    emitter.off(channel, handler);
    const left = (subscribed.get(channel) ?? 1) - 1;
    if (left > 0) {
      subscribed.set(channel, left);
      return;
    }
    subscribed.delete(channel);
    subscriber?.unsubscribe(channel).catch(() => {});
  };
}

/** Tests only: forget the subscriber and the delivered-event memory. */
export function resetBusForTests(): void {
  emitter.removeAllListeners();
  subscribed.clear();
  seen.clear();
  subscriber = null;
}
