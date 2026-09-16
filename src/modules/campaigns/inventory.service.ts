import { boundingBox, haversineMeters } from '../../shared/geo';
import { Decimal, money, type Money } from '../../shared/money';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { CampaignAggregate, CandidateListing } from './campaigns.repository';
import { flightDays } from './campaigns.service';

/**
 * Matching inventory — the screen that turns a brief into a shortlist.
 *
 * DR 02 draws a percentage against every spot ("94% match") and three sort
 * orders: best match, lowest rate, most reach. A percentage that comes out of
 * nowhere is worthless in a sales conversation, so the score here is built from
 * named components and returned *with* its reasons. An agent on the phone can
 * say why a spot is 94% and not 60%, and ops can argue with the weights rather
 * than with the number.
 *
 * Nothing in here invents audience data. Where a listing states no footfall
 * figure, the reach component simply does not contribute, and the spot says so.
 */

/** How much each component can contribute. They sum to 1. */
const WEIGHTS = {
  proximity: 0.35,
  goalFit: 0.2,
  personaFit: 0.15,
  budgetFit: 0.2,
  evidence: 0.1,
} as const;

export type MatchReason = { label: string; detail: string; contribution: number };

export type InventoryMatch = {
  listingId: string;
  title: string;
  city: string | null;
  address: string;
  photoUrl: string | null;
  mediaTypeId: string | null;
  mediaTypeName: string | null;
  mediaTypeCategory: string | null;
  venueTypeName: string | null;
  size: string | null;
  ratePerDay: Money;
  /** The whole flight, at this rate. What the cart adds up. */
  lineTotal: Money;
  distanceMeters: number | null;
  estimatedDailyFootfall: number | null;
  /** 0 to 100, as the frame prints it. */
  matchScore: number;
  reasons: MatchReason[];
  /** No slot left over these dates (Lot G, Q116/136) — every slot of the loop, or the one of a static wall, is held. */
  clashes: boolean;
};

export type InventorySort = 'BEST_MATCH' | 'LOWEST_RATE' | 'MOST_REACH';

/**
 * Which media categories serve which goal.
 *
 * Deliberately coarse. This is a sort order, not a policy: a digital screen is
 * a better bet for a digital-lift campaign, and a large-format hoarding for
 * awareness, but nothing here refuses to show anything.
 */
const GOAL_FIT: Record<string, string[]> = {
  DIGITAL_LIFT: ['DIGITAL', 'TRANSIT'],
  BRAND_AWARENESS: ['OUTDOOR', 'BILLBOARD', 'DIGITAL'],
  LOCAL_FOOTFALL: ['INDOOR', 'MALL', 'TRANSIT', 'RETAIL'],
};

