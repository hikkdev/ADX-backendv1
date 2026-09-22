import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LH5 (the Lead Hunt, 22 Sep 2026) — the hunting map.
 *
 * Pinned: the viewport's arithmetic (a bbox parsed and refused, clusters
 * above sixty km² and pins below, the pin cap, the bulk-plot override for
 * the desk); rings parsed closed or open and tested behind their bbox; the
 * claim rules (D3 — another's hold, the tier cap, the seven-day cooldown
 * after a lapse, a closed lead) and the claim itself (72 h, CLAIMED, the
 * claim row, the touch); release; the hourly sweep (an unworked hold
 * lapses back to the pool, a worked one ends quietly, the warning an hour
 * before goes once); the territory router (D8 — the ring's agent wins,
 * route-only); the priority top-up (D7 — once per lead, the zone's own
 * amount under its budget and the monthly cap, keyed on the zone and the
 * lead); the nearby-hot alert (within a kilometre, a fix today, unclaimed,
 * once); assign-from-polygon.
 */

const { repository, agents, payouts, notifications, pricing, settings, redisStore } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    repository: {
      findById: vi.fn(),
      update: vi.fn(),
      logActivity: vi.fn(),
      findForScoring: vi.fn().mockResolvedValue(null),
      findOpenInBBox: vi.fn().mockResolvedValue([]),
      liveListingPoints: vi.fn().mockResolvedValue([]),
      demandPoints: vi.fn().mockResolvedValue([]),
      createTerritory: vi.fn(),
      updateTerritory: vi.fn(),
      findTerritory: vi.fn(),
      listTerritories: vi.fn().mockResolvedValue([]),
      territoriesCovering: vi.fn().mockResolvedValue([]),
      createZone: vi.fn(),
      updateZone: vi.fn(),
      findZone: vi.fn(),
      listZones: vi.fn().mockResolvedValue([]),
      addZoneSpend: vi.fn(),
      priorityTopUpsSince: vi.fn().mockResolvedValue(0),
      priorityTopUpPaid: vi.fn().mockResolvedValue(false),
      createClaim: vi.fn(),
      closeOpenClaims: vi.fn().mockResolvedValue(1),
      claimsExpiredBefore: vi.fn().mockResolvedValue([]),
      claimsExpiringBetween: vi.fn().mockResolvedValue([]),
      lastLapsedClaim: vi.fn().mockResolvedValue(null),
      countOpenFor: vi.fn().mockResolvedValue(0),
      candidateAgents: vi.fn().mockResolvedValue([]),
      findAgentBrief: vi.fn(),
    },
    agents: {
      requireAgentProfile: vi.fn(async () => ({ id: 'agt_1', userId: 'usr_agent', tier: 'BRONZE' })),
      findAgentProfile: vi.fn(async () => ({ id: 'agt_1', userId: 'usr_agent', tier: 'BRONZE' })),
      findAgentTier: vi.fn(async () => 'BRONZE'),
      assertAgentAcceptsWork: vi.fn(),
      agentMeetsGrade: vi.fn(async () => true),
      getRoutingSettings: vi.fn(async () => ({ enforce: false })),
    },
    payouts: { recordIncentiveOnce: vi.fn(async () => ({ id: 'inc_1' })), rateFor: vi.fn(async () => '500.00') },
    notifications: { notify: vi.fn(async () => undefined) },
    pricing: { cityKeyFor: vi.fn(async () => ({ cityId: 'city_blr' })), withCityKey: vi.fn(async (x: unknown) => x), citySupport: vi.fn() },
    settings: {
      leads: {
        scoring: { weights: { fitMax: 30, intentMax: 35, recencyMin: -25, sourceMax: 15, agentFlag: 10 }, recency: { afterDays7: -5, afterDays21: -15, afterDays45: -25 }, thresholds: { hot: 70, warm: 40 }, agentFlagDays: 14, intent: {}, fit: { defaultCategory: 12, categoryBySide: { PUBLISHER: {}, ADVERTISER: {} }, importanceBonus: { KEY: 4, ENTERPRISE: 8 }, localityBonus: 6, localityRadiusM: 1000 } },
        claims: { holdHours: 72, caps: { BRONZE: 10, SILVER: 20, GOLD: 40, PLATINUM: null }, cooldownDays: 7 },
        referralCredit: 250,
        priority: { topUp: 200, monthlyCap: 25000 },
      },
    },
  };
});

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: repository, distanceM: actual.distanceM };
});
vi.mock('../../agents', () => agents);
vi.mock('../../payouts', () => payouts);
vi.mock('../../pricing', () => pricing);
vi.mock('../../notifications', () => notifications);
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => settings) }));
vi.mock('../../../shared/cache', () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    del: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
  },
}));

