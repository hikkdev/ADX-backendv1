import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot E (Q99) — the AUDIT kind, the campaign tag, and the diary overlay.
 *
 * What is pinned: AUDIT is a visit kind like the other four and is paid at
 * the visit rate because it goes through the same completion; a dispatch may
 * carry `campaignTag` and the card prints it back; and the day view's fold —
 * jobs, site visits, field visits — is the same fold the staff diary reads
 * over a date range, with a link on every row and `include` deciding which
 * tables are asked at all.
 */

const { repository, agents, orders, milestones, identifiers } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    findInWindow: vi.fn(),
    findScheduledInRange: vi.fn(),
    countOutcomes: vi.fn(),
    findMine: vi.fn(),
    findForAdmin: vi.fn(),
  },
  agents: {
    requireAgentProfile: vi.fn(),
    findAgentProfile: vi.fn(),
    getAgentWithUser: vi.fn(),
    assertAgentAcceptsWork: vi.fn(),
  },
  orders: { getAgentOrdersInWindow: vi.fn() },
  milestones: { getAgentMilestones: vi.fn() },
  identifiers: { allocateIdentifier: vi.fn() },
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
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../notifications', () => ({ notify: vi.fn(async () => undefined), createNotification: vi.fn(async () => undefined) }));

import { VISIT_KINDS, adminVisitsQuerySchema, createVisitSchema, myVisitsQuerySchema } from '../visits.schema';
import { createVisit, myVisits, toVisitCard, visitsForAdmin } from '../visits.service';
import { agentWorkInWindow, getAgentDay } from '../day.service';

const NOW = new Date('2026-09-12T06:00:00.000Z');
const WINDOW = { start: new Date('2026-09-11T18:30:00.000Z'), end: new Date('2026-09-14T18:30:00.000Z') };

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'vst_1',
  displayId: 'VST-0001',
  kind: 'AUDIT',
  status: 'SCHEDULED',
  agentId: 'agt_1',
  leadId: null,
  publisherId: 'pub_1',
  advertiserId: null,
  businessName: 'Nilgiri Coffee',
  locality: 'Indiranagar',
  city: 'Bengaluru',
  latitude: null,
  longitude: null,
  scheduledFor: new Date('2026-09-13T04:30:00.000Z'),
  offerExpiresAt: null,
  campaignTag: 'Delhi onboarding drive',
  startedAt: null,
  completedAt: null,
  earnedAmount: null,
  incentiveId: null,
  notes: null,
  requestedByUserId: 'adm_1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_1', tier: 'BRONZE' });
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  agents.getAgentWithUser.mockResolvedValue({ id: 'agt_1', userId: 'usr_1' });
  identifiers.allocateIdentifier.mockResolvedValue('VST-0001');
  repository.create.mockImplementation(async (data: Record<string, unknown>) => visit(data));
  repository.countOutcomes.mockResolvedValue({ sales: 0, campaigns: 0 });
  orders.getAgentOrdersInWindow.mockResolvedValue([]);
  milestones.getAgentMilestones.mockResolvedValue([]);
  repository.findInWindow.mockResolvedValue([]);
  repository.findScheduledInRange.mockResolvedValue([]);
});

