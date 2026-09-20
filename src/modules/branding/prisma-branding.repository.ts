import { Prisma, prisma } from '../../shared/database';
import type { BrandingConfig } from '../../shared/integrations';
import type { BrandingRepository } from './branding.repository';
import type { BrandReleaseRow } from './branding.types';

const row = (r: { id: string; number: number; config: unknown; version: string; note: string | null; publishedById: string | null; publishedAt: Date }): BrandReleaseRow => ({
  ...r,
  config: (r.config as BrandingConfig | null) ?? {},
});

export const prismaBrandingRepository: BrandingRepository = {
  async latest() {
    const found = await prisma.brandRelease.findFirst({ orderBy: { number: 'desc' } });
    return found ? row(found) : null;
  },

  async findByNumber(number) {
    const found = await prisma.brandRelease.findUnique({ where: { number } });
    return found ? row(found) : null;
  },

  async highestNumber() {
    const top = await prisma.brandRelease.findFirst({ orderBy: { number: 'desc' }, select: { number: true } });
    return top?.number ?? 0;
  },

  async list(page, pageSize) {
    const [rows, total] = await Promise.all([
      prisma.brandRelease.findMany({ orderBy: { number: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.brandRelease.count(),
    ]);
    return { rows: rows.map(row), total };
  },

  async create(data) {
    const created = await prisma.brandRelease.create({
      data: { number: data.number, config: data.config as Prisma.InputJsonValue, version: data.version, note: data.note, publishedById: data.publishedById },
    });
    return row(created);
  },

  async namesOf(userIds) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  },
};
