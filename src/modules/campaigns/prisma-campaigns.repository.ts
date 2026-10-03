import { Prisma, prisma } from '../../shared/database';
import { slotsHeldWith } from '../listings';
import type { CampaignRefundStatus, CampaignStatus, CreativeStatus, LandingPageStatus, PrintJobStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import {
  AGENT_WAITING_ORDER_STATUSES,
  CAMPAIGN_REFUND_STATUSES,
  LANDING_PAGE_STATUSES,
  PUBLISHER_WAITING_ORDER_STATUSES,
  SlotClashError,
  type CampaignAdvertiserRow,
  type CampaignPerformanceTotals,
  type CampaignRefundView,
  type CampaignScopeFilter,
  type CampaignsRepository,
  type LandingPageView,
  type CreativeReviewRow,
  type SlotAsk,
} from './campaigns.repository';
import { CAMPAIGN_STATUSES, CREATIVE_STATUSES, type WaitingReason } from './campaigns.schema';

/** What the desk reads beside a creative: its campaign and, when it has one, its spot. */
const creativeReviewInclude = {
  campaign: {
    select: {
      id: true,
      reference: true,
      name: true,
      status: true,
      advertiserId: true,
      agentId: true,
      createdByUserId: true,
      trackingMethod: true,
      contentCategoryId: true,
      industry: true,
      /* CR-1: the flight is a design request's deadline, and the config is
         the brief the advertiser wrote when choosing ADX Design Agency. */
      startDate: true,
      endDate: true,
      creativePath: true,
      creativeConfig: true,
      advertiser: { select: { id: true, name: true, companyName: true } },
    },
  },
  spot: {
    select: {
      id: true,
      listingId: true,
      listing: { select: { id: true, title: true, city: true, widthFt: true, heightFt: true, category: true } },
      /* CR-1: Print-ready — the spot's order. Its print job is stitched on
         afterwards by `withPrintJobs`: `PrintJob.orderId` is a plain unique
         column with no Prisma relation to `Order`, so it cannot be selected
         through it. */
      order: { select: { id: true, status: true } },
    },
  },
  /* `satisfies`, not `as const`: an include held in a variable is not checked
     for unknown fields when it is passed, so a bad key here reached the
     database as a 500. This makes it a compile error. */
} satisfies Prisma.CampaignCreativeInclude;

/** The include's row as Prisma types it — before the print job is stitched on. */
type CreativeReviewFetched = Prisma.CampaignCreativeGetPayload<{ include: typeof creativeReviewInclude }>;

/** A print job as the stitch wants it: keyed by its order. */
export type PrintJobForRow = { id: string; orderId: string; status: PrintJobStatus; printPartner: { id: string; name: string } };

/** The orders a page of rows sits on — what to fetch jobs for. */
export function orderIdsOf(rows: readonly { spot: { order: { id: string } | null } | null }[]): string[] {
  return [...new Set(rows.map((row) => row.spot?.order?.id).filter((id): id is string => Boolean(id)))];
}

/**
 * CR-1: put each order's print job onto `spot.order.printJob`. Pure, so the
 * merge is tested without a database: null where the spot is unbooked or
 * the order has no job; a job on an order no row sits on is ignored.
 */
export function stitchPrintJobs<T extends { spot: { order: { id: string } | null } | null }>(
  rows: readonly T[],
  jobs: readonly PrintJobForRow[],
): (Omit<T, 'spot'> & {
  spot:
    | (Omit<NonNullable<T['spot']>, 'order'> & {
        order: (NonNullable<NonNullable<T['spot']>['order']> & { printJob: Omit<PrintJobForRow, 'orderId'> | null }) | null;
      })
    | null;
})[] {
  const byOrder = new Map(jobs.map((job) => [job.orderId, { id: job.id, status: job.status, printPartner: job.printPartner }]));
  return rows.map((row) => ({
    ...row,
    spot: row.spot
      ? { ...row.spot, order: row.spot.order ? { ...row.spot.order, printJob: byOrder.get(row.spot.order.id) ?? null } : null }
      : null,
  })) as never;
}

/** The fetch half: one query for the whole page, then the pure stitch. */
async function withPrintJobs(rows: CreativeReviewFetched[]): Promise<CreativeReviewRow[]> {
  const orderIds = orderIdsOf(rows);
  const jobs = orderIds.length
    ? await prisma.printJob.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true, orderId: true, status: true, printPartner: { select: { id: true, name: true } } },
      })
    : [];
  return stitchPrintJobs(rows, jobs);
}
import { spendToDate } from './flight';

/**
 * One row of the campaign list. Shared by the paged read and the array read so
 * the two can never drift into different shapes.
 */
/** The campaign beside a landing-page row — the review list's view, and (T-B) the unpublish's answer. */
const landingPageViewInclude = {
  campaign: {
    select: {
      id: true,
      reference: true,
      name: true,
      status: true,
      advertiserId: true,
      advertiser: { select: { id: true, name: true, companyName: true } },
    },
  },
} satisfies Prisma.LandingPageInclude;

/* ── The Campaigns lot (2 Oct 2026) ──────────────────────────────────── */

/**
 * The advertiser behind a campaign for the console's reads — the business,
 * its KYC state, and the person's names and id, shaped into the orders'
 * `placedBy` by the service. The person's row is named column by column:
 * no email, no birth date, no credential ever rides along.
 */
const advertiserPartySelect = {
  id: true,
  name: true,
  companyName: true,
  displayId: true,
  kycStatus: true,
  userId: true,
  suspensionScopes: true,
  user: { select: { id: true, name: true, firstName: true, lastName: true, displayId: true, isActive: true, closedAt: true } },
} satisfies Prisma.AdvertiserSelect;