/** Which venues suit which audience. Same caveat: a nudge, not a gate. */
const PERSONA_FIT: Record<string, string[]> = {
  B2B_DECISION_MAKERS: ['office', 'business', 'airport', 'hotel', 'corporate', 'tech park'],
  STUDENTS_OR_GEN_Z: ['college', 'university', 'mall', 'cafe', 'gym', 'cinema', 'metro'],
  HIGH_INCOME_CONSUMERS: ['mall', 'airport', 'hotel', 'club', 'premium', 'luxury', 'golf'],
  FAMILIES_OR_SUBURBAN: ['mall', 'residential', 'supermarket', 'school', 'park', 'cinema'],
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Everything a match is scored on, gathered so the function stays pure and the
 * tests can drive it without a database.
 */
export type ScoreInput = {
  listing: CandidateListing;
  goal: string | null;
  persona: string | null;
  strategy: string | null;
  /** Metres from the campaign's centre, when it has one. */
  distanceMeters: number | null;
  radiusMeters: number | null;
  /** What is left of the budget after the spots already in the cart. */
  budgetRemaining: Decimal | null;
  days: number;
};

export function scoreListing(input: ScoreInput): { score: number; reasons: MatchReason[] } {
  const { listing } = input;
  const reasons: MatchReason[] = [];
  let total = 0;

  /* Proximity — the closer to the middle of the circle, the better. A campaign
     with no centre (a whole market) scores this neutrally rather than zero,
     which would drag every market campaign down to the fifties. */
  if (input.distanceMeters !== null && input.radiusMeters) {
    const nearness = clamp01(1 - input.distanceMeters / input.radiusMeters);
    total += nearness * WEIGHTS.proximity;
    reasons.push({
      label: 'Distance',
      detail: `${(input.distanceMeters / 1000).toFixed(1)} km from the centre`,
      contribution: Math.round(nearness * WEIGHTS.proximity * 100),
    });
  } else {
    total += 0.7 * WEIGHTS.proximity;
    reasons.push({
      label: 'Area',
      detail: 'Inside the targeted market',
      contribution: Math.round(0.7 * WEIGHTS.proximity * 100),
    });
  }

  /* Goal fit — does this kind of media do the job asked of it. */
  const category = listing.mediaType?.category?.toUpperCase() ?? '';
  const goalCategories = input.goal ? (GOAL_FIT[input.goal] ?? []) : [];
  const goalHit = goalCategories.some((wanted) => category.includes(wanted));
  const goalScore = input.goal ? (goalHit ? 1 : 0.4) : 0.7;
  total += goalScore * WEIGHTS.goalFit;
  if (input.goal) {
    reasons.push({
      label: 'Goal fit',
      detail: goalHit
        ? `${listing.mediaType?.name ?? 'This format'} suits ${input.goal.toLowerCase().replace(/_/g, ' ')}`
        : `${listing.mediaType?.name ?? 'This format'} is not the usual choice for that goal`,
      contribution: Math.round(goalScore * WEIGHTS.goalFit * 100),
    });
  }

  /* Persona fit — does the venue put the brief's audience in front of it. */
  const venue = (listing.venueType?.name ?? '').toLowerCase();
  const personaWords = input.persona ? (PERSONA_FIT[input.persona] ?? []) : [];
  const personaHit = personaWords.some((word) => venue.includes(word));
  const personaScore = input.persona ? (personaHit ? 1 : 0.5) : 0.7;
  total += personaScore * WEIGHTS.personaFit;
  if (input.persona && listing.venueType) {
    reasons.push({
      label: 'Audience',
      detail: personaHit
        ? `${listing.venueType.name} reaches that audience`
        : `${listing.venueType.name} is a broader audience than asked for`,
      contribution: Math.round(personaScore * WEIGHTS.personaFit * 100),
    });
  }

  /* Budget fit — a spot that eats the whole budget is a worse match than one
     that leaves room for the rest of the plan. */
  const rate = listing.ratePerDay ? new Decimal(listing.ratePerDay) : null;
  if (rate && input.budgetRemaining && input.budgetRemaining.greaterThan(0)) {
    const cost = rate.times(input.days);
    const share = cost.dividedBy(input.budgetRemaining).toNumber();
    const fits = share <= 1;
    const budgetScore = fits ? clamp01(1 - share * 0.6) : 0;
    total += budgetScore * WEIGHTS.budgetFit;
    reasons.push({
      label: 'Budget',
      detail: fits
        ? `${Math.round(share * 100)}% of what is left`
        : 'More than the remaining budget',
      contribution: Math.round(budgetScore * WEIGHTS.budgetFit * 100),
    });
  } else {
    total += 0.5 * WEIGHTS.budgetFit;
  }

  /* Evidence — a spot with a photo and a stated footfall is a spot somebody can
     actually assess. Small weight, but it rewards complete listings. */
  const evidence =
    (listing.photos.length > 0 ? 0.5 : 0) + (listing.estimatedDailyFootfall ? 0.5 : 0);
  total += evidence * WEIGHTS.evidence;
  if (listing.estimatedDailyFootfall) {
    reasons.push({
      label: 'Footfall',
      detail: `${listing.estimatedDailyFootfall.toLocaleString('en-IN')} a day, stated by the publisher`,
      contribution: Math.round(evidence * WEIGHTS.evidence * 100),
    });
  }

  /* Strategy shifts what "best" means rather than adding a component: an attack
     campaign wants reach and will pay for it, a defensive one wants the money to
     go further. */
  if (input.strategy === 'ATTACK' && listing.estimatedDailyFootfall) total += 0.03;
  if (input.strategy === 'DEFENSIVE' && rate && input.budgetRemaining) {
    const cost = rate.times(input.days);
    if (cost.lessThan(input.budgetRemaining.dividedBy(3))) total += 0.03;
  }

  return { score: Math.round(clamp01(total) * 100), reasons };
}

const sizeOf = (listing: CandidateListing): string | null =>
  listing.widthFt && listing.heightFt
    ? `${new Decimal(listing.widthFt).toFixed(0)}×${new Decimal(listing.heightFt).toFixed(0)} ft`
    : null;

/**
 * The shortlist for a campaign, sorted as the screen asks.
 *
 * Spots already in the cart are excluded by the query rather than filtered
 * afterwards, so "load more" cannot start repeating what is already booked.
 */
export async function matchingInventory(
  campaign: CampaignAggregate,
  options: { sort?: InventorySort; limit?: number } = {}
): Promise<InventoryMatch[]> {
  const days = flightDays(campaign.startDate, campaign.endDate) || 1;
  const limit = Math.min(options.limit ?? 20, 50);

  /*
   * Every point this campaign wants to be near.
   *
   * A radius campaign has one — the centre the advertiser dropped. A POI
   * campaign has one per venue, and all of them count: the booking screen asks
   * for several pins and shows them on a map, so matching around only the first
   * would quietly throw the rest away. Pins without coordinates are skipped
   * rather than guessed at.
   */
  const centres: { lat: number; lng: number }[] =
    campaign.targetLatitude !== null && campaign.targetLongitude !== null
      ? [{ lat: campaign.targetLatitude, lng: campaign.targetLongitude }]
      : campaign.pois
          .filter((poi) => poi.latitude !== null && poi.longitude !== null)
          .map((poi) => ({ lat: poi.latitude!, lng: poi.longitude! }));

  // A POI campaign searches around each pin; the radius is the walk-up distance
  // rather than the campaign's own, because a pin is a place, not an area.
  const radiusMeters =
    campaign.targetingMethod === 'POI_VENUE'
      ? 2_000
      : campaign.targetRadiusKm
        ? campaign.targetRadiusKm * 1000
        : null;

  /**
   * How far a listing is from the nearest of those points.
   *
   * Nearest rather than first: a spot 300 m from the third venue is 300 m from
   * somewhere the audience goes, and the score should say so.
   */
  const distanceFromNearest = (lat: number, lng: number): number | null => {
    if (centres.length === 0) return null;
    return Math.round(
      Math.min(...centres.map((point) => haversineMeters(point.lat, point.lng, lat, lng)))
    );
  };

  /*
   * One box covering every point, since the prefilter is a single query.
   *
   * It over-selects — the space between two distant pins is inside the box and
   * outside every circle — which is exactly what the exact-distance filter
   * below is for. Over-selecting costs rows; under-selecting loses spots.
   */
  const box =
    centres.length > 0 && radiusMeters
      ? centres.reduce<
          { minLat: number; maxLat: number; minLng: number; maxLng: number } | undefined
        >((accumulated, point) => {
          const { latDelta, lngDelta } = boundingBox(point.lat, radiusMeters);
          const next = {
            minLat: point.lat - latDelta,
            maxLat: point.lat + latDelta,
            minLng: point.lng - lngDelta,
            maxLng: point.lng + lngDelta,
          };
          if (!accumulated) return next;
          return {
            minLat: Math.min(accumulated.minLat, next.minLat),
            maxLat: Math.max(accumulated.maxLat, next.maxLat),
            minLng: Math.min(accumulated.minLng, next.minLng),
            maxLng: Math.max(accumulated.maxLng, next.maxLng),
          };
        }, undefined)
      : undefined;

  // Lot D (Q107): several markets are city IN the list; one market, or none
  // listed, keeps the single-city fallbacks every earlier campaign relied on.
  const markets = (campaign.targetMarkets ?? []).filter((market) => market.trim());
  const candidates = await repository.candidateListings({
    ...(box ? { box } : {}),
    ...(!box && markets.length > 0 ? { cities: markets } : {}),
    ...(!box && markets.length === 0 && campaign.targetMarket ? { city: campaign.targetMarket } : {}),
    ...(!box && markets.length === 0 && !campaign.targetMarket && campaign.targetLocation
      ? { city: campaign.targetLocation }
      : {}),
    excludeListingIds: campaign.spots.map((spot) => spot.listingId),
    // Over-fetch: the exact radius filter and the clash check both remove rows.
    limit: limit * 4,
  });

  const spent = campaign.spots.reduce(
    (sum, spot) => sum.plus(new Decimal(spot.lineTotal)),
    new Decimal(0)
  );
  const budgetRemaining = campaign.budget ? new Decimal(campaign.budget).minus(spent) : null;

  const inRadius = candidates.filter((listing) => {
    if (centres.length === 0 || !radiusMeters) return true;
    if (listing.latitude === null || listing.longitude === null) return false;
    const distance = distanceFromNearest(listing.latitude, listing.longitude);
    return distance !== null && distance <= radiusMeters;
  });

  const clashing =
    campaign.startDate && campaign.endDate
      ? new Set(
          await repository.clashingListingIds(
            inRadius.map((listing) => listing.id),
            campaign.startDate,
            campaign.endDate
          )
        )
      : new Set<string>();

  const matches: InventoryMatch[] = inRadius.map((listing) => {
    const distanceMeters =
      listing.latitude !== null && listing.longitude !== null
        ? distanceFromNearest(listing.latitude, listing.longitude)
        : null;

    const { score, reasons } = scoreListing({
      listing,
      goal: campaign.goal,
      persona: campaign.persona,
      strategy: campaign.strategy,
      distanceMeters,
      radiusMeters,
      budgetRemaining,
      days,
    });

    const rate = new Decimal(listing.ratePerDay ?? 0);
    return {
      listingId: listing.id,
      title: listing.title,
      city: listing.city,
      address: listing.address,
      photoUrl: listing.photos[0]?.url ?? null,
      mediaTypeId: listing.mediaType?.id ?? null,
      mediaTypeName: listing.mediaType?.name ?? null,
      mediaTypeCategory: listing.mediaType?.category ?? null,
      venueTypeName: listing.venueType?.name ?? null,
      size: sizeOf(listing),
      ratePerDay: money(rate),
      lineTotal: money(rate.times(days)),
      distanceMeters,
      estimatedDailyFootfall: listing.estimatedDailyFootfall,
      matchScore: score,
      reasons,
      clashes: clashing.has(listing.id),
    };
  });

  const sorted = [...matches].sort((a, b) => {
    // A clashing spot is still shown — an operator may want to know it exists —
    // but never above one that can actually be booked.
    if (a.clashes !== b.clashes) return a.clashes ? 1 : -1;
    switch (options.sort ?? 'BEST_MATCH') {
      case 'LOWEST_RATE':
        return Number(a.ratePerDay) - Number(b.ratePerDay);
      case 'MOST_REACH':
        return (b.estimatedDailyFootfall ?? -1) - (a.estimatedDailyFootfall ?? -1);
      default:
        return b.matchScore - a.matchScore;
    }
  });

  return sorted.slice(0, limit);
}
