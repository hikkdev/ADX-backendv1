import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LEAD_SCORING, leadScoringSchema, temperatureOf } from '../../../shared/lead-scoring';
import { agentFlagPoints, computeScore, fitPoints, intentPoints, learnedQuality, recencyPoints, sourcePoints, temperatureChangeNote, type ScoreInput } from '../scoring.rules';
import { adminLeadsQuerySchema, leadPillOf, nearLeadsQuerySchema } from '../leads.schema';

/**
 * LH1 (the Lead Hunt, 22 Sep 2026) — the score.
 *
 * Pinned: each of the five signals on its own; the recency decay at the
 * three thresholds; the agent flag worth its points for fourteen days and
 * nothing after; the thresholds; the source's learned quality; the
 * temperature-change note; the pill reading the temperature; the facet on
 * both lists; the nightly job writing its day key only after success.
 */

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-22T09:00:00.000Z');
const policy = DEFAULT_LEAD_SCORING;

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  side: 'PUBLISHER',
  category: null,
  importance: 'STANDARD',
  createdAt: new Date(now.getTime() - 2 * DAY),
  lastTouchedAt: new Date(now.getTime() - 2 * DAY),
  agentFlaggedHotAt: null,
  source: null,
  activity: [],
  liveListingsNearby: null,
  ...over,
});

describe('the five signals', () => {
  it('fit: the category × side table, the default for a category nobody weighted, the band and the locality balance', () => {
    expect(fitPoints(input({ category: 'Gym' }), policy).points).toBe(22);
    expect(fitPoints(input({ category: 'Gym', side: 'ADVERTISER' }), policy).points).toBe(16);
    expect(fitPoints(input({ category: 'Unknown thing' }), policy).points).toBe(policy.fit.defaultCategory);
    expect(fitPoints(input({ category: 'Gym', importance: 'ENTERPRISE' }), policy).points).toBe(30); // 22 + 8
    expect(fitPoints(input({ category: 'Mall', importance: 'ENTERPRISE' }), policy).points).toBe(30); // 24 + 8 = 32, capped
    // A publisher lead where supply is thin gains; where it is rich it does not. The advertiser side reads it the other way.
    expect(fitPoints(input({ category: 'Cafe', liveListingsNearby: 1 }), policy).points).toBe(26);
    expect(fitPoints(input({ category: 'Cafe', liveListingsNearby: 12 }), policy).points).toBe(20);
    expect(fitPoints(input({ side: 'ADVERTISER', category: 'Clinic', liveListingsNearby: 12 }), policy).points).toBe(28);
    expect(fitPoints(input({ side: 'ADVERTISER', category: 'Clinic', liveListingsNearby: 1 }), policy).points).toBe(22);
  });

  it('intent: the thread summed and capped, an inbound door worth its points, the note naming the strongest signals', () => {
    expect(intentPoints(input(), policy)).toEqual({ signal: 'INTENT', points: 0, note: 'No response yet' });
    const called = intentPoints(input({ activity: [{ kind: 'CALLED', at: now }] }), policy);
    expect(called.points).toBe(5);
    expect(called.note).toBe('Spoke on a call');
    const busy = intentPoints(input({ activity: [{ kind: 'VISIT_BOOKED', at: now }, { kind: 'LINK_OPENED', at: now }, { kind: 'CALLED', at: now }, { kind: 'CALLED', at: now }] }), policy);
    expect(busy.points).toBe(35); // 20 + 10 + 5 + 5 = 40, capped
    expect(busy.note).toBe('A visit is booked · Opened the invite link'); // the two calls tie the link at 10 and lose the tie
    expect(intentPoints(input({ source: { quality: 9, kind: 'INBOUND' } }), policy).points).toBe(20);
    expect(intentPoints(input({ source: { quality: 5, kind: 'IMPORT' } }), policy).points).toBe(0);
    // A NOTE is not intent.
    expect(intentPoints(input({ activity: [{ kind: 'NOTE', at: now }] }), policy).points).toBe(0);
  });

  it('recency: nothing under seven days, then −5, −15, −25 at the three thresholds, from the last touch or the creation', () => {
    const at = (days: number) => recencyPoints(input({ lastTouchedAt: new Date(now.getTime() - days * DAY) }), policy, now).points;
    expect(at(0)).toBe(0);
    expect(at(6)).toBe(0);
    expect(at(7)).toBe(-5);
    expect(at(20)).toBe(-5);
    expect(at(21)).toBe(-15);
    expect(at(44)).toBe(-15);
    expect(at(45)).toBe(-25);
    expect(at(400)).toBe(-25);
    expect(recencyPoints(input({ lastTouchedAt: null, createdAt: new Date(now.getTime() - 30 * DAY) }), policy, now).points).toBe(-15);
    expect(recencyPoints(input({ lastTouchedAt: now }), policy, now).note).toBe('Touched today');
    expect(recencyPoints(input({ lastTouchedAt: new Date(now.getTime() - 25 * DAY) }), policy, now).note).toBe('Nothing for 25 days');
  });

  it('source: the learned quality, rounded and capped at the weight; nothing without a source', () => {
    expect(sourcePoints(input(), policy).points).toBe(0);
    expect(sourcePoints(input({ source: { quality: 12.4, kind: 'REFERRAL' } }), policy)).toEqual({ signal: 'SOURCE', points: 12, note: 'Referral source' });
    expect(sourcePoints(input({ source: { quality: 40, kind: 'ADS' } }), policy).points).toBe(15);
  });

  it('the agent flag: worth ten for fourteen days, nothing on the fifteenth', () => {
    expect(agentFlagPoints(input(), policy, now).points).toBe(0);
    expect(agentFlagPoints(input({ agentFlaggedHotAt: new Date(now.getTime() - 13 * DAY) }), policy, now)).toEqual({ signal: 'AGENT_FLAG', points: 10, note: 'Flagged hot by the agent (1 day left)' });
    expect(agentFlagPoints(input({ agentFlaggedHotAt: new Date(now.getTime() - 14 * DAY) }), policy, now).points).toBe(10);
    expect(agentFlagPoints(input({ agentFlaggedHotAt: new Date(now.getTime() - 14 * DAY - 1) }), policy, now)).toEqual({ signal: 'AGENT_FLAG', points: 0, note: 'Flag expired' });
  });
});

