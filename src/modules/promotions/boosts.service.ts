import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import type { BoostPlacement } from '../../shared/database';
import { allocateIdentifier } from '../identifiers';
import { activePlacements, placementAvailability, windowOf } from './catalogue.service';
import { assertBuyerCanPay, assertBuyerMayOrder, BOOSTS_FEATURE, datesLabel, debitBuyer, featureOn, gstFraction, noticeBuyer, refundBuyer, type Buyer } from './common';
import { checkDates, dayKey, dayNumber, fullDays, parseDay, perDayCounts, quoteFor, today, type DayAvailability } from './pricing';
import { prismaPromotionsRepository as repository } from './prisma-promotions.repository';
import type { BoostPatch, BoostRow, BoostScope, ListingLabel, PlacementRow } from './promotions.repository';
import type { AdminBoostsQuery, CreateBoostInput } from './promotions.schema';
import { statsForBoost, type StatsView } from './stats.service';
import type { PromotionPayer, PromotionPaymentTarget } from './ads.service';

/**
 * LM-1 — sponsored listings ("boosts"). A publisher pays to have their own
 * listing shown first: SEARCH_TOP (the top of the search results the listing
 * matches) and/or SIMILAR_TOP (the top of the "Similar listing" row on the
 * listings it is similar to), labelled "Sponsored". No artwork to review —
 * the listing is already approved — so a paid boost goes straight to
 * SCHEDULED (LIVE on its first day).
 *
 *   PENDING_PAYMENT → SCHEDULED → LIVE → ENDED;  → CANCELLED
 *
 * Paid from the publisher wallet (the one earnings land in) or through a
 * gateway (`payments` settles the capture here). Capacity: each placement's
 * `maxConcurrent` per day, in the listing's city and category.
 */

export type BoostActor = { userId: string; isAdmin: boolean; publisherId: string | null };

export const PAY_WITHIN_MINUTES = 60;

type ListingSummary = { id: string; displayId: string | null; title: string; city: string | null; category: string };

export type BoostView = {
  id: string;
  displayId: string | null;
  status: BoostRow['status'];
  listingId: string;
  listing: ListingSummary | null;
  publisherId: string;
  placements: BoostPlacement[];
  cityId: string | null;
  city: string | null;
  category: string;
  startDate: string;
  endDate: string;
  days: number;
  subtotal: Money;
  gstAmount: Money;
  total: Money;
  payBy: string | null;
  reviewNote: string | null;
  paidAt: string | null;
  paymentId: string | null;
  refundedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  publisher?: { id: string; name: string; displayId: string | null } | null;
  stats?: StatsView;
};

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const summaryOf = (label: ListingLabel | undefined | null): ListingSummary | null =>
  label ? { id: label.id, displayId: label.displayId, title: label.title, city: label.city, category: label.category } : null;

