import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-3: who raised the ticket — the requester on every queue row and the
 * rail beside a thread. The account comes from `users`, the party record and
 * the numbers through `RequesterPort`; unregistered, both reads still answer.
 */

const { repository, users, audit } = vi.hoisted(() => ({
  repository: {
    findManyForOps: vi.fn(),
    // E10-1: the queue also answers the teams facet.
    distinctTeams: vi.fn(async () => []),
    findSummaryById: vi.fn(),
    countOpenForUser: vi.fn(),
  },
  users: {
    getUserDisplayName: vi.fn(),
    listAdminUserIds: vi.fn(),
    userExists: vi.fn(),
    findUserSummaries: vi.fn(),
  },
  audit: { listActivity: vi.fn() },
}));

vi.mock('../prisma-support.repository', () => ({ prismaSupportRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../agents', () => ({ agentExists: vi.fn() }));
vi.mock('../live-chat.entitlement', () => ({ liveChatEntitlement: vi.fn(async () => null), planOnDesk: () => null }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ support: { sla: {} } })) }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  listActivity: audit.listActivity,
}));

import { getOpsTickets, getTicketRequester } from '../support.service';
import { registerRequesterPort, resetRequesterPort, type RequesterParty } from '../requester.port';

const now = new Date('2026-09-12T09:00:00.000Z');
const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'tkt_1',
  userId: 'usr_pub',
  displayId: 'TKT-1109-2601',
  status: 'OPEN',
  priority: 'NORMAL',
  createdAt: now,
  slaFirstResponseDueAt: null,
  slaResolutionDueAt: null,
  slaPausedAt: null,
  firstRespondedAt: null,
  ...over,
});

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Asha Rao',
  mobile: '+919845012210',
  email: null,
  isActive: true,
  createdAt: now,
  roles: ['PUBLISHER'],
  role: 'PUBLISHER',
  ...over,
});

const publisher: RequesterParty = { type: 'PUBLISHER', id: 'pub_1', displayId: 'PUB-1009-2601', name: 'Kumar Stores', kycStatus: 'VERIFIED' };
const agent: RequesterParty = { type: 'AGENT', id: 'agt_1', displayId: 'AGT-1009-2601', name: 'Asha Rao', kycStatus: null };

const port = {
  partiesForUsers: vi.fn(async () => new Map<string, RequesterParty[]>()),
  walletBalance: vi.fn(async () => null as string | null),
  openOrders: vi.fn(async () => 0),
};

beforeEach(() => {
  vi.clearAllMocks();
  users.findUserSummaries.mockResolvedValue(new Map([['usr_pub', summary('usr_pub')]]));
  port.partiesForUsers.mockResolvedValue(new Map([['usr_pub', [publisher]]]));
  port.walletBalance.mockResolvedValue('1250.50');
  port.openOrders.mockResolvedValue(2);
  repository.countOpenForUser.mockResolvedValue(3);
  audit.listActivity.mockResolvedValue([
    { action: 'LISTING_UPDATED', createdAt: now },
    { action: 'LOGIN', createdAt: new Date(now.getTime() - 3600_000) },
  ]);
  registerRequesterPort(port);
});

afterEach(() => resetRequesterPort());

