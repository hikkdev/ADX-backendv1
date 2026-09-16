import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot I — live chat, the door and the desk.
 *
 * What is pinned: a caller who is not entitled is 403 NOT_ENTITLED carrying
 * the upsell; inside hours with somebody online a chat is created with
 * channel LIVE_CHAT, put on the operator holding the fewest and announced
 * with a SYSTEM "joined" line; outside hours, or with nobody online, the
 * same message becomes a TICKET with the next opening named; a second start
 * continues the chat already running rather than opening a second one;
 * typing is throttled to one publish every two seconds and never written
 * down; seen stamps the side's mark; the minute sweep breaches once per chat
 * and converts an idle unowned chat to a ticket.
 */

const { repository, settings, users, notifications, presence, bus, entitlement, features, messaging, redis } = vi.hoisted(() => ({
  repository: {
    findOpenLiveChatForUser: vi.fn(),
    countOpenLiveChatsByAdmin: vi.fn(),
    countOpenLiveChats: vi.fn(),
    addReply: vi.fn(),
    patch: vi.fn(),
    findSummaryById: vi.fn(),
    findLiveChatsPastFirstResponse: vi.fn(),
    findIdleLiveChats: vi.fn(),
    findMessageByAttachment: vi.fn(),
    markSeen: vi.fn(),
    findLiveInbox: vi.fn(),
    listCanned: vi.fn(),
    findCanned: vi.fn(),
    createCanned: vi.fn(),
    updateCanned: vi.fn(),
    deleteCanned: vi.fn(),
  },
  settings: { getPlatformSettings: vi.fn() },
  users: { findUserLabels: vi.fn(), userExists: vi.fn(async () => true) },
  notifications: { notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })) },
  presence: { onlineOperatorIds: vi.fn() },
  bus: { publish: vi.fn(async () => undefined), ticketChannel: (id: string) => `support:ticket:${id}`, INBOX_CHANNEL: 'support:inbox' },
  entitlement: {
    liveChatEntitlement: vi.fn(),
    liveChatEntitlementsFor: vi.fn(),
    planOnDesk: (e: { plan: { name: string } | null; reason: string } | undefined) => (e?.plan ? { name: e.plan.name, reason: e.reason } : null),
  },
  features: { isFeatureEnabled: vi.fn(async () => true) },
  messaging: { publishMessage: vi.fn(async () => undefined), resolveAttachment: vi.fn() },
  redis: { redis: { set: vi.fn(async (): Promise<string | null> => 'OK') } },
}));

vi.mock('../prisma-support.repository', () => ({ prismaSupportRepository: repository }));
vi.mock('../../app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app-config')>()),
  ...settings,
}));
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../feature-flags', () => features);
vi.mock('../live-chat.presence', () => presence);
vi.mock('../live-chat.bus', () => bus);
vi.mock('../live-chat.entitlement', () => entitlement);
vi.mock('../live-chat.messaging', () => messaging);
vi.mock('../../../shared/cache', () => redis);
vi.mock('../support.service', () => ({ createTicket: vi.fn() }));

import {
  IDLE_CONVERT_MINUTES,
  convertLiveChat,
  createCannedReply,
  deleteCannedReply,
  liveChatStatus,
  liveInbox,
  markThreadSeen,
  operatorPresence,
  publishTyping,
  reassignLiveChat,
  startLiveChat,
  supportAttachmentViewer,
  sweepLiveChats,
  updateCannedReply,
} from '../live-chat.service';
import { createTicket } from '../support.service';
import { DEFAULT_PLATFORM_SETTINGS } from '../../app-config';

/** 12:00 IST on 14 Sep 2026 — inside the default 09:00–21:00 window. */
const NOON_IST = new Date('2026-09-14T06:30:00Z');
/** 02:00 IST — outside it. */
const NIGHT_IST = new Date('2026-09-13T20:30:00Z');