describe('AUDIT and the campaign tag', () => {
  it('is the fifth kind, accepted on dispatch with a tag', () => {
    expect(VISIT_KINDS).toContain('AUDIT');
    const parsed = createVisitSchema.safeParse({
      kind: 'AUDIT',
      publisherId: 'pub_1',
      agentId: 'agt_1',
      businessName: 'Nilgiri Coffee',
      campaignTag: '  Delhi onboarding drive ',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.campaignTag).toBe('Delhi onboarding drive');
  });

  it('writes the tag on the row and prints it on the card', async () => {
    const card = await createVisit(
      { kind: 'AUDIT', publisherId: 'pub_1', agentId: 'agt_1', businessName: 'Nilgiri Coffee', campaignTag: 'Delhi onboarding drive' } as never,
      { userId: 'adm_1', isAdmin: true },
      NOW,
    );
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AUDIT', campaignTag: 'Delhi onboarding drive' }));
    expect(card.kind).toBe('AUDIT');
    expect(card.campaignTag).toBe('Delhi onboarding drive');
  });

  it('labels an audit on the day view, and the entry carries the kind and the tag (E7-2)', async () => {
    repository.findInWindow.mockResolvedValue([visit({ scheduledFor: new Date('2026-09-12T04:30:00.000Z') })]);
    const day = await getAgentDay('usr_1', NOW);
    expect(day.entries[0]).toMatchObject({ kind: 'FIELD_VISIT', title: 'Audit · Nilgiri Coffee', visitKind: 'AUDIT', campaignTag: 'Delhi onboarding drive' });
  });

  it('E7-2: the card emits kind and campaignTag, null when the visit has no drive', () => {
    expect(toVisitCard(visit() as never, NOW)).toMatchObject({ kind: 'AUDIT', campaignTag: 'Delhi onboarding drive' });
    expect(toVisitCard(visit({ kind: 'SURVEY', campaignTag: null }) as never, NOW)).toMatchObject({ kind: 'SURVEY', campaignTag: null });
  });

  it('E7-2: ?kind=AUDIT is accepted by both lists and reaches the repository; an unknown kind is a 400', async () => {
    expect(myVisitsQuerySchema.parse({ kind: 'AUDIT' }).kind).toBe('AUDIT');
    expect(adminVisitsQuerySchema.parse({ kind: 'AUDIT' }).kind).toBe('AUDIT');
    expect(myVisitsQuerySchema.safeParse({ kind: 'INSPECTION' }).success).toBe(false);
    expect(adminVisitsQuerySchema.safeParse({ kind: 'INSPECTION' }).success).toBe(false);

    repository.findMine.mockResolvedValue({ items: [visit()], total: 1, counts: { SCHEDULED: 1 } });
    repository.findForAdmin.mockResolvedValue({ items: [visit()], total: 1, counts: { SCHEDULED: 1 } });
    const mine = await myVisits('usr_1', myVisitsQuerySchema.parse({ kind: 'AUDIT' }), NOW);
    expect(repository.findMine).toHaveBeenCalledWith('agt_1', expect.objectContaining({ kind: 'AUDIT' }), expect.anything());
    expect(mine.items[0]).toMatchObject({ kind: 'AUDIT', campaignTag: 'Delhi onboarding drive' });
    await visitsForAdmin(adminVisitsQuerySchema.parse({ kind: 'AUDIT' }), NOW);
    expect(repository.findForAdmin).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AUDIT' }), null);
  });
});

describe('agentWorkInWindow — the diary overlay', () => {
  it('folds the three tables over the range, each row with a link, sorted by when', async () => {
    orders.getAgentOrdersInWindow.mockResolvedValue([
      { id: 'ord_1', campaignName: 'Diwali burst', status: 'SLOT_CONFIRMED', slotTime: new Date('2026-09-13T09:00:00.000Z'), listing: { address: '12 MG Road' } },
    ]);
    milestones.getAgentMilestones.mockResolvedValue([
      { id: 'ms_1', orderId: 'ord_2', status: 'DISPATCHED', scheduledStart: new Date('2026-09-12T08:00:00.000Z'), template: { title: 'Site survey' }, order: { listing: { address: '9 Brigade Rd' } } },
      { id: 'ms_2', orderId: 'ord_3', status: 'DISPATCHED', scheduledStart: new Date('2026-09-20T08:00:00.000Z'), template: { title: 'Out of range' } },
    ]);
    repository.findScheduledInRange.mockResolvedValue([visit()]);

    const rows = await agentWorkInWindow('agt_1', WINDOW, { visits: true, milestones: true, jobs: true });
    expect(orders.getAgentOrdersInWindow).toHaveBeenCalledWith('agt_1', WINDOW);
    expect(repository.findScheduledInRange).toHaveBeenCalledWith('agt_1', WINDOW);
    expect(rows.map((r) => r.kind)).toEqual(['SITE_VISIT', 'FIELD_VISIT', 'JOB']);
    expect(rows[0]).toMatchObject({ id: 'ms_1', title: 'Site survey', where: '9 Brigade Rd', link: '/orders/ord_2/milestones/ms_1' });
    expect(rows[1]).toMatchObject({ id: 'vst_1', title: 'Audit · Nilgiri Coffee', where: 'Indiranagar', status: 'SCHEDULED', link: '/visits/vst_1' });
    expect(rows[2]).toMatchObject({ id: 'ord_1', title: 'Diwali burst', where: '12 MG Road', link: '/orders/ord_1' });
    expect(rows.find((r) => r.id === 'ms_2')).toBeUndefined();
  });

  it('asks only the tables the caller named', async () => {
    const rows = await agentWorkInWindow('agt_1', WINDOW, { visits: true, milestones: false, jobs: false });
    expect(rows).toEqual([]);
    expect(repository.findScheduledInRange).toHaveBeenCalled();
    expect(orders.getAgentOrdersInWindow).not.toHaveBeenCalled();
    expect(milestones.getAgentMilestones).not.toHaveBeenCalled();
  });
});
