import { env } from '../../config/env';
import { cityKeyFor, citySupport } from '../pricing';
import { ApiError } from '../../shared/errors';
import { Decimal } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import type { BrowseFilter, BrowseListing, BrowsePlace, CategoryTileListing, VenueTypeRow } from './listings.repository';
import { LISTING_CATEGORIES } from './listings.schema';
import { carriesLoop, slotsHeldFor, slotsLeft, windowFor, type SlotWindow } from './slots.service';
import { publicPhotoUrl } from './spot-page.service';

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
  targetAudience: string | null;
  uniqueSellingPoint: string | null;
  publisherName: string | null;
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
    targetAudience: listing.targetAudience,
    uniqueSellingPoint: listing.uniqueSellingPoint,
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
  };
}

/**
 * Lot G (Q116/136): the slots left on each card over the window, in one
 * count for the page. The window is the caller's `from`/`to`; today when
 * neither was given.
 */
async function withSlots<T extends { id: string; slotsTotal: number }>(cards: T[], window: SlotWindow): Promise<T[]> {
  if (cards.length === 0) return cards;
  const held = await slotsHeldFor(cards.map((card) => card.id), window);
  return cards.map((card) => ({ ...card, slotsLeft: slotsLeft(card.slotsTotal, held.get(card.id)) }));
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
  const closed = await comingSoonFor(input.city);
  if (closed) return { items: [], total: 0, page, pageSize, comingSoon: closed };
  const filter = await placeWithKey(input);
  if (!filter.near) {
    const { items, total } = await repository.findActive(filter, page, pageSize);
    const saved = await savedSet(viewer, items.map((listing) => listing.id));
    const cards = await withSlots(items.map((listing) => toBrowseCard(listing, null, saved.has(listing.id))), window);
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
  const listing = await repository.findActiveById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'That spot is not available');
  const saved = await savedSet(viewer, [listing.id]);
  const [card] = await withSlots([toBrowseCard(listing, null, saved.has(listing.id))], windowFor(window?.from, window?.to));
  return card!;
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