export function toBoostView(row: BoostRow, listing: ListingLabel | null | undefined): BoostView {
  return {
    id: row.id,
    displayId: row.displayId,
    status: row.status,
    listingId: row.listingId,
    listing: summaryOf(listing),
    publisherId: row.publisherId,
    placements: [...row.placements],
    cityId: row.cityId,
    city: row.city,
    category: row.category,
    startDate: dayKey(row.startDate),
    endDate: dayKey(row.endDate),
    days: row.days,
    subtotal: money(row.subtotal),
    gstAmount: money(row.gstAmount),
    total: money(row.total),
    payBy: row.status === 'PENDING_PAYMENT' ? new Date(row.updatedAt.getTime() + PAY_WITHIN_MINUTES * 60_000).toISOString() : null,
    reviewNote: row.reviewNote,
    paidAt: iso(row.paidAt),
    paymentId: row.paymentId,
    refundedAt: iso(row.refundedAt),
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function findBoostOrThrow(id: string): Promise<BoostRow> {
  const row = await repository.findBoost(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Sponsored listing not found');
  return row;
}

export async function boostView(row: BoostRow, options: { stats?: boolean } = {}): Promise<BoostView> {
  const [label] = await repository.listingLabels([row.listingId]);
  const view = toBoostView(row, label);
  if (options.stats) view.stats = await statsForBoost(row.id);
  return view;
}

/** The publisher's own boost, or ADX; anyone else 403 (404 would hide nothing — the id is not guessable). */
export function assertMayActOnBoost(row: Pick<BoostRow, 'publisherId'>, actor: BoostActor): void {
  if (actor.isAdmin) return;
  if (!actor.publisherId || actor.publisherId !== row.publisherId) throw new ApiError(403, 'FORBIDDEN', 'This sponsored listing belongs to another publisher.');
}

const buyerOf = (row: Pick<BoostRow, 'publisherId'>): Buyer => ({ kind: 'PUBLISHER', id: row.publisherId });

const placementWords = (placements: readonly BoostPlacement[]): string =>
  placements.map((placement) => (placement === 'SEARCH_TOP' ? 'top of search' : 'top of similar listings')).join(' and ');

const whatOf = (row: BoostRow, title?: string | null): string => `"${title ?? 'Your listing'}" sponsored at the ${placementWords(row.placements)}`;

const debitKey = (row: Pick<BoostRow, 'id'>): string => `promotion-debit:boost:${row.id}`;
const refundKey = (row: Pick<BoostRow, 'id'>): string => `promotion-refund:boost:${row.id}`;

/** The listing a boost is for: live, its rights in force, the caller's own (or ADX acting). */
async function boostableListing(listingId: string, actor: BoostActor | null): Promise<ListingLabel & { publisherId: string }> {
  const [listing] = await repository.listingLabels([listingId]);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (actor && !actor.isAdmin && (!actor.publisherId || listing.publisherId !== actor.publisherId)) {
    throw new ApiError(403, 'FORBIDDEN', 'You can sponsor only your own listings');
  }
  if (listing.status !== 'ACTIVE' || listing.rightsLapsedAt) throw new ApiError(409, 'CONFLICT', 'Only a live listing can be sponsored');
  if (!listing.publisherId) throw new ApiError(409, 'CONFLICT', 'This listing has no publisher to pay for it');
  return listing as ListingLabel & { publisherId: string };
}

const scopeOf = (listing: Pick<ListingLabel, 'cityId' | 'city' | 'category'>): Omit<BoostScope, 'placement'> => ({ cityId: listing.cityId, city: listing.cityId ? null : listing.city, category: listing.category });

export type BoostQuote = {
  listingId: string;
  placements: BoostPlacement[];
  startDate: string;
  endDate: string;
  days: number;
  ratePerDay: Partial<Record<BoostPlacement, Money>>;
  subtotal: Money;
  gstPct: string;
  gstAmount: Money;
  total: Money;
  /** The days any chosen placement is already full on, in the listing's city and category. */
  full: string[];
  fullByPlacement: Partial<Record<BoostPlacement, string[]>>;
};

async function priceBoost(listing: ListingLabel, placements: readonly BoostPlacement[], startText: string, endText: string, now: Date, excludeId?: string): Promise<{ quote: BoostQuote; configs: PlacementRow[]; startDate: Date; endDate: Date }> {
  const configs = await activePlacements(placements);
  const startDate = parseDay(startText, 'startDate');
  const endDate = parseDay(endText, 'endDate');
  const days = checkDates(startDate, endDate, { minDays: Math.max(...configs.map((config) => config.minDays)), now });
  const priced = quoteFor(configs.map((config) => config.ratePerDay), days, await gstFraction());
  const fullByPlacement: Partial<Record<BoostPlacement, string[]>> = {};
  const full = new Set<string>();
  for (const config of configs) {
    const holds = await repository.boostHolds({ ...scopeOf(listing), placement: config.placement }, startDate, endDate, excludeId);
    const days = fullDays(holds, startDate, endDate, config.maxConcurrent);
    fullByPlacement[config.placement] = days;
    for (const date of days) full.add(date);
  }
  return {
    configs,
    startDate,
    endDate,
    quote: {
      listingId: listing.id,
      placements: [...placements],
      startDate: startText,
      endDate: endText,
      days,
      ratePerDay: Object.fromEntries(configs.map((config) => [config.placement, money(config.ratePerDay)])),
      subtotal: priced.subtotal,
      gstPct: priced.gstPct,
      gstAmount: priced.gstAmount,
      total: priced.total,
      full: [...full].sort(),
      fullByPlacement,
    },
  };
}

/** `GET /promotions/boost/quote` — the price and the full days, for the publisher's own listing. */
export async function quoteBoost(input: { listingId: string; placements: BoostPlacement[]; startDate: string; endDate: string }, actor: BoostActor, now = new Date()): Promise<BoostQuote> {
  const listing = await boostableListing(input.listingId, actor);
  return (await priceBoost(listing, input.placements, input.startDate, input.endDate, now)).quote;
}

/** `GET /promotions/boost/availability` — per placement, each day's left in the listing's city and category. */
export async function boostAvailability(input: { listingId: string; placements?: BoostPlacement[] | undefined; from: string; to: string }): Promise<{ listingId: string; placements: { placement: BoostPlacement; maxConcurrent: number; days: DayAvailability[] }[] }> {
  const listing = await boostableListing(input.listingId, null);
  const { from, to } = windowOf(input.from, input.to);
  const configs = await activePlacements(input.placements ?? ['SEARCH_TOP', 'SIMILAR_TOP']).catch(async (err: unknown) => {
    if (input.placements) throw err;
    // Nothing named: whichever placements are on sale.
    return (await repository.listPlacements()).filter((row) => row.isActive);
  });
  return { listingId: listing.id, placements: await placementAvailability(scopeOf(listing), configs, from, to) };
}

/**
 * `POST /promotions/boosts` — priced and holding its days for an hour
 * (PENDING_PAYMENT). 409 PLACEMENT_FULL names the full days per placement.
 */
export async function createBoost(input: CreateBoostInput, actor: BoostActor, now = new Date()): Promise<BoostView> {
  const listing = await boostableListing(input.listingId, actor);
  // AGE-1: the boost is priced and holds its days here — the order.
  await assertBuyerMayOrder(buyerOf(listing), actor.userId);
  const { quote, configs, startDate, endDate } = await priceBoost(listing, input.placements, input.startDate, input.endDate, now);
  if (quote.full.length) {
    throw new ApiError(409, 'PLACEMENT_FULL', `Sponsored places in ${listing.city ?? 'this city'} are taken on ${quote.full.length} of the days you chose`, { full: quote.full, fullByPlacement: quote.fullByPlacement });
  }
  const row = await repository.createBoost({
    displayId: await allocateIdentifier('LISTING_BOOST', now),
    listingId: listing.id,
    publisherId: listing.publisherId,
    createdByUserId: actor.userId,
    placements: [...input.placements],
    cityId: listing.cityId,
    city: listing.city,
    category: listing.category,
    startDate,
    endDate,
    days: quote.days,
    subtotal: new Decimal(quote.subtotal),
    gstAmount: new Decimal(quote.gstAmount),
    total: new Decimal(quote.total),
    status: 'PENDING_PAYMENT',
  });
  // Optimistic, as the ad side: over the limit after writing → let it go and say so.
  for (const config of configs) {
    const counts = perDayCounts(await repository.boostHolds({ ...scopeOf(listing), placement: config.placement }, startDate, endDate), startDate, endDate);
    if (counts.some((count) => count > config.maxConcurrent)) {
      await repository.transitionBoost(row.id, ['PENDING_PAYMENT'], { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Sold out while being booked' });
      throw new ApiError(409, 'PLACEMENT_FULL', 'Someone took the last sponsored place on some of your days a moment ago', { placement: config.placement });
    }
  }
  await logActivity(actor.userId, 'LISTING_BOOST_CREATED', {
    module: 'promotions',
    targetType: 'ListingBoost',
    targetId: row.id,
    metadata: { displayId: row.displayId, listingId: listing.id, placements: input.placements, startDate: input.startDate, endDate: input.endDate, total: quote.total },
  });
  return toBoostView(row, listing);
}

const isPaid = (row: BoostRow): boolean => Boolean(row.paidAt) && ['SCHEDULED', 'LIVE', 'ENDED'].includes(row.status);

async function takePayment(row: BoostRow, via: { paymentId: string | null; paymentReference: string | null }, byUserId: string | null, now: Date): Promise<BoostRow> {
  const [listing] = await repository.listingLabels([row.listingId]);
  const reference = row.displayId ?? row.id;
  const debit = await debitBuyer(buyerOf(row), {
    amount: money(row.total),
    idempotencyKey: debitKey(row),
    reference: row.id,
    note: `${whatOf(row, listing?.title)}, ${datesLabel(row.startDate, row.endDate)} (${reference}${via.paymentReference ? `, ${via.paymentReference}` : ''})`,
    byUserId,
    now,
  });
  const live = dayNumber(row.startDate) <= dayNumber(today(now));
  const moved = await repository.transitionBoost(row.id, ['PENDING_PAYMENT'], { status: live ? 'LIVE' : 'SCHEDULED', paidAt: now, paymentId: via.paymentId, walletEntryId: debit.walletEntryId });
  if (!moved) {
    const current = await findBoostOrThrow(row.id);
    if (isPaid(current)) return current;
    await refundBuyer(buyerOf(row), { amount: money(row.total), idempotencyKey: `${debitKey(row)}:undo`, reference: row.id, note: `${reference}: the booking was ${current.status.toLowerCase()} while it was being paid`, byUserId, now });
    throw new ApiError(409, 'CONFLICT', `This sponsored listing was ${current.status.toLowerCase().replace('_', ' ')} before the payment went through; the money is back in the wallet.`);
  }
  const paid = await findBoostOrThrow(row.id);
  if (live) {
    const dates = datesLabel(row.startDate, row.endDate);
    await noticeBuyer(buyerOf(row), 'LIVE', { reference, what: whatOf(row, listing?.title), dates, relatedId: row.id, title: 'Your listing is sponsored now', message: `${whatOf(row, listing?.title)} is showing now, ${dates}.` });
  }
  return paid;
}

/** `POST /promotions/boosts/:id/pay-from-wallet` — the publisher wallet pays; SCHEDULED (LIVE on its first day). Idempotent. */
export async function payBoostFromWallet(row: BoostRow, actor: BoostActor, now = new Date()): Promise<BoostView> {
  assertMayActOnBoost(row, actor);
  if (isPaid(row)) return boostView(row);
  if (row.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', `This sponsored listing is ${row.status.toLowerCase().replace('_', ' ')} and is not waiting for payment`);
  await assertBuyerMayOrder(buyerOf(row), actor.userId);
  await assertBuyerCanPay(buyerOf(row), money(row.total), now);
  const paid = await takePayment(row, { paymentId: null, paymentReference: null }, actor.userId, now);
  await logActivity(actor.userId, 'LISTING_BOOST_PAID', { module: 'promotions', targetType: 'ListingBoost', targetId: row.id, metadata: { displayId: row.displayId, total: money(row.total), via: 'WALLET' } });
  return boostView(paid);
}

async function moveBoost(row: BoostRow, patch: BoostPatch): Promise<void> {
  if (!(await repository.transitionBoost(row.id, [row.status], patch))) throw new ApiError(409, 'CONFLICT', 'This sponsored listing changed a moment ago; read it again');
}

async function refundBoost(row: BoostRow, reason: string, byUserId: string | null, now: Date): Promise<void> {
  await refundBuyer(buyerOf(row), { amount: money(row.total), idempotencyKey: refundKey(row), reference: row.id, note: `${row.displayId ?? row.id} refunded: ${reason}`, byUserId, now });
}

/**
 * `POST /promotions/boosts/:id/cancel` — unpaid: let go; paid and not yet
 * started: refunded in full; running: stopped, nothing refunded.
 */
export async function cancelBoost(row: BoostRow, reason: string | undefined, actor: BoostActor, now = new Date()): Promise<BoostView> {
  assertMayActOnBoost(row, actor);
  const started = dayNumber(row.startDate) <= dayNumber(today(now));
  const why = reason?.trim() || 'Cancelled by the publisher';
  let refunded = false;
  if (row.status === 'PENDING_PAYMENT') {
    await moveBoost(row, { status: 'CANCELLED', cancelledAt: now, cancelReason: why });
  } else if (row.status === 'SCHEDULED' && !started) {
    await moveBoost(row, { status: 'CANCELLED', cancelledAt: now, cancelReason: why, refundedAt: now });
    await refundBoost(row, why, actor.userId, now);
    refunded = true;
  } else if (row.status === 'SCHEDULED' || row.status === 'LIVE') {
    await moveBoost(row, { status: 'CANCELLED', cancelledAt: now, cancelReason: why });
  } else {
    throw new ApiError(409, 'CONFLICT', `This sponsored listing is ${row.status.toLowerCase().replace('_', ' ')} and cannot be cancelled`);
  }
  await logActivity(actor.userId, 'LISTING_BOOST_CANCELLED', { module: 'promotions', targetType: 'ListingBoost', targetId: row.id, metadata: { displayId: row.displayId, from: row.status, reason: why, refunded } });
  return boostView(await findBoostOrThrow(row.id));
}

export async function listMyBoosts(publisherId: string, statuses?: readonly BoostRow['status'][]): Promise<BoostView[]> {
  const rows = await repository.listBoostsForPublisher(publisherId, statuses);
  const labels = new Map((await repository.listingLabels([...new Set(rows.map((row) => row.listingId))])).map((label) => [label.id, label]));
  return rows.map((row) => toBoostView(row, labels.get(row.listingId)));
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listBoostsForDesk(query: AdminBoostsQuery): Promise<ListPage<BoostView>> {
  const { items, total, counts } = await repository.listBoostsPage(query);
  const [labels, publishers] = await Promise.all([
    repository.listingLabels([...new Set(items.map((row) => row.listingId))]),
    repository.publisherLabels([...new Set(items.map((row) => row.publisherId))]),
  ]);
  const listingById = new Map(labels.map((label) => [label.id, label]));
  const publisherById = new Map(publishers.map((label) => [label.id, label]));
  return toListPage(
    items.map((row) => ({ ...toBoostView(row, listingById.get(row.listingId)), publisher: publisherById.get(row.publisherId) ?? null })),
    total,
    counts,
    query,
  );
}

/** `POST /promotions/admin/boosts/:id/cancel { reason, refund }` — ADX stops a boost; a paid one refunded in full when asked. */
export async function adminCancelBoost(id: string, input: { reason: string; refund: boolean }, byUserId: string, now = new Date()): Promise<BoostView> {
  const row = await findBoostOrThrow(id);
  if (!['PENDING_PAYMENT', 'SCHEDULED', 'LIVE'].includes(row.status)) throw new ApiError(409, 'CONFLICT', `This sponsored listing is ${row.status.toLowerCase().replace('_', ' ')} and cannot be cancelled`);
  const refund = input.refund && isPaid(row);
  await moveBoost(row, { status: 'CANCELLED', cancelledAt: now, cancelReason: input.reason, reviewNote: input.reason, ...(refund ? { refundedAt: now } : {}) });
  if (refund) await refundBoost(row, input.reason, byUserId, now);
  await logActivity(byUserId, 'LISTING_BOOST_CANCELLED_BY_ADX', { module: 'promotions', targetType: 'ListingBoost', targetId: row.id, metadata: { displayId: row.displayId, from: row.status, reason: input.reason, refunded: refund ? money(row.total) : null } });
  const [listing] = await repository.listingLabels([row.listingId]);
  await noticeBuyer(buyerOf(row), 'CANCELLED', {
    reference: row.displayId ?? row.id,
    what: whatOf(row, listing?.title),
    dates: datesLabel(row.startDate, row.endDate),
    relatedId: row.id,
    reason: input.reason,
    amount: refund ? money(row.total) : null,
    title: 'Your sponsored listing was stopped',
    message: `ADX stopped ${whatOf(row, listing?.title)}: ${input.reason}.${refund ? ` ${money(row.total)} is back in your wallet.` : ''}`,
  });
  return boostView(await findBoostOrThrow(row.id));
}

/* ── Payments (the gateway's door) ────────────────────────────────── */

/** `payments` asks this before a gateway order for a boost: the listing's publisher only, while it waits for payment. */
export async function boostPaymentTarget(boostId: string, actor: PromotionPayer): Promise<PromotionPaymentTarget> {
  if (!(await featureOn(BOOSTS_FEATURE, actor.userId))) throw new ApiError(503, 'FEATURE_OFF', 'This feature is switched off', { key: BOOSTS_FEATURE });
  const row = await findBoostOrThrow(boostId);
  if (!actor.publisherId || actor.publisherId !== row.publisherId) throw new ApiError(403, 'FORBIDDEN', 'Only the publisher can pay for their own sponsored listing.');
  if (isPaid(row)) throw new ApiError(409, 'CONFLICT', 'This sponsored listing is already paid');
  if (row.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', `This sponsored listing is ${row.status.toLowerCase().replace('_', ' ')} and is not waiting for payment`);
  return {
    id: row.id,
    reference: row.displayId ?? row.id,
    payer: { kind: 'PUBLISHER', id: row.publisherId },
    amount: money(row.total),
    description: `Sponsored listing ${row.displayId ?? row.id} — ${placementWords(row.placements)}, ${datesLabel(row.startDate, row.endDate)}`,
  };
}

/** `payments` settles a captured gateway payment here, out of the publisher wallet the capture credited. Idempotent. */
export async function settleBoostPayment(boostId: string, payment: { id: string; reference: string }, byUserId: string | null, now = new Date()): Promise<{ invoiceId: null }> {
  const row = await findBoostOrThrow(boostId);
  if (isPaid(row)) return { invoiceId: null };
  if (row.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', `The sponsored listing was ${row.status.toLowerCase().replace('_', ' ')} before the payment arrived`);
  await takePayment(row, { paymentId: payment.id, paymentReference: payment.reference }, byUserId, now);
  await logActivity(byUserId ?? row.createdByUserId, 'LISTING_BOOST_PAID', { module: 'promotions', targetType: 'ListingBoost', targetId: row.id, metadata: { displayId: row.displayId, total: money(row.total), via: 'GATEWAY', paymentId: payment.id } });
  // A publisher's receipt is a later lot: an Invoice names an advertiser.
  return { invoiceId: null };
}

/* ── The lifecycle (the job) ──────────────────────────────────────── */

export async function startDueBoosts(now: Date): Promise<number> {
  const day = today(now);
  let moved = 0;
  for (const row of await repository.boostsWhere({ status: 'SCHEDULED', startDate: { lte: day } })) {
    const ended = dayNumber(row.endDate) < dayNumber(day);
    if (!(await repository.transitionBoost(row.id, ['SCHEDULED'], { status: ended ? 'ENDED' : 'LIVE' }))) continue;
    moved += 1;
    if (ended) continue;
    const [listing] = await repository.listingLabels([row.listingId]);
    const dates = datesLabel(row.startDate, row.endDate);
    await noticeBuyer(buyerOf(row), 'LIVE', { reference: row.displayId ?? row.id, what: whatOf(row, listing?.title), dates, relatedId: row.id, title: 'Your listing is sponsored now', message: `${whatOf(row, listing?.title)} is showing now, ${dates}.` });
  }
  return moved;
}

export async function endFinishedBoosts(now: Date): Promise<number> {
  const day = today(now);
  let moved = 0;
  for (const row of await repository.boostsWhere({ status: 'LIVE', endDate: { lt: day } })) {
    if (!(await repository.transitionBoost(row.id, ['LIVE'], { status: 'ENDED' }))) continue;
    moved += 1;
    const [listing] = await repository.listingLabels([row.listingId]);
    const stats = await statsForBoost(row.id);
    await noticeBuyer(buyerOf(row), 'ENDED', {
      reference: row.displayId ?? row.id,
      what: whatOf(row, listing?.title),
      dates: datesLabel(row.startDate, row.endDate),
      relatedId: row.id,
      title: 'Your sponsored listing has finished',
      message: `${whatOf(row, listing?.title)} has finished: ${stats.impressions} views, ${stats.clicks} taps.`,
    });
  }
  return moved;
}

export async function cancelUnpaidBoosts(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PAY_WITHIN_MINUTES * 60_000);
  let moved = 0;
  for (const row of await repository.boostsWhere({ status: 'PENDING_PAYMENT', updatedAt: { lt: cutoff } })) {
    if (await repository.transitionBoost(row.id, ['PENDING_PAYMENT'], { status: 'CANCELLED', cancelledAt: now, cancelReason: `Not paid within ${PAY_WITHIN_MINUTES} minutes` })) moved += 1;
  }
  return moved;
}

/* ── The browse port ──────────────────────────────────────────────── */

const CACHE_MS = 30_000;
const cache = new Map<BoostPlacement, { at: number; value: { max: number; boosts: { boostId: string; listingId: string }[] } }>();

/**
 * What `listings`' SponsoredPort asks: the boosts running today for a
 * placement and the most a page carries. Nothing while `promotions.boosts`
 * is off or the placement is off sale. Cached thirty seconds per placement —
 * browse asks on every page one.
 */
export async function runningSponsored(placement: BoostPlacement, now = new Date()): Promise<{ max: number; boosts: { boostId: string; listingId: string }[] }> {
  const hit = cache.get(placement);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.value;
  let value: { max: number; boosts: { boostId: string; listingId: string }[] } = { max: 0, boosts: [] };
  if (await featureOn(BOOSTS_FEATURE)) {
    const config = await repository.findPlacement(placement);
    if (config?.isActive) {
      const rows = await repository.runningBoosts(placement, today(now));
      value = { max: config.maxConcurrent, boosts: rows.map((row) => ({ boostId: row.id, listingId: row.listingId })) };
    }
  }
  cache.set(placement, { at: now.getTime(), value });
  return value;
}

/** For the tests, and after a desk change that should show at once. */
export function clearSponsoredCache(): void {
  cache.clear();
}
