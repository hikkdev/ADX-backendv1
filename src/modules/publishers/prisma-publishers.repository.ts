import { prisma } from '../../shared/database';
import type { KycStatus } from '../../shared/database';
import type {
  KycDocuments,
  NewPublisher,
  PublisherPatch,
  PublishersRepository,
} from './publishers.repository';

const detailInclude = { kyc: true, listings: { include: { photos: true } } } as const;

export const prismaPublishersRepository: PublishersRepository = {
  create(data: NewPublisher) {
    const { type, email, city, state, ...required } = data;
    // Optional columns are omitted rather than set to undefined so Prisma
    // leaves schema defaults in place. The empty KYC row is created up front so
    // every publisher has one to submit into.
    return prisma.publisher.create({
      data: {
        ...required,
        ...(type !== undefined ? { type } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(city !== undefined ? { city } : {}),
        ...(state !== undefined ? { state } : {}),
        kyc: { create: {} },
      },
      include: { kyc: true, listings: true },
    }) as never;
  },

  findForAgent(agentId: string, category?: string) {
    return prisma.publisher.findMany({
      where: {
        agentId,
        // 'KYC' is the UI's tab name, not a column — it filters to verified.
        ...(category === 'KYC' ? { kycStatus: 'VERIFIED' as const } : {}),
      },
      include: detailInclude,
      orderBy: { createdAt: 'desc' },
    }) as never;
  },

  findById(publisherId: string) {
    return prisma.publisher.findUnique({
      where: { id: publisherId },
      include: detailInclude,
    }) as never;
  },

  findSummaryById(publisherId: string) {
    return prisma.publisher.findUnique({ where: { id: publisherId } });
  },

  findByUserId(userId: string) {
    return prisma.publisher.findUnique({ where: { userId } });
  },

  findByUserIdWithKyc(userId: string) {
    return prisma.publisher.findUnique({ where: { userId }, include: { kyc: true } }) as never;
  },

  update(publisherId: string, data: PublisherPatch) {
    return prisma.publisher.update({
      where: { id: publisherId },
      data,
      include: { kyc: true, listings: true },
    }) as never;
  },

  async submitKyc(publisherId: string, docs: KycDocuments) {
    // One transaction: the KYC row and the publisher's mirrored kycStatus must
    // never disagree.
    const [kyc] = await prisma.$transaction([
      prisma.publisherKyc.upsert({
        where: { publisherId },
        update: { ...docs, status: 'PENDING', submittedAt: new Date() },
        create: { publisherId, ...docs, status: 'PENDING', submittedAt: new Date() },
      }),
      prisma.publisher.update({ where: { id: publisherId }, data: { kycStatus: 'PENDING' } }),
    ]);
    return kyc;
  },

  async reviewKyc(publisherId: string, status: KycStatus, rejectionReason?: string) {
    const [kyc] = await prisma.$transaction([
      prisma.publisherKyc.update({
        where: { publisherId },
        data: { status, rejectionReason, reviewedAt: new Date() },
      }),
      prisma.publisher.update({ where: { id: publisherId }, data: { kycStatus: status } }),
    ]);
    return kyc;
  },

  createSelfRegistered({ userId, name, mobile, email }) {
    return prisma.publisher.create({
      data: { userId, name, mobile, email, onboardingStatus: 'PENDING_ONBOARDING' },
    });
  },

  setUserProfile(userId: string, name: string, email?: string) {
    return prisma.user.update({ where: { id: userId }, data: { name, email } });
  },

  findUserMobile(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { mobile: true } });
  },

  claim(publisherId: string, agentId: string) {
    return prisma.publisher.update({
      where: { id: publisherId },
      data: { agentId, claimedAt: new Date(), onboardingStatus: 'IN_ONBOARDING' },
    });
  },

  resetOnboardingState(publisherId: string) {
    return prisma.publisher.update({
      where: { id: publisherId },
      data: { onboardingStatus: 'PENDING_ONBOARDING', agentId: null, claimedAt: null },
    });
  },

  completeOnboarding(publisherId: string) {
    return prisma.publisher.update({
      where: { id: publisherId },
      data: { onboardingStatus: 'ONBOARDING_COMPLETE' },
    });
  },
};