/** What `launch-gates` reads for one campaign. */
const gateFactsSelect = {
  id: true,
  reference: true,
  name: true,
  status: true,
  brandName: true,
  startDate: true,
  endDate: true,
  total: true,
  createdAt: true,
  submittedForPaymentAt: true,
  paidAt: true,
  reservationFeeStatus: true,
  reservationFeeAmount: true,
  reservationFeeDueAt: true,
  reservationFeePaidAt: true,
  creativePath: true,
  designQuoteStatus: true,
  designQuoteAmount: true,
  designQuotedAt: true,
  advertiser: { select: advertiserPartySelect },
  creatives: { select: { id: true, resubmissionOfId: true, fileUrl: true, status: true, designedByAdx: true } },
  spots: { select: { id: true, status: true, order: { select: { id: true, status: true } } } },
  landingPage: { select: { id: true, slug: true, status: true, publishedAt: true } },
} satisfies Prisma.CampaignSelect;

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

/**
 * Lot X-B on a campaign: its city is `targetMarketCityId`, the typed
 * `targetMarket` the fallback for a row with no key — the same rule every
 * section overview's `cityOf` applies to a party's own columns.
 */
export function campaignCityWhere(scope: Pick<CampaignScopeFilter, 'city' | 'cityId'>): Prisma.CampaignWhereInput {
  if (!scope.city) return {};
  const spelling = { equals: scope.city.trim(), mode: 'insensitive' as const };
  return scope.cityId
    ? { OR: [{ targetMarketCityId: scope.cityId }, { targetMarketCityId: null, targetMarket: spelling }] }
    : { targetMarketCityId: null, targetMarket: spelling };
}

/** The advertiser's business, person and ADV-/ADX- ids, for `q`. */
const advertiserMatches = (q: string): Prisma.AdvertiserWhereInput => ({
  OR: [
    { name: contains(q) },
    { companyName: contains(q) },
    { displayId: contains(q) },
    { user: { is: { OR: [{ name: contains(q) }, { firstName: contains(q) }, { lastName: contains(q) }, { displayId: contains(q) }] } } },
  ],
});

/** Scope and search — everything but the status facet, which the chips count around. Whole where-objects under one AND. */
export function campaignScopeWhere(filter: CampaignScopeFilter): Prisma.CampaignWhereInput {
  const and: Prisma.CampaignWhereInput[] = [];
  if (filter.advertiserId) and.push({ advertiserId: filter.advertiserId });
  if (filter.agentId) and.push({ agentId: filter.agentId });
  if (filter.q) {
    and.push({
      OR: [{ name: contains(filter.q) }, { reference: contains(filter.q) }, { brandName: contains(filter.q) }, { advertiser: advertiserMatches(filter.q) }],
    });
  }
  if (filter.city) and.push(campaignCityWhere(filter));
  if (filter.from) and.push({ endDate: { gte: filter.from } });
  if (filter.to) and.push({ startDate: { lt: filter.to } });
  if (filter.goal?.length) and.push({ goal: { in: filter.goal } });
  return and.length ? { AND: and } : {};
}

/** The launch queue's population: paid and not live (SCHEDULED), or held by a paid reservation fee. */
export const PAID_UNLAUNCHED_WHERE: Prisma.CampaignWhereInput = {
  OR: [{ status: 'SCHEDULED' }, { status: 'PENDING_PAYMENT', reservationFeeStatus: 'PAID' }],
};

/**
 * Each gate as a where — exact for all but ARTWORK, which cannot see that a
 * creative was superseded (the resubmission is a plain column) and so reads
 * a superset; `launch-gates.waitingOnOf` narrows the rows exactly.
 */
export function waitingPrefilter(reason: WaitingReason): Prisma.CampaignWhereInput {
  switch (reason) {
    case 'RESERVATION_FEE':
      return { status: 'PENDING_PAYMENT', reservationFeeStatus: 'DUE' };
    case 'PAYMENT':
      return { status: 'PENDING_PAYMENT', OR: [{ reservationFeeStatus: null }, { reservationFeeStatus: { not: 'DUE' } }] };
    case 'DESIGN_QUOTE':
      return { status: 'PENDING_PAYMENT', creativePath: 'ADX_DESIGN_AGENCY', OR: [{ designQuoteStatus: null }, { designQuoteStatus: 'QUOTED' }] };
    case 'KYC':
      return { AND: [PAID_UNLAUNCHED_WHERE, { advertiser: { kycStatus: { not: 'VERIFIED' } } }] };
    case 'ARTWORK':
      return { status: { in: ['PENDING_PAYMENT', 'SCHEDULED'] }, creatives: { some: { fileUrl: { not: null }, status: { not: 'APPROVED' } } } };
    case 'PUBLISHER':
      return { status: 'SCHEDULED', spots: { some: { status: { not: 'CANCELLED' }, order: { is: { status: { in: [...PUBLISHER_WAITING_ORDER_STATUSES] } } } } } };
    case 'AGENT':
      return { status: 'SCHEDULED', spots: { some: { status: { not: 'CANCELLED' }, order: { is: { status: { in: [...AGENT_WAITING_ORDER_STATUSES] } } } } } };
  }
}

/** The landing-page list's search: the slug, the campaign, the advertiser. */
const landingPageMatches = (q: string): Prisma.LandingPageWhereInput => ({
  OR: [
    { slug: contains(q) },
    { campaign: { OR: [{ name: contains(q) }, { reference: contains(q) }, { advertiser: advertiserMatches(q) }] } },
  ],
});