describe('the score and the temperature', () => {
  it('sums the five, clamps to 0–100 and lands in a temperature by the thresholds', () => {
    const cold = computeScore(input(), policy, now);
    expect(cold.score).toBe(12);
    expect(cold.temperature).toBe('COLD');
    expect(cold.reasons.map((r) => r.signal)).toEqual(['FIT', 'INTENT', 'RECENCY', 'SOURCE', 'AGENT_FLAG']);

    const hot = computeScore(input({ category: 'Gym', source: { quality: 12, kind: 'REFERRAL' }, activity: [{ kind: 'VISIT_BOOKED', at: now }], agentFlaggedHotAt: now, lastTouchedAt: now }), policy, now);
    // 22 + (20 + 20 inbound → capped at 35) + 0 + 12 + 10 = 79
    expect(hot.score).toBe(79);
    expect(hot.temperature).toBe('HOT');

    const warm = computeScore(input({ category: 'Gym', activity: [{ kind: 'CALLED', at: now }, { kind: 'MESSAGED', at: now }, { kind: 'LINK_OPENED', at: now }], lastTouchedAt: new Date(now.getTime() - 8 * DAY) }), policy, now);
    // 22 + 20 − 5 + 0 + 0 = 37 → COLD; with the flag 47 → WARM
    expect(warm.score).toBe(37);
    expect(warm.temperature).toBe('COLD');
    expect(computeScore(input({ category: 'Gym', activity: [{ kind: 'CALLED', at: now }, { kind: 'MESSAGED', at: now }, { kind: 'LINK_OPENED', at: now }], lastTouchedAt: new Date(now.getTime() - 8 * DAY), agentFlaggedHotAt: now }), policy, now).temperature).toBe('WARM');

    // A stale, unweighted, unflagged lead cannot go below zero.
    expect(computeScore(input({ category: 'x', lastTouchedAt: new Date(now.getTime() - 60 * DAY) }), policy, now).score).toBe(0);
  });

  it('thresholds are the policy’s: a tuned policy moves the lines', () => {
    expect(temperatureOf(70, policy.thresholds)).toBe('HOT');
    expect(temperatureOf(69, policy.thresholds)).toBe('WARM');
    expect(temperatureOf(40, policy.thresholds)).toBe('WARM');
    expect(temperatureOf(39, policy.thresholds)).toBe('COLD');
    expect(temperatureOf(60, { hot: 60, warm: 30 })).toBe('HOT');
  });

  it('the policy schema refuses a weight outside its range and takes the defaults whole', () => {
    expect(leadScoringSchema.safeParse(DEFAULT_LEAD_SCORING).success).toBe(true);
    expect(leadScoringSchema.safeParse({ ...DEFAULT_LEAD_SCORING, thresholds: { hot: 120, warm: 40 } }).success).toBe(false);
    expect(leadScoringSchema.safeParse({ ...DEFAULT_LEAD_SCORING, weights: { ...DEFAULT_LEAD_SCORING.weights, recencyMin: 5 } }).success).toBe(false);
  });

  it('the change note names the direction and the strongest driver', () => {
    const hot = computeScore(input({ category: 'Gym', activity: [{ kind: 'LINK_OPENED', at: now }], source: { quality: 12, kind: 'REFERRAL' }, agentFlaggedHotAt: now, lastTouchedAt: now }), policy, now);
    expect(temperatureChangeNote('WARM', 'HOT', hot.reasons)).toBe('Warmed up to Hot: Came to ADX themselves · Opened the invite link');
    const cold = computeScore(input({ lastTouchedAt: new Date(now.getTime() - 50 * DAY) }), policy, now);
    expect(temperatureChangeNote('WARM', 'COLD', cold.reasons)).toBe('Cooled to Cold: Nothing for 50 days');
    expect(temperatureChangeNote(null, 'WARM', hot.reasons)).toMatch(/^Warmed up to Warm/);
  });

  it('a source learns its quality from its own conversion rate, once it has a sample', () => {
    expect(learnedQuality(3, 3, 5, 15)).toBe(5); // three leads are not a rate
    expect(learnedQuality(100, 30, 5, 15)).toBe(15); // 30 % → 15
    expect(learnedQuality(100, 2, 5, 15)).toBe(1); // 2 % → 1
    expect(learnedQuality(100, 0, 5, 15)).toBe(1); // never zero: a source that exists is worth a point
    expect(learnedQuality(50, 8, 5, 15)).toBe(8); // 16 % → 8
  });
});

