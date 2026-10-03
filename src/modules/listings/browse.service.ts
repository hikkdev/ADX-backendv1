import { env } from '../../config/env';
import { cityKeyFor, citySupport } from '../pricing';
import { ApiError } from '../../shared/errors';
import { Decimal } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import type { BrowseFilter, BrowseListing, BrowsePlace, CategoryTileListing, VenueTypeRow } from './listings.repository';
import { LISTING_CATEGORIES } from './listings.schema';
import { carriesLoop, slotsHeldFor, slotsLeft, windowFor, type SlotWindow } from './slots.service';
import { similarAnchor } from './prisma-listings.repository';
import { dailyHolds } from './slot-holds';
import { publicPhotoUrl } from './spot-page.service';
import { liveSponsored, shuffled, type SponsoredPlacement } from './sponsored.port';

/**
 * DR 01's advertiser discovery — "Find your space" (4189:2057), the browse
 * with its filter drawer (4189:2170, 4189:2440) and the listing page
 * (4358:18545).
 *
 * The first search endpoint an advertiser has had: `GET /listings` was
 * ADMIN-only and nothing else listed spots outside a campaign's own
 * inventory match. This reads ACTIVE listings by the drawer's facets and
 * hands back the card the frames draw — the spot, its photographs, its rate,
 * the facts the publisher recorded about it — and never the publisher's
 * contact details.
 *
 * What the frames draw and nothing computes is left off rather than filled:
 * "match %" belongs to a campaign's inventory step where a brief exists to
 * match against. Lot D filled three of the gaps: the rating and review count
 * are `reviews`' aggregate, denormalised onto the listing (Q104); "instant
 * booking" is the publisher's opt-in behind a flag (Q105); and the heart is a
 * saved space, per advertiser account (Q5).
 */

export type BrowseCard = {
  id: string;
  displayId: string | null;
  title: string;
  category: string;
  subType: string | null;
  address: string;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Money as a decimal string, per day; null while the publisher has set no rate. */
  ratePerDay: string | null;
  pricingUnit: string;
  basePrice: string | null;
  /** "40 × 20 ft", when both sides are measured. */
  size: string | null;
  photos: string[];
  description: string | null;
  illumination: string | null;
  facing: string | null;
  placement: string | null;
  visibility: string | null;
  estimatedDailyFootfall: number | null;
  availableNow: boolean;
  availableFrom: string | null;
  availableHoursFrom: string | null;
  availableHoursTo: string | null;
  peakPeriodNote: string | null;
  /** WG-1: the website wizard's extra claims, shown on the space's page. */
  maxBookingDays: number | null;
  advanceBookingDays: number | null;
  cancellationNoticeDays: number | null;
  /** LF-2: FLEXIBLE, NOTICE (with the days above) or NONE. */
  cancellationPolicy: string | null;
  /** LF-2: the publisher's "Available year-round?" — a statement, not the live `availableNow`. */
  availableYearRound: boolean | null;
  broadcastLanguage: string | null;
  contentFormat: string | null;
  vehicleType: string | null;
  vehicleModel: string | null;
  widthPx: number | null;
  heightPx: number | null;
  installationByAdx: boolean | null;
  targetAudience: string | null;
  uniqueSellingPoint: string | null;
  publisherName: string | null;
  /** W1: the publisher's id, for "other spaces by this publisher" through `?publisherId=` on the browse. */
  publisherId: string | null;
  /**
   * QR-5: whether the publisher's identity check is verified. An advertiser
   * sees the mark on the card; the list puts verified publishers' spots
   * first. False is "unverified", drawn as such — not hidden. ADX's own
   * spots (no publisher) count as verified.
   */
  publisherVerified: boolean;
  /** QR-7: the publisher's profile picture, when they added one. */
  publisherAvatarUrl: string | null;
  /** Metres from the point searched around, when one was given. */
  distanceM: number | null;
  /** Lot D (Q104): the published reviews' average, two places, or null while there are none. */
  ratingAvg: string | null;
  reviewCount: number;
  /** Lot D (Q5): whether the calling advertiser has this spot in their saved spaces. */
  saved: boolean;
  /** Lot D (Q105): a booking here is accepted without the publisher's tap. */
  instantBooking: boolean;
  /**
   * E11-2: what the share sheet sends — the public spot page at
   * `PUBLIC_WEB_URL/s/:displayId` (the API origin when no web front is
   * named). Null while the spot has no display id, which a live spot always
   * has: the reference is minted at submit.
   */
  shareUrl: string | null;
  /**
   * G12-B: what the spot is made of — `DIGITAL` when the one loop rule
   * (`slots.service.carriesLoop`: the sub-type, the media type's name or its
   * catalogue heading names a screen) says so, `STATIC` otherwise. Stamped
   * here so the apps stop repeating the rule.
   */
  display: 'DIGITAL' | 'STATIC';
  /** Lot G (Q116/136): how many advertisers the spot carries at once — a screen's loop, 1 for a static wall. */
  slotsTotal: number;
  /**
   * Lot G (Q116/136): of those, how many are free over the window the read
   * asked for (`from`/`to`, else today) — never below zero. The rate is per
   * slot per day, so a 6-slot screen at ₹1,000 costs each advertiser ₹1,000.
   */
  slotsLeft: number;
  /**
   * AV-1: of the window's days, how many have at least one slot free, and
   * how many days the window has — so a card can say "Partly booked · 21
   * of 31 days free" instead of "Booked" when only some dates are taken.
   */
  freeDays: number;
  windowDays: number;
  /**
   * LM-1: a sponsored listing — the publisher paid to have it shown first
   * (`promotions`' boosts). The card must say "Sponsored"; `boostId` is what
   * its impression and click events name. Absent on every organic card.
   */
  sponsored?: boolean;
  boostId?: string;
};