const subscriber = { sub: 'usr_pub', roles: ['PUBLISHER'] };
const entitled = {
  entitled: true,
  reason: 'PUBLISHER_SUBSCRIPTION',
  plan: { name: 'Plus subscription', tier: 'PLUS' },
  upsell: { title: 'x', href: '/publisher/subscription' },
};

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: 'tkt_1',
  userId: 'usr_pub',
  displayId: 'TKT-1409-2601',
  title: 'Payout stuck',
  status: 'OPEN',
  channel: 'LIVE_CHAT',
  assignedAdminUserId: null,
  firstResponseAt: null,
  lastMessageAt: NOON_IST,
  createdAt: NOON_IST,
  requesterSeenAt: null,
  agentSeenAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  settings.getPlatformSettings.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS);
  entitlement.liveChatEntitlement.mockResolvedValue(entitled);
  entitlement.liveChatEntitlementsFor.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, entitled])));
  presence.onlineOperatorIds.mockResolvedValue(['usr_priya', 'usr_sam']);
  repository.countOpenLiveChatsByAdmin.mockResolvedValue(new Map([['usr_priya', 3], ['usr_sam', 1]]));
  repository.countOpenLiveChats.mockResolvedValue(4);
  repository.findOpenLiveChatForUser.mockResolvedValue(null);
  repository.addReply.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'msg_1', createdAt: NOON_IST, ...data }));
  repository.patch.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...ticketRow(), id, ...patch }));
  repository.findSummaryById.mockResolvedValue(ticketRow());
  repository.findLiveChatsPastFirstResponse.mockResolvedValue([]);
  repository.findIdleLiveChats.mockResolvedValue([]);
  // A test that pins the throttle leaves this refusing; every other one wants the claim to succeed.
  redis.redis.set.mockResolvedValue('OK');
  users.findUserLabels.mockImplementation(async (ids: string[]) =>
    new Map(ids.map((id) => [id, { id, name: { usr_priya: 'Priya', usr_sam: 'Sam', usr_pub: 'Asha Rao' }[id] ?? null }])),
  );
  vi.mocked(createTicket).mockImplementation((async (data: Record<string, unknown>) => ticketRow(data)) as never);
});

describe('the status read', () => {
  it('carries the entitlement, whether anybody is on, and the wait the open chats imply', async () => {
    const status = await liveChatStatus(subscriber, NOON_IST);
    expect(status).toMatchObject({ entitled: true, reason: 'PUBLISHER_SUBSCRIPTION', online: true, withinHours: true, nextOpening: null });
    // Four chats over two operators is two each, at 120 s a chat.
    expect(status.expectedWaitSec).toBe(240);
  });

  it('is not online outside the hours, whoever is at the desk, and names the next opening', async () => {
    const status = await liveChatStatus(subscriber, NIGHT_IST);
    expect(status.online).toBe(false);
    expect(status.expectedWaitSec).toBeNull();
    expect(status.nextOpening?.toISOString()).toBe('2026-09-14T03:30:00.000Z');
    // I4-B: the same instant as the phone should print it, in the desk's zone.
    expect(status.nextOpeningLabel).toBe('9:00 am IST on Mon 14 Sep');
  });

  it('carries no opening label while the desk is open', async () => {
    const status = await liveChatStatus(subscriber, NOON_IST);
    expect(status).toMatchObject({ nextOpening: null, nextOpeningLabel: null });
  });

  it('answers FEATURE_OFF rather than 503 when the kill switch is down, so the phone can fall back', async () => {
    features.isFeatureEnabled.mockResolvedValueOnce(false);
    const status = await liveChatStatus(subscriber, NOON_IST);
    expect(status).toMatchObject({ entitled: false, reason: 'FEATURE_OFF', online: false });
    expect(entitlement.liveChatEntitlement).not.toHaveBeenCalled();
  });
});

