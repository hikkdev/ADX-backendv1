import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 — field visits.
 *
 * The platform's only visit was an OrderMilestone, whose orderId is
 * non-nullable, so an onboarding call on a lead or a renewal call on an
 * advertiser could not be recorded. This is the model that can.
 *
 * Pinned: an agent booking for themselves is already accepted, ADX dispatching
 * to a named agent is an offer with the order lane's 25-minute clock; the
 * clock is enforced (410 after it); completion records the SITE_VISIT
 * incentive that has been priced since DR 04 and never once recorded, and
 * copies the amount onto the card; a completion with no rate is still a
 * completion, earning nothing the platform can name; and the Today / Upcoming
 * / Past chips are windows on the Indian day, not statuses.
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
  },
  agents: {
    requireAgentProfile: vi.fn(),
    findAgentProfile: vi.fn(),
    getAgentWithUser: vi.fn(),
    // Lot A: every dispatch asks whether the agent is being offered work.
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

import { acceptVisit, completeVisit, createVisit, expireVisitOffers, myVisits, rejectVisit } from '../visits.service';
import { VISIT_OFFER_MINUTES, myVisitsQuerySchema, visitPillOf } from '../visits.schema';

const NOW = new Date('2026-09-11T06:00:00.000Z'); // 11:30 IST

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'vst_1',
  displayId: 'VST-0001',
  kind: 'ONBOARDING',
  status: 'REQUESTED',
  agentId: 'agt_1',
  leadId: 'led_1',
  publisherId: null,
  advertiserId: null,
  businessName: 'Cafe Coffee Day',
  locality: '5th Block',
  city: 'Bengaluru',
  latitude: null,
  longitude: null,
  offerExpiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
  scheduledFor: null,
  startedAt: null,
  completedAt: null,
  declinedReason: null,
  earnedAmount: null,
  incentiveId: null,
  notes: null,
  requestedByUserId: 'usr_admin',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  identifiers.allocateIdentifier.mockResolvedValue('VST-0001');
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent', tier: 'SILVER' });
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent', tier: 'SILVER' });
  agents.getAgentWithUser.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent' });
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  repository.create.mockImplementation(async (data) => visit(data));
  repository.update.mockImplementation(async (_id, patch) => visit({ ...patch }));
  repository.findById.mockResolvedValue(visit());
  notifications.createNotification.mockResolvedValue({});
  notifications.notify.mockResolvedValue({ notificationId: 'ntf_1', templateKey: 'visit-offer', deliveries: [] });
  payouts.recordIncentive.mockResolvedValue({ id: 'inc_1', amount: '500.00' });
});

describe('the pill', () => {
  it('folds seven statuses onto the four the card draws', () => {
    expect(visitPillOf('REQUESTED').label).toBe('New request');
    expect(visitPillOf('SCHEDULED').label).toBe('Scheduled');
    expect(visitPillOf('COMPLETED').label).toBe('Completed');
    expect(visitPillOf('EXPIRED').tone).toBe('neutral');
  });
});

describe('booking a visit', () => {
  it('is already accepted when an agent books it for themselves', async () => {
    const card = await createVisit(
      { kind: 'ONBOARDING', leadId: 'led_1', businessName: 'Cafe Coffee Day' } as never,
      { userId: 'usr_agent', isAdmin: false },
      NOW,
    );
    expect(repository.create).toHaveBeenCalledWith(
      // Lot X-B: no city typed, no key.
      expect.objectContaining({ agentId: 'agt_1', status: 'SCHEDULED', offerExpiresAt: null, city: null, cityId: null }),
    );
    expect(card.expiresInSeconds).toBeNull();
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('VISIT');
  });

  /* Lot X-B: the key beside the typed city. */
  it('stamps the city key on the row — the catalogue row for an old spelling, null for a typed town', async () => {
    await createVisit({ kind: 'ONBOARDING', leadId: 'led_1', businessName: 'Cafe Coffee Day', city: 'Bangalore' } as never, { userId: 'usr_agent', isAdmin: false }, NOW);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bangalore', cityId: 'city_bengaluru' }));
    await createVisit({ kind: 'ONBOARDING', leadId: 'led_1', businessName: 'Typed', city: 'Rameswaram' } as never, { userId: 'usr_agent', isAdmin: false }, NOW);
    expect(repository.create).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Rameswaram', cityId: null }));
  });

  it('is an offer with the 25-minute clock when ADX dispatches it', async () => {
    const card = await createVisit(
      { kind: 'RENEWAL', advertiserId: 'adv_1', agentId: 'agt_1', businessName: 'Third Wave' } as never,
      { userId: 'usr_admin', isAdmin: true },
      NOW,
    );
    const created = repository.create.mock.calls[0]![0];
    expect(created.status).toBe('REQUESTED');
    expect(created.offerExpiresAt.getTime() - NOW.getTime()).toBe(VISIT_OFFER_MINUTES * 60 * 1000);
    expect(card.expiresInSeconds).toBe(VISIT_OFFER_MINUTES * 60);
    // The agent is told there is something to answer.
    // Lot E1/F: one notify call — the in-app ORDER row plus the seeded visit-offer SMS.
    expect(notifications.notify).toHaveBeenCalledWith(
      'VISIT_OFFER',
      'usr_agent',
      expect.objectContaining({ agentName: 'ADX', address: expect.any(String), when: expect.any(String) }),
      { inApp: expect.objectContaining({ type: 'ORDER', title: 'New visit request' }) },
    );
  });
});

