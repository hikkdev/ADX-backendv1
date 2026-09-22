import { describe, expect, it } from 'vitest';

/**
 * AG-5 (the owner, 20 Sep 2026): "more educated and skilled ones can be
 * used to deal with more important clients or publishers."
 *
 * Pinned: the band-to-grade map with the defaults filling a malformed
 * store; the ranking — below the grade dropped when enforced (ranked last
 * when not), the closest fit first, then the higher tier, then DR 07's
 * lane, then the nearer agent; an agent from before the grade reads as G1.
 */

import { DEFAULT_ROUTING_SETTINGS, distanceKm, gradeRank, meetsGrade, requiredGradeForBand, requiredGradeForLead, routingSettingsFrom, tierRank } from '../grade-bands';
import { pickAssignable, rankCandidates, type DispatchCandidate } from '../offer-priority';

const agent = (id: string, over: Partial<DispatchCandidate> = {}): DispatchCandidate => ({
  id,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  maxActiveOrders: null,
  activeOrders: 0,
  recentOffers: [],
  grade: 'G1',
  tier: 'BRONZE',
  tierLevel: 'I',
  latitude: null,
  longitude: null,
  ...over,
});

describe('bands to grades', () => {
  it('maps a band to its grade, defaults filling a malformed store, and reads an ungraded agent as G1', () => {
    expect(routingSettingsFrom(null)).toEqual(DEFAULT_ROUTING_SETTINGS);
    const custom = routingSettingsFrom({ bands: { LARGE_AGENCY: 'G4', SMALL_AGENCY: 'nonsense' }, leadBands: { KEY: 'G2' }, enforce: false });
    expect(custom.bands).toEqual({ INDIVIDUAL: 'G1', SMALL_AGENCY: 'G2', LARGE_AGENCY: 'G4' });
    expect(custom.leadBands).toEqual({ STANDARD: 'G1', KEY: 'G2', ENTERPRISE: 'G4' });
    expect(custom.enforce).toBe(false);
    expect(requiredGradeForBand('LARGE_AGENCY')).toBe('G3');
    expect(requiredGradeForBand(null)).toBe('G1');
    expect(requiredGradeForLead('ENTERPRISE')).toBe('G4');
    expect(gradeRank(null)).toBe(1);
    expect(meetsGrade(null, 'G1')).toBe(true);
    expect(meetsGrade('G2', 'G3')).toBe(false);
    expect(tierRank('PLATINUM', 'III')).toBe(43);
    expect(tierRank(null, null)).toBe(0);
    expect(Math.round(distanceKm({ latitude: 12.9716, longitude: 77.5946 }, { latitude: 12.9352, longitude: 77.6245 })!)).toBe(5);
    expect(distanceKm({ latitude: null, longitude: null }, { latitude: 1, longitude: 1 })).toBeNull();
  });
});

describe('the ranking', () => {
  it('drops agents below the grade when enforced, and puts the closest fit first, then the higher tier', () => {
    const pool = [agent('g1'), agent('g4', { grade: 'G4' }), agent('g2-gold', { grade: 'G2', tier: 'GOLD' }), agent('g2-bronze', { grade: 'G2' }), agent('g3', { grade: 'G3' })];
    expect(rankCandidates(pool, { requiredGrade: 'G2', enforce: true }).map((c) => c.id)).toEqual(['g2-gold', 'g2-bronze', 'g3', 'g4']);
    // Not enforced: the G1 is still offered, last.
    expect(rankCandidates(pool, { requiredGrade: 'G2', enforce: false }).map((c) => c.id)).toEqual(['g2-gold', 'g2-bronze', 'g3', 'g4', 'g1']);
    // No ask reads as G1 asked: the everyday spot goes to the G1 first, so the senior agents stay free.
    expect(rankCandidates(pool).map((c) => c.id)).toEqual(['g1', 'g2-gold', 'g2-bronze', 'g3', 'g4']);
  });

  it('within a grade and tier, the fast lane, then the nearer agent, then the lighter load', () => {
    const spot = { latitude: 12.9716, longitude: 77.5946 };
    const far = agent('far', { latitude: 13.1, longitude: 77.7 });
    const near = agent('near', { latitude: 12.98, longitude: 77.6 });
    const slowed = agent('slowed', { latitude: 12.972, longitude: 77.595, recentOffers: Array.from({ length: 6 }, (_, i) => ({ status: i < 3 ? 'REJECTED' : 'ACCEPTED' })) });
    const loaded = agent('loaded', { latitude: 12.98, longitude: 77.6, activeOrders: 3 });
    expect(rankCandidates([far, loaded, slowed, near], { requiredGrade: 'G1', spot }).map((c) => c.id)).toEqual(['near', 'loaded', 'far', 'slowed']);
    // The pick is the first with room for the work.
    expect(pickAssignable([agent('full', { maxActiveOrders: 1, activeOrders: 1 }), agent('free')], { requiredGrade: 'G1' })?.id).toBe('free');
    expect(pickAssignable([agent('g1')], { requiredGrade: 'G3', enforce: true })).toBeNull();
  });
});