describe('starting a chat', () => {
  it('refuses a caller who is not entitled with the upsell on the error', async () => {
    entitlement.liveChatEntitlement.mockResolvedValue({
      entitled: false,
      reason: 'NOT_SUBSCRIBED',
      plan: null,
      upsell: { title: 'Live chat comes with an ADX subscription', href: '/publisher/subscription' },
    });
    await expect(startLiveChat(subscriber, { message: 'help' }, NOON_IST)).rejects.toMatchObject({
      statusCode: 403,
      code: 'NOT_ENTITLED',
      details: { reason: 'NOT_SUBSCRIBED', upsell: { href: '/publisher/subscription' } },
    });
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('puts a new chat on the operator holding the fewest and says so on the thread', async () => {
    const result = await startLiveChat(subscriber, { message: 'My payout is stuck' }, NOON_IST);

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'LIVE_CHAT', assignedAdminUserId: 'usr_sam', userId: 'usr_pub' }),
      NOON_IST,
    );
    expect(result).toMatchObject({ channel: 'LIVE_CHAT', continued: false, assignedAdmin: { id: 'usr_sam', name: 'Sam' } });
    // The requester's message, then the platform's line under it.
    expect(repository.addReply.mock.calls.map((call) => (call[0] as Record<string, unknown>)['kind'])).toEqual(['TEXT', 'SYSTEM']);
    expect(repository.addReply.mock.calls[1]![0]).toMatchObject({ kind: 'SYSTEM', message: 'Sam joined' });
    // The desk's inbox hears about it and the operator is told.
    expect(bus.publish).toHaveBeenCalledWith('support:inbox', expect.objectContaining({ type: 'chat', assignedAdminUserId: 'usr_sam' }));
    expect(notifications.notify).toHaveBeenCalledWith('LIVE_CHAT_ASSIGNED', 'usr_sam', expect.anything(), expect.anything());
  });

  it('outside the hours opens a TICKET instead, with the next opening named on the thread and in the answer', async () => {
    const result = await startLiveChat(subscriber, { message: 'My payout is stuck' }, NIGHT_IST);
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ channel: 'TICKET' }), NIGHT_IST);
    expect(result).toMatchObject({ channel: 'TICKET', fallback: 'TICKET' });
    expect(result.nextOpening?.toISOString()).toBe('2026-09-14T03:30:00.000Z');
    // I4-B: the SYSTEM line is prose in the desk's zone, never an ISO instant.
    const line = (repository.addReply.mock.calls[1]![0] as { kind: string; message: string });
    expect(line).toMatchObject({ kind: 'SYSTEM', message: 'Live chat is closed. ADX opens again at 9:00 am IST on Mon 14 Sep and will reply on this ticket.' });
    expect(line.message).not.toContain('2026-09-14T03:30');
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('with nobody at the desk inside the hours opens a ticket too — the fallback is the ticket thread', async () => {
    presence.onlineOperatorIds.mockResolvedValue([]);
    const result = await startLiveChat(subscriber, { message: 'hello' }, NOON_IST);
    expect(result).toMatchObject({ channel: 'TICKET', fallback: 'TICKET' });
    expect(repository.addReply.mock.calls[1]![0]).toMatchObject({ message: expect.stringContaining('Nobody is on live chat') });
  });

  it('continues the chat the caller already has running rather than opening a second one', async () => {
    repository.findOpenLiveChatForUser.mockResolvedValue(ticketRow({ assignedAdminUserId: 'usr_priya' }));
    const result = await startLiveChat(subscriber, { message: 'still there?' }, NOON_IST);
    expect(createTicket).not.toHaveBeenCalled();
    expect(result).toMatchObject({ continued: true, channel: 'LIVE_CHAT', assignedAdmin: { id: 'usr_priya', name: 'Priya' } });
    expect(messaging.publishMessage).toHaveBeenCalledTimes(1);
  });

  it('checks an attachment before anything is written', async () => {
    messaging.resolveAttachment.mockRejectedValueOnce(Object.assign(new Error('too big'), { statusCode: 400 }));
    await expect(startLiveChat(subscriber, { message: '', attachmentFileId: 'file_1' }, NOON_IST)).rejects.toThrow('too big');
    expect(createTicket).not.toHaveBeenCalled();
  });
});

describe('presence', () => {
  it('lists who is on with what they hold, lightest first', async () => {
    expect(await operatorPresence(NOON_IST)).toEqual([
      { userId: 'usr_sam', name: 'Sam', openChats: 1 },
      { userId: 'usr_priya', name: 'Priya', openChats: 3 },
    ]);
  });
});