/**
 * E11-2: the address a shared spot opens at. `PUBLIC_WEB_URL` when a web
 * front sits in front of the API; otherwise the API's own origin, which
 * serves the page itself at `GET /s/:displayId`.
 */
export function shareUrlFor(displayId: string | null): string | null {
  if (!displayId) return null;
  const base = env.PUBLIC_WEB_URL ?? env.BASE_URL ?? `http://localhost:${env.PORT}`;
  return `${base.replace(/\/$/, '')}/s/${encodeURIComponent(displayId)}`;
}

/**
 * Who is looking — the advertiser account the `saved` mark is resolved for.
 * Null when the caller has none (ops, a publisher), and every card reads
 * unsaved.
 */
export type BrowseViewer = { advertiserId: string | null };

export type BrowsePage = {
  items: BrowseCard[];
  total: number;
  page: number;
  pageSize: number;
  /** SIM-1: when the page is "spaces like" one listing, which one — for the heading. */
  similarTo?: { id: string; displayId: string | null; title: string };
  /**
   * Lot V: the city filter named a catalogued city whose stage has demand
   * off — SEEDING, PAUSED, WITHDRAWN or PLANNED. The page is empty and says
   * why, so the phone draws "coming soon" and the waitlist rather than "no
   * spots". Absent everywhere else.
   */
  comingSoon?: { city: string; slug: string; stage: string };
};

