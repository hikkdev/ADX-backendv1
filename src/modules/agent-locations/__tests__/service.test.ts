import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LT-1 (live agent tracking, 22 Sep 2026): a ping becomes the live record
 * and, on a trip that is the agent's and still open, a trail — thinned,
 * with the arrival stamped inside the geofence and the order's own
 * position kept through the port; the live map lists every active agent
 * with a state and its alerts; the order timeline folds the trail into the
 * job's moments; the sweep honours the retention setting.
 */

const { state, repository, store, agents, settings, orderPort } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = {
    fixes: new Map<string, Row>(),
    trails: [] as Row[],
    points: [] as Row[],
    contexts: new Map<string, Row>(),
    agents: [] as Row[],
    seq: 0,
    reset() {
      this.fixes.clear();
      this.trails = [];
      this.points = [];
      this.contexts.clear();
      this.agents = [];
      this.seq = 0;
    },
  };
  const repository = {
    tripContext: vi.fn(async (kind: string, id: string) => state.contexts.get(`${kind}:${id}`) ?? null),
    agentSummaries: vi.fn(async (ids: string[]) => state.agents.filter((a) => ids.includes(a.id))),
    activeAgents: vi.fn(async (filter: Row) => state.agents.filter((a) => a.stage === 'ACTIVE' && (!filter.city || a.city === filter.city))),
    findTrail: vi.fn(async (agentId: string, kind: string, contextId: string) => state.trails.find((t) => t.agentId === agentId && t.kind === kind && t.contextId === contextId) ?? null),
    openTrail: vi.fn(async (data: Row) => {
      const row = { id: `trail_${++state.seq}`, ...data, destinationLat: data.destination?.latitude ?? null, destinationLng: data.destination?.longitude ?? null, lastFixAt: data.startedAt, arrivedAt: null, endedAt: null, pointCount: 0, distanceM: 0 };
      state.trails.push(row);
      return row;
    }),
    lastPoint: vi.fn(async (trailId: string) => [...state.points].reverse().find((p) => p.trailId === trailId) ?? null),
    appendPoint: vi.fn(async (trailId: string, p: Row, distanceM: number) => {
      state.points.push({ id: `pt_${++state.seq}`, trailId, ...p });
      const trail = state.trails.find((t) => t.id === trailId)!;
      trail.pointCount += 1;
      trail.distanceM += distanceM;
      trail.lastFixAt = p.at;
    }),
    touchTrail: vi.fn(async (trailId: string, patch: Row) => Object.assign(state.trails.find((t) => t.id === trailId)!, patch)),
    points: vi.fn(async (trailId: string) => state.points.filter((p) => p.trailId === trailId)),
    trailsForOrder: vi.fn(async (orderId: string) => state.trails.filter((t) => t.orderId === orderId)),
    openTrailsFor: vi.fn(async (agentId: string) => state.trails.filter((t) => t.agentId === agentId && !t.endedAt)),
    purgeBefore: vi.fn(async (cut: Date) => {
      const before = state.points.length;
      state.points = state.points.filter((p) => p.at >= cut);
      return { trails: 0, points: before - state.points.length };
    }),
    orderTimelineFacts: vi.fn(),
  };
  const store = {
    readLastFix: vi.fn(async (agentId: string) => state.fixes.get(agentId) ?? null),
    writeLastFix: vi.fn(async (fix: Row) => {
      state.fixes.set(fix.agentId, fix);
    }),
    listLastFixes: vi.fn(async () => [...state.fixes.values()]),
    clearFixContext: vi.fn(async (agentId: string) => {
      const fix = state.fixes.get(agentId);
      if (fix) state.fixes.set(agentId, { ...fix, context: null, tripStart: null });
    }),
  };
  const agents = { findAgentProfile: vi.fn(async (userId: string) => (userId === 'usr_1' ? { id: 'agt_1', userId } : null)) };
  const settings = {
    getPlatformSettings: vi.fn(async () => ({ tracking: { pingMovingSec: 45, pingStillSec: 300, mode: 'WHILE_USING', retentionDays: 30, geofenceRadiusM: 150, idleAlertMin: 15, lateGraceMin: 15, offRouteKm: 2, offlineAfterMin: 10, partiesSeeEta: true } })),
  };
  const orderPort = { update: vi.fn(async () => undefined) };
  return { state, repository, store, agents, settings, orderPort };
});

vi.mock('../prisma-agent-locations.repository', () => ({ prismaAgentLocationsRepository: repository }));
vi.mock('../agent-locations.store', () => store);
vi.mock('../../agents', () => agents);
vi.mock('../../app-config', () => settings);

import { foldTimeline, liveAgents, orderTimeline, recordPing, registerOrderPositionPort, sweepTrails } from '../agent-locations.service';

