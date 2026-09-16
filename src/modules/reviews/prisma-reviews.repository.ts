import { Prisma, prisma } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import type { ReviewStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import { REVIEW_STATUSES, type ListReviewsQuery } from './reviews.schema';
import type { ReviewsRepository } from './reviews.repository';

export const prismaReviewsRepository: ReviewsRepository = {
  findById(id) {
    return prisma.review.findUnique({ where: { id } });
  },

  findByAnchor(anchorKind, anchorId, subjectType) {
    return prisma.review.findUnique({
      where: { anchorKind_anchorId_subjectType: { anchorKind, anchorId, subjectType } },
    });
  },

  async create(data) {
    try {
      return await prisma.review.create({ data });
    } catch (err) {
      // The anchor unique or the partial unique (a publisher rates an agent
      // once): two taps landed together and the service's read-then-check
      // saw neither. The second reads the same 409 the first check gives.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError(409, 'REVIEW_EXISTS', 'This has already been reviewed.');
      }
      throw err;
    }
  },

  async publisherHasRatedAgent(publisherId, agentId) {
    const count = await prisma.review.count({
      where: { subjectType: 'AGENT', subjectId: agentId, authorPublisherId: publisherId },
    });
    return count > 0;
  },

  async aggregate(subjectType, subjectId) {
    const result = await prisma.review.aggregate({
      where: { subjectType, subjectId, status: 'PUBLISHED' },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const count = result._count._all;
    const avg = result._avg.rating;
    return {
      avg: count === 0 || avg === null ? null : new Prisma.Decimal(avg).toFixed(2),
      count,
    };
  },

  async listPublished(subjectType, subjectId, page, pageSize, options = {}) {
    const where: Prisma.ReviewWhereInput = {
      subjectType,
      subjectId,
      status: 'PUBLISHED',
      ...(options.q ? { note: { contains: options.q, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: options.sort === 'OLDEST' ? 'asc' : 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.review.count({ where }),
    ]);
    return { items, total };
  },

  async listForAdmin(query) {
    // Everything but the status facet, so the chips keep their counts while
    // one of them is selected — the same rule every desk list follows.
    const base: Prisma.ReviewWhereInput = {
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.q ? { note: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const where: Prisma.ReviewWhereInput = {
      ...base,
      ...(query.status?.length ? { status: { in: query.status as ReviewStatus[] } } : {}),
    };
    const [items, total, groups] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: query.sort === 'OLDEST' ? 'asc' : 'desc' },
        ...listArgs(query),
      }),
      prisma.review.count({ where }),
      prisma.review.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, REVIEW_STATUSES) };
  },

  setStatus(id, patch) {
    return prisma.review.update({ where: { id }, data: patch });
  },

  findByAnchors(anchorKind, anchorIds, subjectType) {
    if (anchorIds.length === 0) return Promise.resolve([]);
    return prisma.review.findMany({ where: { anchorKind, anchorId: { in: anchorIds }, subjectType } });
  },

  async publisherNames(publisherIds) {
    const ids = [...new Set(publisherIds)];
    if (ids.length === 0) return new Map();
    const rows = await prisma.publisher.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  },

  recentForAgent(agentId, from) {
    return prisma.review.findMany({
      where: { subjectType: 'AGENT', subjectId: agentId, status: 'PUBLISHED', createdAt: { gte: from } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  },
};