const listSelect = {
  id: true,
  reference: true,
  name: true,
  status: true,
  goal: true,
  brandName: true,
  targetLocation: true,
  budget: true,
  total: true,
  startDate: true,
  endDate: true,
  createdAt: true,
  updatedAt: true,
  // Lot B: whose campaign it is. The agent's Orders tab lists campaigns
  // across every advertiser they hold and has to say which is which.
  advertiser: { select: { id: true, displayId: true, name: true } },
  _count: { select: { spots: true } },
  // The Spend Bar on the campaigns list: spend to date is the daily rate of
  // every booked spot for the days that have run — the same sum the
  // analytics page prints, computed from the same rows.
  spots: { select: { ratePerDay: true, quantity: true, status: true } },
} as const;

/**
 * The Prisma side of the port. Every query the campaigns module runs lives here
 * and nowhere else.
 */

const listingSelect = {
  id: true,
  title: true,
  city: true,
  address: true,
  latitude: true,
  longitude: true,
  widthFt: true,
  heightFt: true,
  estimatedDailyFootfall: true,
  mediaType: { select: { id: true, name: true, category: true } },
  photos: { select: { url: true }, take: 1 },
} as const;

/** G10: the slots each ask wants — a bare id wants one; the same listing asked twice wants the sum. */
function wantedSlots(asks: readonly SlotAsk[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const ask of asks) {
    const listingId = typeof ask === 'string' ? ask : ask.listingId;
    const quantity = typeof ask === 'string' ? 1 : Math.max(1, ask.quantity);
    wanted.set(listingId, (wanted.get(listingId) ?? 0) + quantity);
  }
  return wanted;
}

