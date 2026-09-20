import { Prisma, prisma } from '../../shared/database';
import { slotsHeldWith } from '../listings';
import type { CampaignRefundStatus, CampaignStatus, CreativeStatus, LandingPageStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import {
  CAMPAIGN_REFUND_STATUSES,
  LANDING_PAGE_STATUSES,
  SlotClashError,
  type CampaignRefundView,
  type CampaignsRepository,
  type LandingPageView,
  type SlotAsk,
} from './campaigns.repository';
import { CAMPAIGN_STATUSES, CREATIVE_STATUSES } from './campaigns.schema';

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
      advertiser: { select: { id: true, name: true, companyName: true } },
    },
  },
  spot: {
    select: {
      id: true,
      listingId: true,
      listing: { select: { id: true, title: true, city: true, widthFt: true, heightFt: true } },
    },
  },
} as const;
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
      },
    });
  },

  findCampaignBare(id) {
    return prisma.campaign.findUnique({ where: { id } });
  },

  async listCampaignsPage(filter) {
    // Scope and search, but not the status facet — the chips have to keep
    // their own counts while one of them is selected.
    const base: Prisma.CampaignWhereInput = {
      ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      ...(filter.q
        ? {
            OR: [
              { name: { contains: filter.q, mode: 'insensitive' as const } },
              { reference: { contains: filter.q, mode: 'insensitive' as const } },
              { brandName: { contains: filter.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
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

  updateCampaign(id, patch) {
    return prisma.campaign.update({
      where: { id },
      data: patch as Prisma.CampaignUpdateInput,
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

  findCreative(id) {
    return prisma.campaignCreative.findUnique({ where: { id }, include: creativeReviewInclude });
  },

  findCreatives(campaignId) {
    return prisma.campaignCreative.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
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
    // Oldest submission first by default: a queue is worked from the back.
    const orderBy: Prisma.CampaignCreativeOrderByWithRelationInput[] =
      filter.sort === 'NEWEST'
        ? [{ submittedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
        : [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }];
    // E7-2: the desk's other four chips, counted over the same scope as the
    // status histogram (search and facets, not the status), so a chip never
    // reads zero because another one is selected.
    const [rows, total, groups, flagged, statics, video, resubmitted] = await Promise.all([
      prisma.campaignCreative.findMany({ where, orderBy, ...listArgs(filter), include: creativeReviewInclude }),
      prisma.campaignCreative.count({ where }),
      prisma.campaignCreative.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      prisma.campaignCreative.count({ where: { ...base, flags: { isEmpty: false } } }),
      prisma.campaignCreative.count({ where: { ...base, path: 'STATIC_IMAGES' } }),
      prisma.campaignCreative.count({ where: { ...base, path: 'VIDEO_OR_MOTION' } }),
      prisma.campaignCreative.count({ where: { ...base, resubmissionOfId: { not: null } } }),
    ]);
    return { items: rows, total, counts: { ...countsFrom(groups, CREATIVE_STATUSES), flagged, static: statics, video, resubmitted } };
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
      select: { id: true, agentId: true, userId: true, kycStatus: true },
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
    const where = statuses?.length ? { status: { in: statuses } } : {};
    // E7-2 (Lot E addendum 2): LandingPage now has its campaign relation, so
    // the campaign beside each row is the same query, not a second one.
    const [rows, total, groups] = await Promise.all([
      prisma.landingPage.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        ...listArgs(query),
        include: landingPageViewInclude,
      }),
      prisma.landingPage.count({ where }),
      prisma.landingPage.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const items: LandingPageView[] = rows.map(({ campaign, ...row }) => ({ ...row, campaign }));
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