const toMoney = (value: unknown): string | null => (value === null || value === undefined ? null : new Decimal(String(value)).toFixed(2));

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function toBrowseCard(
  listing: BrowseListing,
  near?: { latitude: number; longitude: number } | null,
  saved = false,
): BrowseCard {
  const width = listing.widthFt === null ? null : new Decimal(String(listing.widthFt));
  const height = listing.heightFt === null ? null : new Decimal(String(listing.heightFt));
  const distanceM =
    near && listing.latitude !== null && listing.longitude !== null
      ? Math.round(haversineMeters(near.latitude, near.longitude, listing.latitude, listing.longitude))
      : null;
  return {
    id: listing.id,
    displayId: listing.displayId,
    title: listing.title,
    category: listing.category,
    subType: listing.subType,
    address: listing.address,
    city: listing.city,
    latitude: listing.latitude,
    longitude: listing.longitude,
    ratePerDay: toMoney(listing.ratePerDay),
    pricingUnit: listing.pricingUnit,
    basePrice: toMoney(listing.basePrice),
    size: width && height ? `${width.toFixed(0)} × ${height.toFixed(0)} ft` : listing.size,
    photos: listing.photos.map((photo) => photo.url),
    description: listing.description,
    illumination: listing.illumination,
    facing: listing.facing,
    placement: listing.placement,
    visibility: listing.visibility,
    estimatedDailyFootfall: listing.estimatedDailyFootfall,
    availableNow: listing.availableNow,
    availableFrom: listing.availableFrom ? listing.availableFrom.toISOString() : null,
    availableHoursFrom: listing.availableHoursFrom,
    availableHoursTo: listing.availableHoursTo,
    peakPeriodNote: listing.peakPeriodNote,
    maxBookingDays: listing.maxBookingDays ?? null,
    advanceBookingDays: listing.advanceBookingDays ?? null,
    cancellationNoticeDays: listing.cancellationNoticeDays ?? null,
    cancellationPolicy: listing.cancellationPolicy ?? null,
    availableYearRound: listing.availableYearRound ?? null,
    broadcastLanguage: listing.broadcastLanguage ?? null,
    contentFormat: listing.contentFormat ?? null,
    vehicleType: listing.vehicleType ?? null,
    vehicleModel: listing.vehicleModel ?? null,
    widthPx: listing.widthPx ?? null,
    heightPx: listing.heightPx ?? null,
    installationByAdx: listing.installationByAdx ?? null,
    targetAudience: listing.targetAudience,
    uniqueSellingPoint: listing.uniqueSellingPoint,
    publisherId: listing.publisherId ?? null,
    publisherName: listing.publisher?.name ?? null,
    publisherVerified: listing.publisher === null || listing.publisher.kycStatus === 'VERIFIED',
    publisherAvatarUrl: listing.publisher?.user?.avatarUrl ?? null,
    distanceM,
    ratingAvg: listing.ratingAvg === null || listing.ratingAvg === undefined ? null : new Decimal(String(listing.ratingAvg)).toFixed(2),
    reviewCount: listing.reviewCount ?? 0,
    saved,
    instantBooking: listing.instantBooking ?? false,
    shareUrl: shareUrlFor(listing.displayId),
    display: carriesLoop({
      subType: listing.subType,
      mediaType: listing.mediaType ? { name: listing.mediaType.name, formatGroup: listing.mediaType.formatGroup ?? null } : null,
    })
      ? 'DIGITAL'
      : 'STATIC',
    slotsTotal: listing.slotsTotal ?? 1,
    // Stamped by `withSlots` once the page is known; a card built alone reads full.
    slotsLeft: listing.slotsTotal ?? 1,
    freeDays: 1,
    windowDays: 1,
  };
}

/**
 * Lot G (Q116/136): the slots left on each card over the window, in one
 * count for the page. The window is the caller's `from`/`to`; today when
 * neither was given.
 */
async function withSlots<T extends { id: string; slotsTotal: number }>(cards: T[], window: SlotWindow): Promise<(T & { slotsLeft: number; freeDays: number; windowDays: number })[]> {
  if (cards.length === 0) return [];
  // AV-1: one read of the page's holds with their days; the busiest day is
  // the slots left, and the days with room are counted beside it.
  const holds = await repository.datedHolds(cards.map((card) => card.id), window);
  return cards.map((card) => {
    const days = dailyHolds(holds.filter((hold) => hold.listingId === card.id), window);
    const peak = days.length ? Math.max(...days) : 0;
    return { ...card, slotsLeft: slotsLeft(card.slotsTotal, peak), freeDays: days.filter((held) => held < card.slotsTotal).length, windowDays: days.length };
  });
}

/**
 * Which of these spots the viewer has saved — one IN query for the page,
 * none at all when there is no advertiser to ask for.
 */
async function savedSet(viewer: BrowseViewer | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewer?.advertiserId || ids.length === 0) return new Set();
  return new Set(await repository.savedListingIds(viewer.advertiserId, ids));
}

/**
 * Lot V: a city filter naming a catalogued city with demand switched off
 * answers "coming soon" instead of rows. A city outside the catalogue, or
 * no city filter at all, answers rows as ever.
 */
/**
 * Lot X-L: browse stays on the typed city BY DESIGN — a shopper types, and
 * a town nobody catalogued must still find its spots by spelling. But the
 * typed value is resolved through `cityKeyFor` and, when it resolves, the
 * rows keyed to that city match as well as the spelling, so a shopper
 * typing 'Bangalore' sees the Bengaluru listings whatever they were typed
 * as. Nothing resolved: the spelling alone, as before.
 */
