import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /agents/me — what the DR 01 dashboard header, app bar and counters are
 * drawn from.
 *
 * What is pinned: that the answer is computed from what attribution actually
 * records (accounts brought through onboarding), that the ladder position
 * follows from that count and is written back to the profile so the admin
 * console's tier column tells the same story, that the day the counters
 * describe is an Indian day and not the server's, and that the leads layer is
 * the real one now that a `Lead` model exists — grouped around the agent's
 * position when the app sends one, around their city when it does not, and
 * never allowed to take the dashboard down with it.
 */

const { repository, leads } = vi.hoisted(() => ({
  leads: { leadClusters: vi.fn() },
  repository: {
    findDashboardProfile: vi.fn(),
    countOnboarded: vi.fn(),
    countSales: vi.fn(),
    walletBalance: vi.fn(),
    countToday: vi.fn(),
  },
}));

vi.mock('../lead-layer.port', () => ({ leadLayer: () => ({ clusters: leads.leadClusters }) }));
// The hero's milestone is the board's business; the dashboard only carries it.
vi.mock('../milestones/agent-milestones.service', () => ({ activeMilestoneFor: vi.fn().mockResolvedValue(null) }));
// The rung is the tier service's business; the dashboard draws what it is handed.
vi.mock('../tier/tier.service', async () => {
  const { rungFor } = await import('../tier-ladder');
  return {
    syncTier: vi.fn(async (_profile: unknown, onboarded: number) => ({ position: rungFor(onboarded), event: null })),
  };
});
vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: repository }));

import { dayWindowIST, getAgentDashboard, sidesFrom } from '../dashboard.service';
import { syncTier } from '../tier/tier.service';
import { LADDER } from '../tier-ladder';

const profile = {
  id: 'agt_1',
  displayId: 'AGT-1009-2601',
  city: 'Bengaluru',
  state: 'Karnataka',
  tier: 'BRONZE',
  tierLevel: 'I',
  tierPinnedAt: null,
  name: 'Rahul Kumar',
  roles: ['AGENT_PUBLISHER'],
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findDashboardProfile.mockResolvedValue(profile);
  repository.countOnboarded.mockResolvedValue({ publishers: 3, advertisers: 0 });
  repository.walletBalance.mockResolvedValue({ balance: '45500.00', currency: 'INR' });
  repository.countToday.mockResolvedValue({ orders: 2, visits: 1 });
  repository.countSales.mockResolvedValue({ packagesSold: 0, campaignsLaunched: 0 });
  leads.leadClusters.mockResolvedValue([]);
});

describe('sidesFrom', () => {
  it('reads the sides off the roles, publisher first', () => {
    expect(sidesFrom(['AGENT_PUBLISHER'])).toEqual(['PUBLISHER']);
    expect(sidesFrom(['AGENT_ADVERTISER'])).toEqual(['ADVERTISER']);
    expect(sidesFrom(['ADMIN', 'AGENT_ADVERTISER', 'AGENT_PUBLISHER'])).toEqual(['PUBLISHER', 'ADVERTISER']);
    expect(sidesFrom(['ADMIN'])).toEqual([]);
  });
});

