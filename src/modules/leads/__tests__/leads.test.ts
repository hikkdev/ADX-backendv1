import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 — leads.
 *
 * The domain the platform refused to guess at: `AgentDashboard` declared a
 * `LeadCluster` shape, returned `leads: []`, and a test pinned the empty list
 * as correct "until a lead model exists". This is that model's own behaviour.
 *
 * What is pinned here: six statuses reconcile onto the three pills the card
 * draws; the money slot gives way to "Visit booked" rather than printing a
 * figure beside a booked visit; the commission estimate is quoted from what
 * the platform actually pays rather than typed onto the row; first contact is
 * stamped once; and a lead converts exactly once, through the one door that
 * records what it became.
 */

const { repository, identifiers, payouts, visits, agents } = vi.hoisted(() => ({
  visits: { createVisit: vi.fn() },
  /** Lot A: a lead handed to an agent is work, so the assignment asks first. */
  agents: { assertAgentAcceptsWork: vi.fn() },
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    findNear: vi.fn(),
    findForAdmin: vi.fn(),
    clustersNear: vi.fn(),
    logActivity: vi.fn(),
    // Lot D (Q93): the dedup reads; nothing collides in these tests.
    findByPhones: vi.fn().mockResolvedValue([]),
    findAccountsByPhones: vi.fn().mockResolvedValue([]),
    findByNameAndCity: vi.fn().mockResolvedValue([]),
    importBatch: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  payouts: { rateFor: vi.fn() },
}));

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: repository, distanceM: actual.distanceM };
});
vi.mock('../../identifiers', () => ({ allocateIdentifier: identifiers.allocateIdentifier }));
vi.mock('../../payouts', () => ({ rateFor: payouts.rateFor }));
vi.mock('../../visits', () => ({ createVisit: visits.createVisit }));
vi.mock('../../agents', () => agents);

import { bookVisit, convertLead, createLead, leadsNear, logContact, patchLead } from '../leads.service';
import { isOpenLead, leadPillOf, nearLeadsQuerySchema } from '../leads.schema';

const lead = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  displayId: 'LED-0001',
  side: 'PUBLISHER',
  businessName: 'Suraj Kumar Prints',
  category: 'Print vendor',
  locality: 'Koramangala',
  city: 'Bengaluru',
  status: 'NEW',
  estimatedCommission: '1450.00',
  latitude: 12.935,
  longitude: 77.624,
  contactName: 'Suraj',
  phone: '+919000000001',
  interest: 'Wall panels',
  source: 'Referral',
  bestTimeFrom: '11:00',
  bestTimeTo: '14:00',
  firstContactedAt: null,
  assignedAgentId: null,
  address: 'Koramangala 5th Block',
  email: null,
  activity: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  identifiers.allocateIdentifier.mockResolvedValue('LED-0001');
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  payouts.rateFor.mockResolvedValue('1450.00');
  repository.findById.mockResolvedValue(lead());
  repository.create.mockResolvedValue(lead());
  repository.update.mockResolvedValue(lead());
  repository.logActivity.mockResolvedValue({});
  visits.createVisit.mockResolvedValue({ id: 'vst_1', displayId: 'VST-0001', agentId: 'agt_1' });
});

describe('the status vocabulary', () => {
  it('folds six statuses onto the three pills the card draws', () => {
    expect(leadPillOf('HOT').label).toBe('Hot');
    expect(leadPillOf('NEW').label).toBe('New');
    // A booked visit still reads CONTACTED on the pill; the fact that a visit
    // exists is told in the money slot instead.
    expect(leadPillOf('CONTACTED').label).toBe('Contacted');
    expect(leadPillOf('VISIT_BOOKED').label).toBe('Contacted');
  });

  it("knows which leads are still worth an agent's time", () => {
    expect(isOpenLead('NEW')).toBe(true);
    expect(isOpenLead('VISIT_BOOKED')).toBe(true);
    expect(isOpenLead('CONVERTED')).toBe(false);
    expect(isOpenLead('LOST')).toBe(false);
  });
});