const MG_ROAD = { latitude: 12.9752, longitude: 77.6058 };
const KORAMANGALA = { latitude: 12.9352, longitude: 77.6245 };
const NOW = new Date('2026-09-22T10:00:00Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60000);

beforeEach(() => {
  vi.clearAllMocks();
  state.reset();
  registerOrderPositionPort(orderPort);
  state.agents.push({ id: 'agt_1', displayId: 'AGT-1', userId: 'usr_1', name: 'Rahul', mobile: '+919000000301', city: 'Bengaluru', sides: ['PUBLISHER'], status: 'ACTIVE', stage: 'ACTIVE' });
  state.agents.push({ id: 'agt_2', displayId: 'AGT-2', userId: 'usr_2', name: 'Priya', mobile: '+919000000302', city: 'Bengaluru', sides: ['ADVERTISER'], status: 'ACTIVE', stage: 'ACTIVE' });
  state.contexts.set('ORDER:ord_1', { kind: 'ORDER', id: 'ord_1', orderId: 'ord_1', agentId: 'agt_1', label: 'Install at Koramangala wall', destination: KORAMANGALA, slotAt: later(30), open: true, pickup: null });
  state.contexts.set('ORDER:ord_other', { kind: 'ORDER', id: 'ord_other', orderId: 'ord_other', agentId: 'agt_2', label: 'Somebody else’s', destination: KORAMANGALA, slotAt: null, open: true, pickup: null });
});

describe('a ping', () => {
  it('becomes the live record with no trip when it names none, and answers the still interval when parked', async () => {
    const answer = await recordPing('usr_1', { ...MG_ROAD, speed: 0 }, NOW);
    expect(answer).toMatchObject({ accepted: true, state: 'AVAILABLE', nextPingSec: 45, trip: null });
    expect(store.writeLastFix).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_1', context: null, movingAt: NOW.toISOString() }));
    // The same spot a minute later: not moved, still → the long interval.
    const again = await recordPing('usr_1', { ...MG_ROAD, speed: 0 }, later(1));
    expect(again.nextPingSec).toBe(300);
    expect(state.trails).toHaveLength(0);
  });

  it('on the agent’s open trip, opens the trail, keeps the fixes worth keeping, keeps the order’s position, and stamps the arrival inside the geofence', async () => {
    const first = await recordPing('usr_1', { ...MG_ROAD, speed: 9, context: { kind: 'ORDER', id: 'ord_1' } }, NOW);
    expect(first.state).toBe('TRAVELLING');
    expect(first.trip).toMatchObject({ kind: 'ORDER', id: 'ord_1', label: 'Install at Koramangala wall', arrived: false });
    expect(first.trip!.eta!.distanceM).toBeGreaterThan(4500);
    expect(state.trails).toHaveLength(1);
    expect(state.points).toHaveLength(1);
    expect(orderPort.update).toHaveBeenCalledWith('ord_1', MG_ROAD);

    // Five metres on, ten seconds later: the live record moves, the trail does not grow.
    await recordPing('usr_1', { latitude: MG_ROAD.latitude + 0.00004, longitude: MG_ROAD.longitude, speed: 9, context: { kind: 'ORDER', id: 'ord_1' } }, new Date(NOW.getTime() + 10000));
    expect(state.points).toHaveLength(1);
    expect(repository.touchTrail).toHaveBeenCalledWith('trail_1', expect.objectContaining({ lastFixAt: expect.any(Date) }));

    // Inside the geofence: arrived, once; the ETA is gone; the state is ON_SITE.
    const arrived = await recordPing('usr_1', { latitude: 12.9355, longitude: 77.6247, speed: 2, context: { kind: 'ORDER', id: 'ord_1' } }, later(12));
    expect(arrived.state).toBe('ON_SITE');
    expect(arrived.trip).toMatchObject({ arrived: true, eta: null });
    expect(state.trails[0]!.arrivedAt).toEqual(later(12));
    expect(state.points).toHaveLength(2);
    const parked = await recordPing('usr_1', { latitude: 12.9355, longitude: 77.6247, speed: 0, context: { kind: 'ORDER', id: 'ord_1' } }, later(13));
    expect(parked.trip!.arrivedAt).toBe(later(12).toISOString());
    expect(repository.touchTrail).not.toHaveBeenCalledWith('trail_1', expect.objectContaining({ arrivedAt: later(13) }));
  });

  it('ignores a trip that is not the agent’s or is closed, and a phone clock ten minutes off', async () => {
    const other = await recordPing('usr_1', { ...MG_ROAD, speed: 9, context: { kind: 'ORDER', id: 'ord_other' } }, NOW);
    expect(other.trip).toBeNull();
    state.contexts.set('ORDER:ord_1', { ...state.contexts.get('ORDER:ord_1')!, open: false });
    const closed = await recordPing('usr_1', { ...MG_ROAD, speed: 9, context: { kind: 'ORDER', id: 'ord_1' } }, NOW);
    expect(closed.trip).toBeNull();
    expect(state.trails).toHaveLength(0);
    await recordPing('usr_1', { ...MG_ROAD, at: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString() }, NOW);
    expect(store.writeLastFix).toHaveBeenLastCalledWith(expect.objectContaining({ at: NOW.toISOString() }));
    await expect(recordPing('usr_nobody', { ...MG_ROAD }, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the live map', () => {
  it('lists every active agent with a state, counts them, raises the alerts, and filters by side, state and search', async () => {
    await recordPing('usr_1', { ...MG_ROAD, speed: 0, context: { kind: 'ORDER', id: 'ord_1' } }, NOW);
    // Fifty minutes on, a fresh fix from the same spot, past the slot and its grace: idle and late.
    await recordPing('usr_1', { ...MG_ROAD, speed: 0, context: { kind: 'ORDER', id: 'ord_1' } }, later(50));
    const snapshot = await liveAgents({}, later(51));
    expect(snapshot.counts).toEqual({ OFFLINE: 1, AVAILABLE: 0, TRAVELLING: 0, ON_SITE: 0, STILL: 1 });
    const rahul = snapshot.agents.find((row) => row.agent.id === 'agt_1')!;
    expect(rahul.state).toBe('STILL');
    expect(rahul.alerts.map((a) => a.kind).sort()).toEqual(['IDLE', 'LATE']);
    expect(rahul.trip).toMatchObject({ label: 'Install at Koramangala wall', eta: expect.objectContaining({ minutes: expect.any(Number) }) });
    expect(snapshot.agents[0]!.agent.id).toBe('agt_1');
    expect(snapshot.alerts).toBe(2);
    const priya = snapshot.agents.find((row) => row.agent.id === 'agt_2')!;
    expect(priya).toMatchObject({ state: 'OFFLINE', fix: null, trip: null, alerts: [] });

    expect((await liveAgents({ side: 'ADVERTISER' }, later(51))).agents.map((r) => r.agent.id)).toEqual(['agt_2']);
    expect((await liveAgents({ state: 'STILL' }, later(51))).agents.map((r) => r.agent.id)).toEqual(['agt_1']);
    expect((await liveAgents({ q: 'agt-2' }, later(51))).agents.map((r) => r.agent.id)).toEqual(['agt_2']);
  });
});

describe('the order timeline', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    id: 'ord_1',
    reference: 'ORD_1',
    status: 'IN_PROGRESS',
    agentId: 'agt_1',
    slotTime: later(30),
    printReadyAt: null,
    site: { title: 'Koramangala wall', point: KORAMANGALA },
    printJob: { partnerName: 'Rapid Prints', point: MG_ROAD, readyAt: later(-60), handoverAt: later(-20) },
    installation: { status: 'IN_PROGRESS', startedAt: later(-10), completedAt: null },
    completedAt: null,
    ...over,
  });

  it('folds both legs from the print job, the trail and the milestone', () => {
    const trail = { kind: 'ORDER', startedAt: later(-40), arrivedAt: later(5), endedAt: null } as never;
    const steps = foldTimeline(facts(), [trail]);
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ['PRINT_READY', true],
      ['TO_PARTNER', true],
      ['PICKUP', true],
      ['TO_SITE', true],
      ['ARRIVED', true],
      ['INSTALLED', false],
    ]);
    expect(steps.find((s) => s.key === 'TO_SITE')!.at).toEqual(later(-20));
    expect(steps.find((s) => s.key === 'ARRIVED')!.at).toEqual(later(5));
    // No print job: the install leg only.
    const direct = foldTimeline(facts({ printJob: null, installation: { status: 'COMPLETED', startedAt: later(-10), completedAt: later(20) } }), [trail]);
    expect(direct.map((s) => s.key)).toEqual(['TO_SITE', 'ARRIVED', 'INSTALLED']);
    expect(direct[2]!.done).toBe(true);
  });

  it('reads the facts, the trails and the live agent', async () => {
    repository.orderTimelineFacts.mockResolvedValue(facts());
    await recordPing('usr_1', { ...MG_ROAD, speed: 9, context: { kind: 'ORDER', id: 'ord_1' } }, NOW);
    const timeline = await orderTimeline('ord_1', later(1));
    expect(timeline.order.reference).toBe('ORD_1');
    expect(timeline.trails).toHaveLength(1);
    expect(timeline.trails[0]!.points).toHaveLength(1);
    expect(timeline.live?.agent.id).toBe('agt_1');
    repository.orderTimelineFacts.mockResolvedValueOnce(null);
    await expect(orderTimeline('ord_none')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the sweep', () => {
  it('purges what is older than the retention setting', async () => {
    await recordPing('usr_1', { ...MG_ROAD, speed: 9, context: { kind: 'ORDER', id: 'ord_1' } }, NOW);
    expect(await sweepTrails(later(31 * 24 * 60))).toEqual({ trails: 0, points: 1, retentionDays: 30 });
  });
});
