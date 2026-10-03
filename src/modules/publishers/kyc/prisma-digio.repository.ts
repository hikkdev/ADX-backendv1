import { Prisma, prisma, type KycEntityType } from '../../../shared/database';
import { PROVIDER_FAILED_STATUS } from '../../../shared/verification';
import type { DigioKycFields, DigioRepository, DigioWebhookUpdate } from './digio.repository';

export const prismaDigioRepository: DigioRepository = {
  upsertDigioKyc(publisherId: string, fields: DigioKycFields) {
    return prisma.publisherKyc.upsert({
      where: { publisherId },
      update: fields,
      create: { publisherId, ...fields },
    });
  },

  markProviderFailed(publisherId: string) {
    return prisma.publisherKyc.upsert({
      where: { publisherId },
      update: { digioStatus: PROVIDER_FAILED_STATUS },
      create: { publisherId, digioStatus: PROVIDER_FAILED_STATUS },
    });
  },

  findByRequestId(kycId: string) {
    return prisma.publisherKyc.findFirst({ where: { digioRequestId: kycId } });
  },

  findByPublisherId(publisherId: string) {
    return prisma.publisherKyc.findUnique({ where: { publisherId } });
  },

  applyWebhook(kyc: { id: string; publisherId: string }, update: DigioWebhookUpdate) {
    // Lot N: Digio's completion is the recording — nobody at ADX held the
    // documents. N2-B: an approval puts the row on the Digio path whatever
    // was sent by hand while the session was open. Phase D (1 Oct 2026): the
    // publisher's `kycStatus` mirror moves with the record, as the desk's
    // review moves it — payouts read the mirror, so a Digio-verified
    // publisher was left unable to withdraw.
    // Cashfree Phase 1: the same road carries a Cashfree session's outcome — `via` says who answered.
    const { via = 'DIGIO', ...fields } = update;
    return prisma.$transaction([
      prisma.publisherKyc.update({
        where: { id: kyc.id },
        data: {
          ...fields,
          digioPayload: fields.digioPayload as any,
          recordedVia: via,
          recordedById: null,
          ...(fields.status === 'VERIFIED' ? { method: via } : {}),
        },
      }),
      prisma.publisher.update({ where: { id: kyc.publisherId }, data: { kycStatus: update.status } }),
    ]);
  },

  setEntityType(publisherId: string, entityType: KycEntityType) {
    return prisma.publisher.update({ where: { id: publisherId }, data: { entityType } });
  },

  restartForUpgrade(publisherId: string, entityType: KycEntityType, fields: DigioKycFields) {
    // The decision the individual earned is cleared off the row (the audit
    // keeps it): the record is a fresh Digio case for the business.
    const reopened = {
      ...fields,
      status: 'PENDING' as const,
      digioPayload: Prisma.DbNull,
      digioVerifiedAt: null,
      reviewedAt: null,
      reviewedById: null,
      reviewNote: null,
      rejectionReason: null,
      recordedVia: null,
      recordedById: null,
    };
    return prisma.$transaction([
      prisma.publisher.update({ where: { id: publisherId }, data: { entityType, kycStatus: 'PENDING' } }),
      prisma.publisherKyc.upsert({ where: { publisherId }, update: reopened, create: { publisherId, ...reopened } }),
    ]);
  },

  async findPublisherAgent(publisherId: string) {
    const publisher = await prisma.publisher.findUnique({
      where: { id: publisherId },
      include: { agent: true },
    });
    if (!publisher?.agent) return null;
    return { id: publisher.id, name: publisher.name, agentUserId: publisher.agent.userId };
  },
};