export const prismaCampaignsRepository: CampaignsRepository = {
  createCampaign(data) {
    return prisma.campaign.create({ data });
  },

  findCampaign(id) {
    return prisma.campaign.findUnique({
      where: { id },
      include: {
        spots: {
          orderBy: { createdAt: 'asc' },
          include: { listing: { select: listingSelect } },
        },
        pois: true,
        creatives: true,
        codes: true,
        advertiser: { select: { id: true, name: true, companyName: true } },
        brand: { select: { id: true, name: true } },
        // PC-1: the code on the booking, priced at every review.
        promoCode: true,
      },
    });
  },

  findCampaignBare(id) {
    return prisma.campaign.findUnique({ where: { id } });
  },

  async listCampaignsPage(filter) {
    // Scope and search, but not the status facet — the chips have to keep
    // their own counts while one of them is selected. The Campaigns lot:
    // city, flight, goal and the advertiser in the search; a `waitingOn`
    // filter arrives as the ids it resolved to.
    const scope = campaignScopeWhere(filter);
    const base: Prisma.CampaignWhereInput = filter.ids ? { AND: [scope, { id: { in: filter.ids } }] } : scope;
    const where: Prisma.CampaignWhereInput = {
      ...base,
      ...(filter.status?.length ? { status: { in: filter.status as CampaignStatus[] } } : {}),
    };

    // A draft has neither dates nor a budget, and Postgres sorts NULLs FIRST
    // on DESC — so without `nulls: 'last'` the most expensive campaigns list
    // opened with the ones that have no budget at all. Both sorts say it.
    const orderBy: Prisma.CampaignOrderByWithRelationInput =
      filter.sort === 'OLDEST'
        ? { createdAt: 'asc' }
        : filter.sort === 'BUDGET_DESC'
          ? { budget: { sort: 'desc', nulls: 'last' } }
          : filter.sort === 'ENDING_SOON'
            ? { endDate: { sort: 'asc', nulls: 'last' } }
            : filter.sort === 'NAME'
              ? { name: 'asc' }
              : { updatedAt: 'desc' };

    const [rows, total, groups] = await Promise.all([
      prisma.campaign.findMany({
        where,
        orderBy,
        ...listArgs(filter),
        select: listSelect,
      }),
      prisma.campaign.count({ where }),
      prisma.campaign.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const now = new Date();
    return {
      items: rows.map(({ _count, targetLocation, spots, ...row }) => ({
        ...row,
        city: targetLocation,
        spotCount: _count.spots,
        spendToDate: spendToDate(spots, row.startDate, row.endDate, now),
      })),
      total,
      counts: countsFrom(groups, CAMPAIGN_STATUSES),
    };
  },

  async listCampaigns(filter) {
    const rows = await prisma.campaign.findMany({
      where: {
        ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.status ? { status: { in: filter.status } } : {}),
        ...(filter.search
          ? {
              OR: [
                { name: { contains: filter.search, mode: 'insensitive' as const } },
                { reference: { contains: filter.search, mode: 'insensitive' as const } },
                { brandName: { contains: filter.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: filter.limit,
      select: listSelect,
    });
    const now = new Date();
    return rows.map(({ _count, targetLocation, spots, ...row }) => ({
      ...row,
      city: targetLocation,
      spotCount: _count.spots,
      spendToDate: spendToDate(spots, row.startDate, row.endDate, now),
    }));
  },

  gateCandidates(filter, cap) {
    const and: Prisma.CampaignWhereInput[] = [campaignScopeWhere(filter)];
    if (filter.paidOnly) and.push(PAID_UNLAUNCHED_WHERE);
    if (filter.reasons.length) and.push({ OR: filter.reasons.map(waitingPrefilter) });
    return prisma.campaign.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: cap,
      select: gateFactsSelect,
    });
  },

  campaignGateFacts(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.campaign.findMany({ where: { id: { in: ids } }, select: gateFactsSelect });
  },

  async performanceTotals(campaignIds) {
    if (campaignIds.length === 0) return {};
    // Two queries for the whole page: the codes (their scan counters, and
    // which campaign each belongs to), then the landing page's events
    // grouped by code and type.
    const codes = await prisma.campaignTrackingCode.findMany({
      where: { campaignId: { in: campaignIds } },
      select: { id: true, campaignId: true, scans: true },
    });
    if (codes.length === 0) return {};
    const events = await prisma.trackingEvent.groupBy({
      by: ['codeId', 'type'],
      where: { codeId: { in: codes.map((code) => code.id) }, type: { in: ['VIEW', 'CTA_CLICK', 'FORM_SUBMIT'] } },
      _count: { _all: true },
    });
    const campaignOf = new Map(codes.map((code) => [code.id, code.campaignId]));
    const out: Record<string, CampaignPerformanceTotals> = {};
    const totalsFor = (campaignId: string): CampaignPerformanceTotals => (out[campaignId] ??= { scans: 0, views: 0, ctaClicks: 0, enquiries: 0 });
    for (const code of codes) totalsFor(code.campaignId).scans += code.scans;
    for (const row of events) {
      const campaignId = campaignOf.get(row.codeId);
      if (!campaignId) continue;
      const totals = totalsFor(campaignId);
      if (row.type === 'VIEW') totals.views += row._count._all;
      else if (row.type === 'CTA_CLICK') totals.ctaClicks += row._count._all;
      else if (row.type === 'FORM_SUBMIT') totals.enquiries += row._count._all;
    }
    return out;
  },

  updateCampaign(id, patch) {
    // WG-1: a JSON column clears with Prisma's JsonNull, never a bare null.
    const data = patch.placementPreferences === null ? { ...patch, placementPreferences: Prisma.JsonNull } : patch;
    return prisma.campaign.update({
      where: { id },
      data: data as Prisma.CampaignUpdateInput,
    });
  },

  async deleteCampaign(id) {
    await prisma.campaign.delete({ where: { id } });
  },

  async referenceExists(reference) {
    return (await prisma.campaign.count({ where: { reference } })) > 0;
  },

  async replacePois(campaignId, pois) {
    return prisma.$transaction(async (tx) => {
      await tx.campaignPoi.deleteMany({ where: { campaignId } });
      if (pois.length === 0) return [];
      await tx.campaignPoi.createMany({ data: pois.map((poi) => ({ ...poi, campaignId })) });
      return tx.campaignPoi.findMany({ where: { campaignId } });
    });
  },

  async replaceSpots(campaignId, spots) {
    return prisma.$transaction(async (tx) => {
      /*
       * Only reserved spots are replaceable. A booked spot has an order behind
       * it and a publisher who has been told about it, so editing the cart
       * after payment must never quietly drop one.
       */
      await tx.campaignSpot.deleteMany({ where: { campaignId, status: 'RESERVED' } });
      if (spots.length > 0) await tx.campaignSpot.createMany({ data: spots });
      return tx.campaignSpot.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
    });
  },

  findSpots(campaignId) {
    return prisma.campaignSpot.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
  },

  findSpotsByOrderIds(orderIds) {
    if (orderIds.length === 0) return Promise.resolve([]);
    return prisma.campaignSpot.findMany({
      where: { orderId: { in: orderIds } },
      include: {
        campaign: {
          select: {
            id: true,
            reference: true,
            advertiserId: true,
            status: true,
            startDate: true,
            endDate: true,
            walletHoldId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  updateSpot(id, patch) {
    return prisma.campaignSpot.update({ where: { id }, data: patch });
  },

  candidateListings(query) {
    return prisma.listing.findMany({
      where: {
        status: 'ACTIVE',
        availableNow: true,
        ratePerDay: { not: null },
        id: { notIn: query.excludeListingIds.length > 0 ? query.excludeListingIds : ['__none__'] },
        ...(query.box
          ? {
              latitude: { gte: query.box.minLat, lte: query.box.maxLat },
              longitude: { gte: query.box.minLng, lte: query.box.maxLng },
            }
          : {}),
        ...(query.cities?.length
          ? { city: { in: query.cities, mode: 'insensitive' } }
          : query.city
            ? { city: { equals: query.city, mode: 'insensitive' } }
            : {}),
      },
      take: query.limit,
      select: {
        id: true,
        title: true,
        city: true,
        address: true,
        latitude: true,
        longitude: true,
        ratePerDay: true,
        widthFt: true,
        heightFt: true,
        areaSqFt: true,
        illumination: true,
        estimatedDailyFootfall: true,
        minBookingDays: true,
        availableNow: true,
        mediaType: { select: { id: true, name: true, category: true } },
        venueType: { select: { id: true, name: true } },
        photos: { select: { url: true }, take: 1 },
      },
    });
  },

  async clashingListingIds(asks, from, to, options = {}) {
    const wanted = wantedSlots(asks);
    const listingIds = [...wanted.keys()];
    if (listingIds.length === 0) return [];
    // Lot G (Q116/136): a clash is a spot with too few slots left over the
    // flight, not a spot with one booking on it. The holds are the orders
    // still running on the spot (a BOOKED or LIVE spot has one behind it)
    // plus the live reservations of other campaigns (Lot C, Q88) —
    // `listings`' one count, quantities summed, so this counts what browse
    // counts — against each spot's own `slotsTotal` and (G10) what the ask
    // wants of it.
    const [listings, held] = await Promise.all([
      prisma.listing.findMany({ where: { id: { in: listingIds } }, select: { id: true, slotsTotal: true } }),
      slotsHeldWith(prisma, listingIds, { from, to }, options),
    ]);
    return listings.filter((listing) => (held.get(listing.id) ?? 0) + (wanted.get(listing.id) ?? 1) > listing.slotsTotal).map((listing) => listing.id);
  },

  holdReservations(campaignId, until, now = new Date()) {
    return prisma.$transaction(
      async (tx) => {
        const spots = await tx.campaignSpot.findMany({
          where: { campaignId, status: 'RESERVED' },
          select: { id: true, listingId: true, quantity: true, startDate: true, endDate: true, listing: { select: { slotsTotal: true } } },
        });
        if (spots.length === 0) return 0;

        // G10: the per-listing locks placement takes, one per distinct
        // listing in id order (two campaigns holding the same two spots
        // then queue the same way round, never across each other), before
        // anything else on the transaction.
        for (const listingId of [...new Set(spots.map((spot) => spot.listingId))].sort()) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${listingId}))`;
        }

        // Counted again under the lock: this campaign's own reservations
        // left out, each spot over its own flight (the campaign's when it
        // has none). A spot with no window at all cannot be counted and is
        // not refused here — the review has no window for it either.
        const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { startDate: true, endDate: true } });
        const clashing = new Set<string>();
        for (const spot of spots) {
          const from = spot.startDate ?? campaign?.startDate ?? null;
          const to = spot.endDate ?? campaign?.endDate ?? null;
          if (!from || !to) continue;
          const held = (await slotsHeldWith(tx, [spot.listingId], { from, to }, { excludeCampaignId: campaignId, now })).get(spot.listingId) ?? 0;
          if (held + Math.max(1, spot.quantity) > spot.listing.slotsTotal) clashing.add(spot.listingId);
        }
        if (clashing.size > 0) throw new SlotClashError([...clashing].sort());

        const { count } = await tx.campaignSpot.updateMany({
          where: { campaignId, status: 'RESERVED' },
          data: { reservedUntil: until },
        });
        return count;
      },
      { timeout: 15_000 },
    );
  },

  async clearExpiredReservations(now) {
    const { count } = await prisma.campaignSpot.updateMany({
      where: { status: 'RESERVED', reservedUntil: { not: null, lte: now } },
      data: { reservedUntil: null },
    });
    return count;
  },

  campaignsWithReservationFeeDue(now, limit = 200) {
    return prisma.campaign.findMany({
      where: { status: 'PENDING_PAYMENT', reservationFeeStatus: 'DUE', reservationFeeDueAt: { lte: now } },
      orderBy: { reservationFeeDueAt: 'asc' },
      take: limit,
      select: { id: true },
    });
  },

  campaignsWithLapsedReservationHold(now, limit = 200) {
    return prisma.campaign.findMany({
      where: { status: 'PENDING_PAYMENT', reservationFeeStatus: 'PAID', reservationHoldUntil: { lte: now } },
      orderBy: { reservationHoldUntil: 'asc' },
      take: limit,
      select: { id: true },
    });
  },

  async advertisersWithCampaignActivity(since, limit = 5000) {
    const rows = await prisma.campaign.findMany({
      where: {
        OR: [
          { status: { in: ['LIVE', 'PAUSED', 'SCHEDULED'] } },
          { status: 'COMPLETED', completedAt: { gte: since } },
        ],
      },
      distinct: ['advertiserId'],
      take: limit,
      select: { advertiserId: true },
    });
    return rows;
  },

  async clearCampaignReservations(campaignId) {
    const { count } = await prisma.campaignSpot.updateMany({
      where: { campaignId, status: 'RESERVED', reservedUntil: { not: null } },
      data: { reservedUntil: null },
    });
    return count;
  },

  createCreative(data) {
    const { checks, ...rest } = data;
    return prisma.campaignCreative.create({
      data: { ...rest, checks: checks === null ? Prisma.JsonNull : checks },
    });
  },

  updateCreative(id, patch) {
    const { checks, ...rest } = patch;
    return prisma.campaignCreative.update({
      where: { id },
      data: {
        ...rest,
        ...(checks !== undefined ? { checks: checks === null ? Prisma.JsonNull : checks } : {}),
      },
    });
  },

  async findCreative(id) {
    const row = await prisma.campaignCreative.findUnique({ where: { id }, include: creativeReviewInclude });
    if (!row) return null;
    const [stitched] = await withPrintJobs([row]);
    return stitched ?? null;
  },

  findCreatives(campaignId) {
    return prisma.campaignCreative.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
  },

  createCreativeAnalysis(data) {
    const { raw, ...rest } = data;
    return prisma.creativeAnalysis.create({ data: { ...rest, raw: raw === null ? Prisma.JsonNull : raw } });
  },
  latestCreativeAnalysis(creativeId) {
    return prisma.creativeAnalysis.findFirst({ where: { creativeId }, orderBy: { createdAt: 'desc' } });
  },
  latestCreativeAnalyses(creativeIds) {
    if (creativeIds.length === 0) return Promise.resolve([]);
    // Newest first, one per creative: `distinct` keeps the first row it meets per key.
    return prisma.creativeAnalysis.findMany({ where: { creativeId: { in: creativeIds } }, orderBy: { createdAt: 'desc' }, distinct: ['creativeId'] });
  },
  async listCreativesAwaitingAnalysis(limit) {
    const rows = await prisma.campaignCreative.findMany({
      where: { status: 'IN_REVIEW', fileUrl: { not: null }, mimeType: { startsWith: 'image/' }, analyses: { none: {} } },
      orderBy: [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: limit,
      include: creativeReviewInclude,
    });
    return withPrintJobs(rows);
  },
  listCreativeHashes(exceptCreativeId) {
    return prisma.campaignCreative.findMany({
      where: { id: { not: exceptCreativeId }, perceptualHash: { not: null }, fileUrl: { not: null } },
      select: { id: true, perceptualHash: true },
    });
  },

  async listDesignRequestCandidates() {
    /* Past the draft and not finished: a draft has not been submitted, so
       nothing is owed on it yet, and a completed or cancelled campaign has
       nothing left to print. Oldest first — a queue is worked from the back. */
    return prisma.campaign.findMany({
      where: {
        creativePath: 'ADX_DESIGN_AGENCY',
        status: { in: ['PENDING_PAYMENT', 'SCHEDULED', 'LIVE', 'PAUSED'] },
      },
      orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: {
        id: true,
        reference: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        creativeConfig: true,
        createdAt: true,
        updatedAt: true,
        // DQ-1: where the quote stands.
        designQuoteAmount: true,
        designQuoteStatus: true,
        designQuoteNote: true,
        designQuotedAt: true,
        designQuoteRespondedAt: true,
        advertiser: { select: { id: true, name: true, companyName: true } },
        spots: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            listing: { select: { id: true, title: true, city: true, widthFt: true, heightFt: true, category: true } },
          },
        },
        creatives: {
          select: {
            id: true,
            status: true,
            designedByAdx: true,
            resubmissionOfId: true,
            fileUrl: true,
            reviewNote: true,
            reviewedAt: true,
            createdAt: true,
          },
        },
      },
    });
  },

  async listCreativesPage(filter) {
    // Scope and search but not the status facet, so the chips keep their own
    // counts while one of them is selected — the same shape as the campaign list.
    const base: Prisma.CampaignCreativeWhereInput = {
      fileUrl: { not: null },
      ...(filter.kind ? { path: filter.kind } : {}),
      ...(filter.flagged === true ? { flags: { isEmpty: false } } : {}),
      ...(filter.flagged === false ? { flags: { isEmpty: true } } : {}),
      ...(filter.resubmitted === true ? { resubmissionOfId: { not: null } } : {}),
      ...(filter.resubmitted === false ? { resubmissionOfId: null } : {}),
      ...(filter.analysed === true ? { analyses: { some: {} } } : {}),
      ...(filter.analysed === false ? { analyses: { none: {} } } : {}),
      ...(filter.q
        ? {
            campaign: {
              OR: [
                { name: { contains: filter.q, mode: 'insensitive' as const } },
                { reference: { contains: filter.q, mode: 'insensitive' as const } },
                { brandName: { contains: filter.q, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };
    const where: Prisma.CampaignCreativeWhereInput = {
      ...base,
      ...(filter.status?.length ? { status: { in: filter.status as CreativeStatus[] } } : {}),
    };
    /*
     * 28 Sep 2026 (the owner: "If there's only two creatives here, why does it
     * count 8?"): the kind row is one choice, so its chips count over the scope
     * the kind does NOT narrow — the search and the status in view — and
     * `everyKind` is how many that is. Before, they counted over every status
     * and narrowed each other, and the console summed them into its totals.
     */
    const kindScope: Prisma.CampaignCreativeWhereInput = {
      fileUrl: { not: null },
      ...(filter.q ? { campaign: base.campaign! } : {}),
      ...(filter.status?.length ? { status: { in: filter.status as CreativeStatus[] } } : {}),
    };
    // Oldest submission first by default: a queue is worked from the back.
    const orderBy: Prisma.CampaignCreativeOrderByWithRelationInput[] =
      filter.sort === 'NEWEST'
        ? [{ submittedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
        : [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }];
    // E7-2: the status chips count over the search and the kind in view, not the
    // status, so a chip never reads zero because another one is selected. The
    // kind chips count over `kindScope` (above) for the same reason.
    const [rows, total, groups, everyKind, flagged, statics, video, resubmitted, analysed, unanalysed] = await Promise.all([
      prisma.campaignCreative.findMany({ where, orderBy, ...listArgs(filter), include: creativeReviewInclude }),
      prisma.campaignCreative.count({ where }),
      prisma.campaignCreative.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      prisma.campaignCreative.count({ where: kindScope }),
      prisma.campaignCreative.count({ where: { ...kindScope, flags: { isEmpty: false } } }),
      prisma.campaignCreative.count({ where: { ...kindScope, path: 'STATIC_IMAGES' } }),
      prisma.campaignCreative.count({ where: { ...kindScope, path: 'VIDEO_OR_MOTION' } }),
      prisma.campaignCreative.count({ where: { ...kindScope, resubmissionOfId: { not: null } } }),
      // VA-4: the reading facet, over the same scope.
      prisma.campaignCreative.count({ where: { ...kindScope, analyses: { some: {} } } }),
      prisma.campaignCreative.count({ where: { ...kindScope, analyses: { none: {} } } }),
    ]);
    return {
      items: await withPrintJobs(rows),
      total,
      counts: { ...countsFrom(groups, CREATIVE_STATUSES), everyKind, flagged, static: statics, video, resubmitted, analysed, unanalysed },
    };
  },

  async deleteCreative(id) {
    await prisma.campaignCreative.delete({ where: { id } });
  },

  async createTrackingCodes(rows) {
    if (rows.length === 0) return [];
    await prisma.campaignTrackingCode.createMany({ data: rows });
    return prisma.campaignTrackingCode.findMany({
      where: { code: { in: rows.map((row) => row.code) } },
    });
  },

  findTrackingCode(code) {
    return prisma.campaignTrackingCode.findUnique({
      where: { code },
      include: { campaign: { select: { id: true, status: true } } },
    });
  },

  async codeExists(code) {
    return (await prisma.campaignTrackingCode.count({ where: { code } })) > 0;
  },

  async linkTrackingCodesToEngine(rows, at) {
    if (rows.length === 0) return;
    await prisma.$transaction(
      rows.map((row) =>
        prisma.campaignTrackingCode.update({
          where: { id: row.id },
          data: { engineCodeId: row.engineCodeId, shortUrl: row.shortUrl, engineLinkedAt: at },
        }),
      ),
    );
  },

  async recordTrackingEvent(data) {
    await prisma.trackingEvent.create({
      data: {
        codeId: data.codeId,
        type: data.type,
        city: data.city,
        device: data.device,
        referer: data.referer,
        hourIst: data.hourIst ?? null,
        ctaLabel: data.ctaLabel ?? null,
      },
    });
  },

  async interactionTotals(campaignId) {
    // Landing-page events only — VIEW, CTA_CLICK, FORM_SUBMIT — grouped four
    // ways in the database. Scans and clicks have their own counters.
    const where = {
      type: { in: ['VIEW', 'CTA_CLICK', 'FORM_SUBMIT'] as const },
      code: { campaignId },
    } satisfies Prisma.TrackingEventWhereInput;
    const [byDevice, byHour, byCity, byCta] = await Promise.all([
      prisma.trackingEvent.groupBy({ by: ['device'], where, _count: { _all: true } }),
      prisma.trackingEvent.groupBy({ by: ['hourIst'], where, _count: { _all: true } }),
      prisma.trackingEvent.groupBy({ by: ['city'], where, _count: { _all: true } }),
      prisma.trackingEvent.groupBy({ by: ['ctaLabel'], where, _count: { _all: true } }),
    ]);
    const desc = <T extends { count: number }>(rows: T[]) => rows.sort((a, b) => b.count - a.count);
    return {
      byDevice: desc(byDevice.map((row) => ({ device: row.device, count: row._count._all }))),
      byHour: byHour
        .map((row) => ({ hourIst: row.hourIst, count: row._count._all }))
        .sort((a, b) => (a.hourIst ?? 99) - (b.hourIst ?? 99)),
      byCity: desc(byCity.map((row) => ({ city: row.city, count: row._count._all }))),
      byCta: desc(byCta.map((row) => ({ ctaLabel: row.ctaLabel, count: row._count._all }))),
    };
  },

  async bumpTrackingCounter(codeId, field, by) {
    await prisma.campaignTrackingCode.update({
      where: { id: codeId },
      data: { [field]: { increment: by } },
    });
  },

  async upsertDailyMetric(data) {
    const { campaignId, day, ...rest } = data;
    await prisma.campaignDailyMetric.upsert({
      where: { campaignId_day: { campaignId, day } },
      update: { ...rest, computedAt: new Date() },
      create: { campaignId, day, ...rest },
    });
  },

  findDailyMetrics(campaignId, from, to) {
    return prisma.campaignDailyMetric.findMany({
      where: { campaignId, day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
    });
  },

  async dailyMetricsFor(campaignIds, from, to) {
    if (campaignIds.length === 0) return [];
    return prisma.campaignDailyMetric.findMany({
      where: { campaignId: { in: campaignIds }, day: { gte: from, lte: to } },
      orderBy: [{ campaignId: 'asc' }, { day: 'asc' }],
    });
  },

  async eventTotalsByDay(campaignId, from, to) {
    const rows = await prisma.$queryRaw<{ day: Date; type: string; count: bigint }[]>`
      SELECT date_trunc('day', e."occurredAt") AS day, e."type" AS type, COUNT(*) AS count
      FROM "TrackingEvent" e
      JOIN "CampaignTrackingCode" c ON c."id" = e."codeId"
      WHERE c."campaignId" = ${campaignId}
        AND e."occurredAt" >= ${from}
        AND e."occurredAt" <= ${to}
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `;
    return rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      type: row.type as never,
      count: Number(row.count),
    }));
  },

  async trackingTotals(campaignId) {
    const totals = await prisma.campaignTrackingCode.aggregate({
      where: { campaignId },
      _sum: { scans: true, clicks: true, redemptions: true },
    });
    return {
      scans: totals._sum.scans ?? 0,
      clicks: totals._sum.clicks ?? 0,
      redemptions: totals._sum.redemptions ?? 0,
    };
  },

  advertiserContext(advertiserId) {
    return prisma.advertiser.findUnique({
      where: { id: advertiserId },
      select: { id: true, agentId: true, userId: true, kycStatus: true, name: true },
    });
  },

  listingsByIds(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.listing.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        city: true,
        address: true,
        latitude: true,
        longitude: true,
        ratePerDay: true,
        widthFt: true,
        heightFt: true,
        areaSqFt: true,
        illumination: true,
        estimatedDailyFootfall: true,
        minBookingDays: true,
        availableNow: true,
        status: true,
        mediaType: { select: { id: true, name: true, category: true } },
        venueType: { select: { id: true, name: true } },
        photos: { select: { url: true }, take: 1 },
      },
    });
  },

  campaignsToTransition(now) {
    return prisma.campaign.findMany({
      where: {
        status: { in: ['SCHEDULED', 'LIVE'] },
        OR: [
          { status: 'SCHEDULED', startDate: { lte: now } },
          { status: 'LIVE', endDate: { lt: now } },
        ],
      },
      select: { id: true, status: true, startDate: true, endDate: true },
    });
  },

  /* ── Campaign refunds (Lot B, Q41) ─────────────────────────────── */

  createCampaignRefund(data) {
    return prisma.campaignRefund.create({ data });
  },

  async findCampaignRefund(id) {
    const row = await prisma.campaignRefund.findUnique({ where: { id } });
    if (!row) return null;
    const [view] = await withCampaigns([row]);
    return view ?? null;
  },

  findCampaignRefundByCampaign(campaignId) {
    return prisma.campaignRefund.findUnique({ where: { campaignId } });
  },

  async listCampaignRefunds(query) {
    const statuses = query.status as CampaignRefundStatus[] | undefined;
    // E7-3: the chips count the filter with the status facet removed — one
    // campaign's refund counted on its own page, the whole queue otherwise.
    const base = query.campaignId ? { campaignId: query.campaignId } : {};
    const where = { ...base, ...(statuses?.length ? { status: { in: statuses } } : {}) };
    const [rows, total, groups] = await Promise.all([
      prisma.campaignRefund.findMany({ where, orderBy: { createdAt: 'desc' }, ...listArgs(query) }),
      prisma.campaignRefund.count({ where }),
      prisma.campaignRefund.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items: await withCampaigns(rows), total, counts: countsFrom(groups, CAMPAIGN_REFUND_STATUSES) };
  },

  updateCampaignRefund(id, patch) {
    return prisma.campaignRefund.update({ where: { id }, data: patch });
  },

  /* ── Landing pages (Lot E, Q7/Q106) ───────────────────────────── */

  findLandingPage(campaignId) {
    return prisma.landingPage.findUnique({ where: { campaignId } });
  },

  findLandingPageView(campaignId) {
    return prisma.landingPage.findUnique({ where: { campaignId }, include: landingPageViewInclude });
  },

  async landingPageSummary(campaignId) {
    // E11-2: through the campaign's relation, four columns — the blocks stay
    // on the landing-page read, where the builder wants them.
    const row = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { landingPage: { select: { id: true, slug: true, status: true, publishedAt: true } } },
    });
    return row?.landingPage ?? null;
  },

  async findPublishedLandingPageBySlug(slug) {
    const page = await prisma.landingPage.findUnique({ where: { slug } });
    if (!page || page.status !== 'PUBLISHED') return null;
    const campaign = await prisma.campaign.findUnique({
      where: { id: page.campaignId },
      select: { name: true },
    });
    return { ...page, campaignName: campaign?.name ?? '' };
  },

  async landingSlugExists(slug) {
    return (await prisma.landingPage.count({ where: { slug } })) > 0;
  },

  createLandingPage(data) {
    return prisma.landingPage.create({
      data: {
        campaignId: data.campaignId,
        slug: data.slug,
        blocks: data.blocks,
        theme: data.theme ?? Prisma.JsonNull,
        generatedByAi: data.generatedByAi,
        createdByUserId: data.createdByUserId,
      },
    });
  },

  updateLandingPage(campaignId, patch) {
    const { theme, ...rest } = patch;
    return prisma.landingPage.update({
      where: { campaignId },
      data: { ...rest, ...(theme === undefined ? {} : { theme: theme ?? Prisma.JsonNull }) },
    });
  },

  async listLandingPages(query) {
    const statuses = query.status as LandingPageStatus[] | undefined;
    // The Campaigns lot: `q` narrows the chips' counts too; the status facet does not.
    const base: Prisma.LandingPageWhereInput = query.q ? landingPageMatches(query.q) : {};
    const where: Prisma.LandingPageWhereInput = statuses?.length ? { AND: [base, { status: { in: statuses } }] } : base;
    // E7-2 (Lot E addendum 2): LandingPage now has its campaign relation, so
    // the campaign beside each row is the same query, not a second one —
    // and (the Campaigns lot) its advertiser's party row with it.
    const [rows, total, groups] = await Promise.all([
      prisma.landingPage.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        ...listArgs(query),
        include: {
          campaign: { select: { ...landingPageViewInclude.campaign.select, advertiser: { select: advertiserPartySelect } } },
        },
      }),
      prisma.landingPage.count({ where }),
      prisma.landingPage.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const items = rows.map(({ campaign, ...row }) => {
      if (!campaign) return { ...row, campaign: null, advertiserRow: null };
      const { advertiser, ...rest } = campaign;
      const view: LandingPageView['campaign'] = { ...rest, advertiser: { id: advertiser.id, name: advertiser.name, companyName: advertiser.companyName } };
      return { ...row, campaign: view, advertiserRow: advertiser as CampaignAdvertiserRow };
    });
    return { items, total, counts: countsFrom(groups, LANDING_PAGE_STATUSES) };
  },
};

/**
 * CampaignRefund carries a campaign id without a relation, so the campaign
 * the desk draws beside it is read in one second query rather than one per
 * row. E10-1: the advertiser rides the same query, through the campaign.
 */
async function withCampaigns<T extends { campaignId: string }>(
  rows: T[]
): Promise<(T & { campaign: CampaignRefundView['campaign']; advertiser: CampaignRefundView['advertiser'] })[]> {
  if (rows.length === 0) return [];
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: rows.map((row) => row.campaignId) } },
    select: {
      id: true,
      reference: true,
      name: true,
      advertiserId: true,
      status: true,
      advertiser: { select: { id: true, displayId: true, name: true } },
    },
  });
  const byId = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  return rows.map((row) => {
    const found = byId.get(row.campaignId);
    if (!found) return { ...row, campaign: null, advertiser: null };
    const { advertiser, ...campaign } = found;
    return { ...row, campaign, advertiser: advertiser ?? null };
  });
}
