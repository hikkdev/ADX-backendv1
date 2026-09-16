import { Prisma } from '../../shared/database';
import { prisma } from '../../shared/database/prisma';
import { countsFrom, listArgs } from '../../shared/pagination';
import { PAYMENT_STATUSES, type PaymentsRepository } from './payments.repository';

const withRefunds = { refunds: { orderBy: { createdAt: 'asc' as const } } };

export const prismaPaymentsRepository: PaymentsRepository = {
  createPayment(data) {
    return prisma.payment.create({ data });
  },

  findPayment(id) {
    return prisma.payment.findUnique({ where: { id }, include: withRefunds });
  },

  findByGatewayOrder(gateway, gatewayOrderId) {
    return prisma.payment.findFirst({ where: { gateway, gatewayOrderId }, orderBy: { createdAt: 'desc' }, include: withRefunds });
  },

  findByGatewayPayment(gateway, gatewayPaymentId) {
    return prisma.payment.findFirst({ where: { gateway, gatewayPaymentId }, orderBy: { createdAt: 'desc' }, include: withRefunds });
  },

  updatePayment(id, patch) {
    return prisma.payment.update({ where: { id }, data: patch });
  },

  async referenceExists(reference) {
    return (await prisma.payment.count({ where: { reference } })) > 0;
  },

  async listPaymentsPage(filter) {
    // Scope and search, but not the status facet — the chips keep their own
    // counts while one of them is selected, the shape every list shares.
    const base: Prisma.PaymentWhereInput = {
      ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
      ...(filter.publisherId ? { publisherId: filter.publisherId } : {}),
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
      ...(filter.packageSaleId ? { packageSaleId: filter.packageSaleId } : {}),
      ...(filter.subscriptionOrderId ? { subscriptionOrderId: filter.subscriptionOrderId } : {}),
      ...(filter.gateway ? { gateway: filter.gateway } : {}),
      ...(filter.q
        ? {
            OR: [
              { reference: { contains: filter.q, mode: 'insensitive' as const } },
              { gatewayOrderId: { contains: filter.q, mode: 'insensitive' as const } },
              { gatewayPaymentId: { contains: filter.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const where: Prisma.PaymentWhereInput = {
      ...base,
      ...(filter.status?.length ? { status: { in: filter.status as never } } : {}),
    };
    const orderBy: Prisma.PaymentOrderByWithRelationInput =
      filter.sort === 'OLDEST' ? { createdAt: 'asc' } : filter.sort === 'AMOUNT_DESC' ? { amount: 'desc' } : { createdAt: 'desc' };

    const [items, total, groups] = await Promise.all([
      prisma.payment.findMany({ where, orderBy, ...listArgs(filter), include: withRefunds }),
      prisma.payment.count({ where }),
      prisma.payment.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, PAYMENT_STATUSES) };
  },

  refundableForAdvertiser(advertiserId) {
    return prisma.payment.findMany({
      where: { advertiserId, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
      orderBy: { capturedAt: 'desc' },
      take: 50,
      include: withRefunds,
    });
  },

  createRefund(data) {
    return prisma.paymentRefund.create({ data });
  },

  findRefund(id) {
    return prisma.paymentRefund.findUnique({ where: { id }, include: { payment: true } });
  },

  findRefundByGatewayId(gateway, gatewayRefundId) {
    return prisma.paymentRefund.findFirst({ where: { gatewayRefundId, payment: { gateway } }, include: { payment: true } });
  },

  findRefundByRequest(refundRequestId) {
    return prisma.paymentRefund.findFirst({ where: { refundRequestId }, orderBy: { createdAt: 'desc' }, include: { payment: true } });
  },

  updateRefund(id, patch) {
    return prisma.paymentRefund.update({ where: { id }, data: patch });
  },

  async recordWebhookEvent(data) {
    try {
      const event = await prisma.webhookEvent.create({ data });
      return { event, created: true };
    } catch (err) {
      // The unique on (gateway, eventId): the gateway retried an event the
      // platform already holds. Answer with the row so the caller can say so.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { gateway_eventId: { gateway: data.gateway, eventId: data.eventId } } });
        return { event, created: false };
      }
      throw err;
    }
  },

  async markWebhookProcessed(id, outcome, at) {
    await prisma.webhookEvent.update({ where: { id }, data: { processedAt: at, outcome } });
  },
};
