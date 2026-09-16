import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIENCE_POLICY, resolveAudiencePolicy } from '../../integrations';
import { blendAudience, foldProvenance, footfallAgreement, meanAgreement, otherVendor, provenanceOf } from '../blend';
import type { AudienceCatchment } from '../types';

/**
 * The blend — Y-B, pure.
 *
 * Pinned: each field group is the primary's; the other fills a null only
 * when the fallback is on; footfall is averaged when both answer and the
 * policy says AVERAGE, else the primary's; the per-field provenance names
 * one vendor or BLENDED and never invents; the agreement is
 * 1 − |a − b| / max(a, b); the raw answers ride along for the desk; one
 * vendor alone is that vendor's answer with the same shape.
 */

const geoiq = (over: Partial<AudienceCatchment> = {}): AudienceCatchment => ({
  footfall: { daily: 18000, byHour: null, byWeekday: null },
  demographics: {
    ageBands: [{ label: '18_24', share: 21 }, { label: '25_34', share: 34 }],
    gender: [{ label: 'male', share: 53 }, { label: 'female', share: 47 }],
    incomeBands: [{ label: 'high', share: 38 }],
    affinities: [{ label: 'fitness', share: 12 }],
  },
  provenance: 'PANEL',
  vendor: 'GEOIQ',
  period: '2026-09',
  radiusM: 500,
  fetchedAt: '2026-09-10T00:00:00.000Z',
  ...over,
});

const hours = new Array(24).fill(0).map((_, i) => (i === 8 ? 100 : 0));
const azira = (over: Partial<AudienceCatchment> = {}): AudienceCatchment => ({
  footfall: { daily: 22000, byHour: hours, byWeekday: [10, 10, 10, 10, 20, 20, 20] },
  demographics: {
    ageBands: [{ label: '18-24', share: 19 }, { label: '25-34', share: 36 }],
    gender: [{ label: 'male', share: 55 }, { label: 'female', share: 45 }],
    incomeBands: null,
    affinities: [{ label: 'Dining', share: 41 }],
  },
  provenance: 'PANEL',
  vendor: 'AZIRA',
  period: '2026-09',
  radiusM: 500,
  fetchedAt: '2026-09-12T00:00:00.000Z',
  ...over,
});

describe('blendAudience with the defaults', () => {
  it('averages footfall, takes GeoIQ`s mixes and affinities, names the sources and keeps the raw answers', () => {
    const blended = blendAudience({ GEOIQ: geoiq(), AZIRA: azira() }, DEFAULT_AUDIENCE_POLICY)!;
    expect(blended.footfall).toEqual({ daily: 20000, byHour: hours, byWeekday: [10, 10, 10, 10, 20, 20, 20] });
    expect(blended.demographics).toEqual(geoiq().demographics);
    expect(blended.provenanceByField).toEqual({ footfall: 'BLENDED', demographics: 'GEOIQ', affinities: 'GEOIQ' });
    expect(blended.provenance).toBe('PANEL');
    expect(blended.vendor).toBe('AZIRA');
    expect(blended.vendors).toEqual(['GEOIQ', 'AZIRA']);
    expect(blended.agreement.footfall).toBe(Math.round((1 - 4000 / 22000) * 1000) / 1000);
    expect(blended.rawByVendor).toEqual({ GEOIQ: geoiq(), AZIRA: azira() });
    expect(blended.fetchedAt).toBe('2026-09-12T00:00:00.000Z');
    expect(blended.period).toBe('2026-09');
    expect(blended.radiusM).toBe(500);
  });

  it('falls back to the other vendor for a null in the primary — and says so per group', () => {
    const blended = blendAudience({ GEOIQ: geoiq({ demographics: { ageBands: null, gender: null, incomeBands: null, affinities: null } }), AZIRA: azira() }, DEFAULT_AUDIENCE_POLICY)!;
    expect(blended.demographics.ageBands).toEqual(azira().demographics.ageBands);
    expect(blended.demographics.incomeBands).toBeNull();
    expect(blended.demographics.affinities).toEqual([{ label: 'Dining', share: 41 }]);
    expect(blended.provenanceByField).toEqual({ footfall: 'BLENDED', demographics: 'AZIRA', affinities: 'AZIRA' });
  });

  it('a group whose fields came from different vendors is BLENDED', () => {
    const blended = blendAudience({ GEOIQ: geoiq({ demographics: { ...geoiq().demographics, ageBands: null } }), AZIRA: azira() }, DEFAULT_AUDIENCE_POLICY)!;
    expect(blended.demographics.ageBands).toEqual(azira().demographics.ageBands);
    expect(blended.demographics.gender).toEqual(geoiq().demographics.gender);
    expect(blended.provenanceByField.demographics).toBe('BLENDED');
  });

  it('one vendor alone is that vendor`s answer in the blended shape, agreement null', () => {
    const only = blendAudience({ AZIRA: azira() }, DEFAULT_AUDIENCE_POLICY)!;
    expect(only.footfall).toEqual(azira().footfall);
    expect(only.demographics).toEqual(azira().demographics);
    expect(only.provenanceByField).toEqual({ footfall: 'AZIRA', demographics: 'AZIRA', affinities: 'AZIRA' });
    expect(only.vendor).toBe('AZIRA');
    expect(only.vendors).toEqual(['AZIRA']);
    expect(only.agreement.footfall).toBeNull();
    expect(only.rawByVendor).toEqual({ AZIRA: azira() });
    // GeoIQ alone under an Azira-first footfall policy: the fallback carries it, and `vendor` is who answered.
    const other = blendAudience({ GEOIQ: geoiq() }, DEFAULT_AUDIENCE_POLICY)!;
    expect(other.footfall.daily).toBe(18000);
    expect(other.vendor).toBe('GEOIQ');
    expect(other.provenanceByField.footfall).toBe('GEOIQ');
  });

  it('is null with nothing, and a null entry is no answer', () => {
    expect(blendAudience({}, DEFAULT_AUDIENCE_POLICY)).toBeNull();
    expect(blendAudience({ GEOIQ: null, AZIRA: undefined }, DEFAULT_AUDIENCE_POLICY)).toBeNull();
  });
});

