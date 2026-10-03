import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { Decimal, money, ZERO, type Money } from '../../shared/money';
import type { PromoCode, PromoRedemption } from '../../shared/database';
import { prismaPromoCodesRepository as repository } from './prisma-promo-codes.repository';
import type { NewPromoCode, PromoCodePatch, PromoCodeRow } from './promo-codes.repository';
import type { CreatePromoCodeInput, UpdatePromoCodeInput } from './promo-codes.schema';

/**
 * PC-1 (DR 12, 25 Sep 2026) — promo codes on a campaign booking.
 *
 * The website's Review & pay screen draws "Have a promo code?"; this is
 * what stands behind it. A code is a percent or a flat rupee amount off the
 * booking's media rent plus production fees (never off GST, which is
 * charged on what is actually paid — see the campaigns README), capped by
 * `maxDiscount`, gated by a minimum spend, a validity window, a total usage
 * limit and a per-advertiser limit, and switched on or off by ops under
 * Growth › Promo codes (`growth.edit`).
 *
 * Applying a code is the advertiser's own move (`POST /campaigns/:id/promo`,
 * in `campaigns`); a redemption is counted only when the campaign is paid
 * (`recordRedemption` at authorise) and released if it is later cancelled,
 * so a code tried and abandoned costs nothing against the limits.
 */

export type PromoCodeView = {
  id: string;
  code: string;
  description: string | null;
  kind: PromoCode['kind'];
  value: Money;
  maxDiscount: Money | null;
  minSpend: Money | null;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  perAdvertiserLimit: number | null;
  isActive: boolean;
  redemptions: number;
  createdAt: string;
  updatedAt: string;
};

export type RedemptionView = { id: string; campaignId: string; advertiserId: string; amount: Money; redeemedAt: string; releasedAt: string | null };

/** Upper-cased, without spaces: `festive 20` and `FESTIVE20` are the same code. */
export const normaliseCode = (code: string): string => code.trim().toUpperCase().replace(/\s+/g, '');

/**
 * The rupees a code takes off a base (media rent + fees, before GST):
 * the percent or the flat amount, capped by `maxDiscount`, never more than
 * the base itself, to the paisa.
 */
export function discountFor(promo: Pick<PromoCode, 'kind' | 'value' | 'maxDiscount'>, base: Decimal): Decimal {
  if (base.lessThanOrEqualTo(0)) return ZERO;
  const raw = promo.kind === 'PERCENT' ? base.mul(new Decimal(promo.value)).div(100) : new Decimal(promo.value);
  const capped = promo.maxDiscount ? Decimal.min(raw, new Decimal(promo.maxDiscount)) : raw;
  const bounded = Decimal.min(capped, base);
  return bounded.lessThan(0) ? ZERO : bounded.toDecimalPlaces(2);
}

export type PromoContext = { now: Date; base: Decimal; redemptions: number; advertiserRedemptions: number };

/** Why a code cannot go on this booking now, in the advertiser's words — or null when it can. */
export function promoProblem(
  promo: Pick<PromoCode, 'isActive' | 'startsAt' | 'endsAt' | 'usageLimit' | 'perAdvertiserLimit' | 'minSpend'>,
  ctx: PromoContext,
): string | null {
  if (!promo.isActive) return 'This code is not active.';
  if (promo.startsAt && promo.startsAt.getTime() > ctx.now.getTime()) return `This code starts on ${promo.startsAt.toISOString().slice(0, 10)}.`;
  if (promo.endsAt && promo.endsAt.getTime() < ctx.now.getTime()) return 'This code has expired.';
  if (promo.usageLimit !== null && ctx.redemptions >= promo.usageLimit) return 'This code has been used up.';
  if (promo.perAdvertiserLimit !== null && ctx.advertiserRedemptions >= promo.perAdvertiserLimit) {
    return 'You have already used this code as many times as it allows.';
  }
  if (promo.minSpend && ctx.base.lessThan(new Decimal(promo.minSpend))) {
    return `This code needs a booking of at least ₹${money(promo.minSpend)} in media and production, before GST.`;
  }
  return null;
}

/* ── Campaigns' side ─────────────────────────────────────────────────── */

export async function findPromoByCode(code: string): Promise<PromoCode | null> {
  const normalised = normaliseCode(code);
  return normalised ? repository.findByCode(normalised) : null;
}

export async function countRedemptions(promoCodeId: string, advertiserId?: string): Promise<number> {
  return repository.countRedemptions(promoCodeId, advertiserId);
}

/** At authorise: the code is spent on this campaign for this much. One row per campaign. */
export async function recordRedemption(data: { promoCodeId: string; campaignId: string; advertiserId: string; amount: Decimal }): Promise<PromoRedemption> {
  return repository.upsertRedemption({ ...data, amount: new Decimal(data.amount) });
}

/** A cancelled campaign gives its use of the code back. Never throws: a release is a courtesy, not a gate. */
export async function releaseRedemption(campaignId: string): Promise<void> {
  try {
    await repository.releaseRedemption(campaignId);
  } catch {
    /* the code simply stays counted */
  }
}

/* ── The desk ────────────────────────────────────────────────────────── */