async function placeWithKey<T extends BrowsePlace>(place: T): Promise<T> {
  if (!place.city) return place;
  return { ...place, cityId: (await cityKeyFor(place.city))?.cityId ?? null };
}

async function comingSoonFor(city: string | undefined): Promise<BrowsePage['comingSoon'] | null> {
  if (!city) return null;
  const view = await citySupport(city);
  if (!view.resolved || view.switches.demand) return null;
  return { city: view.city!.name, slug: view.city!.slug, stage: view.stage! };
}

/**
 * A page of spots. Around a point, the box the repository selects is sorted
 * here by exact distance and cut to the radius, so "Popular near you" is
 * the nearest first and never something across the city that fell inside
 * the box's corner.
 */
export async function browseListings(
  input: BrowseFilter,
  page = 1,
  pageSize = 20,
  viewer?: BrowseViewer,
): Promise<BrowsePage> {
  const window = windowFor(input.from, input.to);
  // SIM-1: "View all similar listings" — the anchor listing resolves to the rule the row reads.
  let similarTo: BrowsePage['similarTo'] = undefined;
  if (input.similarToId) {
    const anchor = (await repository.findById(input.similarToId)) ?? (/^LST-/i.test(input.similarToId) ? await repository.findActiveByDisplayId(input.similarToId) : null);
    if (!anchor) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
    const { similarToId: _drop, ...rest } = input;
    input = { ...rest, similar: similarAnchor(anchor as never) };
    similarTo = { id: anchor.id, displayId: (anchor as { displayId?: string | null }).displayId ?? null, title: anchor.title };
  }
  const answer = await browseListingsResolved(input, page, pageSize, window, viewer);
  return similarTo ? { ...answer, similarTo } : answer;
}

async function browseListingsResolved(input: BrowseFilter, page: number, pageSize: number, window: SlotWindow, viewer?: BrowseViewer): Promise<BrowsePage> {
  const closed = await comingSoonFor(input.city);
  if (closed) return { items: [], total: 0, page, pageSize, comingSoon: closed };
  const filter = await placeWithKey(input);
  if (!filter.near) {
    // LM-1: page one of the default order carries today's sponsored listings
    // first — only those in the filtered set, each lifted out of its organic
    // place on the page. A chosen sort or a later page is left organic.
    const sponsored = page === 1 && filter.sort === 'NEWEST' ? await sponsoredListings(filter, filter.similar ? 'SIMILAR_TOP' : 'SEARCH_TOP') : [];
    const lifted = new Set(sponsored.map((entry) => entry.listing.id));
    const { items, total } = await repository.findActive(filter, page, pageSize);
    const organic = items.filter((listing) => !lifted.has(listing.id));
    const saved = await savedSet(viewer, [...sponsored.map((entry) => entry.listing.id), ...organic.map((listing) => listing.id)]);
    const cards = await withSlots(
      [
        ...sponsored.map((entry) => ({ ...toBrowseCard(entry.listing, null, saved.has(entry.listing.id)), sponsored: true, boostId: entry.boostId })),
        ...organic.map((listing) => toBrowseCard(listing, null, saved.has(listing.id))),
      ],
      window,
    );
    return { items: cards, total, page, pageSize };
  }
  // Around a point the whole box is read once — a box is a few hundred
  // spots at most — then ordered by the distance the box cannot express.
  const { items } = await repository.findActive(filter, 1, 500);
  const within = items
    .map((listing) => toBrowseCard(listing, filter.near))
    .filter((card) => card.distanceM !== null && card.distanceM <= filter.near!.radiusKm * 1000)
    .sort((a, b) => a.distanceM! - b.distanceM!);
  const start = (page - 1) * pageSize;
  const pageCards = within.slice(start, start + pageSize);
  // The saved mark is asked for the page that is actually returned, not the box.
  const saved = await savedSet(viewer, pageCards.map((card) => card.id));
  const cards = await withSlots(pageCards.map((card) => ({ ...card, saved: saved.has(card.id) })), window);
  return { items: cards, total: within.length, page, pageSize };
}