describe('the near-you query', () => {
  it('refuses half a point, the way browse does', () => {
    expect(nearLeadsQuerySchema.safeParse({ lat: '12.9' }).success).toBe(false);
    expect(nearLeadsQuerySchema.safeParse({ lat: '12.9', lng: '77.6' }).success).toBe(true);
  });

  it('refuses to rank by distance with nowhere to be near', () => {
    // Answering a distance-ranked question with an unranked list would be
    // worse than refusing it.
    expect(nearLeadsQuerySchema.safeParse({ sort: 'NEAREST' }).success).toBe(false);
    expect(nearLeadsQuerySchema.safeParse({ sort: 'NEWEST' }).success).toBe(true);
  });

  it('defaults to a radius rather than the whole country', () => {
    expect(nearLeadsQuerySchema.parse({}).radiusKm).toBe(25);
  });
});

describe('the card', () => {
  it('carries the pill and the distance so the app keeps no second copy', async () => {
    repository.findNear.mockResolvedValue({ items: [lead()], total: 1, counts: { NEW: 1 } });
    const page = await leadsNear(
      nearLeadsQuerySchema.parse({ lat: '12.935', lng: '77.624', sort: 'NEAREST' }),
    );
    expect(page.items[0]!.pill).toEqual({ label: 'New', tone: 'new' });
    expect(page.items[0]!.distanceM).toBe(0);
    expect(page.items[0]!.visitBooked).toBe(false);
  });

  it('says a visit is booked instead of quoting a figure beside it', async () => {
    repository.findNear.mockResolvedValue({
      items: [lead({ status: 'VISIT_BOOKED' })],
      total: 1,
      counts: {},
    });
    const page = await leadsNear(nearLeadsQuerySchema.parse({}));
    expect(page.items[0]!.visitBooked).toBe(true);
  });

  it('has no distance to give when nobody said where the agent is', async () => {
    repository.findNear.mockResolvedValue({ items: [lead()], total: 1, counts: {} });
    const page = await leadsNear(nearLeadsQuerySchema.parse({}));
    expect(page.items[0]!.distanceM).toBeNull();
  });
});

describe('creating a lead', () => {
  it('mints its identifier through the one counter every party uses', async () => {
    await createLead({ side: 'PUBLISHER', businessName: 'Elite Fitness Gym' } as never, 'usr_1');
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('LEAD');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ displayId: 'LED-0001' }),
    );
  });

  it('quotes the commission the platform actually pays', async () => {
    await createLead({ side: 'PUBLISHER', businessName: 'Elite Fitness Gym' } as never, 'usr_1');
    expect(payouts.rateFor).toHaveBeenCalledWith('PUBLISHER_ONBOARDED');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCommission: '1450.00' }),
    );
  });

  it('T-B: answers the lead as GET /leads/:leadId does — the card with its pill, distance, visit flag and activity', async () => {
    repository.findById.mockResolvedValue(lead({ activity: [{ id: 'act_1', kind: 'IMPORTED', note: 'Added from Referral', createdAt: new Date('2026-09-15T05:00:00Z') }] }));
    const created = await createLead({ side: 'PUBLISHER', businessName: 'Suraj Kumar Prints', source: 'Referral' } as never, 'usr_1');
    expect(repository.findById).toHaveBeenCalledWith('led_1');
    expect(created).toMatchObject({
      id: 'led_1',
      pill: { label: 'New', tone: expect.any(String) },
      distanceM: null,
      visitBooked: false,
      estimatedCommission: '1450.00',
      address: 'Koramangala 5th Block',
      activity: [{ id: 'act_1', kind: 'IMPORTED', note: 'Added from Referral', at: '2026-09-15T05:00:00.000Z' }],
    });
  });

  it('quotes the advertiser-side rate for an advertiser lead', async () => {
    await createLead({ side: 'ADVERTISER', businessName: "Anita's Coffee" } as never, 'usr_1');
    expect(payouts.rateFor).toHaveBeenCalledWith('CAMPAIGN_ASSIST');
  });

  it('prints nothing where the platform has no rate configured', async () => {
    payouts.rateFor.mockResolvedValue(null);
    await createLead({ side: 'PUBLISHER', businessName: 'Blue Tokai' } as never, 'usr_1');
    // Not zero. Zero is a promise to pay nothing.
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCommission: null }),
    );
  });
});

