import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: `GET /support/tickets/queue` answers `teams[]` — the distinct
 * teams across the whole queue, not the page, so the desk's team filter
 * lists every team a ticket has ever been put on whichever page is open.
 */

const { repository, users } = vi.hoisted(() => ({
  repository: { findManyForOps: vi.fn(), distinctTeams: vi.fn(), findSummaryById: vi.fn(), countOpenForUser: vi.fn() },
  users: { getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn(), userExists: vi.fn(), findUserSummaries: vi.fn(async () => new Map()) },
}));

vi.mock('../prisma-support.repository', () => ({ prismaSupportRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../agents', () => ({ agentExists: vi.fn() }));
vi.mock('../live-chat.entitlement', () => ({ liveChatEntitlement: vi.fn(async () => null), planOnDesk: () => null }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ support: { sla: {} } })) }));

import { getOpsTickets } from '../support.service';

const now = new Date('2026-09-12T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  repository.findManyForOps.mockResolvedValue({
    items: [{ id: 'tkt_1', userId: 'usr_1', status: 'OPEN', team: 'Finance', createdAt: now, slaFirstResponseDueAt: null, slaResolutionDueAt: null, slaPausedAt: null, firstRespondedAt: null }],
    total: 40,
    page: 2,
    pageSize: 20,
    counts: { OPEN: 30, CLOSED: 10 },
  });
  repository.distinctTeams.mockResolvedValue(['Finance', 'Ops', 'Supply']);
});

describe('getOpsTickets — the teams facet', () => {
  it('lists the distinct teams across the whole queue beside the page', async () => {
    const page = await getOpsTickets({ page: 2, pageSize: 20, sort: 'OLDEST', team: 'Finance' }, now);
    expect(repository.distinctTeams).toHaveBeenCalledTimes(1);
    expect(page).toMatchObject({ total: 40, page: 2, pageSize: 20, teams: ['Finance', 'Ops', 'Supply'] });
    expect(page.items[0]).toMatchObject({ id: 'tkt_1', team: 'Finance' });
  });
});