/**
 * One live spot, as its page draws it. A spot that is not live reads as
 * missing. `window` (Lot G) is the campaign's dates when the page has them;
 * the slots left are counted over it, else over today.
 */
export async function getBrowseListing(listingId: string, viewer?: BrowseViewer, window?: Partial<SlotWindow>): Promise<BrowseCard> {
  /* W1: the website addresses a spot by its display id (`/spaces/LST-1709-2663`), the apps by its id; both land here. */
  const listing = (await repository.findActiveById(listingId)) ?? (/^LST-/i.test(listingId) ? await repository.findActiveByDisplayId(listingId) : null);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'That spot is not available');
  const saved = await savedSet(viewer, [listing.id]);
  const [card] = await withSlots([toBrowseCard(listing, null, saved.has(listing.id))], windowFor(window?.from, window?.to));
  return card!;
}

/**
 * 26 Sep 2026: `GET /listings/:id/similar` — up to five live spots of the
 * same category in the same city within ±30% of the price, as the browse
 * cards `GET /listings/browse` answers (photos, publisher, slots left) —
 * not the raw rows it used to answer on a public route. `:id` is the
 * spot's id or (W1) its display id. Nothing per viewer: no saved mark.
 */
export async function similarListings(listingId: string, limit = 5): Promise<BrowseCard[]> {
  const listing = (await repository.findById(listingId)) ?? (/^LST-/i.test(listingId) ? await repository.findActiveByDisplayId(listingId) : null);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  // SIM-1: more than five for the website's scrolling row; the app keeps its five.
  // LM-1: today's SIMILAR_TOP boosts from the similar set go first, the rest follow in the row's own order.
  const sponsored = (await sponsoredListings(() => ({ sort: 'NEWEST', similar: similarAnchor(listing as never) }), 'SIMILAR_TOP')).slice(0, limit);
  const lifted = new Set(sponsored.map((entry) => entry.listing.id));
  const rows = (await repository.findSimilar(listing as never, limit)).filter((row) => !lifted.has(row.id)).slice(0, limit - sponsored.length);
  return withSlots(
    [...sponsored.map((entry) => ({ ...toBrowseCard(entry.listing), sponsored: true, boostId: entry.boostId })), ...rows.map((row) => toBrowseCard(row))],
    windowFor(),
  );
}

/**
 * LM-1: the sponsored listings a page may carry — today's boosts for the
 * placement whose listing is in the filtered set (the same `findActive`
 * with every facet the page has, narrowed to the boosted ids), in a shuffled
 * order so boosts sharing the placement take turns, at most the placement's
 * `maxConcurrent`. A listing boosted twice shows once.
 */
async function sponsoredListings(filter: BrowseFilter | (() => BrowseFilter), placement: SponsoredPlacement): Promise<{ boostId: string; listing: BrowseListing }[]> {
  const { max, boosts } = await liveSponsored(placement);
  if (max <= 0 || boosts.length === 0) return [];
  const ids = [...new Set(boosts.map((boost) => boost.listingId))];
  const { items } = await repository.findActive({ ...(typeof filter === 'function' ? filter() : filter), onlyIds: ids }, 1, ids.length);
  const byId = new Map(items.map((listing) => [listing.id, listing]));
  const out: { boostId: string; listing: BrowseListing }[] = [];
  const taken = new Set<string>();
  for (const boost of shuffled(boosts)) {
    const listing = byId.get(boost.listingId);
    if (!listing || taken.has(listing.id)) continue;
    taken.add(listing.id);
    out.push({ boostId: boost.boostId, listing });
    if (out.length >= max) break;
  }
  return out;
}

/* ── Browse by category — G12-B ───────────────────────────────────────── */

export type CategoryTile = {
  category: (typeof LISTING_CATEGORIES)[number];
  /** Live spots of this category in the place. */
  count: number;
  /** The newest live spot's first public photograph — down the newest-first order until one has a picture; null when none does. */
  photoUrl: string | null;
};

/** Metres from a point to a spot, or null when the spot has no coordinates. */
function distanceFrom(near: { latitude: number; longitude: number }, spot: { latitude: number | null; longitude: number | null }): number | null {
  return spot.latitude !== null && spot.longitude !== null
    ? Math.round(haversineMeters(near.latitude, near.longitude, spot.latitude, spot.longitude))
    : null;
}

