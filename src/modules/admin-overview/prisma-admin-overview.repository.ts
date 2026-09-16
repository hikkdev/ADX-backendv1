import { Prisma, prisma, type ListingCategory } from '../../shared/database';
import type { AdminOverviewRepository, AnalyticsFilter, AnalyticsRepository, InsightsRepository, Window } from './admin-overview.repository';

const ZERO = new Prisma.Decimal(0);

const between = (window: Window) => ({ gte: window.start, lt: window.end });

/** A category or city narrows through the listing; "agent-assisted" through the spot's campaign. */
function accrualFilter(filter: AnalyticsFilter): Prisma.EarningAccrualWhereInput {
  // Lot X-B: by the key when the facet resolved to one, the spelling catching the rows whose key is null.
  const spelling = filter.city ? { equals: filter.city.trim(), mode: 'insensitive' as const } : null;
  const listing: Prisma.ListingWhereInput = {
    ...(filter.category ? { category: filter.category as ListingCategory } : {}),
    ...(spelling ? (filter.cityId ? { OR: [{ cityId: filter.cityId }, { cityId: null, city: spelling }] } : { cityId: null, city: spelling }) : {}),
  };
  return {
    ...(Object.keys(listing).length > 0 ? { listing } : {}),
    ...(filter.agentAssisted ? { spot: { campaign: { agentId: { not: null } } } } : {}),
  };
}

