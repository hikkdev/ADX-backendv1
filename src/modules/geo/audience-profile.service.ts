import { readThrough } from '../../shared/cache';
import {
  foldProvenance,
  meanAgreement,
  provenanceOf,
  type AudiencePolicy,
  type AudienceProvenanceByField,
  type AudienceProviderName,
  type AudienceShare,
  type AudienceVendor,
  type BlendedAudienceCatchment,
} from '../../shared/audience';
import { getPlatformSettings } from '../app-config';
import { audienceForSpots, currentPeriod, storedAudienceForListings } from '../listings';
import type { CityMatch, GeoCityRow, GeoRepository, ListingPoint } from './geo.repository';

/**
 * The city audience profile — Y-B (the owner, 15 Sep 2026): "rich data on
 * the audience in a particular geography."
 *
 * The blend over the city's spots' snapshots for a month: the mean daily
 * footfall of a spot, the hour and weekday profiles, the demographic mixes
 * weighted by footfall, how much of the city's supply the panels cover,
 * the vendors in force and how far they agree. It folds what the spot
 * reads already fetched and calls NO vendor — unless
 * `settings.audience.cityProfileSamplePoints` is above 0, in which case up
 * to that many grid points across the city (the bounding box of its placed
 * listings, else a 3 km circle around the city point) are asked once per
 * month per enabled vendor and kept as snapshots on synthetic listing keys
 * `city:<slug>:<n>`. **The cost:** each point is one billable call per
 * vendor per month per city — 16 points × 2 vendors × 50 cities is 1,600
 * calls a month — which is why the default is 0 and the readiness check
 * that reads the profile is soft.
 *
 * Cached a minute per (city, period) so the console's refreshes and the
 * readiness read share one fold. The lead score (when the leads lots
 * land) reads `footfall.daily` for fit through `cityAudienceProfile`.
 */

export const CITY_AUDIENCE_CACHE_TTL_S = 60;
/** The circle a city with no placed listing is sampled over. */
export const CITY_SAMPLE_RADIUS_M = 3_000;

export const cityAudienceCacheKey = (slug: string, period: string): string => `geo:city-audience:${slug}:${period}`;

