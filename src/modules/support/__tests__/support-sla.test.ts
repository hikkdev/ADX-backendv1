import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q53/Q91) — the support SLA.
 *
 * What is pinned: a ticket's two clocks are set from the platform settings at
 * creation and reset when the priority moves; the priority defaults from the
 * category (payment high, account normal, feedback low); WAITING pauses both
 * clocks and the requester's next message restarts them with the pause
 * banked; the first ADX reply stamps `firstRespondedAt` and an internal note
 * does not; breach is derived on read, never stored; an internal note never
 * reaches the requester.
 */

const { repository, identifiers, users, notifications, agents, settings } = vi.hoisted(() => ({
  repository: {
    findManyForUser: vi.fn(),
    findById: vi.fn(),
    findSummaryById: vi.fn(),
    create: vi.fn(),
    addReply: vi.fn(),
    setStatus: vi.fn(),
    patch: vi.fn(),
    countOpenForUser: vi.fn(),
    findManyForOps: vi.fn(),
    assign: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  users: { getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn(), userExists: vi.fn(), findUserLabels: vi.fn(async () => new Map()) },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  agents: { agentExists: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-support.repository', () => ({ prismaSupportRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../agents', () => agents);
vi.mock('../live-chat.messaging', () => ({
  publishMessage: vi.fn(async () => undefined),
  resolveAttachment: vi.fn(),
  notifyRequesterOfReply: vi.fn(async () => undefined),
  notifyOperatorOfRequesterMessage: vi.fn(async () => undefined),
}));
vi.mock('../live-chat.bus', () => ({ publish: vi.fn(async () => undefined), ticketChannel: (id: string) => `support:ticket:${id}` }));
vi.mock('../live-chat.entitlement', () => ({ liveChatEntitlement: vi.fn(async () => null), planOnDesk: () => null }));
vi.mock('../../app-config', async (importOriginal) => ({
  DEFAULT_PLATFORM_SETTINGS: (await importOriginal<typeof import('../../app-config')>()).DEFAULT_PLATFORM_SETTINGS,
  ...settings,
}));

import { addReply, createTicket, getVisibleTicket, patchTicket, slaView } from '../support.service';
import { notifyRequesterOfReply } from '../live-chat.messaging';
import { defaultPriorityFor, slaDueAts } from '../support.sla';
import { DEFAULT_PLATFORM_SETTINGS } from '../../app-config';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-09-12T09:00:00.000Z');
const owner = { sub: 'usr_owner', roles: ['PUBLISHER'] };
const admin = { sub: 'usr_admin', roles: ['ADMIN'] };

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'tkt_1',
  userId: 'usr_owner',
  displayId: 'TKT-1209-2601',
  title: 'Payout stuck',
  category: 'PAYMENT',
  kind: 'ISSUE',
  status: 'OPEN',
  priority: 'HIGH',
  createdAt: now,
  slaFirstResponseDueAt: new Date(now.getTime() + 4 * HOUR),
  slaResolutionDueAt: new Date(now.getTime() + 24 * HOUR),
  firstRespondedAt: null,
  firstResponseAt: null,
  channel: 'TICKET',
  slaPausedAt: null,
  slaPausedMs: 0,
  assignedAdminUserId: null,
  team: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  settings.getPlatformSettings.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS);
  identifiers.allocateIdentifier.mockResolvedValue('TKT-1209-2601');
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
  users.getUserDisplayName.mockResolvedValue('Rahul');
  users.userExists.mockResolvedValue(true);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'tkt_1', createdAt: now, ...data }));
  repository.addReply.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'msg_1', createdAt: now, ...data }));
  repository.patch.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...ticket(), id, ...patch }));
  repository.findSummaryById.mockResolvedValue(ticket());
  repository.findById.mockResolvedValue({ ...ticket(), messages: [] });
});

