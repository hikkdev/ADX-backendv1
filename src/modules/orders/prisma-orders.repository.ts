import { Prisma, prisma } from '../../shared/database';
import type { Order, OrderStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import type {
  AutoAccept,
  MyOrderRow,
  NewOrder,
  OpenOrderScope,
  OrdersRepository,
  PlacementLock,
  VerificationPatch,
} from './orders.repository';
import { CALENDAR_CATEGORIES, ORDER_STATUSES, type AdminOrdersQuery, type CalendarQuery, type MyOrdersQuery } from './orders.schema';
import { slotHoldingOrdersWhere, slotsHeldWith } from '../listings';

/** The client an insert runs on: the repository's own, or the transaction holding the listing lock (G10). */
type OrderWriter = Pick<Prisma.TransactionClient, 'order'>;

/** The insert itself, on either client. With `accepted`, the row is born PENDING_PRINT (Lot D, Q105). */
function createOrder(db: OrderWriter, data: NewOrder, accepted?: AutoAccept) {
  return db.order.create({
    data: {
      ...data,
      ...(accepted
        ? {
            // Lot D (Q105): the listing accepted it. No timer — there is
            // nobody to wait for.
            status: 'PENDING_PRINT',
            publisherAcceptedAt: accepted.at,
            autoAcceptedAt: accepted.at,
            publisherTimerExpiry: null,
            meetingPlace: accepted.meetingPlace,
          }
        : {
            status: 'PENDING_PUBLISHER',
            // The publisher has 30 minutes to respond before the timer job alerts
            // admins. See jobs/publisher-timer.
            publisherTimerExpiry: new Date(Date.now() + 30 * 60 * 1000),
          }),
    },
    include: { listing: { include: { publisher: { include: { user: true } } } } },
  });
}

const withPublisher = { listing: { include: { publisher: true } } } as const;


/**
 * One page of a persona's own orders.
 *
 * The three personas differ only in how they reach an order and how much of
 * the listing they need with it; everything after that — the status facet, the
 * sort, the bound and the chip histogram — is the same question three times,
 * so it is asked in one place.
 *
 * `counts` is computed over the caller's scope WITHOUT the status facet, so a
 * publisher who has tapped "Requests" can still see how many are Active.
 */
async function myOrdersPage(
  scope: Prisma.OrderWhereInput,
  query: MyOrdersQuery,
  include: Prisma.OrderInclude,
): Promise<{ items: MyOrderRow[]; total: number; counts: Record<string, number> }> {
  const where: Prisma.OrderWhereInput = {
    ...scope,
    ...(query.status?.length ? { status: { in: query.status as OrderStatus[] } } : {}),
    ...(query.q
      ? {
          OR: [
            { campaignName: { contains: query.q, mode: 'insensitive' } },
            { listing: { title: { contains: query.q, mode: 'insensitive' } } },
            { listing: { address: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.OrderOrderByWithRelationInput =
    query.sort === 'OLDEST'
      ? { createdAt: 'asc' }
      : query.sort === 'DUE'
        ? { slotTime: { sort: 'asc', nulls: 'last' } }
        : { createdAt: 'desc' };

  const [items, total, groups] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy,
      ...listArgs(query),
      include: {
        ...include,
        // Lot B (Q102): the accepted offer's quote rides on every row, so the
        // agent's list prints the figure without a second read per card.
        agentAssignments: {
          where: { status: 'ACCEPTED' },
          orderBy: { assignedAt: 'desc' },
          take: 1,
          select: { quotedFee: true },
        },
      },
    }),
    prisma.order.count({ where }),
    prisma.order.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
  ]);
  const rows: MyOrderRow[] = items.map(({ agentAssignments, ...row }) => ({
    ...(row as Order),
    quotedFee: agentAssignments[0]?.quotedFee ?? null,
  }));
  return { items: rows, total, counts: countsFrom(groups, ORDER_STATUSES) };
}

/** Lot G (Q114): the calendar's listing filter — ACTIVE spots, by city, category and a search over the spot itself. */
function calendarWhere(query: CalendarQuery): Prisma.ListingWhereInput {
  return {
    status: 'ACTIVE',
    ...(query.city ? { city: { contains: query.city, mode: 'insensitive' } } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: 'insensitive' } },
            { address: { contains: query.q, mode: 'insensitive' } },
            { city: { contains: query.q, mode: 'insensitive' } },
            { displayId: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export const prismaOrdersRepository: OrdersRepository = {
  create(data: NewOrder, accepted?: AutoAccept) {
    return createOrder(prisma, data, accepted);
  },

  placeUnderListingLock<T>(listingId: string, run: (locked: PlacementLock) => Promise<T>): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        // G10: the per-listing lock, first, so the count below and the insert
        // are serialised against every other placement — and every
        // reservation hold, which takes the same key — on this listing.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${listingId}))`;
        return run({
          slotsHeld: async (window, options = {}) => (await slotsHeldWith(tx, [listingId], window, options)).get(listingId) ?? 0,
          create: (data, accepted) => createOrder(tx, data, accepted),
        });
      },
      { timeout: 15_000 },
    );
  },

  findById(orderId: string) {
    return prisma.order.findUnique({ where: { id: orderId } });
  },

  findSummary(orderId: string) {
    return prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, agentId: true, listingId: true },
    });
  },

  findWithPublisher(orderId: string) {
    return prisma.order.findUnique({ where: { id: orderId }, include: withPublisher }) as never;
  },

  findWithVerification(orderId) {
    return prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        selfInstallCheckedInAt: true,
        verification: { select: { qrScanned: true } },
      },
    }) as never;
  },

  async addPhotos(orderId, kind, photos, uploadedByUserId) {
    if (photos.length === 0) return 0;
    const result = await prisma.orderPhoto.createMany({
      data: photos.map((photo) => ({
        orderId,
        kind,
        url: photo.url,
        label: photo.label ?? null,
        latitude: photo.latitude ?? null,
        longitude: photo.longitude ?? null,
        uploadedByUserId: uploadedByUserId ?? null,
      })),
    });
    return result.count;
  },

  async countPhotos(orderId) {
    const rows = await prisma.orderPhoto.groupBy({
      by: ['kind'],
      where: { orderId },
      _count: { _all: true },
    });
    return rows.map((row) => ({ kind: row.kind, count: row._count._all }));
  },

  listPhotos(orderId) {
    return prisma.orderPhoto.findMany({
      where: { orderId },
      orderBy: { capturedAt: 'asc' },
      select: {
        id: true,
        kind: true,
        label: true,
        url: true,
        latitude: true,
        longitude: true,
        capturedAt: true,
      },
    });
  },

  findDetail(orderId) {
    // The widest read in the codebase. `milestones` belongs to the
    // order-milestones module but is joined here because the detail endpoint
    // returns the whole order aggregate in one response.
    return prisma.order.findUnique({
      where: { id: orderId },
      include: {
        listing: {
          include: {
            publisher: { include: { user: true } },
            agent: { include: { user: true } },
          },
        },
        advertiser: true,
        agent: { include: { user: true } },
        agentAssignments: {
          include: { agent: { include: { user: true } } },
          orderBy: { assignedAt: 'desc' },
        },
        checkIn: true,
        verification: true,
        milestones: { include: { template: true }, orderBy: { order: 'asc' } },
      },
    });
  },

  update(orderId: string, data: Record<string, unknown>) {
    return prisma.order.update({ where: { id: orderId }, data });
  },

  findCompletedExpiredForListing(listingId: string) {
    return prisma.order.findFirst({
      where: { listingId, status: 'COMPLETED', endDate: { lt: new Date() } },
    });
  },

  // ── Lot G (Q114): the booking calendar ───────────────────────────────

  async findCalendar(query: CalendarQuery) {
    const where = calendarWhere(query);
    const [items, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        orderBy: [{ city: 'asc' }, { title: 'asc' }],
        ...listArgs(query),
        select: {
          id: true,
          displayId: true,
          title: true,
          city: true,
          category: true,
          slotsTotal: true,
          orders: {
            // The orders that hold a slot over the window — `listings`' rule,
            // so the grid shows exactly what the count refuses against.
            where: slotHoldingOrdersWhere({ from: query.from, to: query.to }),
            orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
            select: {
              id: true,
              status: true,
              campaignName: true,
              startDate: true,
              endDate: true,
              slotTime: true,
              campaignSpot: { select: { campaign: { select: { id: true, reference: true, name: true } } } },
            },
          },
        },
      }),
      prisma.listing.count({ where }),
    ]);
    return { items, total };
  },

  async countCalendarByCategory(query: CalendarQuery) {
    const groups = await prisma.listing.groupBy({ by: ['category'], where: calendarWhere(query), _count: { _all: true } });
    return countsFrom(
      groups.map((group) => ({ status: group.category, _count: group._count })),
      CALENDAR_CATEGORIES,
    );
  },

  findPublisherTimerExpired(windowStart: Date, now: Date) {
    return prisma.order.findMany({
      where: {
        status: 'PENDING_PUBLISHER',
        publisherTimerExpiry: { gte: windowStart, lt: now },
      },
      select: { id: true },
    });
  },

  findAgentTimerExpired(windowStart: Date, now: Date) {
    return prisma.order.findMany({
      where: {
        status: 'PENDING_AGENT',
        agentTimerExpiry: { gte: windowStart, lt: now },
      },
      select: { id: true, agentId: true },
    });
  },

  async findConfirmedSlotsForPublisher(publisherId: string, from: Date, to: Date) {
    const rows = await prisma.order.findMany({
      where: {
        listing: { publisherId },
        status: { in: ['SLOT_CONFIRMED', 'IN_PROGRESS'] },
        slotTime: { gte: from, lt: to },
      },
      select: { slotTime: true },
    });
    return rows.map((row) => row.slotTime).filter((at): at is Date => at !== null);
  },

  findForAdvertiser(advertiserId: string, query: MyOrdersQuery) {
    return myOrdersPage({ advertiserId }, query, { listing: true });
  },

  findForPublisherUser(publisherUserId: string, query: MyOrdersQuery) {
    return myOrdersPage(
      { listing: { publisher: { userId: publisherUserId } } },
      query,
      { listing: true },
    );
  },

  findForAgent(agentProfileId: string, query: MyOrdersQuery) {
    return myOrdersPage({ agentId: agentProfileId }, query, withPublisher);
  },

  findAgentOrderIdsInStatuses(agentProfileId: string, statuses: string[]) {
    return prisma.order.findMany({
      where: { agentId: agentProfileId, status: { in: statuses as any } },
      select: { id: true },
    });
  },

  async findAll(query: AdminOrdersQuery) {
    // Everything except the status facet, so the chip row can still say how
    // many orders are awaiting a publisher while "In progress" is selected.
    // E7-2: the window — a slot inside it, or a flight overlapping it
    // (starts before it ends, ends after it starts); one bound alone is open.
    const window: Prisma.OrderWhereInput[] =
      query.from || query.to
        ? [
            {
              OR: [
                { slotTime: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } },
                {
                  AND: [
                    ...(query.to ? [{ startDate: { lte: query.to } }] : []),
                    ...(query.from ? [{ endDate: { gte: query.from } }] : []),
                    ...(!query.to ? [{ startDate: { not: null } }] : []),
                    ...(!query.from ? [{ endDate: { not: null } }] : []),
                  ],
                },
              ],
            },
          ]
        : [];
    const base: Prisma.OrderWhereInput = {
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.listingId ? { listingId: query.listingId } : {}),
      ...(query.city ? { listing: { city: { contains: query.city, mode: 'insensitive' } } } : {}),
      // E7-2: the advertiser account, through the campaign spot the order was raised from.
      ...(query.advertiserId ? { campaignSpot: { campaign: { advertiserId: query.advertiserId } } } : {}),
      ...(window.length ? { AND: window } : {}),
      ...(query.q
        ? {
            OR: [
              { campaignName: { contains: query.q, mode: 'insensitive' } },
              { listing: { title: { contains: query.q, mode: 'insensitive' } } },
              { listing: { address: { contains: query.q, mode: 'insensitive' } } },
              { listing: { city: { contains: query.q, mode: 'insensitive' } } },
              { agent: { user: { name: { contains: query.q, mode: 'insensitive' } } } },
              { agent: { displayId: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const where: Prisma.OrderWhereInput = {
      ...base,
      ...(query.status?.length ? { status: { in: query.status as OrderStatus[] } } : {}),
    };

    // An order with no confirmed slot has no due time; it sorts last rather
    // than heading a board whose whole point is what happens next.
    const orderBy: Prisma.OrderOrderByWithRelationInput =
      query.sort === 'OLDEST'
        ? { createdAt: 'asc' }
        : query.sort === 'DUE'
          ? { slotTime: { sort: 'asc', nulls: 'last' } }
          : { createdAt: 'desc' };

    const [items, total, groups] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy,
        ...listArgs(query),
        include: { listing: true, agent: { include: { user: true } } },
      }),
      prisma.order.count({ where }),
      prisma.order.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, ORDER_STATUSES) };
  },

  findOpenForListings(listingIds: string[]) {
    if (listingIds.length === 0) return Promise.resolve([]);
    return prisma.order.findMany({
      where: { listingId: { in: listingIds }, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      select: { id: true, listingId: true, advertiserId: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  findAgentLocation(orderId: string) {
    return prisma.order.findUnique({
      where: { id: orderId },
      // LT-1: the site too, so the parties' read can say how far the agent is.
      select: { agentLatitude: true, agentLongitude: true, agentLocationUpdatedAt: true, listing: { select: { latitude: true, longitude: true } } },
    });
  },

  findPendingAssignment(orderId: string, agentId: string) {
    return prisma.orderAgentAssignment.findFirst({
      where: { orderId, agentId, status: 'PENDING' },
    });
  },

  findAssignments(orderId: string) {
    return prisma.orderAgentAssignment.findMany({ where: { orderId } });
  },

  findAssignmentsForAgent(agentId: string) {
    return prisma.orderAgentAssignment.findMany({
      where: { agentId },
      orderBy: { assignedAt: 'desc' },
      take: 200,
    });
  },

  findOpenForAdvertiserUser(userId: string) {
    return prisma.order.findMany({
      where: { advertiserId: userId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      select: { id: true, listingId: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  async countOpenExposure(scope: OpenOrderScope) {
    const party: Prisma.OrderWhereInput =
      'publisherId' in scope ? { listing: { publisherId: scope.publisherId } } : 'advertiserUserId' in scope ? { advertiserId: scope.advertiserUserId } : { agentId: scope.agentId };
    const agg = await prisma.order.aggregate({
      where: { ...party, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      _count: { _all: true },
      _sum: { budget: true },
    });
    return { count: agg._count._all, value: agg._sum.budget };
  },

  findPendingAssignmentsForAgent(agentId: string) {
    return prisma.orderAgentAssignment.findMany({
      where: { agentId, status: 'PENDING' },
      select: { id: true, orderId: true },
      orderBy: { assignedAt: 'asc' },
    });
  },

  createAssignment(orderId: string, agentId: string, quotedFee = null) {
    return prisma.orderAgentAssignment.create({
      data: { orderId, agentId, status: 'PENDING', quotedFee },
    });
  },

  async acceptAssignment(assignmentId: string, orderId: string, agentId: string) {
    // Atomic: an accepted assignment without the order moving to SLOT_PROPOSED
    // would strand the order with no one able to act on it.
    await prisma.$transaction([
      prisma.orderAgentAssignment.update({
        where: { id: assignmentId },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      }),
      prisma.order.update({
        where: { id: orderId },
        // The acceptance window is spent the moment it is answered; leaving the
        // stamp behind would keep a countdown running on a job already taken.
        data: { status: 'SLOT_PROPOSED', agentId, agentTimerExpiry: null },
      }),
    ]);
  },

  async rejectAssignment(assignmentId: string, orderId: string, reason?: string) {
    await prisma.$transaction([
      prisma.orderAgentAssignment.update({
        where: { id: assignmentId },
        data: { status: 'REJECTED', rejectionReason: reason, respondedAt: new Date() },
      }),
      prisma.order.update({
        where: { id: orderId },
        // Cleared rather than left to lapse: auto-assignment sets a fresh window
        // for whoever is offered it next.
        data: { agentRejectionCount: { increment: 1 }, agentTimerExpiry: null },
      }),
    ]);
  },

  findCurrentAssignment(orderId: string, agentId: string) {
    return prisma.orderAgentAssignment.findFirst({
      where: { orderId, agentId, status: { in: ['PENDING', 'ACCEPTED'] } },
      orderBy: { assignedAt: 'desc' },
    });
  },

  async reassignAssignment(assignmentId: string, reason: string) {
    await prisma.orderAgentAssignment.update({
      where: { id: assignmentId },
      data: { status: 'REASSIGNED', rejectionReason: reason, respondedAt: new Date() },
    });
  },

  async findLabelsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await prisma.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, listing: { select: { title: true } } },
    });
    return rows.map((row) => ({ id: row.id, label: row.listing.title + ' - ' + row.status, displayId: null }));
  },

  findCheckIn(orderId: string) {
    return prisma.checkIn.findUnique({ where: { orderId } });
  },

  upsertVerification(orderId: string, data: VerificationPatch) {
    return prisma.siteVerification.upsert({
      where: { orderId },
      update: data,
      create: { orderId, ...data },
    });
  },

  upsertCheckIn(orderId: string, data: { latitude: number; longitude: number; distanceM: number }) {
    return prisma.checkIn.upsert({
      where: { orderId },
      create: { orderId, ...data },
      // checkedInAt is refreshed on re-check-in but set by default on create.
      update: { ...data, checkedInAt: new Date() },
    });
  },
};
