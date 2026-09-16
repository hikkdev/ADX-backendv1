import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot B (Q1): what came of a visit.
 *
 * A package sale or a campaign launched on a visit carries the visit's id, and
 * the visit reports the outcome by counting them — "1 sale, 1 campaign
 * launched" on the card and on the day view — rather than keeping a second
 * record of the work. The other half is the gate: `packages` and `campaigns`
 * ask `assertVisitOutcome` before accepting a visitId, and it says yes only
 * for the agent's own visit, in progress now or completed today.
 */

const { repository, agents, orders, milestones } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findInWindow: vi.fn(),
    countOutcomes: vi.fn(),
  },
  agents: {
    requireAgentProfile: vi.fn(),
    findAgentProfile: vi.fn(),
    getAgentWithUser: vi.fn(),
    assertAgentAcceptsWork: vi.fn(),
  },
  orders: { getAgentOrdersInWindow: vi.fn() },
  milestones: { getAgentMilestones: vi.fn() },
}));

// Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }),
}));
vi.mock('../prisma-visits.repository', () => ({ prismaVisitsRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../orders', () => orders);
vi.mock('../../order-milestones', () => milestones);
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../notifications', () => ({ notify: vi.fn(), createNotification: vi.fn() }));

import { assertVisitOutcome, getVisit, outcomeSummary } from '../visits.service';
import { getAgentDay } from '../day.service';

const NOW = new Date('2026-09-12T06:00:00.000Z'); // 11:30 IST on the 12th

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'vst_1',
  displayId: 'VST-0001',
  kind: 'ONBOARDING',
  status: 'IN_PROGRESS',
  agentId: 'agt_1',
  leadId: null,
  publisherId: null,
  advertiserId: 'adv_1',
  businessName: 'Nilgiri Coffee',
  locality: 'Indiranagar',
  city: 'Bengaluru',
  latitude: null,
  longitude: null,
  scheduledFor: new Date('2026-09-12T04:30:00.000Z'),
  offerExpiresAt: null,
  startedAt: new Date('2026-09-12T05:00:00.000Z'),
  completedAt: null,
  earnedAmount: null,
  notes: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(visit());
  repository.countOutcomes.mockResolvedValue({ sales: 1, campaigns: 1 });
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1' });
});

describe('outcomeSummary', () => {
  it('reads as the card prints it, and is null when nothing came of the visit', () => {
    expect(outcomeSummary({ sales: 1, campaigns: 1 })).toBe('1 sale, 1 campaign launched');
    expect(outcomeSummary({ sales: 2, campaigns: 0 })).toBe('2 sales');
    expect(outcomeSummary({ sales: 0, campaigns: 3 })).toBe('3 campaigns launched');
    expect(outcomeSummary({ sales: 0, campaigns: 0 })).toBeNull();
  });
});

describe('GET /visits/:id', () => {
  it('counts what was sold and launched on the visit', async () => {
    const card = await getVisit('vst_1', 'usr_1', false);
    expect(repository.countOutcomes).toHaveBeenCalledWith('vst_1');
    expect(card.outcomes).toEqual({ sales: 1, campaigns: 1, summary: '1 sale, 1 campaign launched' });
  });
});

describe('the day view', () => {
  it('prints the outcome beside each field visit', async () => {
    orders.getAgentOrdersInWindow.mockResolvedValue([]);
    milestones.getAgentMilestones.mockResolvedValue([]);
    repository.findInWindow.mockResolvedValue([visit()]);
    const day = await getAgentDay('usr_1', NOW);
    expect(day.entries).toEqual([
      expect.objectContaining({ kind: 'FIELD_VISIT', id: 'vst_1', outcome: '1 sale, 1 campaign launched' }),
    ]);
  });
});

describe('assertVisitOutcome — the gate a visitId passes through', () => {
  it('admits the agent’s own visit while it is in progress', async () => {
    await expect(assertVisitOutcome('vst_1', 'agt_1', NOW)).resolves.toBeUndefined();
  });

  it('admits one completed earlier today, and refuses one completed yesterday', async () => {
    repository.findById.mockResolvedValue(visit({ status: 'COMPLETED', completedAt: new Date('2026-09-12T03:00:00.000Z') }));
    await expect(assertVisitOutcome('vst_1', 'agt_1', NOW)).resolves.toBeUndefined();

    repository.findById.mockResolvedValue(visit({ status: 'COMPLETED', completedAt: new Date('2026-09-11T10:00:00.000Z') }));
    await expect(assertVisitOutcome('vst_1', 'agt_1', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a visit that has not started, and somebody else’s visit', async () => {
    repository.findById.mockResolvedValue(visit({ status: 'SCHEDULED', startedAt: null }));
    await expect(assertVisitOutcome('vst_1', 'agt_1', NOW)).rejects.toMatchObject({ statusCode: 409 });

    repository.findById.mockResolvedValue(visit());
    await expect(assertVisitOutcome('vst_1', 'agt_2', NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertVisitOutcome('vst_1', null, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('is a 404 for a visit that does not exist', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(assertVisitOutcome('vst_x', 'agt_1', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});