describe('the clocks', () => {
  it('priority defaults from the category, and feedback is low', () => {
    expect(defaultPriorityFor('PAYMENT', 'ISSUE')).toBe('HIGH');
    expect(defaultPriorityFor('SAFETY', 'ISSUE')).toBe('HIGH');
    expect(defaultPriorityFor('ACCOUNT', 'ISSUE')).toBe('NORMAL');
    expect(defaultPriorityFor('APP_BUG', 'ISSUE')).toBe('NORMAL');
    expect(defaultPriorityFor('IDEA', 'FEEDBACK')).toBe('LOW');
  });

  it('are set from the platform settings for the priority, from the creation time', () => {
    const due = slaDueAts(now, 'URGENT', DEFAULT_PLATFORM_SETTINGS.support.sla, 0);
    expect(due.slaFirstResponseDueAt.getTime()).toBe(now.getTime() + 1 * HOUR);
    expect(due.slaResolutionDueAt.getTime()).toBe(now.getTime() + 4 * HOUR);
    const paused = slaDueAts(now, 'LOW', DEFAULT_PLATFORM_SETTINGS.support.sla, 2 * HOUR);
    expect(paused.slaResolutionDueAt.getTime()).toBe(now.getTime() + 168 * HOUR + 2 * HOUR);
  });

  it('a new payment ticket is HIGH with a 4h / 24h clock', async () => {
    const created = await createTicket({ userId: 'usr_owner', kind: 'ISSUE', title: 'Payout stuck', description: 'x', category: 'PAYMENT', attachmentUrls: [] });
    expect(created).toMatchObject({ priority: 'HIGH' });
    expect(created.slaFirstResponseDueAt!.getTime()).toBe(now.getTime() + 4 * HOUR);
    expect(created.slaResolutionDueAt!.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('a priority change resets both clocks from the creation time, keeping any pause banked', async () => {
    repository.findSummaryById.mockResolvedValue(ticket({ slaPausedMs: HOUR }));
    await patchTicket('tkt_1', admin, { priority: 'URGENT' });
    const patch = repository.patch.mock.calls[0]![1] as Record<string, Date>;
    expect(patch['priority']).toBe('URGENT');
    expect(patch['slaFirstResponseDueAt']!.getTime()).toBe(now.getTime() + 1 * HOUR + HOUR);
    expect(patch['slaResolutionDueAt']!.getTime()).toBe(now.getTime() + 4 * HOUR + HOUR);
  });
});

describe('WAITING', () => {
  it('pauses the clock, and the requester’s next message restarts it with the pause banked', async () => {
    await patchTicket('tkt_1', admin, { status: 'WAITING' });
    expect(repository.patch).toHaveBeenCalledWith('tkt_1', expect.objectContaining({ status: 'WAITING', slaPausedAt: now }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner', title: 'ADX Support needs something from you' }));

    vi.clearAllMocks();
    vi.setSystemTime(new Date(now.getTime() + 3 * HOUR));
    repository.findSummaryById.mockResolvedValue(ticket({ status: 'WAITING', slaPausedAt: now }));
    await addReply('tkt_1', owner, 'Here is the screenshot');

    expect(repository.patch).toHaveBeenCalledWith('tkt_1', {
      status: 'OPEN',
      slaPausedAt: null,
      slaPausedMs: 3 * HOUR,
      slaFirstResponseDueAt: new Date(now.getTime() + 4 * HOUR + 3 * HOUR),
      slaResolutionDueAt: new Date(now.getTime() + 24 * HOUR + 3 * HOUR),
    });
  });

  it('an ADX reply on a WAITING ticket does not restart the clock', async () => {
    repository.findSummaryById.mockResolvedValue(ticket({ status: 'WAITING', slaPausedAt: now, firstRespondedAt: now }));
    await addReply('tkt_1', admin, 'Still waiting on you');
    // Lot I stamps the live first-response moment if it is still unset; the
    // clock itself — the status, the pause and the two due dates — does not move.
    for (const [, patch] of repository.patch.mock.calls as [string, Record<string, unknown>][]) {
      expect(Object.keys(patch)).toEqual(['firstResponseAt']);
    }
  });
});

describe('the first response', () => {
  it('is stamped by the first ADX reply, and not by an internal note', async () => {
    await addReply('tkt_1', admin, 'Looking into it', { internal: true });
    expect(repository.addReply).toHaveBeenCalledWith(expect.objectContaining({ internal: true }));
    expect(repository.patch).not.toHaveBeenCalled();
    expect(notifyRequesterOfReply).not.toHaveBeenCalled();

    await addReply('tkt_1', admin, 'We traced it');
    // Lot I: the same reply stamps the live first-response moment beside the SLA's.
    expect(repository.patch).toHaveBeenCalledWith('tkt_1', { firstRespondedAt: now, firstResponseAt: now });
    expect(notifyRequesterOfReply).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner' }), expect.anything());
  });

  it('the requester cannot write an internal note', async () => {
    await expect(addReply('tkt_1', owner, 'psst', { internal: true })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('breach, derived on read', () => {
  it('reports the first response and the resolution separately, and stops the clock while paused', () => {
    const fresh = slaView(ticket(), now);
    expect(fresh).toMatchObject({ firstResponseBreached: false, resolutionBreached: false, dueIn: 4 * HOUR });

    const late = slaView(ticket(), new Date(now.getTime() + 5 * HOUR));
    expect(late).toMatchObject({ firstResponseBreached: true, resolutionBreached: false, dueIn: -HOUR });

    const answered = slaView(ticket({ firstRespondedAt: now }), new Date(now.getTime() + 25 * HOUR));
    expect(answered).toMatchObject({ firstResponseBreached: false, resolutionBreached: true, dueIn: -HOUR });

    const paused = slaView(ticket({ status: 'WAITING', slaPausedAt: new Date(now.getTime() + 3 * HOUR) }), new Date(now.getTime() + 10 * HOUR));
    expect(paused).toMatchObject({ firstResponseBreached: false, resolutionBreached: false, paused: true, dueIn: 1 * HOUR });

    expect(slaView(ticket({ status: 'CLOSED' }), new Date(now.getTime() + 100 * HOUR))).toMatchObject({ firstResponseBreached: false, resolutionBreached: false, dueIn: null });
  });
});

describe('internal notes stay inside', () => {
  it('the owner’s read drops them; ADX sees the whole thread', async () => {
    repository.findById.mockResolvedValue({
      ...ticket(),
      messages: [
        { id: 'm1', internal: false, message: 'hello' },
        { id: 'm2', internal: true, message: 'ops only' },
      ],
    });
    const mine = await getVisibleTicket('tkt_1', owner);
    expect((mine!.messages as { id: string }[]).map((m) => m.id)).toEqual(['m1']);
    const theirs = await getVisibleTicket('tkt_1', admin);
    expect((theirs!.messages as { id: string }[]).map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(theirs!.sla).toMatchObject({ firstResponseBreached: false });
  });
});

describe('the ops patch', () => {
  it('assigns an admin owner and a team, telling the owner', async () => {
    await patchTicket('tkt_1', admin, { assignedAdminUserId: 'usr_admin2', team: 'payments' });
    expect(users.userExists).toHaveBeenCalledWith('usr_admin2');
    expect(repository.patch).toHaveBeenCalledWith('tkt_1', expect.objectContaining({ assignedAdminUserId: 'usr_admin2', assignedAdminAt: now, team: 'payments' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin2', title: 'Ticket assigned to you' }));
  });

  it('refuses an unknown admin', async () => {
    users.userExists.mockResolvedValue(false);
    await expect(patchTicket('tkt_1', admin, { assignedAdminUserId: 'usr_nobody' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