describe('what the lists and the pill read', () => {
  it('the pill reads the computed temperature for an open lead, and the lifecycle for a closed one', () => {
    expect(leadPillOf('NEW', 'HOT')).toEqual({ label: 'Hot', tone: 'hot' });
    expect(leadPillOf('CONTACTED', 'HOT')).toEqual({ label: 'Hot', tone: 'hot' });
    expect(leadPillOf('CONTACTED', 'WARM')).toEqual({ label: 'Contacted', tone: 'new' });
    expect(leadPillOf('NEW', 'COLD')).toEqual({ label: 'New', tone: 'new' });
    expect(leadPillOf('CONVERTED', 'HOT')).toEqual({ label: 'Converted', tone: 'live' });
    expect(leadPillOf('LOST', 'HOT')).toEqual({ label: 'Lost', tone: 'neutral' });
    // The legacy status HOT still reads as Hot for a row the migration did not reach.
    expect(leadPillOf('HOT')).toEqual({ label: 'Hot', tone: 'hot' });
  });

  it('both lists take one temperature and the HOTTEST sort; a temperature nobody has is refused', () => {
    expect(nearLeadsQuerySchema.parse({ temperature: 'HOT' }).temperature).toBe('HOT');
    expect(nearLeadsQuerySchema.parse({ sort: 'HOTTEST' }).sort).toBe('HOTTEST');
    expect(nearLeadsQuerySchema.safeParse({ temperature: 'LUKEWARM' }).success).toBe(false);
    expect(adminLeadsQuerySchema.parse({ temperature: 'COLD', sort: 'HOTTEST' })).toMatchObject({ temperature: 'COLD', sort: 'HOTTEST' });
  });
});

/* ── the nightly job ──────────────────────────────────────────────────── */

const { redis, leads } = vi.hoisted(() => ({
  redis: { set: vi.fn(), get: vi.fn() },
  leads: { recomputeAll: vi.fn(), learnSourceQuality: vi.fn() },
}));
vi.mock('../../../shared/cache', () => ({ redis }));
vi.mock('../../../shared/jobs', () => ({ recordHeartbeat: vi.fn() }));
vi.mock('../../../shared/errors', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/errors')>()), reportError: vi.fn() }));
vi.mock('../../leads', () => leads);

import { leadScoringTick } from '../../../jobs/lead-scoring.job';

describe('the nightly re-score', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.get.mockResolvedValue(null);
    leads.recomputeAll.mockResolvedValue({ scored: 12, moved: 3 });
    leads.learnSourceQuality.mockResolvedValue({ sources: 4, changed: 1 });
  });

  it('runs once per Indian day, learning the sources first, and writes the day key only after the run succeeded', async () => {
    await leadScoringTick(new Date('2026-09-22T20:00:00.000Z')); // 01:30 IST on the 23rd
    expect(leads.learnSourceQuality).toHaveBeenCalledTimes(1);
    expect(leads.recomputeAll).toHaveBeenCalledTimes(1);
    const dayKeyWrite = redis.set.mock.calls.find((call) => String(call[0]).startsWith('lock:lead-scoring:2026-09-23'));
    expect(dayKeyWrite).toBeTruthy();
    // The day key is written after the work, never before.
    const order = redis.set.mock.invocationCallOrder[1]!;
    expect(order).toBeGreaterThan(leads.recomputeAll.mock.invocationCallOrder[0]!);

    redis.get.mockResolvedValue('1');
    await leadScoringTick(new Date('2026-09-22T21:00:00.000Z'));
    expect(leads.recomputeAll).toHaveBeenCalledTimes(1);
  });

  it('a failed run leaves the day open for the next tick', async () => {
    leads.recomputeAll.mockRejectedValueOnce(new Error('neon hiccup'));
    await leadScoringTick(new Date('2026-09-22T20:00:00.000Z'));
    expect(redis.set.mock.calls.some((call) => String(call[0]).startsWith('lock:lead-scoring:2026-09-23'))).toBe(false);
  });

  it('another instance holding the tick lock does nothing', async () => {
    redis.set.mockResolvedValueOnce(null);
    await leadScoringTick(new Date('2026-09-22T20:00:00.000Z'));
    expect(leads.recomputeAll).not.toHaveBeenCalled();
  });
});
