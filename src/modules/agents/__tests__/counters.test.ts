import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot B, decision 100: onboardings, sales and launches are counters beside
 * the rating, never inside it.
 *
 * `GET /agents/me` and `GET /agents/:id` both print packagesSold and
 * campaignsLaunched next to the onboarded counts. The ladder still climbs on
 * onboardings alone — a counter the rating formula never reads is a counter
 * that cannot quietly become a rating input later.
 */

const { repository, leads } = vi.hoisted(() => ({
  leads: { leadClusters: vi.fn() },
  repository: {
    findById: vi.fn(),
    findDashboardProfile: vi.fn(),
    countOnboarded: vi.fn(),
    countSales: vi.fn(),
    walletBalance: vi.fn(),
    countToday: vi.fn(),
  },
}));

vi.mock('../lead-layer.port', () => ({ leadLayer: () => ({ clusters: leads.leadClusters }) }));
vi.mock('../milestones/agent-milestones.service', () => ({ activeMilestoneFor: vi.fn().mockResolvedValue(null) }));
vi.mock('../tier/tier.service', async () => {
  const { rungFor } = await import('../tier-ladder');
  return {
    syncTier: vi.fn(async (_profile: unknown, onboarded: number) => ({ position: rungFor(onboarded), event: null })),
  };
});
vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m }));

import { getAgentDashboard } from '../dashboard.service';
import { findAgentTier, getAgentDetail } from '../agents.service';
import { syncTier } from '../tier/tier.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findDashboardProfile.mockResolvedValue({
    id: 'agt_1',
    displayId: 'AGT-1009-2601',
    city: 'Bengaluru',
    state: 'Karnataka',
    tier: 'BRONZE',
    tierLevel: 'I',
    tierPinnedAt: null,
    name: 'Rahul Kumar',
    roles: ['AGENT_PUBLISHER', 'AGENT_ADVERTISER'],
    status: 'ACTIVE',
    suspensionScopes: [],
    suspensionReason: null,
    suspendedAt: null,
  });
  repository.findById.mockResolvedValue({ id: 'agt_1', tier: 'SILVER', user: { name: 'Rahul Kumar' } });
  repository.countOnboarded.mockResolvedValue({ publishers: 3, advertisers: 2 });
  repository.countSales.mockResolvedValue({ packagesSold: 4, campaignsLaunched: 1 });
  repository.walletBalance.mockResolvedValue({ balance: '0.00', currency: 'INR' });
  repository.countToday.mockResolvedValue({ orders: 0, visits: 0 });
  leads.leadClusters.mockResolvedValue([]);
});

describe('GET /agents/me', () => {
  it('prints the sales counters beside the onboarded counts', async () => {
    const view = await getAgentDashboard('usr_1', new Date('2026-09-12T09:00:00Z'));
    expect(view.progress).toMatchObject({
      onboarded: { publishers: 3, advertisers: 2, total: 5 },
      packagesSold: 4,
      campaignsLaunched: 1,
    });
    expect(repository.countSales).toHaveBeenCalledWith('agt_1');
  });

  it('climbs the ladder on onboardings only — a sale is not a rung (Q100)', async () => {
    await getAgentDashboard('usr_1', new Date('2026-09-12T09:00:00Z'));
    expect(syncTier).toHaveBeenCalledWith(expect.objectContaining({ id: 'agt_1' }), 5, expect.any(Date));
  });

  it('still answers when the counters cannot be read', async () => {
    repository.countSales.mockRejectedValue(new Error('down'));
    const view = await getAgentDashboard('usr_1', new Date('2026-09-12T09:00:00Z'));
    expect(view.progress).toMatchObject({ packagesSold: 0, campaignsLaunched: 0 });
  });
});

describe('GET /agents/:id', () => {
  it('carries the four counters with the profile', async () => {
    const detail = await getAgentDetail('agt_1');
    expect(detail).toMatchObject({
      id: 'agt_1',
      counters: { publishersOnboarded: 3, advertisersOnboarded: 2, packagesSold: 4, campaignsLaunched: 1 },
    });
  });

  it('is a 404 for an agent that does not exist', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(getAgentDetail('agt_x')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('findAgentTier', () => {
  it('is the tier on the profile, for the modules that record an incentive at it', async () => {
    expect(await findAgentTier('agt_1')).toBe('SILVER');
    repository.findById.mockResolvedValue(null);
    expect(await findAgentTier('agt_x')).toBeNull();
  });
});
