import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 07, wave 2 — support for three personas, operated from the desk.
 *
 * What is pinned: a ticket is raised with a number off the identifiers
 * counter (TKT- for an issue, FB- for feedback) and every admin is told; the
 * categories are a pinned set with the old lower-case plurals folded in; the
 * raiser and ADX can read and answer a thread and nobody else can; ADX's
 * replies are signed "ADX Support" and the raiser hears about them.
 */

const { repository, identifiers, users, notifications, agents } = vi.hoisted(() => ({
  repository: {
    findManyForUser: vi.fn(),
    findById: vi.fn(),
    findSummaryById: vi.fn(),
    create: vi.fn(),
    addReply: vi.fn(),
    setStatus: vi.fn(),
    findManyForOps: vi.fn(),
    assign: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  users: { getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn(), findUserLabels: vi.fn(async () => new Map()) },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  agents: { agentExists: vi.fn() },
}));

vi.mock('../prisma-support.repository', () => ({ prismaSupportRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../agents', () => agents);
// Lot I: every message is published to the thread's stream and every
// attachment is checked; neither is what this file pins.
vi.mock('../live-chat.messaging', () => ({
  publishMessage: vi.fn(async () => undefined),
  resolveAttachment: vi.fn(),
  notifyRequesterOfReply: vi.fn(async () => undefined),
  notifyOperatorOfRequesterMessage: vi.fn(async () => undefined),
}));
vi.mock('../live-chat.bus', () => ({ publish: vi.fn(async () => undefined), ticketChannel: (id: string) => `support:ticket:${id}` }));
// I4-B: a live chat's read carries the requester's plan; the resolver itself is pinned in live-chat-entitlement.test.ts.
vi.mock('../live-chat.entitlement', () => ({
  liveChatEntitlement: vi.fn(async () => ({ entitled: true, reason: 'ADVERTISER_PACKAGE', plan: { name: 'Growth', tier: 'GROWTH' }, upsell: { title: '', href: '' } })),
  planOnDesk: (e: { plan: { name: string } | null; reason: string } | undefined) => (e?.plan ? { name: e.plan.name, reason: e.reason } : null),
}));

import { addReply, createTicket, getVisibleTicket, setTicketStatus, SUPPORT_AUTHOR } from '../support.service';
import { liveChatEntitlement } from '../live-chat.entitlement';
import { notifyOperatorOfRequesterMessage, notifyRequesterOfReply } from '../live-chat.messaging';
import { createTicketSchema, firstLine, normaliseCategory } from '../support.schema';

const owner = { sub: 'usr_owner', roles: ['AGENT_PUBLISHER'] };
const admin = { sub: 'usr_admin', roles: ['ADMIN'] };
const stranger = { sub: 'usr_other', roles: ['PUBLISHER'] };
const ticket = { id: 'tkt_1', userId: 'usr_owner', displayId: 'TKT-1109-2601', title: 'Payout stuck', status: 'OPEN' };

beforeEach(() => {
  vi.clearAllMocks();
  identifiers.allocateIdentifier.mockImplementation(async (kind: string) => (kind === 'FEEDBACK' ? 'FB-1109-2601' : 'TKT-1109-2601'));
  users.listAdminUserIds.mockResolvedValue(['usr_admin', 'usr_admin2']);
  users.getUserDisplayName.mockResolvedValue('Rahul Kumar');
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'tkt_new', ...data }));
  repository.findById.mockResolvedValue({ ...ticket, messages: [] });
  repository.findSummaryById.mockResolvedValue(ticket);
  repository.addReply.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'msg_1', ...data }));
  repository.setStatus.mockImplementation(async (id: string, status: string) => ({ ...ticket, id, status }));
});

describe('raising a ticket', () => {
  it('mints TKT- for an issue off the identifiers counter and tells every admin', async () => {
    const created = await createTicket({ userId: 'usr_owner', kind: 'ISSUE', title: 'App bug', description: 'It crashed', category: 'APP_BUG', attachmentUrls: [] });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('TICKET');
    expect(created).toMatchObject({ displayId: 'TKT-1109-2601', kind: 'ISSUE' });
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', type: 'SYSTEM', title: 'New support ticket', subtitle: 'TKT-1109-2601' }));
  });

  it('mints FB- for feedback', async () => {
    const created = await createTicket({ userId: 'usr_owner', kind: 'FEEDBACK', title: 'Dark mode', description: 'Dark mode please', category: 'IDEA', attachmentUrls: ['https://cdn.adx.in/u/1.png'] });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('FEEDBACK');
    expect(created).toMatchObject({ displayId: 'FB-1109-2601', kind: 'FEEDBACK', attachmentUrls: ['https://cdn.adx.in/u/1.png'] });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'New feedback' }));
  });
});