export const prismaAdminOverviewRepository: AdminOverviewRepository & AnalyticsRepository & InsightsRepository = {
  async bookingsAuthorised(window) {
    const [campaigns, packages] = await Promise.all([
      prisma.campaign.aggregate({
        where: { paidAt: between(window), status: { not: 'CANCELLED' } },
        _sum: { total: true },
      }),
      prisma.packageSale.aggregate({
        where: { paidAt: between(window), status: { not: 'CANCELLED' } },
        _sum: { total: true },
      }),
    ]);
    return { campaigns: campaigns._sum.total ?? ZERO, packages: packages._sum.total ?? ZERO };
  },

  async bookingsCount(window) {
    const [campaigns, packages] = await Promise.all([
      prisma.campaign.count({ where: { paidAt: between(window), status: { not: 'CANCELLED' } } }),
      prisma.packageSale.count({ where: { paidAt: between(window), status: { not: 'CANCELLED' } } }),
    ]);
    return campaigns + packages;
  },

  async campaignSpend(window) {
    // The platform side of the capture — one positive leg per booking on
    // platform:payables — rather than the wallet side, which goodwill-first
    // may split in two.
    const result = await prisma.ledgerLeg.aggregate({
      where: {
        transaction: { kind: 'CAMPAIGN_SPEND', occurredAt: between(window) },
        account: { kind: 'PLATFORM' },
      },
      _sum: { amount: true },
    });
    return result._sum.amount ?? ZERO;
  },

  listingsPublished(window) {
    return prisma.listing.count({ where: { publishedAt: between(window) } });
  },

  async hasCampaignSpendLegs() {
    return (await prisma.ledgerTransaction.count({ where: { kind: 'CAMPAIGN_SPEND' } })) > 0;
  },

  async accrualGross(window) {
    // `forDate` is a UTC-midnight date; the IST window's bounds fall at 18:30
    // UTC the evening before, so the comparison lands on the right days.
    const result = await prisma.earningAccrual.aggregate({
      where: { forDate: between(window) },
      _sum: { gross: true },
    });
    return result._sum.gross ?? ZERO;
  },

  async platformRevenue(window) {
    const result = await prisma.ledgerLeg.aggregate({
      where: {
        account: { code: 'platform:revenue' },
        transaction: { occurredAt: between(window) },
      },
      _sum: { amount: true },
    });
    return result._sum.amount ?? ZERO;
  },

  async publisherEarnings(window) {
    const result = await prisma.earningAccrual.aggregate({
      where: { forDate: between(window) },
      _sum: { net: true },
    });
    return result._sum.net ?? ZERO;
  },

  activeCampaigns(window) {
    return prisma.campaign.count({
      where: {
        status: { in: ['LIVE', 'PAUSED', 'COMPLETED'] },
        startDate: { lt: window.end },
        endDate: { gte: window.start },
      },
    });
  },

  newPublishers(window) {
    return prisma.publisher.count({ where: { createdAt: between(window) } });
  },

  newAdvertisers(window) {
    return prisma.advertiser.count({ where: { createdAt: between(window) } });
  },

  async kycPending() {
    const pending = { status: 'PENDING' as const, submittedAt: { not: null } };
    const [publishers, advertisers, agents, users] = await Promise.all([
      prisma.publisherKyc.count({ where: pending }),
      prisma.advertiserKyc.count({ where: pending }),
      prisma.agentKyc.count({ where: pending }),
      prisma.userKyc.count({ where: pending }),
    ]);
    return publishers + advertisers + agents + users;
  },

  /* ── Lot G (Q115): the facts the analytics set walks ─────────────────── */

  async campaignCaptures(window) {
    const legs = await prisma.ledgerLeg.findMany({
      where: {
        transaction: { kind: 'CAMPAIGN_SPEND', occurredAt: between(window) },
        account: { kind: 'PLATFORM' },
        campaignId: { not: null },
      },
      select: { amount: true, campaignId: true, transaction: { select: { occurredAt: true } } },
    });
    return legs.map((leg) => ({ occurredAt: leg.transaction.occurredAt, campaignId: leg.campaignId!, amount: leg.amount }));
  },

  async campaignsWithSpots(campaignIds) {
    if (campaignIds.length === 0) return [];
    const rows = await prisma.campaign.findMany({
      where: { id: { in: [...campaignIds] } },
      select: {
        id: true,
        name: true,
        advertiserId: true,
        agentId: true,
        advertiser: { select: { name: true } },
        agent: { select: { displayId: true, user: { select: { name: true } } } },
        spots: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            listingId: true,
            lineTotal: true,
            listing: { select: { category: true, city: true, cityId: true, cityRef: { select: { slug: true, name: true } }, publisherId: true, publisher: { select: { name: true } } } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      advertiserId: row.advertiserId,
      advertiserName: row.advertiser.name,
      agentId: row.agentId,
      agentName: row.agent ? (row.agent.user.name ?? row.agent.displayId) : null,
      spots: row.spots.map((spot) => ({
        id: spot.id,
        listingId: spot.listingId,
        lineTotal: spot.lineTotal,
        category: spot.listing.category,
        city: spot.listing.city,
        cityId: spot.listing.cityId,
        citySlug: spot.listing.cityRef?.slug ?? null,
        cityName: spot.listing.cityRef?.name ?? null,
        publisherId: spot.listing.publisherId,
        publisherName: spot.listing.publisher?.name ?? null,
      })),
    }));
  },

  async paidCampaigns(window) {
    const rows = await prisma.campaign.findMany({
      where: { paidAt: between(window), status: { not: 'CANCELLED' } },
      select: { id: true, paidAt: true, total: true, advertiserId: true, agentId: true },
    });
    return rows.map((row) => ({ id: row.id, paidAt: row.paidAt!, total: row.total ?? ZERO, advertiserId: row.advertiserId, agentId: row.agentId }));
  },

  async paidPackageSales(window) {
    const rows = await prisma.packageSale.findMany({
      where: { paidAt: between(window), status: { not: 'CANCELLED' } },
      select: {
        paidAt: true,
        total: true,
        advertiserId: true,
        agentId: true,
        advertiser: { select: { name: true } },
        agent: { select: { displayId: true, user: { select: { name: true } } } },
      },
    });
    return rows.map((row) => ({
      paidAt: row.paidAt!,
      total: row.total,
      advertiserId: row.advertiserId,
      advertiserName: row.advertiser.name,
      agentId: row.agentId,
      agentName: row.agent ? (row.agent.user.name ?? row.agent.displayId) : null,
    }));
  },

  async accrualByDay(window, filter) {
    const groups = await prisma.earningAccrual.groupBy({
      by: ['forDate'],
      where: { forDate: between(window), ...accrualFilter(filter) },
      _sum: { gross: true, net: true },
    });
    return groups.map((group) => ({ forDate: group.forDate, gross: group._sum.gross ?? ZERO, net: group._sum.net ?? ZERO }));
  },

  async accrualBySpot(window, filter) {
    const groups = await prisma.earningAccrual.groupBy({
      by: ['campaignSpotId'],
      where: { forDate: between(window), ...accrualFilter(filter) },
      _sum: { gross: true, net: true },
    });
    return groups.map((group) => ({ campaignSpotId: group.campaignSpotId, gross: group._sum.gross ?? ZERO, net: group._sum.net ?? ZERO }));
  },

  async spotCampaigns(spotIds) {
    if (spotIds.length === 0) return [];
    return prisma.campaignSpot.findMany({ where: { id: { in: [...spotIds] } }, select: { id: true, campaignId: true } });
  },

  async creditedIncentives(window) {
    const rows = await prisma.agentIncentive.findMany({
      where: { status: 'CREDITED', verifiedAt: between(window) },
      select: { verifiedAt: true, amount: true, agentId: true, agent: { select: { city: true, cityId: true, displayId: true, user: { select: { name: true } } } } },
    });
    return rows.map((row) => ({
      verifiedAt: row.verifiedAt!,
      amount: row.amount,
      agentId: row.agentId,
      agentName: row.agent.user.name ?? row.agent.displayId,
      agentCity: row.agent.city,
      agentCityId: row.agent.cityId,
    }));
  },

  async onboardedPublishers(window) {
    const rows = await prisma.publisher.findMany({ where: { activatedAt: between(window) }, select: { activatedAt: true, city: true, cityId: true } });
    return rows.map((row) => ({ at: row.activatedAt!, city: row.city, cityId: row.cityId }));
  },

  async onboardedAdvertisers(window) {
    const rows = await prisma.advertiser.findMany({ where: { activatedAt: between(window) }, select: { activatedAt: true, city: true, cityId: true } });
    return rows.map((row) => ({ at: row.activatedAt!, city: row.city, cityId: row.cityId }));
  },

  async activatedAgents(window) {
    const rows = await prisma.agentKyc.findMany({
      where: { status: 'VERIFIED', reviewedAt: between(window) },
      select: { reviewedAt: true, agent: { select: { city: true, cityId: true } } },
    });
    return rows.map((row) => ({ at: row.reviewedAt!, city: row.agent.city, cityId: row.agent.cityId }));
  },

  activeListingsCapacity() {
    return prisma.listing.findMany({ where: { status: 'ACTIVE' }, select: { id: true, slotsTotal: true, publishedAt: true } });
  },

  async bookedSpots(window) {
    const rows = await prisma.campaignSpot.findMany({
      where: {
        status: { in: ['BOOKED', 'LIVE', 'COMPLETED'] },
        listing: { status: 'ACTIVE' },
        startDate: { lt: window.end },
        endDate: { gte: window.start },
      },
      select: { listingId: true, startDate: true, endDate: true, quantity: true },
    });
    return rows.map((row) => ({ listingId: row.listingId, startDate: row.startDate!, endDate: row.endDate!, quantity: row.quantity }));
  },

  /* ── Lot G (Q112): the counts behind the dashboard's rules ───────────── */

  async kycPendingSubmittedBefore(cutoff) {
    const late = { status: 'PENDING' as const, submittedAt: { lt: cutoff } };
    const [publishers, advertisers, agents, users] = await Promise.all([
      prisma.publisherKyc.count({ where: late }),
      prisma.advertiserKyc.count({ where: late }),
      prisma.agentKyc.count({ where: late }),
      prisma.userKyc.count({ where: late }),
    ]);
    return publishers + advertisers + agents + users;
  },

  payoutBatchesInReview() {
    return prisma.payoutBatch.count({ where: { status: 'IN_REVIEW' } });
  },

  withdrawalsApprovedBefore(cutoff) {
    return prisma.withdrawalRequest.count({ where: { status: 'APPROVED', decidedAt: { lt: cutoff } } });
  },

  fraudCasesOpenBefore(cutoff) {
    return prisma.fraudCase.count({ where: { status: { in: ['OPEN', 'INVESTIGATING', 'ESCALATED'] }, createdAt: { lt: cutoff } } });
  },

  supportTicketsBreached(now) {
    // The support queue's own rule (`?breached=true`): late on either clock, and not paused.
    return prisma.supportTicket.count({
      where: {
        status: { not: 'CLOSED' },
        slaPausedAt: null,
        OR: [
          { firstRespondedAt: null, slaFirstResponseDueAt: { lt: now } },
          { slaResolutionDueAt: { lt: now } },
        ],
      },
    });
  },

  floorGraceEndingBetween(now, until) {
    return prisma.priceApproval.count({ where: { status: 'PENDING', graceUntil: { gte: now, lte: until } } });
  },

  async pendingPaymentHoldsEndingBetween(now, until) {
    const groups = await prisma.campaignSpot.groupBy({
      by: ['campaignId'],
      where: { reservedUntil: { gte: now, lte: until }, campaign: { status: 'PENDING_PAYMENT' } },
    });
    return groups.length;
  },
};
