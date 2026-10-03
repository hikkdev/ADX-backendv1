import type { Prisma, PromoCode, PromoDiscountKind, PromoRedemption } from '../../shared/database';

/** A code with how many times it has been redeemed (paid campaigns, not released). */
export type PromoCodeRow = PromoCode & { _count: { redemptions: number } };

export type NewPromoCode = {
  /** Upper-cased, no spaces — `normaliseCode` in the service. */
  code: string;
  description: string | null;
  kind: PromoDiscountKind;
  value: Prisma.Decimal;
  maxDiscount: Prisma.Decimal | null;
  minSpend: Prisma.Decimal | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  perAdvertiserLimit: number | null;
  isActive: boolean;
  createdById: string | null;
};

export type PromoCodePatch = Partial<Omit<NewPromoCode, 'createdById'>>;

export type NewRedemption = { promoCodeId: string; campaignId: string; advertiserId: string; amount: Prisma.Decimal };

export interface PromoCodesRepository {
  list(): Promise<PromoCodeRow[]>;
  findById(id: string): Promise<PromoCodeRow | null>;
  findByCode(code: string): Promise<PromoCode | null>;
  create(data: NewPromoCode): Promise<PromoCodeRow>;
  update(id: string, patch: PromoCodePatch): Promise<PromoCodeRow>;
  /** Redemptions that stand (not released) — for the code, or for one advertiser on it. */
  countRedemptions(promoCodeId: string, advertiserId?: string): Promise<number>;
  /** One per campaign: a re-authorisation writes the same row again. */
  upsertRedemption(data: NewRedemption): Promise<PromoRedemption>;
  releaseRedemption(campaignId: string): Promise<unknown>;
  listRedemptions(promoCodeId: string): Promise<PromoRedemption[]>;
}
