import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { Decimal, money } from '../../shared/money';
import { getAdvertiserForUser } from '../advertisers';
import { prismaRevenueRepository as repository } from './prisma-revenue.repository';
import { findPlan } from './publisher-plans.service';
import {
  grantCommissionOverride,
  grantSubscription,
  heldRate,
  lockPrice,
  quote,
  setCommissionRate,
} from './revenue.service';
import {
  commissionRateSchema,
  feeSchema,
  lockSchema,
  overrideSchema,
  quoteSchema,
  subscriptionSchema,
  taxSchema,
  updateFeeSchema,
} from './revenue.schema';

const ok = (res: Response, data: unknown): void => {
  res.json({ success: true, data });
};

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Missing ${key}`);
  }
  return value;
}

function actor(req: Request): string {
  const sub = req.user?.sub;
  if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
  return sub;
}

function parse<T>(
  schema: {
    safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } };
  },
  body: unknown
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success || parsed.data === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error?.flatten());
  }
  return parsed.data;
}

/* ── Quote ──────────────────────────────────────────────────────────── */

/**
 * Prices a booking, both sides of it.
 *
 * ADMIN only. The publisher block names ADX's take rate and where it came from,
 * which is exactly what neither an advertiser nor a publisher should read off
 * an endpoint — the advertiser is not meant to see commission at all, and a
 * publisher learning that a neighbour holds a promotional rate is a commercial
 * problem of its own. A trimmed advertiser-facing quote belongs with the cart.
 */
export async function quoteHandler(req: Request, res: Response): Promise<void> {
  ok(res, await quote(parse(quoteSchema, req.body)));
}

/* ── Commission ─────────────────────────────────────────────────────── */

export async function listCommissionRatesHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await repository.listCommissionRates());
}

export async function setCommissionRateHandler(req: Request, res: Response): Promise<void> {
  const body = parse(commissionRateSchema, req.body);
  const userId = actor(req);
  const row = await setCommissionRate({
    category: body.category ?? null,
    mediaTypeId: body.mediaTypeId ?? null,
    minMediaValue: body.minMediaValue ?? null,
    maxMediaValue: body.maxMediaValue ?? null,
    ratePct: body.ratePct,
    note: body.note ?? null,
    userId,
  });
  await logActivity(userId, 'COMMISSION_RATE_SET', {
    req,
    targetType: 'CommissionRate',
    targetId: row.id,
    module: 'revenue',
    metadata: {
      category: row.category,
      mediaTypeId: row.mediaTypeId,
      minMediaValue: row.minMediaValue?.toString() ?? null,
      maxMediaValue: row.maxMediaValue?.toString() ?? null,
      ratePct: row.ratePct.toString(),
    },
  });
  ok(res, row);
}

/* Lot J (B1): the list moved to `publisher-plans.controller.listSubscriptionsPageHandler` (Lot J2, d) — the list contract. */

/** What an audit row says about a subscription: the money and the dates, as strings. */
const subscriptionAudit = (row: { tier: string; ratePct: Decimal; pricePerMonth: Decimal; startsAt: Date; endsAt: Date | null; source?: string }) => ({
  tier: row.tier,
  ratePct: new Decimal(row.ratePct).toFixed(4),
  pricePerMonth: money(row.pricePerMonth),
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt?.toISOString() ?? null,
  ...(row.source ? { source: row.source } : {}),
});

/**
 * The admin grant. Lot J (B1): `ratePct` and `pricePerMonth` are filled from
 * the tier's plan when the body omits them; explicit values still win, so a
 * negotiated grant can carry a rate the catalogue does not sell. Lot J2 (a):
 * audited `SUBSCRIPTION_GRANTED` with the row as the diff.
 */
export async function grantSubscriptionHandler(req: Request, res: Response): Promise<void> {
  const body = parse(subscriptionSchema, req.body);
  let ratePct = body.ratePct;
  let pricePerMonth = body.pricePerMonth;
  if (ratePct === undefined || pricePerMonth === undefined) {
    const plan = await findPlan(body.tier);
    if (!plan) throw new ApiError(404, 'NOT_FOUND', 'Plan not found');
    ratePct ??= new Decimal(plan.ratePct).toFixed(4);
    pricePerMonth ??= money(plan.pricePerMonth);
  }
  const row = await grantSubscription({
    publisherId: body.publisherId,
    tier: body.tier,
    ratePct,
    pricePerMonth,
    startsAt: new Date(body.startsAt),
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
  });
  await logActivity(actor(req), 'SUBSCRIPTION_GRANTED', {
    req,
    module: 'revenue',
    targetType: 'PublisherSubscription',
    targetId: row.id,
    diff: auditDiff(null, subscriptionAudit(row)),
    metadata: { publisherId: row.publisherId, tier: row.tier },
  });
  ok(res, row);
}

/** Lot J2 (a): audited `SUBSCRIPTION_ENDED` with the end date that moved. */
export async function endSubscriptionHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  const found = await repository.findSubscription(id);
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Subscription not found');
  const ended = await repository.endSubscription(id, new Date());
  await logActivity(actor(req), 'SUBSCRIPTION_ENDED', {
    req,
    module: 'revenue',
    targetType: 'PublisherSubscription',
    targetId: id,
    diff: auditDiff(subscriptionAudit(found), subscriptionAudit(ended)),
    metadata: { publisherId: found.publisherId, tier: found.tier },
  });
  ok(res, ended);
}

export async function listOverridesHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.query['publisherId'];
  ok(
    res,
    await repository.listOverrides(typeof publisherId === 'string' ? publisherId : undefined)
  );
}

/** Lot J2 (a): audited `COMMISSION_OVERRIDE_GRANTED` — ADX giving up revenue is the first row finance asks about. */
export async function grantOverrideHandler(req: Request, res: Response): Promise<void> {
  const body = parse(overrideSchema, req.body);
  const row = await grantCommissionOverride({
    publisherId: body.publisherId,
    ratePct: body.ratePct,
    reason: body.reason,
    approvedById: actor(req),
    startsAt: new Date(body.startsAt),
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
  });
  await logActivity(actor(req), 'COMMISSION_OVERRIDE_GRANTED', {
    req,
    module: 'revenue',
    targetType: 'PublisherCommissionOverride',
    targetId: row.id,
    diff: auditDiff(null, { ratePct: new Decimal(row.ratePct).toFixed(4), reason: row.reason, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null }),
    metadata: { publisherId: row.publisherId },
  });
  ok(res, row);
}

/* ── Fees ───────────────────────────────────────────────────────────── */

export async function listFeesHandler(req: Request, res: Response): Promise<void> {
  ok(res, await repository.listFees(req.query['includeInactive'] === 'true'));
}

/** What an audit row says about a fee. */
const feeAudit = (fee: { kind: string; name: string; percentPct: Decimal | null; flatAmount: Decimal | null; gstPct: Decimal; amountShownInCart: boolean; perSpot: boolean; isActive: boolean }) => ({
  kind: fee.kind,
  name: fee.name,
  percentPct: fee.percentPct === null ? null : new Decimal(fee.percentPct).toString(),
  flatAmount: fee.flatAmount === null ? null : money(fee.flatAmount),
  gstPct: new Decimal(fee.gstPct).toString(),
  amountShownInCart: fee.amountShownInCart,
  perSpot: fee.perSpot,
  isActive: fee.isActive,
});

/** Lot J2 (a): audited `FEE_CREATED`. */
export async function createFeeHandler(req: Request, res: Response): Promise<void> {
  const body = parse(feeSchema, req.body);
  const row = await repository.createFee({
    kind: body.kind,
    name: body.name,
    percentPct: body.percentPct ?? null,
    flatAmount: body.flatAmount ?? null,
    gstPct: body.gstPct,
    amountShownInCart: body.amountShownInCart,
    perSpot: body.perSpot,
  });
  await logActivity(actor(req), 'FEE_CREATED', {
    req,
    module: 'revenue',
    targetType: 'FeeSchedule',
    targetId: row.id,
    diff: auditDiff(null, feeAudit(row)),
  });
  ok(res, row);
}

export async function updateFeeHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  const fee = await repository.findFee(id);
  if (!fee) throw new ApiError(404, 'NOT_FOUND', 'Fee not found');

  const patch = parse(updateFeeSchema, req.body);
  // The schema cannot know which shape this fee is, so the cross-shape patch is
  // caught here against the stored row. Without it the column CHECK fires and
  // a plain validation failure arrives as a 500.
  const isPercentFee = fee.percentPct !== null;
  const wrongShape = isPercentFee
    ? patch.flatAmount !== undefined
    : patch.percentPct !== undefined;
  if (wrongShape) {
    throw new ApiError(
      409,
      'CONFLICT',
      `"${fee.name}" is a ${isPercentFee ? 'percentage' : 'flat'} fee — set its ${
        isPercentFee ? 'percentPct' : 'flatAmount'
      }, or retire it and add a fee of the other shape`
    );
  }
  const after = await repository.updateFee(id, patch, actor(req));
  // Lot J2 (a): audited `FEE_UPDATED` with the diff.
  await logActivity(actor(req), 'FEE_UPDATED', {
    req,
    module: 'revenue',
    targetType: 'FeeSchedule',
    targetId: id,
    diff: auditDiff(feeAudit(fee), feeAudit(after)),
  });
  ok(res, after);
}

/* ── Tax ────────────────────────────────────────────────────────────── */

export async function getTaxHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await repository.getTaxSettings());
}

/**
 * Lot J2: the one configurable GST — read by the campaign quote, the
 * invoice, and both subscription pricing paths (`publisher-plans` and
 * `packages`). Audited `TAX_SETTINGS_UPDATED` with the rate that moved (a).
 */
export async function updateTaxHandler(req: Request, res: Response): Promise<void> {
  const { mediaGstPct } = parse(taxSchema, req.body);
  const before = await repository.getTaxSettings();
  const after = await repository.updateTaxSettings(mediaGstPct, actor(req));
  await logActivity(actor(req), 'TAX_SETTINGS_UPDATED', {
    req,
    module: 'revenue',
    targetType: 'TaxSettings',
    targetId: after.id,
    diff: auditDiff(
      { mediaGstPct: before ? new Decimal(before.mediaGstPct).toString() : null },
      { mediaGstPct: new Decimal(after.mediaGstPct).toString() },
    ),
  });
  ok(res, after);
}

/* ── Price locks ────────────────────────────────────────────────────── */

/**
 * Holds a rate for the advertiser making the request.
 *
 * The advertiser is taken from the session, never the body. A lock keyed by a
 * client-supplied id would let anyone hold a price on someone else's behalf,
 * and more usefully to an attacker, read back what that someone was quoted.
 */
export async function lockPriceHandler(req: Request, res: Response): Promise<void> {
  const body = parse(lockSchema, req.body);
  const advertiserId = await advertiserFor(req);
  ok(
    res,
    await lockPrice({
      advertiserId,
      listingId: body.listingId,
      spotsInCart: body.spotsInCart,
    })
  );
}

export async function heldRateHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = await advertiserFor(req);
  const rate = await heldRate(advertiserId, param(req, 'listingId'));
  ok(res, { ratePerDay: rate, held: rate !== null });
}

/**
 * The advertiser behind the session.
 *
 * Resolved through the advertisers module rather than trusting a body field —
 * see `lockPriceHandler`.
 */
async function advertiserFor(req: Request): Promise<string> {
  const advertiser = await getAdvertiserForUser(actor(req));
  if (!advertiser) {
    throw new ApiError(404, 'NOT_FOUND', 'No advertiser account for this user');
  }
  return advertiser.id;
}