import {
  CLUSTER_ABOVE_KM2,
  PIN_CAP,
  bboxAreaKm2,
  bboxOfRing,
  claimVerdict,
  clusterPoints,
  inRing,
  parseBBox,
  parseRing,
  topUpAllowed,
  zoneCovers,
  type ZoneRow,
} from '../map.rules';
import { alertNearbyHot, assignInPolygon, claimLead, createTerritory, createZone, mapView, payPriorityTopUp, releaseLead, sweepClaims, territoryFor } from '../map.service';

const now = new Date('2026-09-22T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Koramangala, roughly: a 2 km square.
const small = { south: 12.925, west: 77.615, north: 12.945, east: 77.635 };
// Bengaluru, roughly: 40 km on a side.
const big = { south: 12.8, west: 77.4, north: 13.16, east: 77.8 };
const ring: [number, number][] = [
  [77.615, 12.925],
  [77.635, 12.925],
  [77.635, 12.945],
  [77.615, 12.945],
];

const lead = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  displayId: 'LED-0001',
  side: 'PUBLISHER',
  businessName: 'Suraj Kumar Prints',
  category: 'Wall',
  status: 'NEW',
  stage: 'SCORED',
  stageChangedAt: now,
  assignedAgentId: null,
  claimedByAgentId: null,
  claimExpiresAt: null,
  territoryId: null,
  latitude: 12.935,
  longitude: 77.625,
  cityId: 'city_blr',
  temperature: 'HOT',
  score: 80,
  estimatedValue: null,
  estimatedCommission: null,
  lastTouchedAt: null,
  convertedPublisherId: null,
  convertedAdvertiserId: null,
  activity: [],
  attribution: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => patch);
  repository.findById.mockResolvedValue(lead());
  repository.findOpenInBBox.mockResolvedValue([]);
  repository.listZones.mockResolvedValue([]);
  repository.listTerritories.mockResolvedValue([]);
  repository.territoriesCovering.mockResolvedValue([]);
  repository.countOpenFor.mockResolvedValue(0);
  repository.lastLapsedClaim.mockResolvedValue(null);
  repository.priorityTopUpsSince.mockResolvedValue(0);
  repository.priorityTopUpPaid.mockResolvedValue(false);
  repository.claimsExpiredBefore.mockResolvedValue([]);
  repository.claimsExpiringBetween.mockResolvedValue([]);
  repository.candidateAgents.mockResolvedValue([]);
  repository.findAgentBrief.mockImplementation(async (id: string) => ({ id, userId: `usr_${id}`, city: 'Bengaluru', cityId: 'city_blr', sides: ['PUBLISHER'] }));
  repository.createClaim.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'clm_1', ...data }));
  repository.createTerritory.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'ter_1', createdAt: now, isActive: true, ...data }));
  repository.createZone.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'zone_1', createdAt: now, isActive: true, spent: 0, ...data }));
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent', tier: 'BRONZE' });
});

/* ── the arithmetic ────────────────────────────────────────────────────── */

describe('the viewport', () => {
  it('parses south,west,north,east and refuses anything that is not a box', () => {
    expect(parseBBox('12.9,77.6,12.95,77.65')).toEqual({ south: 12.9, west: 77.6, north: 12.95, east: 77.65 });
    expect(parseBBox('12.95,77.6,12.9,77.65')).toBeNull();
    expect(parseBBox('a,b,c,d')).toBeNull();
    expect(parseBBox('12.9,77.6,12.95')).toBeNull();
    expect(parseBBox(undefined)).toBeNull();
  });

  it('measures the area — a 2 km square is pins, a city is clusters', () => {
    expect(bboxAreaKm2(small)).toBeLessThan(CLUSTER_ABOVE_KM2);
    expect(bboxAreaKm2(big)).toBeGreaterThan(CLUSTER_ABOVE_KM2);
  });

  it('clusters by grid cell with the temperature split and the biggest first', () => {
    const rows = [
      { latitude: 12.93, longitude: 77.62, temperature: 'HOT' },
      { latitude: 12.931, longitude: 77.621, temperature: 'WARM' },
      { latitude: 13.1, longitude: 77.75, temperature: 'COLD' },
    ];
    const clusters = clusterPoints(rows, big);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ count: 2, hot: 1, warm: 1, cold: 0, label: '2 LEADS' });
    expect(clusters[1]).toMatchObject({ count: 1, cold: 1, label: '1 LEAD' });
  });
});

