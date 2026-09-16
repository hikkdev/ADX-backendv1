import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: `GET /agents/:id` carries `user: { closedAt, closeReason } | null`
 * the way the publisher and advertiser reads do (Lot A, Q21), so the
 * console's banner can say the account is closed without a second call.
 * The rest of the user slice — id, name, mobile, email, isActive — is
 * untouched; a profile with no account behind it answers null.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findById: vi.fn(), countOnboarded: vi.fn(), countSales: vi.fn() },
}));

vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m }));

import { getAgentDetail } from '../agents.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.countOnboarded.mockResolvedValue({ publishers: 0, advertisers: 0 });
  repository.countSales.mockResolvedValue({ packagesSold: 0, campaignsLaunched: 0 });
});

describe('GET /agents/:id — the account behind the profile', () => {
  it('carries the closure columns on the user slice, beside the counters', async () => {
    repository.findById.mockResolvedValue({
      id: 'agt_1',
      tier: 'SILVER',
      user: {
        id: 'usr_1',
        name: 'Rahul Kumar',
        mobile: '+919845012210',
        email: null,
        isActive: false,
        closedAt: new Date('2026-09-01T00:00:00Z'),
        closeReason: 'Left the business',
      },
    });
    const view = await getAgentDetail('agt_1');
    expect(view.user).toEqual({
      id: 'usr_1',
      name: 'Rahul Kumar',
      mobile: '+919845012210',
      email: null,
      isActive: false,
      closedAt: new Date('2026-09-01T00:00:00Z'),
      closeReason: 'Left the business',
    });
    expect(view.counters).toEqual({ publishersOnboarded: 0, advertisersOnboarded: 0, packagesSold: 0, campaignsLaunched: 0 });
  });

  it('answers user: null for a profile with no account behind it', async () => {
    repository.findById.mockResolvedValue({ id: 'agt_2', tier: 'BRONZE', user: null });
    const view = await getAgentDetail('agt_2');
    expect(view.user).toBeNull();
  });
});
