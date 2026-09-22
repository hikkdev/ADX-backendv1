import { describe, expect, it } from 'vitest';
import { alertsFor, distanceM, distanceToSegmentM, etaTo, isArrived, nextPingSec, stateOf, worthKeeping, type LastFix } from '../agent-locations.rules';

/**
 * LT-1 (live agent tracking, 22 Sep 2026): the arithmetic behind the live
 * map, on numbers. Bengaluru: MG Road to Koramangala is about 5 km.
 */

const MG_ROAD = { latitude: 12.9752, longitude: 77.6058 };
const KORAMANGALA = { latitude: 12.9352, longitude: 77.6245 };
const rules = { geofenceRadiusM: 150, idleAlertMin: 15, lateGraceMin: 15, offRouteKm: 2, offlineAfterMin: 10 };
const at = (minutesAgo: number, now: Date) => new Date(now.getTime() - minutesAgo * 60000).toISOString();

const fix = (now: Date, over: Partial<LastFix> = {}): LastFix => ({
  agentId: 'agt_1',
  latitude: MG_ROAD.latitude,
  longitude: MG_ROAD.longitude,
  at: at(1, now),
  accuracy: 10,
  speed: 8,
  heading: 180,
  context: { kind: 'ORDER', id: 'ord_1', orderId: 'ord_1', label: 'Install at Koramangala wall', destination: KORAMANGALA, slotAt: null, arrivedAt: null },
  movingAt: at(1, now),
  tripStart: MG_ROAD,
  ...over,
});

describe('distances', () => {
  it('measures MG Road to Koramangala at about five kilometres, and a point beside the line as near it', () => {
    const d = distanceM(MG_ROAD, KORAMANGALA);
    expect(d).toBeGreaterThan(4500);
    expect(d).toBeLessThan(5200);
    const midway = { latitude: 12.9552, longitude: 77.6152 };
    expect(distanceToSegmentM(midway, MG_ROAD, KORAMANGALA)).toBeLessThan(150);
    const aside = { latitude: 12.9552, longitude: 77.6452 };
    expect(distanceToSegmentM(aside, MG_ROAD, KORAMANGALA)).toBeGreaterThan(2500);
  });

  it('keeps a fix that moved 25 m or waited 60 s, and drops the rest', () => {
    const t0 = new Date('2026-09-22T10:00:00Z');
    expect(worthKeeping(null, { ...MG_ROAD, at: t0 })).toBe(true);
    const prev = { ...MG_ROAD, at: t0 };
    expect(worthKeeping(prev, { latitude: MG_ROAD.latitude + 0.0001, longitude: MG_ROAD.longitude, at: new Date(t0.getTime() + 10000) })).toBe(false);
    expect(worthKeeping(prev, { latitude: MG_ROAD.latitude + 0.0003, longitude: MG_ROAD.longitude, at: new Date(t0.getTime() + 10000) })).toBe(true);
    expect(worthKeeping(prev, { ...MG_ROAD, at: new Date(t0.getTime() + 60000) })).toBe(true);
  });

  it('gives an ETA at the reported speed, floored at a city drive, and knows the geofence', () => {
    expect(etaTo({ ...MG_ROAD, speed: null }, null)).toBeNull();
    const slow = etaTo({ ...MG_ROAD, speed: 0 }, KORAMANGALA)!;
    expect(slow.minutes).toBeGreaterThanOrEqual(12);
    expect(slow.minutes).toBeLessThanOrEqual(15);
    const fast = etaTo({ ...MG_ROAD, speed: 15 }, KORAMANGALA)!;
    expect(fast.minutes).toBeLessThan(slow.minutes);
    expect(isArrived({ latitude: 12.9355, longitude: 77.6247 }, KORAMANGALA, rules)).toBe(true);
    expect(isArrived(MG_ROAD, KORAMANGALA, rules)).toBe(false);
    expect(isArrived(MG_ROAD, null, rules)).toBe(false);
  });
});

describe('state', () => {
  const now = new Date('2026-09-22T10:30:00Z');
  it('reads OFFLINE with no fix or an old one, AVAILABLE with no trip, TRAVELLING / STILL / ON_SITE on a trip', () => {
    expect(stateOf(null, now, rules)).toBe('OFFLINE');
    expect(stateOf(fix(now, { at: at(11, now) }), now, rules)).toBe('OFFLINE');
    expect(stateOf(fix(now, { context: null }), now, rules)).toBe('AVAILABLE');
    expect(stateOf(fix(now), now, rules)).toBe('TRAVELLING');
    expect(stateOf(fix(now, { speed: 0, movingAt: at(5, now) }), now, rules)).toBe('STILL');
    expect(stateOf(fix(now, { speed: 0, movingAt: at(1, now) }), now, rules)).toBe('TRAVELLING');
    expect(stateOf(fix(now, { context: { ...fix(now).context!, arrivedAt: at(2, now) } }), now, rules)).toBe('ON_SITE');
  });

  it('picks the moving interval when moving, the still one when parked', () => {
    const intervals = { pingMovingSec: 45, pingStillSec: 300 };
    expect(nextPingSec({ speed: 8 }, false, intervals)).toBe(45);
    expect(nextPingSec({ speed: 0 }, true, intervals)).toBe(45);
    expect(nextPingSec({ speed: 0 }, false, intervals)).toBe(300);
    expect(nextPingSec({ speed: null }, false, intervals)).toBe(300);
  });
});

describe('alerts', () => {
  const now = new Date('2026-09-22T10:30:00Z');
  it('raises nothing for a fresh fix on the way, and each flag on its own condition', () => {
    expect(alertsFor(fix(now), now, rules)).toEqual([]);
    expect(alertsFor(null, now, rules)).toEqual([]);
    // Idle: parked past the threshold while on the trip.
    expect(alertsFor(fix(now, { speed: 0, movingAt: at(20, now) }), now, rules).map((a) => a.kind)).toEqual(['IDLE']);
    // Late: the slot passed by more than the grace, not arrived.
    expect(alertsFor(fix(now, { context: { ...fix(now).context!, slotAt: at(30, now) } }), now, rules).map((a) => a.kind)).toEqual(['LATE']);
    expect(alertsFor(fix(now, { context: { ...fix(now).context!, slotAt: at(10, now) } }), now, rules)).toEqual([]);
    // Off route: well aside of the straight line.
    expect(alertsFor(fix(now, { latitude: 12.9552, longitude: 77.6452 }), now, rules).map((a) => a.kind)).toEqual(['OFF_ROUTE']);
    // Offline on a job: no fix for longer than the threshold.
    expect(alertsFor(fix(now, { at: at(25, now) }), now, rules).map((a) => a.kind)).toEqual(['OFFLINE']);
    // Arrived: nothing is late, idle or off route any more.
    expect(alertsFor(fix(now, { speed: 0, movingAt: at(40, now), context: { ...fix(now).context!, slotAt: at(60, now), arrivedAt: at(5, now) } }), now, rules)).toEqual([]);
    // Off the job, an old fix is not an alert — the desk sees OFFLINE in the state.
    expect(alertsFor(fix(now, { at: at(25, now), context: null }), now, rules)).toEqual([]);
  });
});
