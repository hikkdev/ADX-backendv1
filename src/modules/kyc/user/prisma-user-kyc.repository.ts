import { prisma } from '../../../shared/database';
import type { KycStatus, UserKycPurpose } from '../../../shared/database';
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

  async upsertLiveness(userId: string, selfVideoUrl: string, recordedById: string, fileId: string) {
    const existing = await prisma.userKyc.findUnique({ where: { userId }, select: { id: true } });
    const now = new Date();
    const kyc = await prisma.userKyc.upsert({
      where: { userId },
      create: { userId, selfVideoUrl, fileId, purpose: 'LIVENESS', recordedById, status: 'PENDING', submittedAt: now },
      update: { selfVideoUrl, fileId, purpose: 'LIVENESS', recordedById, status: 'PENDING', rejectionReason: null, submittedAt: now, reviewedAt: null },
    });
    return { kyc, created: existing === null };
  },

  async attest(userId: string, stamp: { attestedById: string; attestationNote: string; at: Date }) {
    const existing = await prisma.userKyc.findUnique({ where: { userId }, select: { id: true } });
    const data = {
      purpose: 'LIVENESS' as const,
      status: 'VERIFIED' as const,
      rejectionReason: null,
      reviewedAt: stamp.at,
      attestedById: stamp.attestedById,
      attestedAt: stamp.at,
      attestationNote: stamp.attestationNote,
    };
    const kyc = await prisma.userKyc.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return { kyc, created: existing === null };
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

  findPurgeable(purpose: UserKycPurpose, cutoff: Date, limit: number) {
    return prisma.userKyc.findMany({
      where: { purpose, status: 'VERIFIED', selfVideoUrl: { not: null }, reviewedAt: { not: null, lt: cutoff } },
      orderBy: { reviewedAt: 'asc' },
      take: limit,
    });
  },

  purgeVideo(id: string) {
    return prisma.userKyc.update({ where: { id }, data: { selfVideoUrl: null, fileId: null } });
  },
};
