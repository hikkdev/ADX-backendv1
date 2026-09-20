import { Prisma, prisma } from '../../shared/database';
import { listArgs } from '../../shared/pagination';
import type { DeskDraftsQuery, SaveDraftInput } from './drafts.schema';
import type { DraftsRepository } from './drafts.repository';

const deskInclude = {
  publisher: { select: { id: true, displayId: true, name: true, mobile: true, city: true, kycStatus: true } },
} satisfies Prisma.ListingDraftInclude;

const data = (input: SaveDraftInput) => ({
  ...(input.category !== undefined ? { category: input.category } : {}),
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
  ...(input.stepKey !== undefined ? { stepKey: input.stepKey } : {}),
  answers: input.answers as Prisma.InputJsonValue,
});

export const prismaDraftsRepository: DraftsRepository = {
  listForPublisher(publisherId) {
    return prisma.listingDraft.findMany({ where: { publisherId }, orderBy: { updatedAt: 'desc' } });
  },
  findForPublisher(publisherId, id) {
    return prisma.listingDraft.findFirst({ where: { id, publisherId } });
  },
  create(publisherId, displayId, input) {
    return prisma.listingDraft.create({ data: { publisherId, displayId, ...data(input) } });
  },
  update(id, input) {
    return prisma.listingDraft.update({ where: { id }, data: data(input) });
  },
  remove(id) {
    return prisma.listingDraft.delete({ where: { id } });
  },
  async desk(query, idleBefore) {
    const where: Prisma.ListingDraftWhereInput = {
      ...(idleBefore ? { updatedAt: { lte: idleBefore } } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q
        ? {
            OR: [
              { displayId: { contains: query.q, mode: 'insensitive' } },
              { title: { contains: query.q, mode: 'insensitive' } },
              { publisher: { name: { contains: query.q, mode: 'insensitive' } } },
              { publisher: { mobile: { contains: query.q } } },
              { publisher: { displayId: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.listingDraft.findMany({
        where,
        orderBy: { updatedAt: query.sort === 'NEWEST' ? 'desc' : 'asc' },
        include: deskInclude,
        ...listArgs(query),
      }),
      prisma.listingDraft.count({ where }),
    ]);
    return { items, total };
  },
};