/**
 * The "Browse by category" grid: one tile per `ListingCategory` in the
 * place, the count of live spots and a photograph to draw it with, most
 * populous first. Every category is present — a tile at zero is how the
 * grid says "nothing here yet" without dropping the chip.
 *
 * The place is resolved the way `browseListings` resolves it: a city by
 * name, or a point — the repository's bounding box cut to the circle here,
 * by exact distance, so a spot in the box's corner is not counted as near.
 */
export async function browseCategories(input: BrowsePlace): Promise<{ items: CategoryTile[]; total: number }> {
  const place = await placeWithKey(input);
  const rows = await repository.findActiveForCategories(place);
  const near = place.near;
  const within: CategoryTileListing[] = near
    ? rows.filter((row) => {
        const distanceM = distanceFrom(near, row);
        return distanceM !== null && distanceM <= near.radiusKm * 1000;
      })
    : rows;
  const tiles = new Map<CategoryTile['category'], CategoryTile>(
    LISTING_CATEGORIES.map((category) => [category, { category, count: 0, photoUrl: null }]),
  );
  // Rows arrive newest published first, so the first public photograph seen
  // for a category is the newest spot's.
  for (const row of within) {
    const tile = tiles.get(row.category as CategoryTile['category']);
    if (!tile) continue;
    tile.count += 1;
    if (tile.photoUrl === null) tile.photoUrl = publicPhotoUrl(row.photos);
  }
  const order = new Map(LISTING_CATEGORIES.map((category, index) => [category, index]));
  const items = [...tiles.values()].sort((a, b) => b.count - a.count || order.get(a.category)! - order.get(b.category)!);
  return { items, total: within.length };
}

/* ── Venue tiles — QR-20 ─────────────────────────────────────────────── */

/**
 * QR-20 (the owner, 17 Sep): the home's strip and the Explore grid carry
 * the sub-categories too — the catalogue's venue types, each its own tile.
 * A tile is the venue, its category, how many live spots the place has in
 * it, and the newest such spot's first public photograph. Every active
 * venue is answered, counted or not: the strip must look full in a city
 * that has three spots, and a tile with nothing behind it says so.
 */
export type VenueTile = {
  venueTypeId: string;
  slug: string;
  /** The catalogue's full name — "Shopping Malls / Retail Centers / Department Stores". */
  name: string;
  /** The tile's word — "Malls". */
  label: string;
  category: (typeof LISTING_CATEGORIES)[number];
  count: number;
  photoUrl: string | null;
};

/** The tiles' words for the venues the frame names and the ones people look for first; the rest take the first segment of the catalogue name. */
const VENUE_LABELS: Record<string, string> = {
  'city-roads-urban-streets-main-roads': 'Roadside billboards',
  'highways-expressways-national-highways': 'Highways',
  'flyovers-overpasses-elevated-roads-skywalks': 'Flyovers',
  'it-parks-sez-tech-parks-business-parks': 'Tech parks',
  'airports-outdoor-perimeter-areas': 'Airport approaches',
  'shopping-malls-retail-centers-department-stores': 'Malls',
  'gyms-fitness-clubs-wellness-centers-yoga-studios': 'Gyms',
  'restaurants-cafe-s-food-courts-qsrs-cloud-kitchens': 'Cafés & restaurants',
  'multiplexes-cinemas-movie-theaters': 'Cinemas',
  'supermarkets-hypermarkets-grocery-stores': 'Supermarkets',
  'hotels-resorts-lodges-guest-houses-service-apartments': 'Hotels',
  'hospitals-clinics-diagnostic-centers-pharmacies-medical-faci': 'Hospitals',
  'colleges-universities-schools-educational-institutions': 'Colleges',
  'business-centers-corporate-offices-coworking-spaces': 'Offices',
  'banks-atms-financial-service-centers': 'Banks & ATMs',
  'beauty-salons-spas-wellness-studios-nail-studios': 'Salons & spas',
  'residential-societies-apartment-complexes-gated-communities': 'Apartments',
  'metro-subway-underground': 'Metro',
  'bus-bus-rapid-transit-brt': 'Buses',
  'auto-rickshaw': 'Auto-rickshaws',
  'taxi-cab-app-based-traditional': 'Cabs',
  'railway-train-stations': 'Railway stations',
  'aviation-in-flight-in-airport-aircraft': 'Airports',
  television: 'TV',
  'news-television': 'News TV',
  radio: 'Radio',
  print: 'Print',
};