describe('typing and seen', () => {
  it('publishes typing at most once every two seconds per person, and never writes it down', async () => {
    const ticket = ticketRow() as never;
    expect(await publishTyping(ticket, subscriber, true)).toBe(true);
    expect(redis.redis.set).toHaveBeenCalledWith('support:typing:tkt_1:usr_pub', '1', 'EX', 2, 'NX');
    expect(bus.publish).toHaveBeenCalledWith('support:ticket:tkt_1', { type: 'typing', who: 'requester', typing: true });

    redis.redis.set.mockResolvedValueOnce(null);
    expect(await publishTyping(ticket, subscriber, true)).toBe(false);
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(repository.addReply).not.toHaveBeenCalled();
  });

  it('lets a stop always through — a stuck indicator is worse than a missed one', async () => {
    redis.redis.set.mockResolvedValue(null);
    expect(await publishTyping(ticketRow() as never, subscriber, false)).toBe(true);
    expect(bus.publish).toHaveBeenCalledWith('support:ticket:tkt_1', { type: 'typing', who: 'requester', typing: false });
  });

  it('stamps the right side and tells the other', async () => {
    repository.markSeen.mockResolvedValue(ticketRow({ requesterSeenAt: NOON_IST }));
    await markThreadSeen(ticketRow() as never, subscriber, NOON_IST);
    expect(repository.markSeen).toHaveBeenCalledWith('tkt_1', 'requester', 'usr_pub', NOON_IST);
    expect(bus.publish).toHaveBeenCalledWith('support:ticket:tkt_1', { type: 'seen', who: 'requester', at: NOON_IST.toISOString() });

    await markThreadSeen(ticketRow() as never, { sub: 'usr_sam', roles: ['ADMIN'] }, NOON_IST);
    expect(repository.markSeen).toHaveBeenLastCalledWith('tkt_1', 'agent', 'usr_sam', NOON_IST);
  });
});

describe('reassigning', () => {
  it('puts the chat on somebody else and says so on the thread', async () => {
    const { after } = await reassignLiveChat('tkt_1', 'usr_priya', { sub: 'usr_sam', roles: ['ADMIN'] }, NOON_IST);
    expect(repository.patch).toHaveBeenCalledWith('tkt_1', { assignedAdminUserId: 'usr_priya', assignedAdminAt: NOON_IST });
    expect(after.assignedAdminUserId).toBe('usr_priya');
    expect(repository.addReply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SYSTEM', message: 'Priya joined' }));
    expect(notifications.notify).toHaveBeenCalledWith('LIVE_CHAT_ASSIGNED', 'usr_priya', expect.anything(), expect.anything());
  });

  it('refuses a ticket that is not a live chat the way convert does, so an ordinary thread never grows a "joined" line', async () => {
    repository.findSummaryById.mockResolvedValue(ticketRow({ channel: 'TICKET' }));
    await expect(reassignLiveChat('tkt_1', 'usr_priya', { sub: 'usr_sam', roles: ['ADMIN'] }, NOON_IST)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'That ticket is not a live chat',
    });
    expect(repository.patch).not.toHaveBeenCalled();
    expect(repository.addReply).not.toHaveBeenCalled();
    expect(users.userExists).not.toHaveBeenCalled();
  });
});

