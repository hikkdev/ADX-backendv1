import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../shared/errors';

/**
 * Lot A on the day.
 *
 * BLOCK_NEW: no visit is booked to a suspended agent — not by ADX dispatching
 * one, not by the agent booking their own, and not by a reassignment, which is
 * a fresh offer with a fresh clock and so a fresh dispatch.
 *
 * STOP_OPEN_WORK: what is still ahead of them comes off the day. A visit in
 * progress or already finished is left alone — the work happened, and
 * rewriting it would be a lie about the day.
 */

const { repository, agents, identifiers, payouts, notifications } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    findMine: vi.fn(),
    findForAdmin: vi.fn(),
    findInWindow: vi.fn(),
    findExpiredOffers: vi.fn(),
    findOpenForAgent: vi.fn(),
  },
  agents: {
    requireAgentProfile: vi.fn(),
    findAgentProfile: vi.fn(),
    getAgentWithUser: vi.fn(),
    assertAgentAcceptsWork: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  payouts: { recordIncentive: vi.fn() },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
}));

// Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }),
}));
vi.mock('../prisma-visits.repository', () => ({ prismaVisitsRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../identifiers', () => ({ allocateIdentifier: identifiers.allocateIdentifier }));
vi.mock('../../payouts', () => ({ recordIncentive: payouts.recordIncentive }));
vi.mock('../../notifications', () => ({ createNotification: notifications.createNotification, notify: notifications.notify }));

import { cancelAgentVisits, createVisit, patchVisit } from '../visits.service';

const NOW = new Date('2026-09-12T06:00:00.000Z');

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'vst_1',
  displayId: 'VST-0001',
  kind: 'ONBOARDING',
  status: 'SCHEDULED',
  agentId: 'agt_1',
  leadId: null,
  publisherId: null,
  advertiserId: null,
  businessName: 'Cafe Coffee Day',
  locality: null,
  city: 'Bengaluru',
  latitude: null,
  longitude: null,
  offerExpiresAt: null,
  scheduledFor: null,
  startedAt: null,
  completedAt: null,
  declinedReason: null,
  earnedAmount: null,
  incentiveId: null,
  notes: null,
  ...over,
});

const suspended = new ApiError(409, 'AGENT_SUSPENDED', 'That agent is not being offered work at the moment');

beforeEach(() => {
  vi.clearAllMocks();
  identifiers.allocateIdentifier.mockResolvedValue('VST-0002');
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent' });
  agents.getAgentWithUser.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent' });
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => visit(data));
  repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => visit(patch));
  repository.findById.mockResolvedValue(visit());
  repository.findOpenForAgent.mockResolvedValue([]);
  notifications.createNotification.mockResolvedValue({});
});

describe('BLOCK_NEW', () => {
  it('refuses a visit ADX tries to dispatch to a suspended agent', async () => {
    agents.assertAgentAcceptsWork.mockRejectedValue(suspended);
    await expect(
      createVisit({ kind: 'RENEWAL', agentId: 'agt_1', businessName: 'Third Wave' } as never, { userId: 'usr_admin', isAdmin: true }, NOW),
    ).rejects.toMatchObject({ code: 'AGENT_SUSPENDED' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses one a suspended agent books for themselves', async () => {
    agents.assertAgentAcceptsWork.mockRejectedValue(suspended);
    await expect(
      createVisit({ kind: 'ONBOARDING', businessName: 'Cafe Coffee Day' } as never, { userId: 'usr_agent', isAdmin: false }, NOW),
    ).rejects.toMatchObject({ code: 'AGENT_SUSPENDED' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a reassignment onto one, because that is a fresh offer', async () => {
    agents.assertAgentAcceptsWork.mockRejectedValue(suspended);
    await expect(patchVisit('vst_1', { agentId: 'agt_other' }, NOW)).rejects.toMatchObject({ code: 'AGENT_SUSPENDED' });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('leaves an ordinary booking alone', async () => {
    await createVisit({ kind: 'ONBOARDING', businessName: 'Cafe Coffee Day' } as never, { userId: 'usr_agent', isAdmin: false }, NOW);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_1', status: 'SCHEDULED' }));
  });
});

describe('STOP_OPEN_WORK', () => {
  it('cancels every visit still ahead of the agent, with the reason on it', async () => {
    repository.findOpenForAgent.mockResolvedValue([visit({ id: 'vst_1', status: 'REQUESTED' }), visit({ id: 'vst_2' })]);

    const cancelled = await cancelAgentVisits('agt_1', 'SUSPENDED');

    expect(cancelled).toEqual(['vst_1', 'vst_2']);
    expect(repository.update).toHaveBeenCalledWith('vst_1', {
      status: 'CANCELLED',
      offerExpiresAt: null,
      declinedReason: 'SUSPENDED',
    });
  });

  it('asks only for the open ones, so a completed visit is never rewritten', async () => {
    await cancelAgentVisits('agt_1', 'SUSPENDED');
    expect(repository.findOpenForAgent).toHaveBeenCalledWith('agt_1');
    expect(repository.update).not.toHaveBeenCalled();
  });
});