describe('answering an offer', () => {
  it('accepts inside the window', async () => {
    await acceptVisit('vst_1', 'usr_agent', NOW);
    expect(repository.update).toHaveBeenCalledWith('vst_1', { status: 'SCHEDULED', offerExpiresAt: null });
  });

  it('is 410 after the window closes — the clock on the card is the clock ADX keeps', async () => {
    repository.findById.mockResolvedValue(visit({ offerExpiresAt: new Date(NOW.getTime() - 1000) }));
    await expect(acceptVisit('vst_1', 'usr_agent', NOW)).rejects.toMatchObject({
      statusCode: 410,
      code: 'OFFER_EXPIRED',
    });
  });

  it('is somebody else\'s visit, so it is refused', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_other' });
    await expect(acceptVisit('vst_1', 'usr_stranger', NOW)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records why it was declined', async () => {
    await rejectVisit('vst_1', 'usr_agent', 'Too far today', NOW);
    expect(repository.update).toHaveBeenCalledWith(
      'vst_1',
      expect.objectContaining({ status: 'DECLINED', declinedReason: 'Too far today' }),
    );
  });
});

describe('completing a visit', () => {
  it('records the SITE_VISIT incentive at the agent\'s tier and copies the amount onto the card', async () => {
    repository.findById.mockResolvedValue(visit({ status: 'IN_PROGRESS', offerExpiresAt: null }));
    const card = await completeVisit('vst_1', 'usr_agent', undefined, NOW);
    expect(payouts.recordIncentive).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_1', event: 'SITE_VISIT', tier: 'SILVER' }),
      NOW,
    );
    expect(repository.update).toHaveBeenCalledWith(
      'vst_1',
      expect.objectContaining({ status: 'COMPLETED', earnedAmount: '500.00', incentiveId: 'inc_1' }),
    );
    // "₹145 earned" on the card is the figure the wallet will show.
    expect(card.earned).toBe('500.00');
  });

  it('is still done when no rate is configured — it just earned nothing the platform can name', async () => {
    repository.findById.mockResolvedValue(visit({ status: 'IN_PROGRESS', offerExpiresAt: null }));
    payouts.recordIncentive.mockRejectedValue(new Error('No incentive rate'));
    const card = await completeVisit('vst_1', 'usr_agent', undefined, NOW);
    expect(card.status).toBe('COMPLETED');
    expect(card.earned).toBeNull();
  });

  it('is a read the second time', async () => {
    repository.findById.mockResolvedValue(visit({ status: 'COMPLETED', completedAt: NOW, earnedAmount: '500.00' }));
    await completeVisit('vst_1', 'usr_agent', undefined, NOW);
    expect(payouts.recordIncentive).not.toHaveBeenCalled();
  });
});

describe('the three chips', () => {
  it('are windows on the Indian day, sent to the repository with the day', async () => {
    repository.findMine.mockResolvedValue({ items: [], total: 0, counts: {} });
    await myVisits('usr_agent', myVisitsQuerySchema.parse({ scope: 'TODAY' }), NOW);
    const [, , day] = repository.findMine.mock.calls[0]!;
    // 11 Sep 2026 in IST runs 18:30Z the day before to 18:30Z today.
    expect(day.start.toISOString()).toBe('2026-09-10T18:30:00.000Z');
    expect(day.end.toISOString()).toBe('2026-09-11T18:30:00.000Z');
  });

  it('default to Today', () => {
    expect(myVisitsQuerySchema.parse({}).scope).toBe('TODAY');
  });
});

describe('the sweep', () => {
  it('expires the requests whose window closed in the tick, and only those', async () => {
    repository.findExpiredOffers.mockResolvedValue([visit({ id: 'vst_a' }), visit({ id: 'vst_b' })]);
    const window = { start: new Date(NOW.getTime() - 60_000), end: NOW };
    const count = await expireVisitOffers(window);
    expect(count).toBe(2);
    expect(repository.findExpiredOffers).toHaveBeenCalledWith(window.end, window.start);
    expect(repository.update).toHaveBeenCalledWith('vst_a', { status: 'EXPIRED', offerExpiresAt: null });
  });
});
