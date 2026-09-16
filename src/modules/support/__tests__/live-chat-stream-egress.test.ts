import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Lot I — what leaves the ticket stream, and to whom.
 *
 * The wire format and the stream token are pinned in
 * `live-chat-stream.test.ts`; this pins the two rules the handler itself
 * carries, both of which are about who is on the other end of the socket:
 *
 *  - **A stranger opens nothing.** A bearer that is neither the requester
 *    nor an ADMIN is a 404 on the ticket — the same answer a ticket that
 *    does not exist gives, so the stream cannot be used to learn that one
 *    exists.
 *  - **An internal note never reaches the requester.** Every message is
 *    published to one channel and filtered on the way out, per viewer, in
 *    the catch-up replay *and* live. `support-sla.test.ts` pins the same
 *    rule on the REST read; this is the socket, which is the copy that
 *    would leak silently.
 */

const { repository, bus, service, presence, audit } = vi.hoisted(() => ({
  repository: { findSummaryById: vi.fn(), findMessagesAfter: vi.fn() },
  bus: {
    INBOX_CHANNEL: 'support:inbox',
    ticketChannel: (id: string) => `support:ticket:${id}`,
    subscribe: vi.fn(),
  },
  service: {
    convertLiveChat: vi.fn(),
    createCannedReply: vi.fn(),
    deleteCannedReply: vi.fn(),
    liveChatStatus: vi.fn(),
    liveInbox: vi.fn(),
    listCannedReplies: vi.fn(),
    markThreadSeen: vi.fn(),
    operatorPresence: vi.fn(),
    publishTyping: vi.fn(),
    reassignLiveChat: vi.fn(),
    startLiveChat: vi.fn(),
    updateCannedReply: vi.fn(),
  },
  presence: { heartbeatOperator: vi.fn(), setOperatorPresence: vi.fn() },
  audit: { auditDiff: vi.fn(() => ({})), logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-support.repository', () => ({ prismaSupportRepository: repository }));
vi.mock('../live-chat.bus', () => bus);
vi.mock('../live-chat.service', () => service);
vi.mock('../live-chat.presence', () => presence);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../../shared/cache', () => ({ redis: { set: vi.fn(), multi: vi.fn() } }));
vi.mock('../live-chat.messaging', () => ({
  messageEvent: (message: Record<string, unknown>) => ({
    type: 'message',
    id: message['id'],
    authorId: message['authorId'],
    internal: message['internal'],
    message: message['message'],
    createdAt: (message['createdAt'] as Date).toISOString(),
  }),
}));

import { ticketEventsHandler } from '../live-chat.controller';

const AT = new Date('2026-09-14T06:30:00Z');

/** A response that records every frame written, and a request that can be closed. */
function socket(user: { sub: string; roles: string[] }, headers: Record<string, string> = {}) {
  const frames: string[] = [];
  const req = Object.assign(new EventEmitter(), {
    headers,
    params: { ticketId: 'tkt_1' },
    query: {},
    user,
  }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      frames.push(chunk);
      return true;
    }),
    end: vi.fn(),
  }) as unknown as Response;
  return { req, res, frames, sent: () => frames.join('') };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  authorId: 'usr_admin',
  authorName: 'ADX Support',
  kind: 'TEXT',
  message: 'ops only: refund already queued',
  internal: true,
  attachmentFileId: null,
  attachmentName: null,
  createdAt: AT,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findSummaryById.mockResolvedValue({ id: 'tkt_1', userId: 'usr_pub', status: 'OPEN', channel: 'LIVE_CHAT' });
  repository.findMessagesAfter.mockResolvedValue([]);
  bus.subscribe.mockReturnValue(() => undefined);
});

describe('who may hold a ticket stream open', () => {
  it('is 404 for a bearer that is neither the requester nor ADX — the same answer as a ticket that does not exist', async () => {
    const { req, res } = socket({ sub: 'usr_stranger', roles: ['PUBLISHER'] }, { authorization: 'Bearer x' });
    await expect(ticketEventsHandler(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(bus.subscribe).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it('is 404 when the ticket is gone, before anything is written', async () => {
    repository.findSummaryById.mockResolvedValue(null);
    const { req, res } = socket({ sub: 'usr_pub', roles: ['PUBLISHER'] });
    await expect(ticketEventsHandler(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(bus.subscribe).not.toHaveBeenCalled();
  });
});

describe('an internal note on the socket', () => {
  it('is dropped from the requester’s catch-up and from their live feed', async () => {
    repository.findMessagesAfter.mockResolvedValue([
      message({ id: 'm_note' }),
      message({ id: 'm_reply', internal: false, message: 'Your payout is on its way' }),
    ]);
    const { req, res, sent } = socket({ sub: 'usr_pub', roles: ['PUBLISHER'] }, { 'last-event-id': String(AT.getTime() - 1000) });
    await ticketEventsHandler(req, res);

    expect(sent()).not.toContain('m_note');
    expect(sent()).toContain('m_reply');

    const push = bus.subscribe.mock.calls[0]![1] as (event: unknown) => void;
    push({ type: 'message', authorId: 'usr_admin', internal: true, id: 'm_live_note', createdAt: AT.toISOString() });
    push({ type: 'message', authorId: 'usr_admin', internal: false, id: 'm_live_reply', createdAt: AT.toISOString() });
    expect(sent()).not.toContain('m_live_note');
    expect(sent()).toContain('m_live_reply');
  });

  it('reaches the desk, which is who it was written for', async () => {
    repository.findMessagesAfter.mockResolvedValue([message({ id: 'm_note' })]);
    const { req, res, sent } = socket({ sub: 'usr_sam', roles: ['ADMIN'] }, { 'last-event-id': String(AT.getTime() - 1000) });
    await ticketEventsHandler(req, res);

    expect(sent()).toContain('m_note');
    const push = bus.subscribe.mock.calls[0]![1] as (event: unknown) => void;
    push({ type: 'message', authorId: 'usr_sam', internal: true, id: 'm_live_note', createdAt: AT.toISOString() });
    expect(sent()).toContain('m_live_note');
    // The desk's own line comes back marked as theirs, so the console can side it.
    expect(sent()).toContain('"mine":true');
  });
});
