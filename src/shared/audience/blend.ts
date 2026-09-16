import type { AudiencePolicy } from '../integrations';
import {
  AUDIENCE_VENDORS,
  type AudienceCatchment,
  type AudienceProvenanceByField,
  type AudienceShare,
  type AudienceSource,
  type AudienceVendor,
  type BlendedAudienceCatchment,
} from './types';

/**
 * The blend — Y-B (the owner, 15 Sep 2026): both vendors at once, for
 * rich data on the audience in a geography.
 *
 * Pure: raw answers in, one catchment out, with the policy deciding per
 * field group. Each field is the primary's; the other vendor's fills a
 * null when the group's `fallback` is on; footfall's three figures are
 * AVERAGED when both vendors carry them and the policy says `AVERAGE`.
 * Nothing is invented: a field neither vendor has stays null, and the
 * per-field provenance names exactly who contributed — one vendor, or
 * `BLENDED` when both did (an averaged figure, or a group whose fields
 * came from different vendors).
 *
 * Stored per vendor and blended on read, so a policy change re-blends
 * without a vendor call (`listings`' snapshots, `geo`'s city profile).
 */

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 1 - |a - b| / max(a, b): 1 when the two figures are identical, 0 when one is nothing. Two zeros agree. */
export function footfallAgreement(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return 1;
  return Math.round((1 - Math.abs(a - b) / max) * 1000) / 1000;
}

/** Element-wise mean of two profiles of the same length, or null. */
function averageProfile(a: number[] | null, b: number[] | null): number[] | null {
  if (!a || !b || a.length !== b.length) return null;
  return a.map((v, i) => round1((v + (b[i] ?? 0)) / 2));
}

type Pair<T> = { primary: T | null; other: T | null; primaryVendor: AudienceVendor; otherVendor: AudienceVendor | null };

/** The primary's value, else the other's when the fallback is on. Says who gave it. */
function pick<T>(p: Pair<T>, fallback: boolean): { value: T | null; from: AudienceVendor | null } {
  if (p.primary !== null) return { value: p.primary, from: p.primaryVendor };
  if (fallback && p.other !== null && p.otherVendor) return { value: p.other, from: p.otherVendor };
  return { value: null, from: null };
}

/** One vendor -> that vendor; two -> BLENDED; none -> null. */
function sourceOf(from: (AudienceSource | null)[]): AudienceSource | null {
  const set = new Set<AudienceVendor>();
  for (const f of from) {
    if (f === 'BLENDED') return 'BLENDED';
    if (f) set.add(f);
  }
  if (set.size === 0) return null;
  return set.size === 1 ? [...set][0]! : 'BLENDED';
}

/** The other vendor — the one that is not `vendor`. */
export function otherVendor(vendor: AudienceVendor): AudienceVendor {
  return vendor === 'AZIRA' ? 'GEOIQ' : 'AZIRA';
}

/**
 * Folds the raw per-vendor answers into one blended catchment. Null when
 * no vendor answered. `period` and `radiusM` come from the answers;
 * `fetchedAt` is the latest of them.
 */
