import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import {
  askFailure,
  askVendors,
  blendAudience,
  getAudienceSetup,
  periodBounds,
  type AudienceCatchment,
  type AudiencePolicy,
  type AudienceProviderName,
  type AudienceVendor,
  type BlendedAudienceCatchment,
} from '../../shared/audience';
import { legacyAudienceProvider } from '../../shared/integrations';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import { assertCanEditListing } from './listings.service';

/**
 * The audience panel for a spot — G7 (Q109), Y-B.
 *
 * The footfall / data-panel vendors (GeoIQ and Azira, behind
 * `shared/audience`) are asked about the circle around a spot for one
 * month, and EACH vendor's raw answer is kept as an `AudienceSnapshot` per
 * (listing, vendor, period) — exactly the unique key — until a week past
 * the end of that month. So a vendor is asked ONCE per spot per month —
 * every screen that opens afterwards, every campaign analytics read that
 * folds the spot in, reads the rows. A vendor bills per call; a panel
 * figure for September does not change on the 14th.
 *
 * Y-B: the blend happens at READ time, from the rows, by the policy on the
 * integrations row. Switching the policy re-blends without a vendor call;
 * a vendor enabled later fills in on the next read (only the vendors that
 * lack a fresh row are asked); a vendor disabled later is left out of the
 * blend though its row stays.
 *
 * "Nothing there" is not cached: a null from a vendor is answered as null
 * and asked again next time, because it is far more often a vendor gap that
 * will fill than a spot with no catchment.
 */

/** A week after the month ends: the vendor's own late data has landed by then. */
const SNAPSHOT_GRACE_DAYS = 7;