describe('contacting a lead', () => {
  it('stamps first contact once and moves NEW along', async () => {
    await logContact('led_1', 'usr_1', { kind: 'CALLED' });
    expect(repository.update).toHaveBeenCalledWith(
      'led_1',
      expect.objectContaining({ status: 'CONTACTED', firstContactedAt: expect.any(Date) }),
    );
  });

  it('does not move first contact on the second call', async () => {
    repository.findById.mockResolvedValue(lead({ firstContactedAt: new Date('2026-01-01') }));
    await logContact('led_1', 'usr_1', { kind: 'CALLED' });
    const patch = repository.update.mock.calls[0]?.[1] ?? {};
    expect(patch).not.toHaveProperty('firstContactedAt');
  });

  it("leaves a HOT lead hot — that is the agent's judgement, not a side effect", async () => {
    repository.findById.mockResolvedValue(lead({ status: 'HOT' }));
    await logContact('led_1', 'usr_1', { kind: 'CALLED' });
    const patch = repository.update.mock.calls[0]?.[1] ?? {};
    expect(patch).not.toHaveProperty('status');
  });
});

describe('booking a visit', () => {
  it("books a real field visit on the agent's day, then moves the lead", async () => {
    // The visit is a FieldVisit the Visits list and the dispatch board read;
    // the lead only remembers that one exists.
    await bookVisit('led_1', 'usr_1');
    expect(visits.createVisit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ONBOARDING', leadId: 'led_1', businessName: 'Suraj Kumar Prints' }),
      { userId: 'usr_1', isAdmin: false },
    );
    expect(repository.update).toHaveBeenCalledWith(
      'led_1',
      expect.objectContaining({ status: 'VISIT_BOOKED', assignedAgentId: 'agt_1' }),
    );
    expect(repository.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'VISIT_BOOKED' }),
    );
  });

  it('refuses a lead that is already closed', async () => {
    repository.findById.mockResolvedValue(lead({ status: 'CONVERTED' }));
    await expect(bookVisit('led_1', 'usr_1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('converting a lead', () => {
  it('records what it became and when', async () => {
    await convertLead('led_1', 'usr_1', { publisherId: 'pub_1' });
    expect(repository.update).toHaveBeenCalledWith(
      'led_1',
      expect.objectContaining({
        status: 'CONVERTED',
        convertedPublisherId: 'pub_1',
        convertedAt: expect.any(Date),
      }),
    );
  });

  it('refuses to convert the same lead twice', async () => {
    // The funnel counts conversions; a lead that could convert twice would be
    // counted twice.
    repository.findById.mockResolvedValue(lead({ status: 'CONVERTED' }));
    await expect(convertLead('led_1', 'usr_1', { publisherId: 'pub_1' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("will not let a PATCH convert one behind the domain's back", async () => {
    // The table's own CHECK requires `convertedAt` beside the status, and a
    // patch that set one without the other would fail at the database with a
    // 500 instead of a sentence.
    await expect(patchLead('led_1', 'usr_1', { status: 'CONVERTED' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

/**
 * Lot A BLOCK_NEW: a lead handed to an agent is work, so the assignment asks
 * whether that agent is being offered any. Clearing the assignment always
 * works — that is how a lead comes off a suspended agent and back to the pool.
 */
describe('assigning a lead to a suspended agent', () => {
  it('is refused when the lead is created against them', async () => {
    agents.assertAgentAcceptsWork.mockRejectedValue(
      Object.assign(new Error('suspended'), { statusCode: 409, code: 'AGENT_SUSPENDED' }),
    );
    await expect(
      createLead({ side: 'PUBLISHER', businessName: 'Cafe Coffee Day', assignedAgentId: 'agt_1' } as never, 'usr_1'),
    ).rejects.toMatchObject({ code: 'AGENT_SUSPENDED' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('is refused when an existing lead is reassigned to them', async () => {
    agents.assertAgentAcceptsWork.mockRejectedValue(
      Object.assign(new Error('suspended'), { statusCode: 409, code: 'AGENT_SUSPENDED' }),
    );
    await expect(patchLead('led_1', 'usr_1', { assignedAgentId: 'agt_1' })).rejects.toMatchObject({
      code: 'AGENT_SUSPENDED',
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('never blocks the clearing of an assignment', async () => {
    await patchLead('led_1', 'usr_1', { assignedAgentId: null });
    expect(agents.assertAgentAcceptsWork).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith('led_1', { assignedAgentId: null });
  });
});