export function toPromoCodeView(row: PromoCodeRow): PromoCodeView {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    kind: row.kind,
    value: money(row.value),
    maxDiscount: row.maxDiscount ? money(row.maxDiscount) : null,
    minSpend: row.minSpend ? money(row.minSpend) : null,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    usageLimit: row.usageLimit,
    perAdvertiserLimit: row.perAdvertiserLimit,
    isActive: row.isActive,
    redemptions: row._count.redemptions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const toRedemptionView = (row: PromoRedemption): RedemptionView => ({
  id: row.id,
  campaignId: row.campaignId,
  advertiserId: row.advertiserId,
  amount: money(row.amount),
  redeemedAt: row.redeemedAt.toISOString(),
  releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
});

function assertShape(input: { kind: PromoCode['kind']; value: string; startsAt?: string | null | undefined; endsAt?: string | null | undefined }): void {
  if (input.kind === 'PERCENT' && new Decimal(input.value).greaterThan(100)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A percent code cannot take more than 100% off.', { value: input.value });
  }
  if (input.startsAt && input.endsAt && new Date(input.startsAt).getTime() > new Date(input.endsAt).getTime()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The code would end before it starts.', { startsAt: input.startsAt, endsAt: input.endsAt });
  }
}

const decimalOrNull = (value: string | null | undefined): Decimal | null => (value === undefined || value === null || value === '' ? null : new Decimal(value));
const dateOrNull = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

export async function listPromoCodes(): Promise<PromoCodeView[]> {
  return (await repository.list()).map(toPromoCodeView);
}

export async function getPromoCode(id: string): Promise<PromoCodeView & { history: RedemptionView[] }> {
  const row = await repository.findById(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Promo code not found');
  const history = (await repository.listRedemptions(id)).map(toRedemptionView);
  return { ...toPromoCodeView(row), history };
}

export async function createPromoCode(input: CreatePromoCodeInput, actorId: string): Promise<PromoCodeView> {
  assertShape(input);
  const code = normaliseCode(input.code);
  if (!code) throw new ApiError(400, 'VALIDATION_ERROR', 'The code needs letters or digits.');
  if (await repository.findByCode(code)) throw new ApiError(409, 'CONFLICT', `${code} already exists. Edit that one, or choose another code.`);
  const data: NewPromoCode = {
    code,
    description: input.description?.trim() || null,
    kind: input.kind,
    value: new Decimal(input.value),
    maxDiscount: decimalOrNull(input.maxDiscount),
    minSpend: decimalOrNull(input.minSpend),
    startsAt: dateOrNull(input.startsAt),
    endsAt: dateOrNull(input.endsAt),
    usageLimit: input.usageLimit ?? null,
    perAdvertiserLimit: input.perAdvertiserLimit ?? null,
    isActive: input.isActive ?? true,
    createdById: actorId,
  };
  const row = await repository.create(data);
  await logActivity(actorId, 'PROMO_CODE_CREATED', {
    module: 'promo-codes',
    targetType: 'PromoCode',
    targetId: row.id,
    metadata: { code: row.code, kind: row.kind, value: money(row.value), isActive: row.isActive },
  });
  return toPromoCodeView(row);
}

export async function updatePromoCode(id: string, input: UpdatePromoCodeInput, actorId: string): Promise<PromoCodeView> {
  const current = await repository.findById(id);
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Promo code not found');
  assertShape({
    kind: input.kind ?? current.kind,
    value: input.value ?? money(current.value),
    startsAt: input.startsAt === undefined ? (current.startsAt ? current.startsAt.toISOString() : null) : input.startsAt,
    endsAt: input.endsAt === undefined ? (current.endsAt ? current.endsAt.toISOString() : null) : input.endsAt,
  });
  const patch: PromoCodePatch = {};
  if (input.code !== undefined) {
    const code = normaliseCode(input.code);
    if (!code) throw new ApiError(400, 'VALIDATION_ERROR', 'The code needs letters or digits.');
    const holder = await repository.findByCode(code);
    if (holder && holder.id !== id) throw new ApiError(409, 'CONFLICT', `${code} already exists.`);
    patch.code = code;
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.value !== undefined) patch.value = new Decimal(input.value);
  if (input.maxDiscount !== undefined) patch.maxDiscount = decimalOrNull(input.maxDiscount);
  if (input.minSpend !== undefined) patch.minSpend = decimalOrNull(input.minSpend);
  if (input.startsAt !== undefined) patch.startsAt = dateOrNull(input.startsAt);
  if (input.endsAt !== undefined) patch.endsAt = dateOrNull(input.endsAt);
  if (input.usageLimit !== undefined) patch.usageLimit = input.usageLimit;
  if (input.perAdvertiserLimit !== undefined) patch.perAdvertiserLimit = input.perAdvertiserLimit;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const row = await repository.update(id, patch);
  await logActivity(actorId, 'PROMO_CODE_UPDATED', {
    module: 'promo-codes',
    targetType: 'PromoCode',
    targetId: id,
    diff: auditDiff(
      { code: current.code, isActive: current.isActive, value: money(current.value), kind: current.kind },
      { code: row.code, isActive: row.isActive, value: money(row.value), kind: row.kind },
      ['code', 'isActive', 'value', 'kind'],
    ),
    metadata: { fields: Object.keys(patch) },
  });
  return toPromoCodeView(row);
}