/** The order the strip fills in once the counted venues are placed — what people look for first. */
export const VENUE_ORDER: readonly string[] = Object.keys(VENUE_LABELS);

export function venueLabel(venue: Pick<VenueTypeRow, 'slug' | 'name'>): string {
  return VENUE_LABELS[venue.slug] ?? (venue.name.split(' / ')[0] ?? venue.name).trim();
}

export async function browseVenues(input: BrowsePlace): Promise<{ items: VenueTile[]; total: number }> {
  const place = await placeWithKey(input);
  const [venues, rows] = await Promise.all([repository.venueTypes(), repository.findActiveForCategories(place)]);
  const near = place.near;
  const within = near
    ? rows.filter((row) => {
        const distanceM = distanceFrom(near, row);
        return distanceM !== null && distanceM <= near.radiusKm * 1000;
      })
    : rows;
  const tiles = new Map<string, VenueTile>(
    venues.map((venue) => [
      venue.id,
      { venueTypeId: venue.id, slug: venue.slug, name: venue.name, label: venueLabel(venue), category: venue.category as VenueTile['category'], count: 0, photoUrl: null },
    ]),
  );
  // Rows arrive newest published first, so the first public photograph seen for a venue is the newest spot's.
  for (const row of within) {
    const tile = row.venueTypeId ? tiles.get(row.venueTypeId) : undefined;
    if (!tile) continue;
    tile.count += 1;
    if (tile.photoUrl === null) tile.photoUrl = publicPhotoUrl(row.photos);
  }
  // The frame's order (4189:2057): billboards first, then indoor, transit, media.
  const category = new Map<string, number>(['OUTDOOR', 'INDOOR', 'TRANSIT', 'MEDIA'].map((value, index) => [value, index]));
  const curated = new Map(VENUE_ORDER.map((slug, index) => [slug, index]));
  const rank = (tile: VenueTile) => curated.get(tile.slug) ?? VENUE_ORDER.length;
  // The counted venues first, then the curated order, then the catalogue's alphabet — within each category in the frame's order.
  const items = [...tiles.values()].sort(
    (a, b) =>
      category.get(a.category)! - category.get(b.category)! ||
      b.count - a.count ||
      rank(a) - rank(b) ||
      a.label.localeCompare(b.label),
  );
  return { items, total: within.length };
}

/* ── Saved spaces — Lot D (Q5/Q104) ──────────────────────────────────── */

/**
 * The heart. Keyed by the advertiser account the caller resolved to — their
 * own, or the one an agent is holding under a live grant — so the book is the
 * advertiser's whatever phone tapped it. Only a live spot can be saved; the
 * card comes back marked so the screen need not re-read it.
 */
export async function saveListing(advertiserId: string, listingId: string): Promise<BrowseCard> {
  const listing = await repository.findActiveById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'That spot is not available');
  await repository.saveListing(advertiserId, listingId);
  return toBrowseCard(listing, null, true);
}

/** Idempotent: unsaving a spot that was never saved is the same "no". */
export async function unsaveListing(advertiserId: string, listingId: string): Promise<{ saved: false }> {
  await repository.unsaveListing(advertiserId, listingId);
  return { saved: false };
}

/**
 * The advertiser's saved spaces, as browse cards, newest save first. A spot
 * that has gone off the market is left out rather than drawn as bookable;
 * the row stays, so it returns if the spot does. The list contract, with an
 * empty histogram — a saved space has no status to chip on.
 */
export async function listSavedListings(
  advertiserId: string,
  query: { page: number; pageSize: number },
): Promise<ListPage<BrowseCard>> {
  const { items, total } = await repository.findSavedForAdvertiser(advertiserId, query.page, query.pageSize);
  return toListPage(items.map((listing) => toBrowseCard(listing, null, true)), total, {}, query);
}
