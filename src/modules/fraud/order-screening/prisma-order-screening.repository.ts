import { Prisma, prisma } from '../../../shared/database';
import type { OrderStatus } from '../../../shared/database';
import type { OrderScreeningIndex, ScreeningParty } from './order-screening.repository';

/**
 * Order fraud screening — the read-only index behind the order signals
 * (2 Oct 2026). Reads across the advertiser, publisher, order, payment,
 * campaign-refund, fraud-case and accrual tables; writes nothing. Every
 * write to an order goes through `orders`.
 */

/** An order that never took a slot, or gave it back: it cannot be a duplicate of anything. */
const DEAD_STATUSES: OrderStatus[] = ['CANCELLED', 'PUBLISHER_REJECTED', 'DRAFT'];
/** QR-14: the doors an agent opens — `onboardedById` is then the agent's login. */
const AGENT_DOORS = ['AGENT', 'QR'];
const DAY_MS = 24 * 60 * 60 * 1000;

const partySelect = { id: true, userId: true, agentId: true, onboardedVia: true, onboardedById: true, createdAt: true } as const;
type PartyRow = { id: string; userId: string | null; agentId: string | null; onboardedVia: string | null; onboardedById: string | null; createdAt: Date };
const toParty = (row: PartyRow): ScreeningParty => ({
  id: row.id,
  userId: row.userId,
  agentId: row.agentId,
  onboardedByAgentUserId: row.onboardedVia && AGENT_DOORS.includes(row.onboardedVia) ? row.onboardedById : null,
  createdAt: row.createdAt,
});

export const prismaOrderScreeningIndex: OrderScreeningIndex = {
  async advertiserForLogin(userId) {
    const row = await prisma.advertiser.findUnique({ where: { userId }, select: { ...partySelect, user: { select: { createdAt: true } } } });
    if (!row) return null;
    return { ...toParty(row), userCreatedAt: row.user?.createdAt ?? null };
  },

  async loginCreatedAt(userId) {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  },

  async publisherOfListing(listingId) {
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { publisher: { select: partySelect } } });
    return listing?.publisher ? toParty(listing.publisher) : null;
  },

  countOrdersPlaced(userId, from, to) {
    return prisma.order.count({ where: { advertiserId: userId, createdAt: { gte: from, lte: to } } });
  },

  overlappingOrders({ userId, listingId, excludeOrderId, window, placedAt }) {
    const when: Prisma.OrderWhereInput = window
      ? { startDate: { lte: window.end }, endDate: { gte: window.start } }
      : { startDate: null, endDate: null, createdAt: { gte: new Date(placedAt.getTime() - DAY_MS), lte: new Date(placedAt.getTime() + DAY_MS) } };
    return prisma.order.findMany({
      where: { advertiserId: userId, listingId, id: { not: excludeOrderId }, status: { notIn: DEAD_STATUSES }, ...when },
      select: { id: true, displayId: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  },

  async paymentHistory({ advertiserId, campaignId, placedAt, since }) {
    const failedWhere: Prisma.PaymentWhereInput = campaignId
      ? { campaignId, status: 'FAILED' }
      : { advertiserId, status: 'FAILED', createdAt: { gte: new Date(placedAt.getTime() - DAY_MS), lte: placedAt } };
    const [failedAttempts, gatewayRefunds, campaignIds] = await Promise.all([
      prisma.payment.count({ where: failedWhere }),
      prisma.payment.count({ where: { advertiserId, status: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] }, updatedAt: { gte: since } } }),
      prisma.campaign.findMany({ where: { advertiserId }, select: { id: true } }),
    ]);
    const ids = campaignIds.map((c) => c.id);
    // `CampaignRefund` carries a campaign id without a relation, so the campaigns are read first.
    const campaignRefunds = ids.length ? await prisma.campaignRefund.count({ where: { campaignId: { in: ids }, createdAt: { gte: since } } }) : 0;
    return { failedAttempts, refunds: gatewayRefunds + campaignRefunds };
  },

  async priorConfirmedFraud({ advertiserId, publisherId, advertiserUserId, excludeOrderId }) {
    const [advertiserCases, publisherCases, advertiserOrders, publisherOrders] = await Promise.all([
      advertiserId ? prisma.fraudCase.count({ where: { subjectType: 'ADVERTISER', subjectId: advertiserId, status: 'CONFIRMED' } }) : Promise.resolve(0),
      publisherId ? prisma.fraudCase.count({ where: { subjectType: 'PUBLISHER', subjectId: publisherId, status: 'CONFIRMED' } }) : Promise.resolve(0),
      prisma.order.count({ where: { advertiserId: advertiserUserId, riskReviewStatus: 'CONFIRMED_FRAUD', id: { not: excludeOrderId } } }),
      publisherId
        ? prisma.order.count({ where: { listing: { publisherId }, riskReviewStatus: 'CONFIRMED_FRAUD', id: { not: excludeOrderId } } })
        : Promise.resolve(0),
    ]);
    return { advertiserCases, publisherCases, advertiserOrders, publisherOrders };
  },

  async accruedForOrder(orderId) {
    const agg = await prisma.earningAccrual.aggregate({ where: { spot: { orderId } }, _sum: { net: true } });
    return (agg._sum.net ?? new Prisma.Decimal(0)).toFixed(2);
  },

  async agentsOnOrder(orderId, holdingAgentId) {
    const pending = await prisma.orderAgentAssignment.findMany({ where: { orderId, status: 'PENDING' }, select: { agentId: true } });
    return new Set([...(holdingAgentId ? [holdingAgentId] : []), ...pending.map((offer) => offer.agentId)]).size;
  },
};
