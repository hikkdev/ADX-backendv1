import { Prisma, prisma } from '../../shared/database';
import type { CompetitorSightingsRepository, SightingFilter } from './competitor-sightings.repository';

const include = { agent: { select: { id: true, displayId: true, user: { select: { name: true } } } } } as const;

function whereOf(filter: Partial<SightingFilter>): Prisma.CompetitorSightingWhereInput {
  return {
    ...(filter.brand ? { brand: { equals: filter.brand, mode: 'insensitive' } } : {}),
    ...(filter.format ? { format: filter.format } : {}),
    ...(filter.agentId ? { agentId: filter.agentId } : {}),
    ...(filter.city ? { OR: [{ city: { equals: filter.city, mode: 'insensitive' } }, { address: { contains: filter.city, mode: 'insensitive' } }] } : {}),
    ...(filter.from || filter.to ? { capturedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) } } : {}),
    ...(filter.analysed === true ? { analysedAt: { not: null } } : filter.analysed === false ? { analysedAt: null } : {}),
    ...(filter.q
      ? {
          OR: [
            { brand: { contains: filter.q, mode: 'insensitive' } },
            { category: { contains: filter.q, mode: 'insensitive' } },
            { note: { contains: filter.q, mode: 'insensitive' } },
            { address: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export const prismaCompetitorSightingsRepository: CompetitorSightingsRepository = {
  create(data) {
    return prisma.competitorSighting.create({ data, include });
  },
  findById(id) {
    return prisma.competitorSighting.findUnique({ where: { id }, include });
  },
  async list(filter) {
    const where = whereOf(filter);
    const [items, total, analysed] = await Promise.all([
      prisma.competitorSighting.findMany({ where, include, orderBy: { capturedAt: 'desc' }, skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize }),
      prisma.competitorSighting.count({ where }),
      prisma.competitorSighting.count({ where: { ...whereOf({ ...filter, analysed: undefined }), analysedAt: { not: null } } }),
    ]);
    const all = await prisma.competitorSighting.count({ where: whereOf({ ...filter, analysed: undefined }) });
    return { items, total, counts: { ALL: all, ANALYSED: analysed, UNANALYSED: all - analysed } };
  },
  listAll(filter) {
    return prisma.competitorSighting.findMany({ where: whereOf(filter), include, orderBy: { capturedAt: 'asc' } });
  },
  recordAnalysis(id, analysis, at) {
    return prisma.competitorSighting.update({ where: { id }, data: { analysis, analysedAt: at }, include });
  },
  async brands() {
    const rows = await prisma.competitorSighting.groupBy({ by: ['brand'], where: { brand: { not: null } }, _count: { _all: true }, orderBy: { _count: { brand: 'desc' } }, take: 50 });
    return rows.filter((row): row is typeof row & { brand: string } => row.brand !== null).map((row) => ({ brand: row.brand, count: row._count._all }));
  },
};