export type CityAudienceProfile = {
  city: string;
  period: string;
  provenance: 'PANEL';
  /** The one name an old reader prints; NONE when nothing backs a figure. */
  provider: AudienceProviderName;
  /** The vendors in force, the policy the rows were blended by, who each folded group came from, and how far the vendors agree on daily footfall. */
  vendors: AudienceVendor[];
  policy: AudiencePolicy | null;
  provenanceByField: AudienceProvenanceByField;
  agreement: { footfall: number | null };
  /** Live spots in the city; those with a panel for the period; the share. */
  coverage: { spots: number; withSnapshot: number; ratio: number | null };
  /** The grid, when `settings.audience.cityProfileSamplePoints` is on: null when off. */
  samplePoints: { configured: number; asked: number; withSnapshot: number } | null;
  /** MEAN daily footfall per catchment (a city's spots overlap — a sum would double count), and the footfall-weighted profiles. */
  footfall: { daily: number | null; byHour: number[] | null; byWeekday: number[] | null };
  /** The mixes, weighted by each catchment's daily footfall (a catchment with no figure counts as an average one). */
  demographics: {
    ageBands: AudienceShare[] | null;
    gender: AudienceShare[] | null;
    incomeBands: AudienceShare[] | null;
    affinities: AudienceShare[] | null;
  };
  basis: string;
  computedAt: string;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Weighted mean of a share group across catchments; null when none carries it. */
function foldShares(rows: { weight: number; shares: AudienceShare[] | null }[]): AudienceShare[] | null {
  const carrying = rows.filter((r): r is { weight: number; shares: AudienceShare[] } => r.shares !== null && r.weight > 0);
  if (carrying.length === 0) return null;
  const totalWeight = carrying.reduce((sum, r) => sum + r.weight, 0);
  const byLabel = new Map<string, number>();
  for (const row of carrying) {
    for (const share of row.shares) {
      byLabel.set(share.label, (byLabel.get(share.label) ?? 0) + (share.share * row.weight) / totalWeight);
    }
  }
  return [...byLabel.entries()].map(([label, share]) => ({ label, share: round1(share) }));
}

/** Element-wise weighted mean of a profile; null when none carries one of the right length. */
function foldProfile(rows: { weight: number; profile: number[] | null }[], length: number): number[] | null {
  const carrying = rows.filter((r): r is { weight: number; profile: number[] } => r.profile !== null && r.profile.length === length && r.weight > 0);
  if (carrying.length === 0) return null;
  const totalWeight = carrying.reduce((sum, r) => sum + r.weight, 0);
  return Array.from({ length }, (_, i) => round1(carrying.reduce((sum, r) => sum + ((r.profile[i] ?? 0) * r.weight) / totalWeight, 0)));
}

export type CityAudienceFold = Pick<CityAudienceProfile, 'footfall' | 'demographics' | 'provenanceByField' | 'agreement'>;

/**
 * Folds blended catchments into one geography's — pure. Footfall is the
 * MEAN per catchment (the spots of a city overlap; a sum would count the
 * same street twice); the mixes and the profiles are weighted by each
 * catchment's daily footfall, a catchment with no figure counting as an
 * average one (1 when no figure is known at all).
 */
export function foldCityAudience(panels: BlendedAudienceCatchment[]): CityAudienceFold {
  const dailies = panels.map((p) => p.footfall.daily).filter((d): d is number => d !== null);
  const meanDaily = dailies.length > 0 ? dailies.reduce((a, b) => a + b, 0) / dailies.length : null;
  const rows = panels.map((p) => ({ weight: p.footfall.daily ?? meanDaily ?? 1, audience: p }));
  return {
    footfall: {
      daily: meanDaily === null ? null : Math.round(meanDaily),
      byHour: foldProfile(rows.map((r) => ({ weight: r.weight, profile: r.audience.footfall.byHour })), 24),
      byWeekday: foldProfile(rows.map((r) => ({ weight: r.weight, profile: r.audience.footfall.byWeekday })), 7),
    },
    demographics: {
      ageBands: foldShares(rows.map((r) => ({ weight: r.weight, shares: r.audience.demographics.ageBands }))),
      gender: foldShares(rows.map((r) => ({ weight: r.weight, shares: r.audience.demographics.gender }))),
      incomeBands: foldShares(rows.map((r) => ({ weight: r.weight, shares: r.audience.demographics.incomeBands }))),
      affinities: foldShares(rows.map((r) => ({ weight: r.weight, shares: r.audience.demographics.affinities }))),
    },
    provenanceByField: foldProvenance(panels.map((p) => provenanceOf(p))),
    agreement: { footfall: meanAgreement(panels.map((p) => p.agreement.footfall)) },
  };
}

export type SampleBox = { minLat: number; minLng: number; maxLat: number; maxLng: number };

/** The bounding box of the placed listings, else a `CITY_SAMPLE_RADIUS_M` circle's box around the city point; null when the city has no point either. */
export function sampleBox(points: ListingPoint[], city: Pick<GeoCityRow, 'latitude' | 'longitude'>): SampleBox | null {
  const placed = points.filter((p): p is { id: string; latitude: number; longitude: number } => p.latitude !== null && p.longitude !== null);
  if (placed.length > 0) {
    const lats = placed.map((p) => p.latitude);
    const lngs = placed.map((p) => p.longitude);
    return { minLat: Math.min(...lats), minLng: Math.min(...lngs), maxLat: Math.max(...lats), maxLng: Math.max(...lngs) };
  }
  if (city.latitude === null || city.longitude === null) return null;
  const dLat = CITY_SAMPLE_RADIUS_M / 111_320;
  const dLng = CITY_SAMPLE_RADIUS_M / (111_320 * Math.max(Math.cos((city.latitude * Math.PI) / 180), 0.01));
  return { minLat: city.latitude - dLat, minLng: city.longitude - dLng, maxLat: city.latitude + dLat, maxLng: city.longitude + dLng };
}

/**
 * Up to `n` points on a k × k grid across the box (k = ceil √n), corners
 * inclusive, row by row from the south-west; a single point is the centre.
 * Deterministic, so the synthetic keys `city:<slug>:<i>` name the same
 * place each month while the box holds.
 */
export function sampleGrid(box: SampleBox, n: number): { latitude: number; longitude: number }[] {
  if (n <= 0) return [];
  if (n === 1) return [{ latitude: (box.minLat + box.maxLat) / 2, longitude: (box.minLng + box.maxLng) / 2 }];
  const k = Math.ceil(Math.sqrt(n));
  const out: { latitude: number; longitude: number }[] = [];
  for (let row = 0; row < k && out.length < n; row += 1) {
    for (let col = 0; col < k && out.length < n; col += 1) {
      out.push({
        latitude: box.minLat + ((box.maxLat - box.minLat) * row) / (k - 1),
        longitude: box.minLng + ((box.maxLng - box.minLng) * col) / (k - 1),
      });
    }
  }
  return out;
}

export const sampleKey = (slug: string, i: number): string => `city:${slug}:${i}`;

const vendorLabel = (vendors: readonly AudienceVendor[]): string => vendors.join(' + ');

/** The fold, uncached. `repository` is the rollout service's (swappable for the tests). */
export async function buildCityAudienceProfile(
  city: GeoCityRow,
  match: CityMatch,
  repository: Pick<GeoRepository, 'listingPoints'>,
  period: string,
  now = new Date(),
): Promise<CityAudienceProfile> {
  const points = await repository.listingPoints(match);
  const stored = await storedAudienceForListings(
    points.map((p) => p.id),
    period,
  );
  const empty: CityAudienceFold = {
    footfall: { daily: null, byHour: null, byWeekday: null },
    demographics: { ageBands: null, gender: null, incomeBands: null, affinities: null },
    provenanceByField: { footfall: null, demographics: null, affinities: null },
    agreement: { footfall: null },
  };
  if (!stored) {
    return {
      city: city.slug,
      period,
      provenance: 'PANEL',
      provider: 'NONE',
      vendors: [],
      policy: null,
      ...empty,
      coverage: { spots: points.length, withSnapshot: 0, ratio: points.length > 0 ? 0 : null },
      samplePoints: null,
      basis: 'No audience vendor is configured',
      computedAt: now.toISOString(),
    };
  }

  const spotPanels = stored.spots.map((s) => s.audience).filter((a): a is BlendedAudienceCatchment => a !== null);

  // The sample grid: off by default, and every point a billable call per vendor per month.
  const configured = (await getPlatformSettings()).audience?.cityProfileSamplePoints ?? 0;
  let samplePoints: CityAudienceProfile['samplePoints'] = null;
  const samplePanels: BlendedAudienceCatchment[] = [];
  if (configured > 0) {
    const box = sampleBox(points, city);
    const grid = box ? sampleGrid(box, configured) : [];
    const sampled = grid.length > 0 ? await audienceForSpots(grid.map((p, i) => ({ listingId: sampleKey(city.slug, i), ...p })), period).catch(() => null) : null;
    for (const s of sampled?.spots ?? []) if (s.audience) samplePanels.push(s.audience);
    samplePoints = { configured, asked: grid.length, withSnapshot: samplePanels.length };
  }

  const panels = [...spotPanels, ...samplePanels];
  const fold = panels.length > 0 ? foldCityAudience(panels) : empty;
  const label = vendorLabel(stored.vendors);
  const coverage = { spots: points.length, withSnapshot: spotPanels.length, ratio: points.length > 0 ? Math.round((spotPanels.length / points.length) * 1000) / 1000 : null };
  return {
    city: city.slug,
    period,
    provenance: 'PANEL',
    provider: stored.vendor,
    vendors: stored.vendors,
    policy: stored.policy,
    ...fold,
    coverage,
    samplePoints,
    basis:
      panels.length === 0
        ? `${label} ${stored.vendors.length > 1 ? 'have' : 'has'} no stored panel for any of the ${points.length} live spot${points.length === 1 ? '' : 's'} in ${period}${samplePoints ? ` nor for the ${samplePoints.asked} sample points` : ''}`
        : `${label} panel${stored.vendors.length > 1 ? 's, blended,' : ''} on ${spotPanels.length} of ${points.length} live spot${points.length === 1 ? '' : 's'}${samplePoints ? ` and ${samplePanels.length} of ${samplePoints.asked} sample points` : ''}, ${period}; mixes weighted by footfall`,
    computedAt: now.toISOString(),
  };
}

/** The profile, cached a minute per (city, period). */
export async function cachedCityAudienceProfile(
  city: GeoCityRow,
  match: CityMatch,
  repository: Pick<GeoRepository, 'listingPoints'>,
  period: string | undefined,
  now = new Date(),
): Promise<CityAudienceProfile> {
  const month = period ?? currentPeriod(now);
  return readThrough(cityAudienceCacheKey(city.slug, month), CITY_AUDIENCE_CACHE_TTL_S, () => buildCityAudienceProfile(city, match, repository, month, now));
}