describe('converting', () => {
  it('keeps the same row and the same thread, and tells the requester where it went', async () => {
    const { after } = await convertLiveChat('tkt_1', { sub: 'usr_sam', roles: ['ADMIN'] });
    expect(repository.patch).toHaveBeenCalledWith('tkt_1', { channel: 'TICKET' });
    expect(after.channel).toBe('TICKET');
    expect(repository.addReply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SYSTEM' }));
    expect(notifications.notify).toHaveBeenCalledWith('LIVE_CHAT_CONVERTED', 'usr_pub', expect.anything(), expect.anything());
  });

  it('refuses a ticket that was never a chat', async () => {
    repository.findSummaryById.mockResolvedValue(ticketRow({ channel: 'TICKET' }));
    await expect(convertLiveChat('tkt_1', { sub: 'usr_sam', roles: ['ADMIN'] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'That ticket is not a live chat',
    });
  });
});

describe('the minute sweep', () => {
  it('breaches a chat past the target once, telling the inbox and every operator on shift', async () => {
    const late = ticketRow({ createdAt: new Date(NOON_IST.getTime() - 5 * 60 * 1000) });
    repository.findLiveChatsPastFirstResponse.mockResolvedValue([late]);

    const first = await sweepLiveChats(NOON_IST);
    expect(first.breached).toEqual(['tkt_1']);
    expect(repository.findLiveChatsPastFirstResponse).toHaveBeenCalledWith(new Date(NOON_IST.getTime() - 120_000));
    expect(bus.publish).toHaveBeenCalledWith('support:inbox', expect.objectContaining({ type: 'breach', ticketId: 'tkt_1', waitedSec: 300 }));
    expect(notifications.notify).toHaveBeenCalledTimes(2);

    // The claim key is the once: a chat still waiting a minute later is not re-paged.
    redis.redis.set.mockResolvedValueOnce(null);
    vi.mocked(notifications.notify).mockClear();
    expect((await sweepLiveChats(NOON_IST)).breached).toEqual([]);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('converts a chat nobody picked up that has sat idle, and leaves an owned one alone', async () => {
    const idle = new Date(NOON_IST.getTime() - (IDLE_CONVERT_MINUTES + 1) * 60 * 1000);
    repository.findIdleLiveChats.mockResolvedValue([
      ticketRow({ id: 'tkt_idle', assignedAdminUserId: null, lastMessage: { authorId: 'usr_pub', createdAt: idle } }),
      ticketRow({ id: 'tkt_owned', assignedAdminUserId: 'usr_sam', lastMessage: { authorId: 'usr_pub', createdAt: idle } }),
    ]);
    repository.findSummaryById.mockResolvedValue(ticketRow({ id: 'tkt_idle' }));

    const summary = await sweepLiveChats(NOON_IST);
    expect(summary.converted).toEqual(['tkt_idle']);
    expect(repository.findIdleLiveChats).toHaveBeenCalledWith(new Date(NOON_IST.getTime() - IDLE_CONVERT_MINUTES * 60_000));
    expect(repository.patch).toHaveBeenCalledWith('tkt_idle', { channel: 'TICKET' });
  });

  it('leaves an unassigned chat alone once an agent has ever replied, whoever spoke last', async () => {
    // I4-B, the verifier's case: an agent answered, was reassigned away (or
    // dropped presence), and the requester replied after. The newest human
    // message is the requester's, but the chat is not "unanswered" —
    // firstResponseAt says an agent has been on it — so it is not swept.
    const idle = new Date(NOON_IST.getTime() - (IDLE_CONVERT_MINUTES + 1) * 60 * 1000);
    repository.findIdleLiveChats.mockResolvedValue([
      ticketRow({
        id: 'tkt_answered',
        assignedAdminUserId: null,
        firstResponseAt: new Date(idle.getTime() - 10 * 60 * 1000),
        lastMessage: { authorId: 'usr_pub', createdAt: idle },
      }),
      // Never answered, nobody on it: the one the rule is for.
      ticketRow({ id: 'tkt_unanswered', assignedAdminUserId: null, firstResponseAt: null, lastMessage: { authorId: 'usr_pub', createdAt: idle } }),
    ]);
    repository.findSummaryById.mockResolvedValue(ticketRow({ id: 'tkt_unanswered' }));

    const summary = await sweepLiveChats(NOON_IST);
    expect(summary.converted).toEqual(['tkt_unanswered']);
    expect(repository.patch).not.toHaveBeenCalledWith('tkt_answered', expect.anything());
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });
});

describe('the desk inbox', () => {
  const inboxRow = (over: Record<string, unknown> = {}) => ({
    ...ticketRow(),
    lastMessage: { id: 'msg_1', authorId: 'usr_pub', authorName: 'Asha Rao', kind: 'TEXT', message: 'still stuck?', createdAt: NOON_IST },
    unreadForAgent: 2,
    ...over,
  });

  it('prints who is waiting, since when, and whether the first response is late', async () => {
    repository.findLiveInbox.mockResolvedValue({
      items: [
        // Opened five minutes ago, never answered: late against the 120 s target.
        inboxRow({ id: 'tkt_late', createdAt: new Date(NOON_IST.getTime() - 5 * 60 * 1000), assignedAdminUserId: 'usr_sam' }),
        // Answered within the target: not late, and nothing is waiting on the desk.
        inboxRow({
          id: 'tkt_answered',
          createdAt: new Date(NOON_IST.getTime() - 10 * 60 * 1000),
          firstResponseAt: new Date(NOON_IST.getTime() - 10 * 60 * 1000 + 30_000),
          lastMessage: { id: 'msg_2', authorId: 'usr_sam', authorName: 'Sam', kind: 'TEXT', message: 'on it', createdAt: NOON_IST },
          unreadForAgent: 0,
        }),
      ],
      total: 2,
      page: 1,
      pageSize: 20,
      counts: { OPEN: 2 },
    });

    const page = await liveInbox({ page: 1, pageSize: 20, sort: 'WAITING' }, NOON_IST);
    expect(page.firstResponseTargetSec).toBe(120);
    expect(page.items[0]).toMatchObject({
      id: 'tkt_late',
      requester: { userId: 'usr_pub', name: 'Asha Rao' },
      plan: { name: 'Plus subscription', reason: 'PUBLISHER_SUBSCRIPTION' },
      assignedAdmin: { id: 'usr_sam', name: 'Sam' },
      firstResponseBreached: true,
      unread: 2,
    });
    // I4-B: the plan is resolved for the page in one batch, never once per row.
    expect(entitlement.liveChatEntitlementsFor).toHaveBeenCalledTimes(1);
    expect(entitlement.liveChatEntitlementsFor).toHaveBeenCalledWith(['usr_pub', 'usr_pub'], NOON_IST);
    expect(entitlement.liveChatEntitlement).not.toHaveBeenCalled();
    // The clock the row counts from is the requester's last unanswered message.
    expect(page.items[0]!.waitingSince).toEqual(NOON_IST);
    expect(page.items[1]).toMatchObject({ id: 'tkt_answered', firstResponseBreached: false, waitingSince: null, assignedAdmin: null });
  });

  it('prints a lapsed subscriber with no plan, and an excluded one with the plan they are on', async () => {
    repository.findLiveInbox.mockResolvedValue({
      items: [inboxRow({ id: 'tkt_lapsed', userId: 'usr_lapsed' }), inboxRow({ id: 'tkt_excluded', userId: 'usr_excluded' })],
      total: 2,
      page: 1,
      pageSize: 20,
      counts: { OPEN: 2 },
    });
    entitlement.liveChatEntitlementsFor.mockResolvedValue(
      new Map([
        ['usr_lapsed', { entitled: false, reason: 'NOT_SUBSCRIBED', plan: null, upsell: { title: 'x', href: '/publisher/subscription' } }],
        ['usr_excluded', { entitled: false, reason: 'PLAN_EXCLUDED', plan: { name: 'Starter', tier: 'STARTER' }, upsell: { title: 'x', href: '/advertiser/packages' } }],
      ]),
    );
    const page = await liveInbox({ page: 1, pageSize: 20, sort: 'WAITING' }, NOON_IST);
    expect(page.items[0]!.plan).toBeNull();
    expect(page.items[1]!.plan).toEqual({ name: 'Starter', reason: 'PLAN_EXCLUDED' });
  });
});

describe('the canned replies', () => {
  it('are stamped with who wrote them, and a missing one is 404 rather than a silent no-op', async () => {
    repository.createCanned.mockResolvedValue({ id: 'cr_1' });
    await createCannedReply({ title: 'Payout delay', body: 'We are on it.', team: 'FINANCE' }, { sub: 'usr_sam', roles: ['ADMIN'] });
    expect(repository.createCanned).toHaveBeenCalledWith({ title: 'Payout delay', body: 'We are on it.', team: 'FINANCE', createdById: 'usr_sam' });

    repository.findCanned.mockResolvedValue(null);
    await expect(updateCannedReply('cr_missing', { isActive: false })).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteCannedReply('cr_missing')).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.updateCanned).not.toHaveBeenCalled();
    expect(repository.deleteCanned).not.toHaveBeenCalled();
  });
});

describe('the uploads door', () => {
  it('opens a support attachment to the requester of the thread it sits on, and to nobody else', async () => {
    repository.findMessageByAttachment.mockResolvedValue({ ticketId: 'tkt_1', ticketUserId: 'usr_pub' });
    expect(await supportAttachmentViewer('usr_pub', 'file_1')).toBe(true);
    expect(await supportAttachmentViewer('usr_stranger', 'file_1')).toBe(false);

    repository.findMessageByAttachment.mockResolvedValue(null);
    expect(await supportAttachmentViewer('usr_pub', 'file_orphan')).toBe(false);
  });

  it('asks for the viewer’s own thread, so one file the desk attached to two tickets opens for both', async () => {
    // The desk reuses a screenshot. The lookup is filtered by the asking
    // viewer rather than taking whichever message the table returns first,
    // or the second requester would be refused a file sent to them.
    repository.findMessageByAttachment.mockImplementation(async (fileId: string, ticketUserId?: string) =>
      ticketUserId === 'usr_b' ? { ticketId: 'tkt_2', ticketUserId: 'usr_b' } : { ticketId: 'tkt_1', ticketUserId: 'usr_a' },
    );
    expect(await supportAttachmentViewer('usr_b', 'file_shared')).toBe(true);
    expect(repository.findMessageByAttachment).toHaveBeenLastCalledWith('file_shared', 'usr_b');
    expect(await supportAttachmentViewer('usr_a', 'file_shared')).toBe(true);
  });
});
