import { prisma } from '../../shared/database';
import type {
  AdvertisementFilter,
  AdvertisementRepository,
  NewAdvertisement,
} from './advertisements.repository';
import type { UpdateAdvertisementInput } from './advertisements.schema';

export const prismaAdvertisementRepository: AdvertisementRepository = {
  async findPage(where: AdvertisementFilter, page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      prisma.advertisement.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.advertisement.count({ where }),
    ]);
    return { items, total };
  },

  findById(id: string) {
    return prisma.advertisement.findUnique({ where: { id } });
  },

  create(data: NewAdvertisement) {
    return prisma.advertisement.create({ data });
  },

  update(id: string, data: UpdateAdvertisementInput) {
    return prisma.advertisement.update({ where: { id }, data });
  },

  remove(id: string) {
    return prisma.advertisement.delete({ where: { id } });
  },
};
