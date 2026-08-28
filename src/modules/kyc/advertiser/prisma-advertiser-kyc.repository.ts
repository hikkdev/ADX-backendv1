import { prisma } from '../../../shared/database';
import type { KycStatus } from '../../../shared/database';
import type { AdvertiserKycFilter, AdvertiserKycRepository } from './advertiser-kyc.repository';
import type { CreateAdvertiserKycInput, UpdateAdvertiserKycInput } from './advertiser-kyc.schema';

const advertiserSelection = { select: { id: true, name: true, mobile: true, email: true } };

export const prismaAdvertiserKycRepository: AdvertiserKycRepository = {
  async findPage(where: AdvertiserKycFilter, page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      prisma.advertiserKyc.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { advertiser: advertiserSelection },
      }),
      prisma.advertiserKyc.count({ where }),
    ]);
    return { items, total };
  },

  findByAdvertiserId(advertiserId: string) {
    return prisma.advertiserKyc.findUnique({ where: { advertiserId } });
  },

  findById(id: string) {
    // Deliberately no advertiser join: the by-id response has never included it.
    return prisma.advertiserKyc.findUnique({ where: { id } });
  },

  create(advertiserId: string, data: CreateAdvertiserKycInput) {
    return prisma.advertiserKyc.create({ data: { advertiserId, ...data, submittedAt: new Date() } });
  },

  resubmit(advertiserId: string, data: UpdateAdvertiserKycInput) {
    return prisma.advertiserKyc.update({
      where: { advertiserId },
      data: { ...data, status: 'PENDING', rejectionReason: null, submittedAt: new Date() },
    });
  },

  updateById(id: string, data: UpdateAdvertiserKycInput) {
    return prisma.advertiserKyc.update({ where: { id }, data });
  },

  review(id: string, status: KycStatus, rejectionReason: string | null) {
    return prisma.advertiserKyc.update({
      where: { id },
      data: { status, rejectionReason, reviewedAt: new Date() },
    });
  },

  remove(id: string) {
    return prisma.advertiserKyc.delete({ where: { id } });
  },
};