describe('rings', () => {
  it('takes a closed or an open ring and refuses fewer than three corners', () => {
    expect(parseRing(ring)).toHaveLength(4);
    expect(parseRing([...ring, ring[0]])).toHaveLength(4);
    expect(parseRing(ring.slice(0, 2))).toBeNull();
    expect(parseRing([[200, 12]])).toBeNull();
    expect(parseRing('nope')).toBeNull();
  });

  it('tests a point behind its bounding box', () => {
    expect(bboxOfRing(ring)).toEqual(small);
    expect(inRing({ latitude: 12.935, longitude: 77.625 }, ring)).toBe(true);
    expect(inRing({ latitude: 12.95, longitude: 77.625 }, ring)).toBe(false);
  });
});

/* ── claims (D3) ───────────────────────────────────────────────────────── */

describe('the claim verdict', () => {
  const base = { agentId: 'agt_1', tier: 'BRONZE', open: 0, caps: { BRONZE: 10, SILVER: 20, GOLD: 40, PLATINUM: null }, lastLapsedAt: null, cooldownDays: 7, now };

  it('allows an open lead', () => {
    expect(claimVerdict({ ...base, lead: lead() })).toEqual({ ok: true });
  });

  it("refuses another agent's live hold, but not a lapsed one", () => {
    expect(claimVerdict({ ...base, lead: lead({ claimedByAgentId: 'agt_2', claimExpiresAt: new Date(now.getTime() + HOUR) }) })).toMatchObject({ ok: false, code: 'CLAIMED_BY_OTHER' });
    expect(claimVerdict({ ...base, lead: lead({ claimedByAgentId: 'agt_2', claimExpiresAt: new Date(now.getTime() - HOUR) }) })).toEqual({ ok: true });
    expect(claimVerdict({ ...base, lead: lead({ assignedAgentId: 'agt_2' }) })).toMatchObject({ ok: false, code: 'CLAIMED_BY_OTHER' });
  });

  it('holds the tier cap, and PLATINUM has none', () => {
    expect(claimVerdict({ ...base, lead: lead(), open: 10 })).toMatchObject({ ok: false, code: 'CLAIM_CAP' });
    expect(claimVerdict({ ...base, lead: lead(), open: 9 })).toEqual({ ok: true });
    expect(claimVerdict({ ...base, lead: lead(), tier: 'PLATINUM', open: 500 })).toEqual({ ok: true });
  });

  it('keeps the cooldown after a lapse for seven days', () => {
    const verdict = claimVerdict({ ...base, lead: lead(), lastLapsedAt: new Date(now.getTime() - 2 * DAY) });
    expect(verdict).toMatchObject({ ok: false, code: 'COOLDOWN' });
    expect((verdict as { until: Date }).until.toISOString()).toBe('2026-09-27T09:00:00.000Z');
    expect(claimVerdict({ ...base, lead: lead(), lastLapsedAt: new Date(now.getTime() - 8 * DAY) })).toEqual({ ok: true });
  });

  it('refuses a closed lead', () => {
    expect(claimVerdict({ ...base, lead: lead({ stage: 'LOST' }) })).toMatchObject({ ok: false, code: 'CLOSED' });
    expect(claimVerdict({ ...base, lead: lead({ stage: 'ACTIVATED' }) })).toMatchObject({ ok: false, code: 'CLOSED' });
  });
});

