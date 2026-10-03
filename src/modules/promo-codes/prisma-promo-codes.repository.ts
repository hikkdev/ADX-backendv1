import { prisma } from '../../shared/database';
import type { PromoCodesRepository } from './promo-codes.repository';

const withCount = { _count: { select: { redemptions: { where: { releasedAt: null } } } } } as const;

export const prismaPromoCodesRepository: PromoCodesRepository = {
  list() {
    return prisma.promoCode.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], include: withCount });
  },

  findById(id) {
    return prisma.promoCode.findUnique({ where: { id }, include: withCount });
  },

  findByCode(code) {
    return prisma.promoCode.findUnique({ where: { code } });
  },

  create(data) {
    return prisma.promoCode.create({ data, include: withCount });
  },

  update(id, patch) {
    return prisma.promoCode.update({ where: { id }, data: patch, include: withCount });
  },

  countRedemptions(promoCodeId, advertiserId) {
    return prisma.promoRedemption.count({ where: { promoCodeId, releasedAt: null, ...(advertiserId ? { advertiserId } : {}) } });
  },

  upsertRedemption({ promoCodeId, campaignId, advertiserId, amount }) {
    return prisma.promoRedemption.upsert({
      where: { campaignId },
      create: { promoCodeId, campaignId, advertiserId, amount },
      update: { promoCodeId, advertiserId, amount, releasedAt: null, redeemedAt: new Date() },
    });
  },

  releaseRedemption(campaignId) {
    return prisma.promoRedemption.updateMany({ where: { campaignId, releasedAt: null }, data: { releasedAt: new Date() } });
  },

  listRedemptions(promoCodeId) {
    return prisma.promoRedemption.findMany({ where: { promoCodeId }, orderBy: { redeemedAt: 'desc' }, take: 200 });
  },
};
