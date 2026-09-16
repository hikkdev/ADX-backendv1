import { prisma } from '../../../shared/database';
import type { KycPartyType } from '../../../shared/database';
import type { DocumentReviewInput, DocumentReviewRepository } from './document-review.repository';

export const prismaDocumentReviewRepository: DocumentReviewRepository = {
  upsert(input: DocumentReviewInput) {
    const { partyType, kycId, field, decision, note, reviewedById } = input;
    return prisma.kycDocumentReview.upsert({
      where: { partyType_kycId_field: { partyType, kycId, field } },
      update: { decision, note: note ?? null, reviewedById, reviewedAt: new Date() },
      create: { partyType, kycId, field, decision, note: note ?? null, reviewedById },
    });
  },

  listFor(partyType: KycPartyType, kycId: string) {
    return prisma.kycDocumentReview.findMany({ where: { partyType, kycId }, orderBy: { reviewedAt: 'asc' } });
  },

  async clear(partyType: KycPartyType, kycId: string, fields: string[]) {
    if (fields.length === 0) return 0;
    const { count } = await prisma.kycDocumentReview.deleteMany({ where: { partyType, kycId, field: { in: fields } } });
    return count;
  },
};