describe('dayWindowIST', () => {
  it('is the Indian day around the instant, whatever the host thinks', () => {
    // 20:00 UTC on the 10th is 01:30 IST on the 11th: the window is the 11th.
    const { start, end } = dayWindowIST(new Date('2026-09-10T20:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-09-10T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-09-11T18:30:00.000Z');
  });

  it('an instant just before IST midnight is still the earlier day', () => {
    const { start } = dayWindowIST(new Date('2026-09-10T18:29:59.000Z'));
    expect(start.toISOString()).toBe('2026-09-09T18:30:00.000Z');
  });
});

describe('getAgentDashboard', () => {
  it('refuses a user with no agent profile', async () => {
    repository.findDashboardProfile.mockResolvedValue(null);
    await expect(getAgentDashboard('usr_x')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Agent profile not found',
    });
  });

  it('draws the header from attribution, the wallet and the day', async () => {
    const now = new Date('2026-09-10T09:00:00.000Z');
    const view = await getAgentDashboard('usr_1', now);

    expect(repository.countToday).toHaveBeenCalledWith(
      'agt_1',
      new Date('2026-09-09T18:30:00.000Z'),
      new Date('2026-09-10T18:30:00.000Z'),
    );

    expect(view).toMatchObject({
      id: 'agt_1',
      displayId: 'AGT-1009-2601',
      name: 'Rahul Kumar',
      city: 'Bengaluru',
      sides: ['PUBLISHER'],
      tier: { name: 'BRONZE', level: 'I', label: 'Bronze I', next: { name: 'BRONZE', level: 'II', label: 'Bronze II' } },
      progress: {
        onboarded: { publishers: 3, advertisers: 0, total: 3 },
        stepDone: 3,
        stepTarget: LADDER[1]!.from - LADDER[0]!.from,
      },
      wallet: { balance: '45500.00', currency: 'INR' },
      today: { orders: 2, visits: 1 },
    });
  });

  it('the ladder climbs on both sides together', async () => {
    repository.findDashboardProfile.mockResolvedValue({ ...profile, roles: ['AGENT_PUBLISHER', 'AGENT_ADVERTISER'] });
    repository.countOnboarded.mockResolvedValue({ publishers: 7, advertisers: 4 });

    const view = await getAgentDashboard('usr_1');
    expect(view.sides).toEqual(['PUBLISHER', 'ADVERTISER']);
    expect(view.progress.onboarded.total).toBe(11);
    expect(view.tier).toMatchObject({ name: 'BRONZE', level: 'III' });
    expect(view.progress.stepDone).toBe(1);
  });

  it('hands the count to the tier service, which keeps the rung current', async () => {
    repository.countOnboarded.mockResolvedValue({ publishers: 25, advertisers: 0 });
    const view = await getAgentDashboard('usr_1');
    expect(view.tier.name).toBe('SILVER');
    expect(syncTier).toHaveBeenCalledWith(expect.objectContaining({ id: 'agt_1' }), 25, expect.any(Date));
  });

  /* ── the map layer ─────────────────────────────────────────────────
   *
   * This used to assert an empty list, and said so: "an honest empty list
   * until a lead model exists". DR 06 wave 2 built the model, so the
   * assertion is the other way round now — but the empty case still has to
   * be honest, and a failure to draw bubbles must not take the header, the
   * wallet and the day's counters down with it.
   */
  it('draws the bubbles the leads module reports', async () => {
    leads.leadClusters.mockResolvedValue([
      { latitude: 12.97, longitude: 77.6, count: 5, label: 'Koramangala' },
    ]);
    const view = await getAgentDashboard('usr_1');
    expect(view.leads).toEqual([
      { latitude: 12.97, longitude: 77.6, count: 5, label: 'Koramangala' },
    ]);
  });

  it('asks around the agent when the app has said where they are', async () => {
    leads.leadClusters.mockResolvedValue([]);
    await getAgentDashboard('usr_1', new Date(), { latitude: 12.9, longitude: 77.6, radiusKm: 10 });
    expect(leads.leadClusters).toHaveBeenCalledWith({
      point: { latitude: 12.9, longitude: 77.6, radiusKm: 10 },
    });
  });

  it('falls back to their city rather than showing nothing without a fix', async () => {
    leads.leadClusters.mockResolvedValue([]);
    await getAgentDashboard('usr_1');
    expect(leads.leadClusters).toHaveBeenCalledWith({ city: 'Bengaluru' });
  });

  it('still answers with the dashboard when the lead query fails', async () => {
    // The header, the wallet and the counters are what this screen is for.
    leads.leadClusters.mockRejectedValue(new Error('lead store is down'));
    const view = await getAgentDashboard('usr_1');
    expect(view.leads).toEqual([]);
    expect(view.tier.name).toBeDefined();
  });
});