export function snapshotExpiry(period: string): Date {
  const { end } = periodBounds(period);
  return new Date(end.getTime() + SNAPSHOT_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

/** YYYY-MM of `now`, UTC. */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type ListingAudience = {
  listingId: string;
  period: string;
  /** The one name an old reader prints: the footfall primary in force, else the first enabled vendor; NONE with none. */
  provider: AudienceProviderName;
  /** Y-B: the enabled set. */
  providers: AudienceVendor[];
  /** Null when no vendor is configured, or no vendor has anything for the circle. Blended by the policy; `rawByVendor` for the desk. */
  audience: BlendedAudienceCatchment | null;
  /** Says why `audience` is what it is, in words a screen can print. */
  basis: string;
  /** True when no vendor was called on this read — every answer came from the stored rows. */
  cached: boolean;
  /** Vendors in force that could not answer this read: skipped for want of credentials, or failed (429 / 502) — the other's answer stands. */
  unavailable: { vendor: AudienceVendor; reason: string }[];
};

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type SnapshotRead = {
  raw: Partial<Record<AudienceVendor, AudienceCatchment>>;
  cached: boolean;
  unavailable: { vendor: AudienceVendor; reason: string }[];
  /** What to throw when nothing answered and something failed — null when the vendors simply had nothing. */
  failure: unknown | null;
};

/**
 * Each enabled vendor's stored row for the month, or its fresh answer
 * stored — only the vendors that lack a fresh row are asked, in parallel,
 * each failure isolated. Never throws: `failure` says what the direct
 * read should surface when no vendor answered at all.
 */
async function readThroughSnapshots(
  listing: { id: string; latitude: number; longitude: number },
  vendors: readonly AudienceVendor[],
  period: string,
  radiusM: number,
): Promise<SnapshotRead> {
  const now = new Date();
  const raw: SnapshotRead['raw'] = {};
  const missing: AudienceVendor[] = [];
  await Promise.all(
    vendors.map(async (vendor) => {
      const stored = await repository.findAudienceSnapshot(listing.id, vendor, period);
      if (stored && (stored.expiresAt === null || stored.expiresAt > now)) raw[vendor] = stored.data as AudienceCatchment;
      else missing.push(vendor);
    }),
  );
  if (missing.length === 0) return { raw, cached: true, unavailable: [], failure: null };

  const ask = await askVendors(missing, listing.latitude, listing.longitude, radiusM, period);
  await Promise.all(
    missing.map(async (vendor) => {
      const answer = ask.raw[vendor];
      if (!answer) return;
      raw[vendor] = answer;
      await repository.upsertAudienceSnapshot({ listingId: listing.id, vendor, period, data: answer, expiresAt: snapshotExpiry(period) });
    }),
  );
  const unavailable = [
    ...ask.skipped.map((vendor) => ({ vendor, reason: 'not configured' })),
    ...ask.failed.map(({ vendor, error }) => ({ vendor, reason: reasonOf(error) })),
  ];
  const answered = Object.keys(raw).length > 0;
  return { raw, cached: ask.asked.length === 0 && ask.failed.length === 0, unavailable, failure: answered ? null : askFailure(ask, missing) };
}

export type AudienceViewer = { userId: string; isAdmin: boolean; advertiserId: string | null };

/**
 * Who may read a spot's audience: ADX; the publisher's side of the listing
 * (the publisher, the agent who onboarded them, an agent under a live
 * LISTINGS grant — the same door as an edit); or an advertiser who has the
 * spot in a campaign of theirs that is not a draft, in person or through
 * their agent naming them. A panel figure is what the vendor charges for,
 * so it is not a browse-level read.
 */
export async function assertCanReadAudience(listingId: string, viewer: AudienceViewer): Promise<void> {
  if (viewer.isAdmin) return;
  try {
    await assertCanEditListing(listingId, { userId: viewer.userId, isAdmin: false });
    return;
  } catch (err) {
    if (!(err instanceof ApiError) || err.statusCode !== 403) throw err;
  }
  if (viewer.advertiserId && (await repository.advertiserHasSpot(viewer.advertiserId, listingId))) return;
  throw new ApiError(403, 'FORBIDDEN', 'Only the publisher of this spot, or an advertiser who has booked it, may read its audience.');
}

const vendorLabel = (vendors: readonly AudienceVendor[]): string => vendors.join(' + ');

/** GET /listings/:id/audience — the panel for one spot, one month. */
export async function listingAudience(listingId: string, period: string | undefined, viewer: AudienceViewer): Promise<ListingAudience> {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  await assertCanReadAudience(listingId, viewer);

  const month = period ?? currentPeriod();
  const { vendors, policy, radiusM } = await getAudienceSetup();
  const provider = legacyAudienceProvider(vendors, policy);
  if (vendors.length === 0) {
    return { listingId, period: month, provider: 'NONE', providers: [], audience: null, basis: 'No audience vendor is configured', cached: false, unavailable: [] };
  }
  if (listing.latitude === null || listing.longitude === null) {
    return { listingId, period: month, provider, providers: vendors, audience: null, basis: 'This spot has no coordinates yet', cached: false, unavailable: [] };
  }
  const read = await readThroughSnapshots({ id: listing.id, latitude: listing.latitude, longitude: listing.longitude }, vendors, month, radiusM);
  const audience = blendAudience(read.raw, policy);
  if (!audience && read.failure) throw read.failure;
  return {
    listingId,
    period: month,
    provider,
    providers: vendors,
    audience,
    basis: audience
      ? `${vendorLabel(audience.vendors)} panel${audience.vendors.length > 1 ? 's, blended,' : ''} for the ${audience.radiusM} m catchment, ${month}${read.cached ? ' (stored)' : ''}`
      : `${vendorLabel(vendors)} ${vendors.length > 1 ? 'have' : 'has'} no panel for this catchment in ${month}`,
    cached: read.cached,
    unavailable: read.unavailable,
  };
}

/* ------------------------------------------------------------------ */
/* For campaigns' analytics and geo's city profile                     */
/* ------------------------------------------------------------------ */

export type SpotAudience = { listingId: string; audience: BlendedAudienceCatchment | null };

export type SpotsAudience = {
  /** The one name an old reader prints — see `ListingAudience.provider`. */
  vendor: AudienceVendor;
  /** Y-B: the enabled set. */
  vendors: AudienceVendor[];
  policy: AudiencePolicy;
  spots: SpotAudience[];
};

/**
 * The panel for each of a campaign's spots, for one month, through the
 * snapshots. Never throws: a vendor failure on one spot is that spot's
 * null and a log line, because the audience is a decoration on the
 * analytics, not the analytics. Returns null altogether when no vendor is
 * configured so the caller prints "no panel" rather than an empty fold.
 *
 * Y-B: `geo`'s city profile also reads through here for its sample
 * points, with synthetic `city:<slug>:<n>` keys — the same one-call-per-
 * month rule keeps a grid point's cost to one call per vendor per month.
 */
export async function audienceForSpots(
  spots: { listingId: string; latitude: number | null; longitude: number | null }[],
  period: string,
): Promise<SpotsAudience | null> {
  const { vendors, policy, radiusM } = await getAudienceSetup();
  if (vendors.length === 0) return null;
  const vendor = legacyAudienceProvider(vendors, policy) as AudienceVendor;
  const seen = new Set<string>();
  const results: SpotAudience[] = [];
  for (const spot of spots) {
    if (seen.has(spot.listingId)) continue;
    seen.add(spot.listingId);
    if (spot.latitude == null || spot.longitude == null) {
      results.push({ listingId: spot.listingId, audience: null });
      continue;
    }
    try {
      const read = await readThroughSnapshots({ id: spot.listingId, latitude: spot.latitude, longitude: spot.longitude }, vendors, period, radiusM);
      if (read.failure) {
        logger.warn('audience panel unavailable for spot', { listingId: spot.listingId, vendors, period, err: reasonOf(read.failure) });
      }
      results.push({ listingId: spot.listingId, audience: blendAudience(read.raw, policy) });
    } catch (err) {
      logger.warn('audience panel unavailable for spot', { listingId: spot.listingId, vendors, period, err: reasonOf(err) });
      results.push({ listingId: spot.listingId, audience: null });
    }
  }
  return { vendor, vendors, policy, spots: results };
}

/**
 * Y-B: the STORED panels for these listings (or synthetic keys) in a
 * month, blended by the policy in force — no vendor is called, whatever
 * is missing stays missing. Rows of a vendor no longer enabled are left
 * out; expired rows are folded (they still describe the month — expiry
 * only says a spot read would refetch). Null altogether when no vendor is
 * configured. `geo`'s city profile folds a city's spots through here.
 */
export async function storedAudienceForListings(listingIds: string[], period: string): Promise<SpotsAudience | null> {
  const { vendors, policy } = await getAudienceSetup();
  if (vendors.length === 0) return null;
  const vendor = legacyAudienceProvider(vendors, policy) as AudienceVendor;
  const ids = [...new Set(listingIds)];
  const rows = await repository.findAudienceSnapshots(ids, period);
  const byListing = new Map<string, Partial<Record<AudienceVendor, AudienceCatchment>>>();
  for (const row of rows) {
    if (!vendors.includes(row.vendor as AudienceVendor)) continue;
    const raw = byListing.get(row.listingId) ?? {};
    raw[row.vendor as AudienceVendor] = row.data as AudienceCatchment;
    byListing.set(row.listingId, raw);
  }
  return {
    vendor,
    vendors,
    policy,
    spots: ids.map((listingId) => ({ listingId, audience: blendAudience(byListing.get(listingId) ?? {}, policy) })),
  };
}