describe('the queue rows', () => {
  it('carry the requester — name, role and displayId from the party record — in two round trips per page', async () => {
    repository.findManyForOps.mockResolvedValue({
      items: [ticket(), ticket({ id: 'tkt_2', userId: 'usr_pub' }), ticket({ id: 'tkt_3', userId: 'usr_ghost' })],
      total: 3,
      page: 1,
      pageSize: 20,
      counts: {},
    });

    const page = await getOpsTickets({ page: 1, pageSize: 20, sort: 'OLDEST' }, now);

    expect(users.findUserSummaries).toHaveBeenCalledTimes(1);
    expect(users.findUserSummaries).toHaveBeenCalledWith(['usr_pub', 'usr_ghost']);
    expect(port.partiesForUsers).toHaveBeenCalledWith(['usr_pub', 'usr_ghost']);
    expect(page.items[0]).toMatchObject({
      id: 'tkt_1',
      requester: { userId: 'usr_pub', name: 'Kumar Stores', role: 'PUBLISHER', displayId: 'PUB-1009-2601' },
    });
    expect(page.items[0]!.sla).toBeDefined();
    expect(page.items[2]!.requester).toEqual({ userId: 'usr_ghost', name: null, role: null, displayId: null });
  });

  it('fold an account with no party record to its role, and an agent login to AGENT', async () => {
    port.partiesForUsers.mockResolvedValue(new Map());
    users.findUserSummaries.mockResolvedValue(
      new Map([
        ['usr_adm', summary('usr_adm', { name: 'Ops', roles: ['ADMIN'], role: 'ADMIN' })],
        ['usr_agt', summary('usr_agt', { name: null, roles: ['AGENT_PUBLISHER'], role: 'AGENT_PUBLISHER' })],
      ]),
    );
    repository.findManyForOps.mockResolvedValue({
      items: [ticket({ userId: 'usr_adm' }), ticket({ id: 'tkt_2', userId: 'usr_agt' })],
      total: 2,
      page: 1,
      pageSize: 20,
      counts: {},
    });

    const page = await getOpsTickets({ page: 1, pageSize: 20, sort: 'OLDEST' }, now);

    expect(page.items[0]!.requester).toEqual({ userId: 'usr_adm', name: 'Ops', role: 'ADMIN', displayId: null });
    expect(page.items[1]!.requester).toEqual({ userId: 'usr_agt', name: '+919845012210', role: 'AGENT', displayId: null });
  });

  it('print the record the primary role names when a login holds two', async () => {
    port.partiesForUsers.mockResolvedValue(new Map([['usr_pub', [publisher, agent]]]));
    users.findUserSummaries.mockResolvedValue(new Map([['usr_pub', summary('usr_pub', { roles: ['AGENT_PUBLISHER', 'PUBLISHER'], role: 'AGENT_PUBLISHER' })]]));
    repository.findManyForOps.mockResolvedValue({ items: [ticket()], total: 1, page: 1, pageSize: 20, counts: {} });

    const page = await getOpsTickets({ page: 1, pageSize: 20, sort: 'OLDEST' }, now);

    expect(page.items[0]!.requester).toMatchObject({ role: 'AGENT', displayId: 'AGT-1009-2601' });
  });

  it('still list with no port registered', async () => {
    resetRequesterPort();
    repository.findManyForOps.mockResolvedValue({ items: [ticket()], total: 1, page: 1, pageSize: 20, counts: {} });
    const page = await getOpsTickets({ page: 1, pageSize: 20, sort: 'OLDEST' }, now);
    expect(page.items[0]!.requester).toEqual({ userId: 'usr_pub', name: 'Asha Rao', role: 'PUBLISHER', displayId: null });
  });
});

describe('the requester rail', () => {
  it('answers the account, the party with its KYC state, the wallet, the orders, the tickets and the trail', async () => {
    repository.findSummaryById.mockResolvedValue(ticket());

    const rail = await getTicketRequester('tkt_1');

    expect(rail).toMatchObject({
      user: { id: 'usr_pub', name: 'Asha Rao', role: 'PUBLISHER', roles: ['PUBLISHER'] },
      party: { type: 'PUBLISHER', id: 'pub_1', displayId: 'PUB-1009-2601', name: 'Kumar Stores', kycStatus: 'VERIFIED' },
      walletBalance: '1250.50',
      openOrders: 2,
      openTickets: 3,
    });
    expect(rail!.recentActivity).toEqual([
      { action: 'LISTING_UPDATED', at: now },
      { action: 'LOGIN', at: new Date(now.getTime() - 3600_000) },
    ]);
    expect(port.walletBalance).toHaveBeenCalledWith(publisher);
    expect(port.openOrders).toHaveBeenCalledWith('usr_pub', publisher);
    expect(repository.countOpenForUser).toHaveBeenCalledWith('usr_pub');
    expect(audit.listActivity).toHaveBeenCalledWith('usr_pub', 10);
  });

  it('is null for a ticket that does not exist, and answers the account alone without a port', async () => {
    repository.findSummaryById.mockResolvedValue(null);
    expect(await getTicketRequester('tkt_none')).toBeNull();

    resetRequesterPort();
    repository.findSummaryById.mockResolvedValue(ticket());
    const rail = await getTicketRequester('tkt_1');
    expect(rail).toMatchObject({ user: { id: 'usr_pub' }, party: null, walletBalance: null, openOrders: 0, openTickets: 3 });
  });
});