describe('the pinned categories', () => {
  it('folds the old lower-case plurals into the set and refuses what it does not know', () => {
    expect(normaliseCategory('listings', 'ISSUE')).toBe('LISTING');
    expect(normaliseCategory('Order issue', 'ISSUE')).toBe('ORDER');
    expect(normaliseCategory('payouts', 'ISSUE')).toBe('PAYMENT');
    expect(normaliseCategory(undefined, 'ISSUE')).toBe('OTHER');
    expect(normaliseCategory('weather', 'ISSUE')).toBeNull();
    expect(normaliseCategory('content issue', 'FEEDBACK')).toBe('CONTENT');
    expect(normaliseCategory(undefined, 'FEEDBACK')).toBe('IDEA');
    expect(normaliseCategory('ORDER', 'FEEDBACK')).toBeNull();
  });

  it('the create schema normalises the category and titles untitled feedback from its first line', () => {
    const legacy = createTicketSchema.safeParse({ title: 'Let an agent in', description: 'Please', category: 'listings' });
    expect(legacy.success).toBe(true);
    expect(legacy.success && legacy.data).toMatchObject({ kind: 'ISSUE', category: 'LISTING', attachmentUrls: [] });

    const feedback = createTicketSchema.safeParse({ kind: 'feedback', description: 'Dark mode would help at night.\nMy eyes.', category: 'idea' });
    expect(feedback.success && feedback.data).toMatchObject({ kind: 'FEEDBACK', category: 'IDEA', title: 'Dark mode would help at night.' });

    const bad = createTicketSchema.safeParse({ description: 'x', category: 'weather' });
    expect(bad.success).toBe(false);
    const tooMany = createTicketSchema.safeParse({ description: 'x', attachmentUrls: Array(6).fill('https://cdn.adx.in/a.png') });
    expect(tooMany.success).toBe(false);
  });

  it('takes the first sentence as a title and trims a long one', () => {
    expect(firstLine('Dark mode. It hurts my eyes.')).toBe('Dark mode.');
    expect(firstLine('\n\n  Second line first\nthird')).toBe('Second line first');
    expect(firstLine('a'.repeat(100)).length).toBe(80);
  });
});

describe('who may read a thread', () => {
  it('is the raiser, and ADX, and nobody else', async () => {
    expect(await getVisibleTicket('tkt_1', owner)).toMatchObject({ id: 'tkt_1' });
    expect(await getVisibleTicket('tkt_1', admin)).toMatchObject({ id: 'tkt_1' });
    expect(await getVisibleTicket('tkt_1', stranger)).toBeNull();
    repository.findById.mockResolvedValueOnce(null);
    expect(await getVisibleTicket('tkt_9', admin)).toBeNull();
  });

  it('a live chat carries the plan the requester holds; an ordinary ticket carries null and asks nothing (I4-B)', async () => {
    repository.findById.mockResolvedValue({ ...ticket, channel: 'LIVE_CHAT', messages: [] });
    expect(await getVisibleTicket('tkt_1', admin)).toMatchObject({ plan: { name: 'Growth', reason: 'ADVERTISER_PACKAGE' } });
    expect(liveChatEntitlement).toHaveBeenCalledWith('usr_owner', expect.any(Date));

    vi.mocked(liveChatEntitlement).mockClear();
    repository.findById.mockResolvedValue({ ...ticket, channel: 'TICKET', messages: [] });
    expect(await getVisibleTicket('tkt_1', owner)).toMatchObject({ plan: null });
    expect(liveChatEntitlement).not.toHaveBeenCalled();
  });
});

describe('replying', () => {
  it('the raiser replies under their own name, and the raiser is not told about their own message', async () => {
    const reply = await addReply('tkt_1', owner, 'Still stuck');
    expect(reply).toMatchObject({ authorId: 'usr_owner', authorName: 'Rahul Kumar', message: 'Still stuck' });
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(notifyRequesterOfReply).not.toHaveBeenCalled();
    // Lot I: on a chat somebody owns, their operator hears it.
    expect(notifyOperatorOfRequesterMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'tkt_1' }), expect.objectContaining({ message: 'Still stuck' }));
  });

  it('ADX replies as ADX Support and the raiser is told', async () => {
    const reply = await addReply('tkt_1', admin, 'We traced the delay to our bank partner.');
    expect(reply).toMatchObject({ authorId: 'usr_admin', authorName: SUPPORT_AUTHOR });
    expect(notifyRequesterOfReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tkt_1', userId: 'usr_owner', displayId: 'TKT-1109-2601' }),
      expect.objectContaining({ message: 'We traced the delay to our bank partner.' }),
    );
  });

  it('a stranger is refused with 403, and a missing ticket is 404', async () => {
    await expect(addReply('tkt_1', stranger, 'hi')).rejects.toMatchObject({ statusCode: 403 });
    repository.findSummaryById.mockResolvedValueOnce(null);
    await expect(addReply('tkt_9', admin, 'hi')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('closing', () => {
  it('ADX closing a ticket tells the raiser; the raiser closing their own tells nobody', async () => {
    await setTicketStatus('tkt_1', 'CLOSED', admin);
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner', title: 'Ticket closed' }));
    vi.clearAllMocks();
    repository.setStatus.mockResolvedValue({ ...ticket, status: 'CLOSED' });
    await setTicketStatus('tkt_1', 'CLOSED', owner);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