describe('claiming and releasing', () => {
  it('claims for 72 hours: the claim row, the lead assigned and CLAIMED, the touch', async () => {
    const result = await claimLead('led_1', 'usr_agent', now);
    expect(repository.createClaim).toHaveBeenCalledWith({ leadId: 'led_1', agentId: 'agt_1', claimedAt: now, expiresAt: new Date('2026-09-25T09:00:00.000Z') });
    expect(repository.update).toHaveBeenCalledWith('led_1', { assignedAgentId: 'agt_1', claimedByAgentId: 'agt_1', claimExpiresAt: new Date('2026-09-25T09:00:00.000Z') });
    expect(repository.update).toHaveBeenCalledWith('led_1', expect.objectContaining({ stage: 'CLAIMED' }));
    expect(result.claim).toEqual({ expiresAt: '2026-09-25T09:00:00.000Z', holdHours: 72 });
  });

  it('answers 409 with the code when the rules refuse', async () => {
    repository.countOpenFor.mockResolvedValue(10);
    await expect(claimLead('led_1', 'usr_agent', now)).rejects.toMatchObject({ statusCode: 409, details: { reason: 'CLAIM_CAP' } });
    expect(repository.createClaim).not.toHaveBeenCalled();
  });

  it('releases only a lead the agent holds, closing the claim and clearing the pin', async () => {
    repository.findById.mockResolvedValue(lead({ assignedAgentId: 'agt_1', claimedByAgentId: 'agt_1', claimExpiresAt: new Date(now.getTime() + DAY) }));
    await releaseLead('led_1', 'usr_agent', 'wrong number', now);
    expect(repository.closeOpenClaims).toHaveBeenCalledWith('led_1', now, 'wrong number');
    expect(repository.update).toHaveBeenCalledWith('led_1', { assignedAgentId: null, claimedByAgentId: null, claimExpiresAt: null });

    repository.findById.mockResolvedValue(lead({ assignedAgentId: 'agt_2' }));
    await expect(releaseLead('led_1', 'usr_agent', undefined, now)).rejects.toMatchObject({ statusCode: 409, details: { reason: 'NOT_HOLDER' } });
  });
});

describe('the hourly sweep', () => {
  it('lapses an unworked hold back to the pool and ends a worked one quietly', async () => {
    const claimedAt = new Date(now.getTime() - 73 * HOUR);
    repository.claimsExpiredBefore.mockResolvedValue([
      { id: 'clm_a', leadId: 'led_a', agentId: 'agt_1', claimedAt, expiresAt: new Date(now.getTime() - HOUR) },
      { id: 'clm_b', leadId: 'led_b', agentId: 'agt_1', claimedAt, expiresAt: new Date(now.getTime() - HOUR) },
    ]);
    repository.findById.mockImplementation(async (id: string) =>
      id === 'led_a'
        ? lead({ id, assignedAgentId: 'agt_1', claimedByAgentId: 'agt_1', claimExpiresAt: new Date(now.getTime() - HOUR), stage: 'CLAIMED' })
        : lead({ id, assignedAgentId: 'agt_1', claimedByAgentId: 'agt_1', claimExpiresAt: new Date(now.getTime() - HOUR), stage: 'CONTACTED', lastTouchedAt: new Date(now.getTime() - DAY) }),
    );
    const result = await sweepClaims(now);
    expect(result).toEqual({ lapsed: 1, warned: 0 });
    expect(repository.closeOpenClaims).toHaveBeenCalledWith('led_a', now, 'lapsed');
    expect(repository.update).toHaveBeenCalledWith('led_a', { assignedAgentId: null, claimedByAgentId: null, claimExpiresAt: null });
    expect(repository.closeOpenClaims).toHaveBeenCalledWith('led_b', now, 'worked — hold ended');
    expect(repository.update).toHaveBeenCalledWith('led_b', { claimedByAgentId: null, claimExpiresAt: null });
  });

  it('warns the holder an hour before, once per claim', async () => {
    repository.claimsExpiringBetween.mockResolvedValue([{ id: 'clm_c', leadId: 'led_1', agentId: 'agt_1', claimedAt: new Date(now.getTime() - 71 * HOUR), expiresAt: new Date(now.getTime() + 40 * 60 * 1000) }]);
    repository.findById.mockResolvedValue(lead({ assignedAgentId: 'agt_1', claimedByAgentId: 'agt_1', claimExpiresAt: new Date(now.getTime() + 40 * 60 * 1000), stage: 'CLAIMED' }));
    expect(await sweepClaims(now)).toEqual({ lapsed: 0, warned: 1 });
    expect(notifications.notify).toHaveBeenCalledWith('LEAD_CLAIM_LAPSING', 'usr_agt_1', { businessName: 'Suraj Kumar Prints', minutes: '40', deepLink: 'adx://lead/led_1' }, expect.objectContaining({ type: 'SYSTEM', inApp: expect.objectContaining({ relatedType: 'LEAD', relatedId: 'led_1' }) }));
    expect(await sweepClaims(now)).toEqual({ lapsed: 0, warned: 0 });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });
});