describe('the policy', () => {
  it('PRIMARY blend prints the primary`s footfall alone, the agreement still measured', () => {
    const policy = resolveAudiencePolicy({ footfall: { blend: 'PRIMARY' } });
    const blended = blendAudience({ GEOIQ: geoiq(), AZIRA: azira() }, policy)!;
    expect(blended.footfall.daily).toBe(22000);
    expect(blended.provenanceByField.footfall).toBe('AZIRA');
    expect(blended.vendor).toBe('AZIRA');
    expect(blended.agreement.footfall).not.toBeNull();
  });

  it('with the fallback off, a null in the primary stays null — never the other vendor`s figure', () => {
    const policy = resolveAudiencePolicy({ footfall: { primary: 'GEOIQ', fallback: false, blend: 'PRIMARY' }, demographics: { fallback: false } });
    const blended = blendAudience({ GEOIQ: geoiq(), AZIRA: azira() }, policy)!;
    expect(blended.footfall).toEqual({ daily: 18000, byHour: null, byWeekday: null });
    expect(blended.provenanceByField.footfall).toBe('GEOIQ');
    const noGeoiqMixes = blendAudience({ GEOIQ: geoiq({ demographics: { ageBands: null, gender: null, incomeBands: null, affinities: null } }), AZIRA: azira() }, policy)!;
    expect(noGeoiqMixes.demographics.ageBands).toBeNull();
    expect(noGeoiqMixes.provenanceByField.demographics).toBeNull();
    // affinities keep their own fallback (on): Azira's fill in.
    expect(noGeoiqMixes.demographics.affinities).toEqual([{ label: 'Dining', share: 41 }]);
    expect(noGeoiqMixes.provenanceByField.affinities).toBe('AZIRA');
  });

  it('AVERAGE with the primary missing a panel the other has takes the other`s (fallback on) — BLENDED footfall', () => {
    const policy = resolveAudiencePolicy({ footfall: { primary: 'GEOIQ' } });
    const blended = blendAudience({ GEOIQ: geoiq(), AZIRA: azira() }, policy)!;
    expect(blended.footfall.daily).toBe(20000);
    expect(blended.footfall.byHour).toEqual(hours);
    expect(blended.provenanceByField.footfall).toBe('BLENDED');
    expect(blended.vendor).toBe('GEOIQ');
  });

  it('the swap is a form change: Azira-first mixes re-blend the same rows', () => {
    const policy = resolveAudiencePolicy({ demographics: { primary: 'AZIRA' }, affinities: { primary: 'AZIRA' } });
    const blended = blendAudience({ GEOIQ: geoiq(), AZIRA: azira() }, policy)!;
    expect(blended.demographics.ageBands).toEqual(azira().demographics.ageBands);
    // Azira has no income bands: GeoIQ's fill in, so the group is BLENDED.
    expect(blended.demographics.incomeBands).toEqual([{ label: 'high', share: 38 }]);
    expect(blended.provenanceByField).toEqual({ footfall: 'BLENDED', demographics: 'BLENDED', affinities: 'AZIRA' });
  });
});

describe('the agreement maths', () => {
  it('is 1 − |a − b| / max(a, b), to three places; two zeros agree; null without both', () => {
    expect(footfallAgreement(100, 100)).toBe(1);
    expect(footfallAgreement(88, 100)).toBe(0.88);
    expect(footfallAgreement(100, 88)).toBe(0.88);
    expect(footfallAgreement(0, 100)).toBe(0);
    expect(footfallAgreement(0, 0)).toBe(1);
    expect(footfallAgreement(18421, 21340)).toBe(0.863);
    expect(footfallAgreement(null, 100)).toBeNull();
    expect(footfallAgreement(100, null)).toBeNull();
  });

  it('a mean over sites ignores the sites without one', () => {
    expect(meanAgreement([0.8, null, 1, undefined])).toBe(0.9);
    expect(meanAgreement([null, undefined])).toBeNull();
    expect(meanAgreement([])).toBeNull();
  });
});

describe('provenance helpers', () => {
  it('folds per group across catchments — one vendor stays, two become BLENDED, none is null', () => {
    expect(
      foldProvenance([
        { footfall: 'GEOIQ', demographics: 'GEOIQ', affinities: null },
        { footfall: 'AZIRA', demographics: 'GEOIQ', affinities: null },
        null,
      ]),
    ).toEqual({ footfall: 'BLENDED', demographics: 'GEOIQ', affinities: null });
  });

  it('reads a raw single-vendor catchment as that vendor`s on every group it carries', () => {
    expect(provenanceOf(geoiq())).toEqual({ footfall: 'GEOIQ', demographics: 'GEOIQ', affinities: 'GEOIQ' });
    expect(provenanceOf(azira({ footfall: { daily: null, byHour: null, byWeekday: null } }))).toEqual({ footfall: null, demographics: 'AZIRA', affinities: 'AZIRA' });
    expect(provenanceOf(blendAudience({ GEOIQ: geoiq(), AZIRA: azira() }, DEFAULT_AUDIENCE_POLICY)!)).toEqual({ footfall: 'BLENDED', demographics: 'GEOIQ', affinities: 'GEOIQ' });
    expect(otherVendor('GEOIQ')).toBe('AZIRA');
    expect(otherVendor('AZIRA')).toBe('GEOIQ');
  });
});