export function blendAudience(
  raw: Partial<Record<AudienceVendor, AudienceCatchment | null | undefined>>,
  policy: AudiencePolicy,
): BlendedAudienceCatchment | null {
  const rawByVendor: Partial<Record<AudienceVendor, AudienceCatchment>> = {};
  for (const vendor of AUDIENCE_VENDORS) {
    const answer = raw[vendor];
    if (answer) rawByVendor[vendor] = answer;
  }
  const vendors = AUDIENCE_VENDORS.filter((vendor) => rawByVendor[vendor] !== undefined);
  if (vendors.length === 0) return null;

  const pair = <T>(primaryVendor: AudienceVendor, read: (c: AudienceCatchment) => T | null): Pair<T> => {
    const other = otherVendor(primaryVendor);
    const p = rawByVendor[primaryVendor];
    const o = rawByVendor[other];
    return { primary: p ? read(p) : null, other: o ? read(o) : null, primaryVendor, otherVendor: o ? other : null };
  };

  /* footfall */
  const ff = policy.footfall;
  const average = ff.blend === 'AVERAGE';
  const footfallField = <T>(read: (c: AudienceCatchment) => T | null, avg: (a: T, b: T) => T | null): { value: T | null; from: AudienceSource | null } => {
    const p = pair(ff.primary, read);
    if (average && p.primary !== null && p.other !== null) {
      const blended = avg(p.primary, p.other);
      if (blended !== null) return { value: blended, from: 'BLENDED' };
    }
    return pick(p, ff.fallback);
  };
  const daily = footfallField(
    (c) => c.footfall.daily,
    (a, b) => Math.round((a + b) / 2),
  );
  const byHour = footfallField((c) => c.footfall.byHour, averageProfile);
  const byWeekday = footfallField((c) => c.footfall.byWeekday, averageProfile);

  /* demographics */
  const dg = policy.demographics;
  const ageBands = pick(pair(dg.primary, (c) => c.demographics.ageBands), dg.fallback);
  const gender = pick(pair(dg.primary, (c) => c.demographics.gender), dg.fallback);
  const incomeBands = pick(pair(dg.primary, (c) => c.demographics.incomeBands), dg.fallback);

  /* affinities */
  const af = policy.affinities;
  const affinities = pick(pair(af.primary, (c) => c.demographics.affinities), af.fallback);

  const provenanceByField: AudienceProvenanceByField = {
    footfall: sourceOf([daily.from, byHour.from, byWeekday.from]),
    demographics: sourceOf([ageBands.from, gender.from, incomeBands.from]),
    affinities: sourceOf([affinities.from]),
  };

  const first = rawByVendor[vendors[0]!]!;
  const fetchedAt = vendors.map((v) => rawByVendor[v]!.fetchedAt).sort().pop() ?? first.fetchedAt;
  const footfallSource = provenanceByField.footfall;
  const vendor: AudienceVendor =
    footfallSource && footfallSource !== 'BLENDED' ? footfallSource : vendors.includes(ff.primary) ? ff.primary : vendors[0]!;

  return {
    footfall: { daily: daily.value, byHour: byHour.value, byWeekday: byWeekday.value },
    demographics: {
      ageBands: ageBands.value as AudienceShare[] | null,
      gender: gender.value as AudienceShare[] | null,
      incomeBands: incomeBands.value as AudienceShare[] | null,
      affinities: affinities.value as AudienceShare[] | null,
    },
    provenance: 'PANEL',
    provenanceByField,
    vendor,
    vendors,
    agreement: { footfall: footfallAgreement(rawByVendor.GEOIQ?.footfall.daily ?? null, rawByVendor.AZIRA?.footfall.daily ?? null) },
    rawByVendor,
    period: first.period,
    radiusM: first.radiusM,
    fetchedAt,
  };
}

/** Folds several catchments' per-field provenance: the union — one vendor, or BLENDED. Null where none carried the group. */
export function foldProvenance(rows: (AudienceProvenanceByField | null | undefined)[]): AudienceProvenanceByField {
  const present = rows.filter((r): r is AudienceProvenanceByField => !!r);
  return {
    footfall: sourceOf(present.map((r) => r.footfall)),
    demographics: sourceOf(present.map((r) => r.demographics)),
    affinities: sourceOf(present.map((r) => r.affinities)),
  };
}

/**
 * A catchment's provenance by field — the blended one's own, or, for a
 * raw single-vendor catchment (a stored row, an old reader's fixture),
 * every group it carries is that vendor's.
 */
export function provenanceOf(catchment: AudienceCatchment & { provenanceByField?: AudienceProvenanceByField }): AudienceProvenanceByField {
  if (catchment.provenanceByField) return catchment.provenanceByField;
  const { footfall, demographics, vendor } = catchment;
  return {
    footfall: footfall.daily !== null || footfall.byHour !== null || footfall.byWeekday !== null ? vendor : null,
    demographics: demographics.ageBands !== null || demographics.gender !== null || demographics.incomeBands !== null ? vendor : null,
    affinities: demographics.affinities !== null ? vendor : null,
  };
}

/** The mean of the agreements that exist, to three places; null when none does. */
export function meanAgreement(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  if (present.length === 0) return null;
  return Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 1000) / 1000;
}
