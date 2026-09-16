import { Prisma, prisma } from '../../shared/database';
import type { FieldVisitStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import type { NewVisit, VisitPatch, VisitsRepository } from './visits.repository';
import { VISIT_STATUSES, type AdminVisitsQuery, type MyVisitsQuery } from './visits.schema';

/** Still ahead of the agent, or happening now. */
const OPEN: FieldVisitStatus[] = ['REQUESTED', 'SCHEDULED', 'IN_PROGRESS'];

/**
 * Which window a visit falls in.
 *
 * TODAY is anything open with a slot inside the day, plus a request with no
 * slot yet — it needs answering today whether or not it has a time. UPCOMING
 * is open and slotted after today. PAST is everything settled, however it
 * settled, newest first.
 */
function scopeWhere(scope: MyVisitsQuery['scope'], day: { start: Date; end: Date }): Prisma.FieldVisitWhereInput {
  switch (scope) {
    case 'TODAY':
      return {
        status: { in: OPEN },
        OR: [{ scheduledFor: { gte: day.start, lt: day.end } }, { scheduledFor: null }],
      };
    case 'UPCOMING':
      return { status: { in: OPEN }, scheduledFor: { gte: day.end } };
    case 'PAST':
      return { status: { notIn: OPEN } };
  }
}

const orderFor = (sort: string, scope?: string): Prisma.FieldVisitOrderByWithRelationInput[] =>
  scope === 'PAST'
    ? [{ completedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }]
    : sort === 'NEWEST'
      ? [{ createdAt: 'desc' }]
      : // A request with no slot has nothing to sort on; it goes to the top,
        // because it is the thing that needs answering.
        [{ scheduledFor: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }];

export const prismaVisitsRepository: VisitsRepository = {
  create(data: NewVisit) {
    return prisma.fieldVisit.create({ data: data as Prisma.FieldVisitUncheckedCreateInput });
  },

  findById(visitId: string) {
    return prisma.fieldVisit.findUnique({ where: { id: visitId } });
  },

  update(visitId: string, patch: VisitPatch) {
    return prisma.fieldVisit.update({
      where: { id: visitId },
      data: patch as Prisma.FieldVisitUncheckedUpdateInput,
    });
  },

  async findMine(agentId: string, query: MyVisitsQuery, day: { start: Date; end: Date }) {
    const base: Prisma.FieldVisitWhereInput = {
      agentId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.q
        ? {
            OR: [
              { businessName: { contains: query.q, mode: 'insensitive' } },
              { locality: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    // The three chips are windows, not statuses; the status facet composes
    // with them and the histogram is counted over the window without it.
    const scoped: Prisma.FieldVisitWhereInput = { AND: [base, scopeWhere(query.scope, day)] };
    const where: Prisma.FieldVisitWhereInput = {
      AND: [scoped, ...(query.status?.length ? [{ status: { in: query.status as FieldVisitStatus[] } }] : [])],
    };
    const [items, total, groups] = await Promise.all([
      prisma.fieldVisit.findMany({ where, orderBy: orderFor(query.sort, query.scope), ...listArgs(query) }),
      prisma.fieldVisit.count({ where }),
      prisma.fieldVisit.groupBy({ by: ['status'], where: scoped, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, VISIT_STATUSES) };
  },

  async findForAdmin(query: AdminVisitsQuery & { cityId?: string | null }, day: { start: Date; end: Date } | null) {
    // Lot X-L: the key is the identity — keyed rows by key, null-keyed rows by the spelling.
    const cityWhere: Prisma.FieldVisitWhereInput = query.city
      ? query.cityId
        ? { OR: [{ cityId: query.cityId }, { cityId: null, city: { contains: query.city, mode: 'insensitive' } }] }
        : { cityId: null, city: { contains: query.city, mode: 'insensitive' } }
      : {};
    const base: Prisma.FieldVisitWhereInput = {
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.campaignTag ? { campaignTag: { equals: query.campaignTag, mode: 'insensitive' } } : {}),
      ...(day ? { scheduledFor: { gte: day.start, lt: day.end } } : {}),
      // The city clause and `q` each own an OR, so both sit in one AND list.
      AND: [
        cityWhere,
        ...(query.q
          ? [
              {
                OR: [
                  { businessName: { contains: query.q, mode: 'insensitive' as const } },
                  { displayId: { contains: query.q, mode: 'insensitive' as const } },
                  { locality: { contains: query.q, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const where: Prisma.FieldVisitWhereInput = {
      ...base,
      ...(query.status?.length ? { status: { in: query.status as FieldVisitStatus[] } } : {}),
    };
    const [items, total, groups] = await Promise.all([
      prisma.fieldVisit.findMany({ where, orderBy: orderFor(query.sort), ...listArgs(query) }),
      prisma.fieldVisit.count({ where }),
      prisma.fieldVisit.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, VISIT_STATUSES) };
  },

  findInWindow(agentId: string, window: { start: Date; end: Date }) {
    return prisma.fieldVisit.findMany({
      where: {
        agentId,
        status: { in: OPEN },
        OR: [{ scheduledFor: { gte: window.start, lt: window.end } }, { scheduledFor: null }],
      },
      orderBy: [{ scheduledFor: { sort: 'asc', nulls: 'first' } }],
    });
  },

  findScheduledInRange(agentId: string, window: { start: Date; end: Date }) {
    return prisma.fieldVisit.findMany({
      where: { agentId, scheduledFor: { gte: window.start, lt: window.end } },
      orderBy: [{ scheduledFor: 'asc' }],
    });
  },

  findExpiredOffers(closedBefore: Date, notBefore: Date) {
    return prisma.fieldVisit.findMany({
      where: { status: 'REQUESTED', offerExpiresAt: { gte: notBefore, lt: closedBefore } },
    });
  },

  findOpenForAgent(agentId: string) {
    return prisma.fieldVisit.findMany({
      where: { agentId, status: { in: ['REQUESTED', 'SCHEDULED'] } },
      orderBy: { createdAt: 'asc' },
    });
  },

  findForPublisher(publisherId: string, limit: number) {
    return prisma.fieldVisit.findMany({
      where: { publisherId, status: { in: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  async countOutcomes(visitId: string) {
    const [sales, campaigns] = await Promise.all([
      prisma.packageSale.count({
        where: { visitId, status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'EXPIRED'] } },
      }),
      prisma.campaign.count({
        where: { visitId, status: { in: ['SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED'] } },
      }),
    ]);
    return { sales, campaigns };
  },
};
