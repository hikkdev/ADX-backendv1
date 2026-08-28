import { prisma } from '../../../shared/database';
import type { KycStatus } from '../../../shared/database';
import type { UserKycRepository } from './user-kyc.repository';

const userSelection = { select: { id: true, name: true, mobile: true } };

export const prismaUserKycRepository: UserKycRepository = {
  async findPage(page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      prisma.userKyc.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: userSelection },
      }),
      prisma.userKyc.count(),
    ]);
    return { items, total };
  },

  findByUserId(userId: string) {
    // No user join: the /me response has never included it.
    return prisma.userKyc.findUnique({ where: { userId } });
  },

  findById(id: string) {
    return prisma.userKyc.findUnique({ where: { id }, include: { user: userSelection } });
  },

  create(userId: string, selfVideoUrl: string) {
    return prisma.userKyc.create({ data: { userId, selfVideoUrl, submittedAt: new Date() } });
  },

  resubmit(userId: string, selfVideoUrl: string) {
    return prisma.userKyc.update({
      where: { userId },
      data: { selfVideoUrl, status: 'PENDING', rejectionReason: null, submittedAt: new Date() },
    });
  },

  review(id: string, status: KycStatus, rejectionReason: string | null) {
    return prisma.userKyc.update({
      where: { id },
      data: { status, rejectionReason, reviewedAt: new Date() },
    });
  },

  removeByUserId(userId: string) {
    return prisma.userKyc.delete({ where: { userId } });
  },

  removeById(id: string) {
    return prisma.userKyc.delete({ where: { id } });
  },
};