/* ── territories (D8) ──────────────────────────────────────────────────── */

describe('territories', () => {
  it('creates one with its bbox from the ring, for an agent of the side', async () => {
    const territory = await createTerritory({ name: 'Koramangala', side: 'PUBLISHER', polygon: ring, agentId: 'agt_1' }, 'usr_admin');
    expect(repository.createTerritory).toHaveBeenCalledWith(expect.objectContaining({ name: 'Koramangala', side: 'PUBLISHER', ...small, agentId: 'agt_1', city: 'Bengaluru', cityId: 'city_blr', createdById: 'usr_admin' }));
    expect(territory).toMatchObject({ id: 'ter_1', name: 'Koramangala', leadCount: 0 });
    await expect(createTerritory({ name: 'Ads', side: 'ADVERTISER', polygon: ring, agentId: 'agt_1' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    await expect(createTerritory({ name: 'Bad', side: 'PUBLISHER', polygon: [[1, 2]], agentId: 'agt_1' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('routes a point inside a ring to its agent, and nothing outside', async () => {
    repository.territoriesCovering.mockResolvedValue([{ id: 'ter_1', agentId: 'agt_9', polygon: ring }]);
    expect(await territoryFor({ side: 'PUBLISHER', latitude: 12.935, longitude: 77.625 })).toEqual({ id: 'ter_1', agentId: 'agt_9' });
    expect(await territoryFor({ side: 'PUBLISHER', latitude: 12.95, longitude: 77.625 })).toBeNull();
    expect(await territoryFor({ side: 'PUBLISHER', latitude: null, longitude: null })).toBeNull();
  });

  it('assigns every open, unassigned lead inside the polygon and leaves the held ones', async () => {
    repository.findOpenInBBox.mockResolvedValue([lead({ id: 'led_in' }), lead({ id: 'led_held', assignedAgentId: 'agt_2' }), lead({ id: 'led_out', latitude: 12.95 })]);
    const result = await assignInPolygon({ polygon: ring, side: 'PUBLISHER', agentId: 'agt_1' }, 'usr_admin');
    expect(result).toEqual({ assigned: 1, ids: ['led_in'] });
    expect(repository.update).toHaveBeenCalledWith('led_in', { assignedAgentId: 'agt_1', claimedByAgentId: null, claimExpiresAt: null });
  });
});

/* ── priority zones (D7) ───────────────────────────────────────────────── */

const zone = (over: Partial<ZoneRow> = {}): ZoneRow => ({ id: 'zone_1', name: 'Koramangala push', side: null, ring, category: null, topUp: 0, startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 7 * DAY), budgetCap: null, spent: 0, isActive: true, ...over });

describe('priority zones', () => {
  it('covers by ring, by category, or both — never by nothing', () => {
    expect(zoneCovers(zone(), lead(), now)).toBe(true);
    expect(zoneCovers(zone(), lead({ latitude: 12.95 }), now)).toBe(false);
    expect(zoneCovers(zone({ ring: null, category: 'wall' }), lead({ latitude: null, longitude: null }), now)).toBe(true);
    expect(zoneCovers(zone({ category: 'Hoarding' }), lead(), now)).toBe(false);
    expect(zoneCovers(zone({ side: 'ADVERTISER' }), lead(), now)).toBe(false);
    expect(zoneCovers(zone({ endsAt: new Date(now.getTime() - HOUR) }), lead(), now)).toBe(false);
    expect(zoneCovers(zone({ ring: null, category: null }), lead(), now)).toBe(false);
  });

  it("pays the zone's own top-up or the platform's, under the zone budget and the monthly cap", () => {
    expect(topUpAllowed(zone(), 200, 25000, 0)).toBe(200);
    expect(topUpAllowed(zone({ topUp: 350 }), 200, 25000, 0)).toBe(350);
    expect(topUpAllowed(zone({ topUp: 350, budgetCap: 1000, spent: 800 }), 200, 25000, 0)).toBe(200);
    expect(topUpAllowed(zone({ topUp: 350 }), 200, 25000, 24900)).toBe(100);
    expect(topUpAllowed(zone({ topUp: 350 }), 200, 25000, 25000)).toBe(0);
  });

  it('records the top-up once per lead, keyed on the zone, and adds it to the spend', async () => {
    repository.listZones.mockResolvedValue([{ id: 'zone_1', name: 'Koramangala push', side: null, polygon: ring, category: null, topUp: '0', startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 7 * DAY), budgetCap: null, spent: '0', isActive: true }]);
    const result = await payPriorityTopUp(lead({ assignedAgentId: 'agt_1' }), now);
    expect(result).toEqual({ paid: '200.00', zoneId: 'zone_1' });
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_1', event: 'LEAD_ACTIVATED', tier: 'BRONZE', side: 'PUBLISHER', orderId: 'priority:zone_1:led_1', amount: '200.00' }));
    expect(repository.addZoneSpend).toHaveBeenCalledWith('zone_1', '200.00');
    // The second activation hook on the same lead (a retry, a second zone) pays nothing more.
    repository.priorityTopUpPaid.mockResolvedValue(true);
    expect(await payPriorityTopUp(lead({ assignedAgentId: 'agt_1' }), now)).toEqual({ paid: null, zoneId: 'zone_1' });
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledTimes(1);
    expect(repository.addZoneSpend).toHaveBeenCalledTimes(1);
  });

  it('pays nothing without an agent, outside every zone, or when the month is spent', async () => {
    expect(await payPriorityTopUp(lead(), now)).toEqual({ paid: null, zoneId: null });
    repository.listZones.mockResolvedValue([{ id: 'zone_1', name: 'z', side: null, polygon: ring, category: null, topUp: '0', startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + DAY), budgetCap: null, spent: '0', isActive: true }]);
    expect(await payPriorityTopUp(lead({ assignedAgentId: 'agt_1', latitude: 12.95 }), now)).toEqual({ paid: null, zoneId: null });
    repository.priorityTopUpsSince.mockResolvedValue(25000);
    expect(await payPriorityTopUp(lead({ assignedAgentId: 'agt_1' }), now)).toEqual({ paid: null, zoneId: 'zone_1' });
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
  });

  it('creates a zone as a ring, a category, or both, never neither, and ending after it starts', async () => {
    await createZone({ name: 'Walls in Koramangala', polygon: ring, category: 'Wall', topUp: 300, startsAt: now, endsAt: new Date(now.getTime() + 7 * DAY), budgetCap: 5000 }, 'usr_admin');
    expect(repository.createZone).toHaveBeenCalledWith(expect.objectContaining({ name: 'Walls in Koramangala', category: 'Wall', topUp: 300, budgetCap: 5000, ...small }));
    await expect(createZone({ name: 'Nothing', startsAt: now, endsAt: new Date(now.getTime() + DAY) }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    await expect(createZone({ name: 'Backwards', category: 'Wall', startsAt: now, endsAt: new Date(now.getTime() - DAY) }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
  });
});

/* ── the map view ──────────────────────────────────────────────────────── */

describe('the map view', () => {
  it('draws pins in a small viewport with the claim state and the priority tint', async () => {
    repository.findOpenInBBox.mockResolvedValue([lead(), lead({ id: 'led_2', claimedByAgentId: 'agt_1', claimExpiresAt: new Date(now.getTime() + DAY), latitude: 12.93 })]);
    repository.listZones.mockResolvedValue([{ id: 'zone_1', name: 'z', side: null, polygon: ring, category: null, topUp: '250', startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + DAY), budgetCap: null, spent: '0', isActive: true }]);
    const view = await mapView({ bbox: small }, { userId: 'usr_agent', isAdmin: false }, now);
    expect(view.mode).toBe('PINS');
    expect(view.total).toBe(2);
    expect(view.pins[0]).toMatchObject({ id: 'led_1', temperature: 'HOT', claim: null, priority: true });
    expect(view.pins[1]).toMatchObject({ id: 'led_2', claim: { agentId: 'agt_1', mine: true, expiresAt: '2026-09-23T09:00:00.000Z' } });
    expect(view.zones).toEqual([{ id: 'zone_1', name: 'z', polygon: ring, topUp: '250.00' }]);
    expect(view.territories).toEqual([]);
  });

  it('clusters a city-sized viewport unless the desk asks for pins', async () => {
    repository.findOpenInBBox.mockResolvedValue([lead(), lead({ id: 'led_2', latitude: 13.1, longitude: 77.75 })]);
    const clustered = await mapView({ bbox: big }, { userId: 'usr_admin', isAdmin: true }, now);
    expect(clustered.mode).toBe('CLUSTERS');
    expect(clustered.clusters).toHaveLength(2);
    expect(clustered.pins).toEqual([]);
    const plotted = await mapView({ bbox: big, pins: true }, { userId: 'usr_admin', isAdmin: true }, now);
    expect(plotted.mode).toBe('PINS');
    expect(plotted.pins).toHaveLength(2);
  });

  it('caps the pins and filters MINE / OPEN', async () => {
    repository.findOpenInBBox.mockResolvedValue(Array.from({ length: PIN_CAP + 20 }, (_, i) => lead({ id: `led_${i}`, latitude: 12.93 + i * 0.00001, assignedAgentId: i % 2 ? 'agt_1' : null })));
    const all = await mapView({ bbox: small, pins: true }, { userId: 'usr_agent', isAdmin: false }, now);
    expect(all.pins).toHaveLength(PIN_CAP);
    const mine = await mapView({ bbox: small, claimed: 'MINE' }, { userId: 'usr_agent', isAdmin: false }, now);
    expect(mine.total).toBe((PIN_CAP + 20) / 2);
    const open = await mapView({ bbox: small, claimed: 'OPEN' }, { userId: 'usr_agent', isAdmin: false }, now);
    expect(open.total).toBe((PIN_CAP + 20) / 2);
  });
});

/* ── the nearby-hot alert ──────────────────────────────────────────────── */

describe('the nearby-hot alert', () => {
  it('offers an unclaimed HOT lead to the agents within a kilometre with a fix today, once each', async () => {
    const { registerMapPositionPort } = await import('../map.service');
    registerMapPositionPort(async (agentId) => (agentId === 'agt_near' ? { latitude: 12.936, longitude: 77.626, at: new Date(now.getTime() - HOUR) } : agentId === 'agt_far' ? { latitude: 13.1, longitude: 77.75, at: now } : { latitude: 12.935, longitude: 77.625, at: new Date(now.getTime() - 2 * DAY) }));
    repository.candidateAgents.mockResolvedValue([
      { id: 'agt_near', userId: 'usr_near', tier: 'BRONZE', cityId: 'city_blr', openLeads: 0 },
      { id: 'agt_far', userId: 'usr_far', tier: 'BRONZE', cityId: 'city_blr', openLeads: 0 },
      { id: 'agt_stale', userId: 'usr_stale', tier: 'BRONZE', cityId: 'city_blr', openLeads: 0 },
    ]);
    expect(await alertNearbyHot('led_1', now)).toBe(1);
    expect(notifications.notify).toHaveBeenCalledWith('LEAD_NEARBY_HOT', 'usr_near', expect.objectContaining({ businessName: 'Suraj Kumar Prints', deepLink: 'adx://lead/led_1' }), expect.objectContaining({ type: 'SYSTEM', inApp: expect.objectContaining({ relatedType: 'LEAD', relatedId: 'led_1' }) }));
    const vars = (notifications.notify.mock.calls as unknown as [string, string, { metres: string }][])[0]![2];
    expect(Number(vars.metres)).toBeLessThan(200);
    expect(await alertNearbyHot('led_1', now)).toBe(0);
  });

  it('stays quiet for a warm lead or a held one', async () => {
    repository.findById.mockResolvedValue(lead({ temperature: 'WARM' }));
    expect(await alertNearbyHot('led_1', now)).toBe(0);
    repository.findById.mockResolvedValue(lead({ assignedAgentId: 'agt_2' }));
    expect(await alertNearbyHot('led_1', now)).toBe(0);
    expect(repository.candidateAgents).not.toHaveBeenCalled();
  });
});
