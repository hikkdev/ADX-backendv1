import { prisma } from '../../../shared/database';
import type { DigioKycFields, DigioRepository, DigioWebhookUpdate } from './digio.repository';

export const prismaDigioRepository: DigioRepository = {
  upsertDigioKyc(publisherId: string, fields: DigioKycFields) {
    return prisma.publisherKyc.upsert({
      where: { publisherId },
      update: fields,
      create: { publisherId, ...fields },
    });
  },

  findByRequestId(kycId: string) {
    return prisma.publisherKyc.findFirst({ where: { digioRequestId: kycId } });
  },

  findByPublisherId(publisherId: string) {
    return prisma.publisherKyc.findUnique({ where: { publisherId } });
  },

  applyWebhook(kycRowId: string, update: DigioWebhookUpdate) {
    // Lot N: Digio's completion is the recording — nobody at ADX held the
    // documents. N2-B: an approval puts the row on the Digio path whatever
    // was sent by hand while the session was open.
    return prisma.publisherKyc.update({
      where: { id: kycRowId },
      data: {
        ...update,
        digioPayload: update.digioPayload as any,
        recordedVia: 'DIGIO',
        recordedById: null,
        ...(update.status === 'VERIFIED' ? { method: 'DIGIO' } : {}),
      },
    });
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
