import { Prisma, prisma } from '../../shared/database';
import type { Listing, ListingStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import type {
  BrowseFilter,
  BrowsePlace,
  ContentRule,
  ListingPatch,
  ListingsRepository,
  NewListing,
  SendBackStatus,
} from './listings.repository';
import { LISTING_STATUSES, type AdminListingsQuery, type ReviewQueueQuery } from './listings.schema';
import { liveReservationsWhere, slotHoldingOrdersWhere, sumSlotHolds, type SlotHoldOptions, type SlotWindow } from './slot-holds';

const D = Prisma.Decimal;

/** The two tables the slot count reads — the client itself, or a transaction inside one. */
export type SlotCountClient = Pick<Prisma.TransactionClient, 'order' | 'campaignSpot'>;

/**
 * Lot G (Q116/136) / G10: how many slots each listing has held over the
 * window, on whatever client is handed in. The listings repository counts
 * on the client for browse; the orders and campaigns repositories count on
 * a transaction that holds the listing's advisory lock, so the count and
 * the insert it guards are one act. Quantities are summed (`sumSlotHolds`):
 * a campaign spot of three holds three.
 */
export async function slotsHeldWith(db: SlotCountClient, listingIds: string[], window: SlotWindow, options: SlotHoldOptions = {}): Promise<Map<string, number>> {
  if (listingIds.length === 0) return new Map<string, number>();
  const [orders, reservations] = await Promise.all([
    db.order.findMany({
      where: { listingId: { in: listingIds }, ...slotHoldingOrdersWhere(window) },
      select: { listingId: true, campaignSpot: { select: { quantity: true } } },
    }),
    db.campaignSpot.groupBy({
      by: ['listingId'],
      where: { listingId: { in: listingIds }, ...liveReservationsWhere(window, options) },
      _sum: { quantity: true },
    }),
  ]);
  return sumSlotHolds({ orders, reservations });
}

/**
 * What a reviewer reads beside the listing. Shared by the queue and the case so
 * the two never disagree about who the publisher is or which documents exist.
 */
const reviewJoins = {
  publisher: {
    select: { id: true, name: true, displayId: true, city: true, mobile: true },
  },
  agent: {
    select: { id: true, displayId: true, user: { select: { name: true } } },
  },
  photos: true,
  documents: {
    select: {
      id: true,
      kind: true,
      url: true,
      status: true,
      rejectionReason: true,
      submittedAt: true,
      reviewedAt: true,
    },
    orderBy: { submittedAt: 'asc' as const },
  },
} satisfies Prisma.ListingInclude;

/**
 * The divisor between the canonical daily rate and the deprecated monthly one.
 *
 * A flat 30 rather than the real month length, because `monthlyPrice` is a
 * display leftover on its way out and a rate that changed with the calendar
 * would be worse than one that is merely approximate.
 */
const DAYS_PER_MONTH = 30;

/**
 * The decimal-string fields, as Decimals.
 *
 * Only the keys that are actually present are returned, so spreading the result
 * over a patch never turns an untouched column into `undefined` — which Prisma
 * ignores on an update but which would overwrite a supplied value if the spread
 * happened to land after it.
 */
function decimals(rest: {
  widthFt?: string;
  heightFt?: string;
  areaSqFt?: string;
  basePrice?: string;
}): { widthFt?: Prisma.Decimal; heightFt?: Prisma.Decimal; areaSqFt?: Prisma.Decimal; basePrice?: Prisma.Decimal } {
  return {
    ...(rest.widthFt === undefined ? {} : { widthFt: new D(rest.widthFt) }),
    ...(rest.heightFt === undefined ? {} : { heightFt: new D(rest.heightFt) }),
    ...(rest.areaSqFt === undefined ? {} : { areaSqFt: new D(rest.areaSqFt) }),
    ...(rest.basePrice === undefined ? {} : { basePrice: new D(rest.basePrice) }),
  };
}

/**
 * What a browse row carries beside the listing: the photographs (main
 * first, as filed), the publisher's name, and — G12-B — the media type the
 * spot was filed under, for the card's `display` verdict.
 */
const browseInclude = {
  photos: { select: { url: true, type: true }, orderBy: { createdAt: 'asc' } },
  // QR-5: the publisher's KYC state rides on every card — the verified mark,
  // and the partition below. QR-7: their picture beside the name.
  publisher: { select: { name: true, kycStatus: true, user: { select: { avatarUrl: true } } } },
  mediaType: { select: { name: true, formatGroup: true } },
} satisfies Prisma.ListingInclude;

/**
 * Where a browse looks — a city by name, or the bounding box around a
 * point (the service cuts the box to the circle by exact distance). One
 * function so the category grid (G12-B) resolves the place exactly as the
 * browse page does.
 */
/**
 * The place a browse names, as AND clauses (the city clause owns an OR of
 * its own once the typed value resolves to a key, and `q` owns the
 * top-level one). Lot X-L: the typed city stays the match — a shopper
 * types — and, when it resolved, the rows keyed to that city match too.
 */
function browsePlaceClauses(place: BrowsePlace): Prisma.ListingWhereInput[] {
  const clauses: Prisma.ListingWhereInput[] = [];
  if (place.city) {
    const spelling: Prisma.ListingWhereInput = { city: { contains: place.city, mode: 'insensitive' } };
    clauses.push(place.cityId ? { OR: [{ cityId: place.cityId }, spelling] } : spelling);
  }
  if (place.near) {
    clauses.push({
      latitude: { gte: place.near.latitude - place.near.radiusKm / 111, lte: place.near.latitude + place.near.radiusKm / 111 },
      longitude: {
        gte: place.near.longitude - place.near.radiusKm / (111 * Math.cos((place.near.latitude * Math.PI) / 180)),
        lte: place.near.longitude + place.near.radiusKm / (111 * Math.cos((place.near.latitude * Math.PI) / 180)),
      },
    });
  }
  return clauses;
}

export const prismaListingsRepository: ListingsRepository = {
  create(data: NewListing) {
    const { photos, ratePerDay, monthlyPrice, ...rest } = data;
    const rate = new D(ratePerDay);
    // Measurements and the publisher's own figure arrive as decimal strings and
    // land in Decimal columns; Prisma would take the strings, but converting
    // here keeps one rule for every numeric column on this model.
    const measured = decimals(rest);
    return prisma.listing.create({
      data: {
        ...rest,
        ...measured,
        ratePerDay: rate,
        // Derived only when the caller did not send one. A caller who posts a
        // monthly price and reads it back must get their own number: deriving
        // it from a 2dp daily rate returns 999.9 for 1000, which breaks the
        // compatibility path this dual-field shape exists to protect.
        monthlyPrice: monthlyPrice ?? rate.times(DAYS_PER_MONTH).toNumber(),
        ratePerDaySetAt: new Date(),
        photos: photos?.length ? { create: photos } : undefined,
      },
      include: { photos: true },
    });
  },

  findForPublisher(publisherId: string) {
    return prisma.listing.findMany({
      where: { publisherId },
      include: { photos: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  async findAllForAdmin(query: AdminListingsQuery & { cityId?: string | null }) {
    // The admin listing joins publisher and agent; the per-publisher one does
    // not. Both shapes are contract.
    //
    // Everything except the status facet. The chip row has to be able to say
    // how many ACTIVE rows there are while PENDING_REVIEW is selected, so the
    // histogram is counted over this clause and the table over this clause
    // plus the status.
    const base: Prisma.ListingWhereInput = {
      // Lot X-B: the key is the identity — by the key when the facet resolved
      // to one, the spelling (contains, as before) catching only the rows
      // whose key is null.
      ...(query.city
        ? query.cityId
          ? { OR: [{ cityId: query.cityId }, { cityId: null, city: { contains: query.city, mode: 'insensitive' } }] }
          : { cityId: null, city: { contains: query.city, mode: 'insensitive' } }
        : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { displayId: { contains: query.q, mode: 'insensitive' } },
              { city: { contains: query.q, mode: 'insensitive' } },
              { address: { contains: query.q, mode: 'insensitive' } },
              { publisher: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const where: Prisma.ListingWhereInput = {
      ...base,
      ...(query.status?.length ? { status: { in: query.status as ListingStatus[] } } : {}),
    };

    // `submittedAt` is null on anything never sent for review. Nulls last, so
    // the column works the queue rather than burying it.
    const orderBy: Prisma.ListingOrderByWithRelationInput =
      query.sort === 'OLDEST'
        ? { createdAt: 'asc' }
        : query.sort === 'RATE_ASC'
          ? { ratePerDay: 'asc' }
          : query.sort === 'RATE_DESC'
            ? { ratePerDay: 'desc' }
            : query.sort === 'TITLE'
              ? { title: 'asc' }
              : query.sort === 'SUBMITTED'
                ? { submittedAt: { sort: 'desc', nulls: 'last' } }
                : { createdAt: 'desc' };

    const [items, total, groups] = await Promise.all([
      prisma.listing.findMany({
        where,
        orderBy,
        ...listArgs(query),
        include: { publisher: true, agent: true, photos: true },
      }),
      prisma.listing.count({ where }),
      prisma.listing.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, LISTING_STATUSES) };
  },

  findById(listingId: string) {
    return prisma.listing.findUnique({ where: { id: listingId } });
  },

  // The platform had no single-listing read at all: the table could not open a
  // row, and the only per-listing joins were the review case (which is a
  // reviewer's view of a PENDING_REVIEW spot) and browse (ACTIVE only).
  findOneForAdmin(listingId: string) {
    return prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        publisher: { select: { id: true, name: true, displayId: true, city: true } },
        agent: { select: { id: true, displayId: true } },
        photos: true,
        // G11-1: the loop decision's evidence, joined rather than looked up again.
        mediaType: { select: { name: true, formatGroup: true } },
      },
    });
  },

  update(listingId: string, data: ListingPatch) {
    const { ratePerDay, monthlyPrice, ...rest } = data;
    const measured = decimals(rest);
    // A price change re-dates the listing as a comparable and re-records how
    // long surge keeps it out of everyone else's pool.
    const priced =
      ratePerDay === undefined
        ? {}
        : {
            ratePerDay: new D(ratePerDay),
            monthlyPrice: monthlyPrice ?? new D(ratePerDay).times(DAYS_PER_MONTH).toNumber(),
            ratePerDaySetAt: new Date(),
          };
    return prisma.listing.update({
      where: { id: listingId },
      data: { ...rest, ...measured, ...priced },
      include: { photos: true },
    });
  },

  submitForReview(listingId, displayId, at) {
    return prisma.listing.update({
      where: { id: listingId },
      data: {
        status: 'PENDING_REVIEW',
        submittedAt: at,
        ...(displayId ? { displayId } : {}),
      },
    });
  },

  async displayIdExists(displayId) {
    return (await prisma.listing.count({ where: { displayId } })) > 0;
  },

  countAll() {
    return prisma.listing.count();
  },

  publish(listingId) {
    return prisma.listing.update({
      where: { id: listingId },
      // A listing that was sent back, fixed and approved must not carry the
      // old reason onto the marketplace — the review it records is over.
      data: { status: 'ACTIVE', publishedAt: new Date(), rejectionReason: null },
      include: { photos: true },
    });
  },

  /* ---------------------------------------------------------------- */
  /* The review desk                                                   */
  /* ---------------------------------------------------------------- */

  async findPendingReview(query: ReviewQueueQuery) {
    const where: Prisma.ListingWhereInput = {
      status: 'PENDING_REVIEW',
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { displayId: { contains: query.q, mode: 'insensitive' } },
              { city: { contains: query.q, mode: 'insensitive' } },
              { publisher: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    // Oldest wait first; a row that was never dated (submitted before the
    // column existed) sorts to the top rather than the bottom.
    const orderBy: Prisma.ListingOrderByWithRelationInput[] =
      query.sort === 'NEWEST'
        ? [{ submittedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
        : [{ submittedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }];
    const [items, total] = await Promise.all([
      prisma.listing.findMany({ where, include: reviewJoins, orderBy, ...listArgs(query) }),
      prisma.listing.count({ where }),
    ]);
    return { items, total };
  },

  findReviewCase(listingId: string) {
    return prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        ...reviewJoins,
        mediaType: { select: { id: true, name: true } },
        sizeClass: { select: { id: true, name: true } },
        material: { select: { id: true, name: true } },
        venueType: { select: { id: true, name: true } },
        contentRules: {
          select: { stance: true, category: { select: { id: true, name: true } } },
          orderBy: { category: { name: 'asc' } },
        },
      },
    });
  },

  sendBack(listingId: string, input: { status: SendBackStatus; reason: string }) {
    return prisma.listing.update({
      where: { id: listingId },
      data: {
        status: input.status,
        rejectionReason: input.reason,
        // Back to the publisher means back to the start of the clock.
        ...(input.status === 'DRAFT' ? { submittedAt: null } : {}),
      },
      include: { photos: true },
    });
  },

  findSimilar(listing: Listing) {
    return prisma.listing.findMany({
      where: {
        id: { not: listing.id },
        // Lot X-L: the key is the identity when the listing carries one; the string as before when it does not.
        ...(listing.cityId ? { cityId: listing.cityId } : { city: listing.city ?? undefined }),
        category: listing.category,
        status: 'ACTIVE',
        monthlyPrice: { gte: listing.monthlyPrice * 0.7, lte: listing.monthlyPrice * 1.3 },
      },
      orderBy: { monthlyPrice: 'asc' },
      take: 5,
    });
  },

  findWithPublisher(listingId: string) {
    return prisma.listing.findUnique({
      where: { id: listingId },
      include: { publisher: { include: { user: true } } },
    }) as never;
  },

  // ── DR 01 browse ────────────────────────────────────────────────────

  async findActive(filter: BrowseFilter, page: number, pageSize: number) {
    // The clauses that each need their own OR go in one AND list: `q` owns
    // the top-level OR, and a second one would overwrite the first.
    const clauses: Prisma.ListingWhereInput[] = browsePlaceClauses(filter);
    // Available from the campaign's start (or by its end when only that is
    // given), or with no date set — a spot that never said when it opens is
    // not hidden for it.
    const availableBy = filter.from ?? filter.to;
    if (availableBy) clauses.push({ OR: [{ availableFrom: null }, { availableFrom: { lte: availableBy } }] });
    // E7-2: with an end to the window, a spot booked over any of it is out —
    // the clash rule checkout applies (BOOKED / LIVE, or a live RESERVED
    // hold), a flight that starts before the window ends and ends after it
    // starts. `listings` cannot import `campaigns`, so the rule is repeated
    // here rather than read through it.
    // Lot G (Q116/136): a spot with a loop is never hidden for one booking —
    // its card says how many slots are left, which may be none. SQL cannot
    // count the loop against its holds here; the card can, and does.
    if (filter.to) {
      clauses.push({
        OR: [
          { slotsTotal: { gt: 1 } },
          {
            NOT: {
              campaignSpots: {
                some: {
                  OR: [{ status: { in: ['BOOKED', 'LIVE'] } }, { status: 'RESERVED', reservedUntil: { gt: new Date() } }],
                  AND: [
                    { OR: [{ startDate: null }, { startDate: { lte: filter.to } }] },
                    ...(filter.from ? [{ OR: [{ endDate: null }, { endDate: { gte: filter.from } }] }] : []),
                  ],
                },
              },
            },
          },
        ],
      });
    }
    if (filter.illuminated === false) {
      clauses.push({ OR: [{ illumination: null }, { illumination: { equals: 'NONE', mode: 'insensitive' } }] });
    }
    const where: Prisma.ListingWhereInput = {
      status: 'ACTIVE',
      // QR-24: a spot whose lease, licence or permit has run out takes no new booking.
      rightsLapsedAt: null,
      ...(filter.category ? { category: filter.category } : {}),
      // QR-20: the sub-category, one venue.
      ...(filter.venueTypeId ? { venueTypeId: filter.venueTypeId } : {}),
      ...(filter.display === 'DIGITAL'
        ? { subType: { contains: 'digital', mode: 'insensitive' } }
        : filter.display === 'STATIC'
          ? { NOT: { subType: { contains: 'digital', mode: 'insensitive' } } }
          : {}),
      ...(filter.minRate || filter.maxRate
        ? {
            ratePerDay: {
              ...(filter.minRate ? { gte: new D(filter.minRate) } : {}),
              ...(filter.maxRate ? { lte: new D(filter.maxRate) } : {}),
            },
          }
        : {}),
      ...(clauses.length ? { AND: clauses } : {}),
      ...(filter.minFootfall ? { estimatedDailyFootfall: { gte: filter.minFootfall } } : {}),
      // Lot D (Q105): three states, like `illuminated` below.
      ...(filter.instant === undefined ? {} : { instantBooking: filter.instant }),
      // Three states, not two. `illuminated` was applied behind a falsy check,
      // so `illuminated=false` produced the same query as omitting it and the
      // drawer's switch could only ever filter one way. The negative branch
      // is in the AND list above, because `q` below owns OR.
      ...(filter.illuminated === true
        ? { illumination: { not: null }, NOT: { illumination: { equals: 'NONE', mode: 'insensitive' } } }
        : {}),
      ...(filter.q
        ? {
            OR: [
              { title: { contains: filter.q, mode: 'insensitive' } },
              { address: { contains: filter.q, mode: 'insensitive' } },
              { city: { contains: filter.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    // RATING (Lot D, Q104): best-rated first, the unrated last, a bigger
    // sample breaking ties — five stars from one review does not outrank
    // 4.9 from forty.
    const orderBy: Prisma.ListingOrderByWithRelationInput | Prisma.ListingOrderByWithRelationInput[] =
      filter.sort === 'PRICE_ASC'
        ? { ratePerDay: 'asc' }
        : filter.sort === 'PRICE_DESC'
          ? { ratePerDay: 'desc' }
          : filter.sort === 'NAME'
            ? { title: 'asc' }
            : filter.sort === 'RATING'
              ? [{ ratingAvg: { sort: 'desc', nulls: 'last' } }, { reviewCount: 'desc' }, { publishedAt: 'desc' }]
              : { publishedAt: 'desc' };
    // QR-5 (the owner): verified publishers' spots come first, whatever the
    // sort, and the unverified follow in the same sort — two partitions
    // paged as one list. A KycStatus enum cannot be ordered "VERIFIED first"
    // by the database, so the page is cut across the partitions here:
    // however many of the verified fall on this page, the rest is filled
    // from the unverified with the offset moved past the verified count.
    // ADX's own spots (no publisher) sit with the verified. The partition
    // joins the AND list so `q`'s OR and the place clause keep their seats.
    const partitioned = (clause: Prisma.ListingWhereInput): Prisma.ListingWhereInput => ({
      ...where,
      AND: [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), clause],
    });
    const verifiedWhere = partitioned({ OR: [{ publisherId: null }, { publisher: { kycStatus: 'VERIFIED' } }] });
    const unverifiedWhere = partitioned({ publisher: { kycStatus: { not: 'VERIFIED' } } });
    const skip = (page - 1) * pageSize;
    const [verifiedTotal, total] = await Promise.all([prisma.listing.count({ where: verifiedWhere }), prisma.listing.count({ where })]);
    const fromVerified = Math.max(0, Math.min(pageSize, verifiedTotal - skip));
    const unverifiedSkip = Math.max(0, skip - verifiedTotal);
    const fromUnverified = pageSize - fromVerified;
    const [verified, unverified] = await Promise.all([
      fromVerified > 0
        ? prisma.listing.findMany({ where: verifiedWhere, orderBy, skip, take: fromVerified, include: browseInclude })
        : Promise.resolve([]),
      fromUnverified > 0
        ? prisma.listing.findMany({ where: unverifiedWhere, orderBy, skip: unverifiedSkip, take: fromUnverified, include: browseInclude })
        : Promise.resolve([]),
    ]);
    return { items: [...verified, ...unverified], total };
  },

  // ── Saved spaces — Lot D (Q5/Q104) ──────────────────────────────────

  async savedListingIds(advertiserId, listingIds) {
    if (listingIds.length === 0) return [];
    const rows = await prisma.savedListing.findMany({
      where: { advertiserId, listingId: { in: listingIds } },
      select: { listingId: true },
    });
    return rows.map((row) => row.listingId);
  },

  async saveListing(advertiserId, listingId) {
    await prisma.savedListing.upsert({
      where: { advertiserId_listingId: { advertiserId, listingId } },
      update: {},
      create: { advertiserId, listingId },
    });
  },

  async unsaveListing(advertiserId, listingId) {
    await prisma.savedListing.deleteMany({ where: { advertiserId, listingId } });
  },

  async findSavedForAdvertiser(advertiserId, page, pageSize) {
    // Two reads rather than a relation join: SavedListing carries no relation
    // to Listing in the schema, so the ids are paged here and the live rows
    // read back in the order they were saved.
    const where: Prisma.SavedListingWhereInput = { advertiserId };
    const [saved, total] = await Promise.all([
      prisma.savedListing.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { listingId: true },
      }),
      prisma.savedListing.count({ where }),
    ]);
    if (saved.length === 0) return { items: [], total };
    const ids = saved.map((row) => row.listingId);
    const listings = await prisma.listing.findMany({
      where: { id: { in: ids }, status: 'ACTIVE' },
      include: browseInclude,
    });
    const byId = new Map(listings.map((listing) => [listing.id, listing]));
    return { items: ids.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row)), total };
  },

  async setRatingSnapshot(listingId, snapshot) {
    await prisma.listing.update({
      where: { id: listingId },
      data: {
        ratingAvg: snapshot.ratingAvg === null ? null : new D(snapshot.ratingAvg),
        reviewCount: snapshot.reviewCount,
      },
    });
  },

  publisherMeetingPlace(publisherId) {
    return prisma.publisher.findUnique({
      where: { id: publisherId },
      select: { address: true, city: true, state: true },
    });
  },

  // ── Slots — Lot G (Q116/136) ─────────────────────────────────────────

  mediaTypeLoopHint(mediaTypeId: string) {
    return prisma.mediaType.findUnique({ where: { id: mediaTypeId }, select: { name: true, formatGroup: true } });
  },

  slotsHeld(listingIds: string[], window: SlotWindow, options: SlotHoldOptions = {}) {
    return slotsHeldWith(prisma, listingIds, window, options);
  },

  findActiveById(listingId: string) {
    return prisma.listing.findFirst({
      where: { id: listingId, status: 'ACTIVE' },
      include: browseInclude,
    });
  },

  findActiveByDisplayId(displayId: string) {
    return prisma.listing.findFirst({
      where: { displayId, status: 'ACTIVE' },
      include: {
        photos: { select: { url: true, type: true }, orderBy: { createdAt: 'asc' } },
        publisher: { select: { name: true, kycStatus: true, user: { select: { avatarUrl: true } } } },
        mediaType: { select: { name: true, formatGroup: true } },
      },
    });
  },

  findActiveForCategories(place: BrowsePlace) {
    return prisma.listing.findMany({
      where: { status: 'ACTIVE', rightsLapsedAt: null, AND: browsePlaceClauses(place) },
      // Newest live spot first: the tile is drawn with the first public
      // photograph down this order.
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: {
        id: true,
        category: true,
        venueTypeId: true,
        latitude: true,
        longitude: true,
        publishedAt: true,
        photos: { select: { url: true, type: true }, orderBy: { createdAt: 'asc' } },
      },
    });
  },

  venueTypes() {
    return prisma.venueType.findMany({ where: { isActive: true }, select: { id: true, name: true, slug: true, category: true }, orderBy: { name: 'asc' } });
  },

  setAvailability(listingId: string, availableNow: boolean) {
    return prisma.listing.update({ where: { id: listingId }, data: { availableNow } });
  },

  async retireForPublisher(publisherId: string) {
    const open = await prisma.listing.findMany({
      where: { publisherId, status: { notIn: ['INACTIVE', 'REJECTED'] } },
      select: { id: true },
    });
    if (open.length === 0) return [];
    await prisma.listing.updateMany({
      where: { id: { in: open.map((row) => row.id) } },
      data: { status: 'INACTIVE', availableNow: false },
    });
    return open;
  },

  async agentExists(agentId: string) {
    return (await prisma.agentProfile.findUnique({ where: { id: agentId } })) !== null;
  },

  async findPublisherByUserId(userId: string) {
    const row = await prisma.publisher.findUnique({
      where: { userId },
      select: { id: true, name: true, mobile: true, email: true, address: true, activatedAt: true, user: { select: { dateOfBirth: true } } },
    });
    if (!row) return null;
    const { user, ...publisher } = row;
    return { ...publisher, dateOfBirth: user?.dateOfBirth ?? null };
  },

  async findPublisherById(publisherId: string) {
    const row = await prisma.publisher.findUnique({
      where: { id: publisherId },
      select: {
        id: true, userId: true, agentId: true, kycStatus: true,
        name: true, mobile: true, email: true, address: true,
        user: { select: { dateOfBirth: true } },
      },
    });
    if (!row) return null;
    const { user, ...publisher } = row;
    return { ...publisher, dateOfBirth: user?.dateOfBirth ?? null };
  },

  listContentCategories() {
    return prisma.contentCategory.findMany({
      where: { isActive: true },
      orderBy: [{ isSensitive: 'asc' }, { name: 'asc' }],
    });
  },

  async setContentRules(listingId: string, rules: ContentRule[]) {
    // Replace rather than merge, in one transaction. A partial write would
    // leave a listing carrying a stance the publisher had just removed, and a
    // stance nobody can withdraw is worse than no stance at all.
    await prisma.$transaction([
      prisma.listingContentRule.deleteMany({ where: { listingId } }),
      ...(rules.length === 0
        ? []
        : [
            prisma.listingContentRule.createMany({
              data: rules.map((rule) => ({ ...rule, listingId })),
            }),
          ]),
    ]);
  },

  async findLabelsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await prisma.listing.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
    return rows.map((row) => ({ id: row.id, label: row.title, displayId: null }));
  },

  contentRulesFor(listingId: string) {
    return prisma.listingContentRule.findMany({
      where: { listingId },
      select: { contentCategoryId: true, stance: true },
    });
  },

  /* ── Audience — G7 (Q109) ───────────────────────────────────────── */

  findAudienceSnapshot(listingId, vendor, period) {
    return prisma.audienceSnapshot.findUnique({ where: { listingId_vendor_period: { listingId, vendor, period } } });
  },

  findAudienceSnapshots(listingIds, period) {
    if (listingIds.length === 0) return Promise.resolve([]);
    return prisma.audienceSnapshot.findMany({ where: { listingId: { in: listingIds }, period } });
  },

  upsertAudienceSnapshot({ listingId, vendor, period, data, expiresAt }) {
    const json = data as Prisma.InputJsonValue;
    return prisma.audienceSnapshot.upsert({
      where: { listingId_vendor_period: { listingId, vendor, period } },
      create: { listingId, vendor, period, data: json, expiresAt },
      update: { data: json, expiresAt, fetchedAt: new Date() },
    });
  },

  async advertiserHasSpot(advertiserId, listingId) {
    const spot = await prisma.campaignSpot.findFirst({
      where: { listingId, campaign: { advertiserId, status: { not: 'DRAFT' } } },
      select: { id: true },
    });
    return spot !== null;
  },
};
