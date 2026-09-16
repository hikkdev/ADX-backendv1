import { Prisma, prisma } from '../../shared/database';
import type { PublisherSubscription, SubscriptionTierName } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import type {
  Activation,
  NewOrder,
  NewPlan,
  OrderListFilter,
  OrderRow,
  PlanPatch,
  PlanRow,
  PublisherPlansRepository,
  SubscriptionListFilter,
  TrialStart,
  TrialStartResult,
} from './publisher-plans.repository';
import { SUBSCRIPTION_STATES } from './publisher-plans.repository';

const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'] as const;

const withPublisher = {
  publisher: { select: { id: true, name: true, userId: true, displayId: true } },
} as const;

export const prismaPublisherPlansRepository: PublisherPlansRepository = {
  /* ---------------------------------------------------------------- */
  /* The catalogue                                                     */
  /* ---------------------------------------------------------------- */

  async listPlans(includeInactive: boolean): Promise<PlanRow[]> {
    return prisma.publisherSubscriptionPlan.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { tier: 'asc' }],
    });
  },

  async findPlan(tier: SubscriptionTierName): Promise<PlanRow | null> {
    return prisma.publisherSubscriptionPlan.findUnique({ where: { tier } });
  },

  /** The seed's door: writes the row once, never over an edited one. */
  async upsertPlan(data: NewPlan): Promise<PlanRow> {
    return prisma.publisherSubscriptionPlan.upsert({
      where: { tier: data.tier },
      create: data,
      update: {},
    });
  },

  async updatePlan(tier: SubscriptionTierName, patch: PlanPatch): Promise<PlanRow> {
    return prisma.publisherSubscriptionPlan.update({ where: { tier }, data: patch });
  },

  /* ---------------------------------------------------------------- */
  /* Orders                                                            */
  /* ---------------------------------------------------------------- */

  async referenceExists(reference: string): Promise<boolean> {
    const row = await prisma.publisherSubscriptionOrder.findUnique({ where: { reference }, select: { id: true } });
    return row !== null;
  },

  async createOrder(data: NewOrder): Promise<OrderRow> {
    return prisma.publisherSubscriptionOrder.create({ data, include: withPublisher });
  },

  async findOrder(id: string): Promise<OrderRow | null> {
    return prisma.publisherSubscriptionOrder.findUnique({ where: { id }, include: withPublisher });
  },

  async listOrdersForPublisher(publisherId: string): Promise<OrderRow[]> {
    return prisma.publisherSubscriptionOrder.findMany({
      where: { publisherId },
      orderBy: { createdAt: 'desc' },
      include: withPublisher,
    });
  },

  async listOrdersPage(filter: OrderListFilter) {
    const base: Prisma.PublisherSubscriptionOrderWhereInput = {
      ...(filter.publisherId ? { publisherId: filter.publisherId } : {}),
      ...(filter.q
        ? {
            OR: [
              { reference: { contains: filter.q, mode: 'insensitive' as const } },
              { planName: { contains: filter.q, mode: 'insensitive' as const } },
              { publisher: { name: { contains: filter.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const where: Prisma.PublisherSubscriptionOrderWhereInput = filter.status?.length
      ? { AND: [base, { status: { in: [...filter.status] } }] }
      : base;

    const [items, total, groups] = await Promise.all([
      prisma.publisherSubscriptionOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: withPublisher,
        ...listArgs(filter),
      }),
      prisma.publisherSubscriptionOrder.count({ where }),
      // The chips are counted with the status facet removed — see list-page.ts.
      prisma.publisherSubscriptionOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, ORDER_STATUSES) };
  },

  async cancelOrder(id: string, at: Date): Promise<OrderRow> {
    return prisma.publisherSubscriptionOrder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: at },
      include: withPublisher,
    });
  },

  async expireStaleOrders(before: Date): Promise<number> {
    const result = await prisma.publisherSubscriptionOrder.updateMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: before } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  },

  async findOrderStartingAt(publisherId: string, tier: SubscriptionTierName, startsAt: Date): Promise<OrderRow | null> {
    return prisma.publisherSubscriptionOrder.findFirst({
      where: { publisherId, tier, startsAt, status: { in: ['PENDING_PAYMENT', 'PAID'] } },
      orderBy: { createdAt: 'desc' },
      include: withPublisher,
    });
  },

  async findOrderBySubscription(subscriptionId: string): Promise<OrderRow | null> {
    return prisma.publisherSubscriptionOrder.findUnique({ where: { subscriptionId }, include: withPublisher });
  },

  async startTrial(input: TrialStart): Promise<TrialStartResult> {
    return prisma.$transaction(async (tx) => {
      // Lot K (B2): the per-publisher lock first, so the history read below
      // sees every trial start that got here before this one.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.publisherId}))`;
      const held = await tx.publisherSubscription.count({ where: { publisherId: input.publisherId } });
      if (held > 0) return { started: false, order: null, subscription: null };

      const subscription = await tx.publisherSubscription.create({
        data: {
          publisherId: input.publisherId,
          tier: input.order.tier,
          ratePct: input.order.ratePct,
          pricePerMonth: input.order.pricePerMonth,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          source: 'SELF_SERVICE',
          autoRenew: false,
        },
      });
      const order = await tx.publisherSubscriptionOrder.create({
        data: {
          ...input.order,
          status: 'PAID',
          paidAt: input.now,
          paidMethod: 'TRIAL',
          paidReference: null,
          startsAt: input.startsAt,
          subscriptionId: subscription.id,
        },
        include: withPublisher,
      });
      return { started: true, order, subscription };
    });
  },

  async debitPosted(idempotencyKey: string): Promise<boolean> {
    const row = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey }, select: { id: true } });
    return row !== null;
  },

  async activateOrder(input: Activation) {
    return prisma.$transaction(async (tx) => {
      const current = await tx.publisherSubscriptionOrder.findUnique({ where: { id: input.orderId }, include: withPublisher });
      if (!current) throw new Error('Subscription order vanished during activation');
      if (current.status === 'PAID') {
        const existing = current.subscriptionId
          ? await tx.publisherSubscription.findUnique({ where: { id: current.subscriptionId } })
          : null;
        return { order: current, subscription: existing, activated: false };
      }

      if (input.endRunningId) {
        await tx.publisherSubscription.update({ where: { id: input.endRunningId }, data: { endsAt: input.now } });
      }
      const subscription = await tx.publisherSubscription.create({
        data: {
          publisherId: current.publisherId,
          tier: current.tier,
          ratePct: current.ratePct,
          pricePerMonth: current.pricePerMonth,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          source: 'SELF_SERVICE',
          autoRenew: input.autoRenew ?? false,
        },
      });
      const order = await tx.publisherSubscriptionOrder.update({
        where: { id: current.id },
        data: {
          status: 'PAID',
          paidAt: input.now,
          paidMethod: input.method,
          paidReference: input.reference,
          startsAt: input.startsAt,
          subscriptionId: subscription.id,
        },
        include: withPublisher,
      });
      return { order, subscription, activated: true };
    });
  },

  /* ---------------------------------------------------------------- */
  /* Subscriptions, for the phone and the sweep                        */
  /* ---------------------------------------------------------------- */

  async listSubscriptionsForPublisher(publisherId: string): Promise<PublisherSubscription[]> {
    return prisma.publisherSubscription.findMany({ where: { publisherId }, orderBy: { startsAt: 'desc' } });
  },

  async listSubscriptionsPage(filter: SubscriptionListFilter, now: Date) {
    const stateWhere = (state: (typeof SUBSCRIPTION_STATES)[number]): Prisma.PublisherSubscriptionWhereInput =>
      state === 'RUNNING'
        ? { startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
        : state === 'UPCOMING'
          ? { startsAt: { gt: now } }
          : { endsAt: { lte: now } };
    const base: Prisma.PublisherSubscriptionWhereInput = {
      ...(filter.publisherId ? { publisherId: filter.publisherId } : {}),
      ...(filter.q
        ? {
            OR: [
              { publisher: { name: { contains: filter.q, mode: 'insensitive' as const } } },
              { publisher: { displayId: { contains: filter.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const where: Prisma.PublisherSubscriptionWhereInput = filter.state ? { AND: [base, stateWhere(filter.state)] } : base;
    const include = { publisher: { select: { id: true, name: true, displayId: true } } } as const;
    const [items, total, ...perState] = await Promise.all([
      prisma.publisherSubscription.findMany({ where, orderBy: { startsAt: 'desc' }, include, ...listArgs(filter) }),
      prisma.publisherSubscription.count({ where }),
      // The chips are counted with the state facet removed — see list-page.ts.
      ...SUBSCRIPTION_STATES.map((state) => prisma.publisherSubscription.count({ where: { AND: [base, stateWhere(state)] } })),
    ]);
    const counts = Object.fromEntries(SUBSCRIPTION_STATES.map((state, index) => [state, perState[index] ?? 0]));
    return { items, total, counts };
  },

  async setSubscriptionAutoRenew(id: string, autoRenew: boolean): Promise<PublisherSubscription> {
    return prisma.publisherSubscription.update({ where: { id }, data: { autoRenew } });
  },

  async findEndingBetween(from: Date, to: Date) {
    return prisma.publisherSubscription.findMany({
      where: { endsAt: { gt: from, lte: to } },
      include: {
        publisher: { select: { id: true, name: true, userId: true } },
        order: { select: { id: true, cycle: true, paidMethod: true } },
      },
      orderBy: { endsAt: 'asc' },
    });
  },

  async hasSuccessor(publisherId: string, at: Date, excludeId: string): Promise<boolean> {
    const row = await prisma.publisherSubscription.findFirst({
      where: {
        publisherId,
        id: { not: excludeId },
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      },
      select: { id: true },
    });
    return row !== null;
  },

  async noticeSent(userId: string, relatedId: string, title: string): Promise<boolean> {
    const row = await prisma.notification.findFirst({ where: { userId, relatedId, title }, select: { id: true } });
    return row !== null;
  },
};
