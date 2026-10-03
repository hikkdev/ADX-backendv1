import fs from 'node:fs';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import { bookingEligibility, getAdvertiser } from '../advertisers';
import { allocateIdentifier } from '../identifiers';
import { creditNoteForAdvertising, issueInvoiceForAdvertising } from '../invoices';
import { storeMediaFile } from '../media';
import type { IncomingFile } from '../uploads';
import { activeSlotByKey, specFor } from './catalogue.service';
import { ADS_FEATURE, assertBuyerCanPay, assertBuyerMayOrder, datesLabel, debitBuyer, featureOn, gstFraction, noticeBuyer, refundBuyer, type Buyer } from './common';
import { checkDates, dayKey, dayNumber, fullDays, parseDay, perDayCounts, quoteFor, today } from './pricing';
import { prismaPromotionsRepository as repository } from './prisma-promotions.repository';
import type { AdBookingRow, AdPatch, CityLabel, MediaRow } from './promotions.repository';
import type { AdminAdsQuery, CreateAdInput, UpdateAdInput } from './promotions.schema';
import { statsForAd, type StatsView } from './stats.service';

/**
 * LM-1 — display ads, sold in slots.
 *
 * A buyer (an advertiser account; its agent under the act rule; ADX on its
 * behalf) books a slot for dates, uploads artwork checked against the slot's
 * size spec, and pays — from the advertiser wallet, or through a gateway
 * (`payments` settles the capture here). ADX reviews the artwork; approved,
 * it runs, rotating with the other ads in the slot; rejected, the money goes
 * back in full.
 *
 *   DRAFT → PENDING_PAYMENT → PENDING_REVIEW → SCHEDULED → LIVE → ENDED
 *                                 ↘ REJECTED (refunded)
 *   any → CANCELLED (before it starts: refunded; after: stops, no refund)
 *
 * Capacity is the slot's `maxConcurrent` on every day of the booking: a
 * booking holds its days from PENDING_PAYMENT (for its hour) until it ends.
 */

export type AdActor = { userId: string; isAdmin: boolean };

/** How long a priced booking holds its days while the buyer pays. */
export const PAY_WITHIN_MINUTES = 60;

export type AdView = {
  id: string;
  displayId: string | null;
  status: AdBookingRow['status'];
  advertiserId: string;
  title: string;
  headline: string | null;
  ctaLabel: string | null;
  targetUrl: string | null;
  /** The catalogue ids the ad is shown in; empty = everywhere. */
  cityIds: string[];
  /** The same cities, named — what a buyer and the desk read. */
  cities: CityLabel[];
  startDate: string;
  endDate: string;
  days: number;
  slot: { key: string; label: string; spec: string; surfaces: string[] };
  media: { id: string; url: string; width: number | null; height: number | null; altText: string | null } | null;
  quote: { days: number; ratePerDay: Money; subtotal: Money; gstPct: string; gstAmount: Money; total: Money };
  ratePerDay: Money;
  subtotal: Money;
  gstAmount: Money;
  total: Money;
  /** While PENDING_PAYMENT: when the held days are let go if nothing is paid. */
  payBy: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  paidAt: string | null;
  paymentId: string | null;
  refundedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** On a draft: the days of its dates the slot is already full on — submit would be refused for them. */
  fullDays?: string[];
  advertiser?: { id: string; name: string; displayId: string | null } | null;
  stats?: StatsView;
};

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const gstPctOf = (row: Pick<AdBookingRow, 'subtotal' | 'gstAmount'>): string => {
  const subtotal = new Decimal(row.subtotal);
  return subtotal.isZero() ? '0' : new Decimal(row.gstAmount).dividedBy(subtotal).times(100).toDecimalPlaces(2).toString();
};

export function toAdView(row: AdBookingRow, media: MediaRow | null, cities: ReadonlyMap<string, CityLabel> = new Map()): AdView {
  const quote = { days: row.days, ratePerDay: money(row.ratePerDay), subtotal: money(row.subtotal), gstPct: gstPctOf(row), gstAmount: money(row.gstAmount), total: money(row.total) };
  return {
    id: row.id,
    displayId: row.displayId,
    status: row.status,
    advertiserId: row.advertiserId,
    title: row.title,
    headline: row.headline,
    ctaLabel: row.ctaLabel,
    targetUrl: row.targetUrl,
    cityIds: [...row.cityIds],
    cities: row.cityIds.map((id) => cities.get(id) ?? { id, slug: id, name: id }),
    startDate: dayKey(row.startDate),
    endDate: dayKey(row.endDate),
    days: row.days,
    slot: { key: row.slot.key, label: row.slot.label, spec: row.slot.spec, surfaces: [...row.slot.surfaces] },
    media: media && !media.archivedAt ? { id: media.id, url: media.url, width: media.width, height: media.height, altText: media.altText } : null,
    quote,
    ratePerDay: quote.ratePerDay,
    subtotal: quote.subtotal,
    gstAmount: quote.gstAmount,
    total: quote.total,
    payBy: row.status === 'PENDING_PAYMENT' ? new Date(row.updatedAt.getTime() + PAY_WITHIN_MINUTES * 60_000).toISOString() : null,
    reviewNote: row.reviewNote,
    reviewedAt: iso(row.reviewedAt),
    paidAt: iso(row.paidAt),
    paymentId: row.paymentId,
    refundedAt: iso(row.refundedAt),
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function mediaOf(row: AdBookingRow): Promise<MediaRow | null> {
  return row.mediaId ? repository.findMedia(row.mediaId) : null;
}

export async function findAdOrThrow(id: string): Promise<AdBookingRow> {
  const row = await repository.findAd(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Ad booking not found');
  return row;
}

/** The cities a set of bookings names, by id, for their views — one read. */
async function citiesOf(rows: readonly Pick<AdBookingRow, 'cityIds'>[]): Promise<Map<string, CityLabel>> {
  const ids = [...new Set(rows.flatMap((row) => row.cityIds))];
  return new Map((await repository.cityLabels(ids)).map((city) => [city.id, city]));
}

/**
 * LM-1: a buyer names cities as the public picker answers them — a slug
 * (`bengaluru`) — or by catalogue id; both are stored as the City id, which
 * is what the layout's resolver matches the city of a page against. 400
 * naming any that are not in the catalogue.
 */
export async function normaliseCities(values: readonly string[] | undefined): Promise<string[]> {
  if (!values?.length) return [];
  const keys = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const found = await repository.cityLabels(keys);
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const city = found.find((candidate) => candidate.id === key || candidate.slug === key.toLowerCase());
    if (city) ids.push(city.id);
    else unknown.push(key);
  }
  if (unknown.length) throw new ApiError(400, 'VALIDATION_ERROR', `Not a city ADX knows: ${unknown.join(', ')}`, { unknownCities: unknown });
  return [...new Set(ids)];
}

/** The booking as its buyer (or the desk) reads it — with its artwork, its cities and its numbers. */
export async function adView(row: AdBookingRow, options: { stats?: boolean } = {}): Promise<AdView> {
  const view = toAdView(row, await mediaOf(row), await citiesOf([row]));
  if (options.stats) view.stats = await statsForAd(row.id);
  return view;
}

const buyerOf = (row: Pick<AdBookingRow, 'advertiserId'>): Buyer => ({ kind: 'ADVERTISER', id: row.advertiserId });

/** A booking's line on a notice and on the invoice. */
const whatOf = (row: AdBookingRow): string => `${row.slot.label} ad "${row.title}"`;

/** The key of the charge for this round: a booking rejected, edited and paid again is a second round. */
const debitKey = (row: Pick<AdBookingRow, 'id' | 'refundedAt'>): string => `promotion-debit:ad:${row.id}${row.refundedAt ? `:${row.refundedAt.getTime()}` : ''}`;
const refundKey = (row: Pick<AdBookingRow, 'id' | 'paidAt'>): string => `promotion-refund:ad:${row.id}:${row.paidAt ? row.paidAt.getTime() : 0}`;

async function fullDaysFor(row: AdBookingRow): Promise<string[]> {
  return fullDays(await repository.adHolds(row.slotId, row.startDate, row.endDate, row.id), row.startDate, row.endDate, row.slot.maxConcurrent);
}

/** The gates an advertiser passes before paying, funds excepted — the booking gates (QR-16: KYC holds a campaign's launch, not a purchase). */
async function assertAdvertiserMayBuy(advertiserId: string): Promise<void> {
  const { blockedBy } = await bookingEligibility(advertiserId);
  if (blockedBy.includes('SUSPENDED')) throw new ApiError(409, 'ADVERTISER_SUSPENDED', 'This advertiser account is suspended and cannot buy ads');
  if (blockedBy.includes('PROFILE')) throw new ApiError(409, 'CONFLICT', 'Complete the advertiser profile before buying an ad');
  if (blockedBy.includes('AGREEMENT')) throw new ApiError(403, 'PLATFORM_AGREEMENT_REQUIRED', 'Accept the current advertiser platform agreement before buying an ad');
}

/* ── The buyer ────────────────────────────────────────────────────── */

/** `POST /promotions/ads` — a DRAFT, priced at the slot's rate today; the days already full are named so the buyer can move. */
export async function createAd(advertiserId: string, input: CreateAdInput, actor: AdActor, now = new Date()): Promise<AdView> {
  await getAdvertiser(advertiserId);
  const slot = await activeSlotByKey(input.slotKey);
  const startDate = parseDay(input.startDate, 'startDate');
  const endDate = parseDay(input.endDate, 'endDate');
  const days = checkDates(startDate, endDate, { minDays: slot.minDays, now });
  const quote = quoteFor([slot.ratePerDay], days, await gstFraction());
  const row = await repository.createAd({
    displayId: await allocateIdentifier('AD_BOOKING', now),
    slotId: slot.id,
    advertiserId,
    createdByUserId: actor.userId,
    title: input.title,
    headline: input.headline ?? null,
    ctaLabel: input.ctaLabel ?? null,
    targetUrl: input.targetUrl,
    cityIds: await normaliseCities(input.cityIds),
    startDate,
    endDate,
    days,
    ratePerDay: new Decimal(slot.ratePerDay),
    subtotal: new Decimal(quote.subtotal),
    gstAmount: new Decimal(quote.gstAmount),
    total: new Decimal(quote.total),
  });
  await logActivity(actor.userId, 'AD_BOOKING_CREATED', {
    module: 'promotions',
    targetType: 'AdBooking',
    targetId: row.id,
    metadata: { displayId: row.displayId, advertiserId, slotKey: slot.key, startDate: input.startDate, endDate: input.endDate, total: quote.total },
  });
  return { ...toAdView(row, null, await citiesOf([row])), fullDays: await fullDaysFor(row) };
}

/**
 * `PATCH /promotions/ads/:id` — a DRAFT, or a REJECTED booking being put
 * right (it goes back to DRAFT, to be paid again). The slot changes only
 * while it is a DRAFT: the booking is re-priced at the new slot's rate, and
 * artwork made for another size spec is let go (it would not fit).
 */
export async function updateAd(row: AdBookingRow, input: UpdateAdInput, actor: AdActor, now = new Date()): Promise<AdView> {
  if (row.status !== 'DRAFT' && row.status !== 'REJECTED') {
    throw new ApiError(409, 'CONFLICT', `A booking can be edited while it is a draft or after it was rejected; this one is ${row.status.toLowerCase().replace('_', ' ')}.`);
  }
  const patch: AdPatch = {};
  let slot = row.slot;
  if (input.slotKey !== undefined && input.slotKey !== row.slot.key) {
    if (row.status !== 'DRAFT') throw new ApiError(409, 'CONFLICT', 'The slot can be changed only while the booking is a draft. Book the other slot anew.');
    slot = await activeSlotByKey(input.slotKey);
    patch.slotId = slot.id;
    if (row.mediaId && slot.spec !== row.slot.spec) patch.mediaId = null;
  }
  const repriced = slot.id !== row.slot.id;
  if (input.title !== undefined) patch.title = input.title;
  if (input.headline !== undefined) patch.headline = input.headline;
  if (input.ctaLabel !== undefined) patch.ctaLabel = input.ctaLabel;
  if (input.targetUrl !== undefined) patch.targetUrl = input.targetUrl;
  if (input.cityIds !== undefined) patch.cityIds = await normaliseCities(input.cityIds);
  if (input.startDate !== undefined || input.endDate !== undefined || repriced) {
    const startDate = input.startDate !== undefined ? parseDay(input.startDate, 'startDate') : row.startDate;
    const endDate = input.endDate !== undefined ? parseDay(input.endDate, 'endDate') : row.endDate;
    const days = checkDates(startDate, endDate, { minDays: slot.minDays, now });
    const quote = quoteFor([slot.ratePerDay], days, await gstFraction());
    Object.assign(patch, {
      startDate,
      endDate,
      days,
      ratePerDay: new Decimal(slot.ratePerDay),
      subtotal: new Decimal(quote.subtotal),
      gstAmount: new Decimal(quote.gstAmount),
      total: new Decimal(quote.total),
    });
  }
  if (row.status === 'REJECTED') Object.assign(patch, { status: 'DRAFT', paymentId: null, walletEntryId: null });
  const updated = await repository.updateAd(row.id, patch);
  if (patch.mediaId === null && row.mediaId) await repository.archiveMedia(row.mediaId, now);
  await logActivity(actor.userId, 'AD_BOOKING_UPDATED', {
    module: 'promotions',
    targetType: 'AdBooking',
    targetId: row.id,
    metadata: { displayId: row.displayId, fields: Object.keys(input), from: row.status, ...(repriced ? { slotKey: slot.key, artworkDropped: patch.mediaId === null } : {}) },
  });
  return { ...toAdView(updated, await mediaOf(updated), await citiesOf([updated])), fullDays: await fullDaysFor(updated) };
}

/**
 * `POST /promotions/ads/:id/artwork` — the buyer's image (a multipart temp
 * file), checked against the slot's size spec by `media` — the same check
 * and the same spec list `GET /media/specs` answers — stored public under
 * `media` and recorded as a MediaAsset owned by the advertiser. Replacing
 * artwork archives the old asset. Allowed until the ad is approved — ADX
 * reviews whatever stands when it looks.
 */
export async function uploadArtwork(
  row: AdBookingRow,
  file: IncomingFile | undefined,
  input: { altText?: string | undefined },
  actor: AdActor,
  baseUrl: string,
  now = new Date(),
): Promise<AdView> {
  const drop = () => (file ? fs.promises.unlink(file.path).catch(() => undefined) : Promise.resolve());
  if (!['DRAFT', 'PENDING_PAYMENT', 'PENDING_REVIEW', 'REJECTED'].includes(row.status)) {
    await drop();
    throw new ApiError(409, 'CONFLICT', 'The artwork is fixed once the ad is approved. Cancel and book again to change it.');
  }
  if (!file) throw new ApiError(400, 'BAD_REQUEST', 'Attach the image as `file`');
  const spec = specFor(row.slot.spec);
  if (!spec) {
    await drop();
    throw new ApiError(409, 'CONFLICT', `The slot names a size spec (${row.slot.spec}) the media library does not know`);
  }
  // `media` checks it against the spec (400 INVALID_IMAGE naming every problem), stores it and records it; a refusal leaves nothing behind.
  const media = await storeMediaFile(
    file,
    { spec: spec.key, altText: input.altText?.trim() || row.headline || row.title, title: row.title, tags: ['ad', row.slot.key], ownerAdvertiserId: row.advertiserId },
    { userId: actor.userId, isAdmin: actor.isAdmin, baseUrl },
  );
  const previous = row.mediaId;
  const updated = await repository.updateAd(row.id, { mediaId: media.id });
  if (previous && previous !== media.id) await repository.archiveMedia(previous, now);
  await logActivity(actor.userId, 'AD_BOOKING_ARTWORK_UPLOADED', {
    module: 'promotions',
    targetType: 'AdBooking',
    targetId: row.id,
    metadata: { displayId: row.displayId, mediaId: media.id, width: media.width, height: media.height, bytes: media.bytes, replaced: previous },
  });
  return toAdView(updated, media, await citiesOf([updated]));
}

/**
 * `POST /promotions/ads/:id/submit` — DRAFT → PENDING_PAYMENT, priced at the
 * slot's rate now, the days held for an hour. Refused 409 SLOT_FULL with the
 * days the slot is full on; 409 ARTWORK_REQUIRED without an image.
 */
export async function submitAd(row: AdBookingRow, actor: AdActor, now = new Date()): Promise<AdView> {
  if (row.status === 'PENDING_PAYMENT') return adView(row);
  if (row.status !== 'DRAFT') throw new ApiError(409, 'CONFLICT', `Only a draft is submitted; this booking is ${row.status.toLowerCase().replace('_', ' ')}.`);
  if (!row.mediaId) throw new ApiError(409, 'ARTWORK_REQUIRED', 'Upload the artwork before submitting');
  if (!row.targetUrl) throw new ApiError(409, 'CONFLICT', 'Add the link the ad opens before submitting');
  // AGE-1: submitting prices the booking and holds its days — the order.
  await assertBuyerMayOrder(buyerOf(row), actor.userId);
  const slot = await activeSlotByKey(row.slot.key);
  if (dayNumber(row.startDate) < dayNumber(today(now))) throw new ApiError(409, 'CONFLICT', 'The start date has passed — change the dates and submit again');
  checkDates(row.startDate, row.endDate, { minDays: slot.minDays, now });
  const full = fullDays(await repository.adHolds(slot.id, row.startDate, row.endDate, row.id), row.startDate, row.endDate, slot.maxConcurrent);
  if (full.length) throw new ApiError(409, 'SLOT_FULL', `The ${slot.label} is fully booked on ${full.length} of the days you chose`, { fullDays: full });

  const quote = quoteFor([slot.ratePerDay], row.days, await gstFraction());
  const moved = await repository.transitionAd(row.id, ['DRAFT'], {
    status: 'PENDING_PAYMENT',
    ratePerDay: new Decimal(slot.ratePerDay),
    subtotal: new Decimal(quote.subtotal),
    gstAmount: new Decimal(quote.gstAmount),
    total: new Decimal(quote.total),
  });
  if (!moved) throw new ApiError(409, 'CONFLICT', 'This booking changed while it was being submitted; read it again');
  // Optimistic: two buyers submitting for the last place on the same day
  // both pass the count above; whoever finds the day over its limit after
  // writing steps back to DRAFT rather than overselling the slot.
  const after = perDayCounts(await repository.adHolds(slot.id, row.startDate, row.endDate), row.startDate, row.endDate);
  if (after.some((count) => count > slot.maxConcurrent)) {
    await repository.transitionAd(row.id, ['PENDING_PAYMENT'], { status: 'DRAFT' });
    const clash = fullDays(await repository.adHolds(slot.id, row.startDate, row.endDate, row.id), row.startDate, row.endDate, slot.maxConcurrent);
    throw new ApiError(409, 'SLOT_FULL', 'Someone booked the last place on some of your days a moment ago', { fullDays: clash });
  }
  await logActivity(actor.userId, 'AD_BOOKING_SUBMITTED', { module: 'promotions', targetType: 'AdBooking', targetId: row.id, metadata: { displayId: row.displayId, total: quote.total } });
  return adView(await findAdOrThrow(row.id));
}

/** Whether a booking's money has already been taken for this round. */
const isPaid = (row: AdBookingRow): boolean => Boolean(row.paidAt) && ['PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'ENDED'].includes(row.status);

/**
 * The charge and its paper, once — the wallet route and the gateway's
 * settlement both come through here. PENDING_PAYMENT → PENDING_REVIEW.
 * A booking that moved on while the debit ran (the hour lapsed) gets the
 * money straight back and a 409.
 */
async function takePayment(row: AdBookingRow, via: { paymentId: string | null; paymentReference: string | null }, byUserId: string | null, now: Date): Promise<AdBookingRow> {
  const reference = row.displayId ?? row.id;
  const debit = await debitBuyer(buyerOf(row), {
    amount: money(row.total),
    idempotencyKey: debitKey(row),
    reference: row.id,
    note: `${whatOf(row)}, ${datesLabel(row.startDate, row.endDate)} (${reference}${via.paymentReference ? `, ${via.paymentReference}` : ''})`,
    byUserId,
    now,
  });
  const moved = await repository.transitionAd(row.id, ['PENDING_PAYMENT'], { status: 'PENDING_REVIEW', paidAt: now, paymentId: via.paymentId, walletEntryId: debit.walletEntryId });
  if (!moved) {
    const current = await findAdOrThrow(row.id);
    if (isPaid(current)) return current;
    await refundBuyer(buyerOf(row), {
      amount: money(row.total),
      idempotencyKey: `${debitKey(row)}:undo`,
      reference: row.id,
      note: `${reference}: the booking was ${current.status.toLowerCase()} while it was being paid`,
      byUserId,
      now,
    });
    throw new ApiError(409, 'CONFLICT', `This booking was ${current.status.toLowerCase().replace('_', ' ')} before the payment went through; the money is back in the wallet.`);
  }
  const paid = await findAdOrThrow(row.id);
  await issueAdInvoice(paid, via.paymentId, byUserId, now);
  return paid;
}

async function issueAdInvoice(row: AdBookingRow, paymentId: string | null, byUserId: string | null, now: Date): Promise<string | null> {
  try {
    const invoice = await issueInvoiceForAdvertising({
      advertiserId: row.advertiserId,
      reference: row.displayId ?? row.id,
      description: `Advertising on ADX — ${row.slot.label}, ${datesLabel(row.startDate, row.endDate)}`,
      quantity: row.days,
      unitRate: money(row.ratePerDay),
      taxableValue: money(row.subtotal),
      gstPct: new Decimal(row.gstAmount).dividedBy(new Decimal(row.subtotal).isZero() ? 1 : row.subtotal).toDecimalPlaces(4).toString(),
      byUserId,
      paymentId,
      now,
    });
    return invoice.id;
  } catch (err) {
    logger.warn('Ad booking paid but its invoice could not be issued', { adBookingId: row.id, err });
    return null;
  }
}

/** `POST /promotions/ads/:id/pay-from-wallet` — the advertiser wallet pays; the ad waits for ADX's review. Idempotent. */
export async function payAdFromWallet(row: AdBookingRow, actor: AdActor, now = new Date()): Promise<AdView> {
  if (isPaid(row)) return adView(row);
  if (row.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', 'Submit the booking before paying for it');
  await assertBuyerMayOrder(buyerOf(row), actor.userId);
  await assertAdvertiserMayBuy(row.advertiserId);
  await assertBuyerCanPay(buyerOf(row), money(row.total), now);
  const paid = await takePayment(row, { paymentId: null, paymentReference: null }, actor.userId, now);
  await logActivity(actor.userId, 'AD_BOOKING_PAID', { module: 'promotions', targetType: 'AdBooking', targetId: row.id, metadata: { displayId: row.displayId, total: money(row.total), via: 'WALLET' } });
  return adView(paid);
}

/**
 * The refund of a paid booking, in full, with its credit note — ADX
 * rejected it, the buyer cancelled before it started, or it was never
 * reviewed before its dates ran out. Keyed on the payment it undoes.
 */
async function refundAd(row: AdBookingRow, reason: string, byUserId: string | null, now: Date): Promise<void> {
  await refundBuyer(buyerOf(row), {
    amount: money(row.total),
    idempotencyKey: refundKey(row),
    reference: row.id,
    note: `${row.displayId ?? row.id} refunded: ${reason}`,
    byUserId,
    now,
  });
  try {
    await creditNoteForAdvertising(row.advertiserId, row.displayId ?? row.id, reason, byUserId);
  } catch (err) {
    logger.warn('Ad booking refunded but its invoice could not be credited', { adBookingId: row.id, err });
  }
}

/**
 * `POST /promotions/ads/:id/cancel` — before it starts, the money comes back
 * in full; once it has started it stops, and nothing is refunded.
 */
export async function cancelAd(row: AdBookingRow, reason: string | undefined, actor: AdActor, now = new Date()): Promise<AdView> {
  const started = dayNumber(row.startDate) <= dayNumber(today(now));
  const why = reason?.trim() || 'Cancelled by the buyer';
  if (row.status === 'DRAFT' || row.status === 'PENDING_PAYMENT') {
    await moveAd(row, [row.status], { status: 'CANCELLED', cancelledAt: now, cancelReason: why });
  } else if (row.status === 'PENDING_REVIEW' || (row.status === 'SCHEDULED' && !started)) {
    await moveAd(row, [row.status], { status: 'CANCELLED', cancelledAt: now, cancelReason: why, refundedAt: now });
    await refundAd(row, why, actor.userId, now);
  } else if (row.status === 'SCHEDULED' || row.status === 'LIVE') {
    await moveAd(row, [row.status], { status: 'CANCELLED', cancelledAt: now, cancelReason: why });
  } else {
    throw new ApiError(409, 'CONFLICT', `This booking is ${row.status.toLowerCase().replace('_', ' ')} and cannot be cancelled`);
  }
  await logActivity(actor.userId, 'AD_BOOKING_CANCELLED', { module: 'promotions', targetType: 'AdBooking', targetId: row.id, metadata: { displayId: row.displayId, from: row.status, reason: why, refunded: row.status === 'PENDING_REVIEW' || (row.status === 'SCHEDULED' && !started) } });
  return adView(await findAdOrThrow(row.id));
}

async function moveAd(row: AdBookingRow, from: AdBookingRow['status'][], patch: AdPatch): Promise<void> {
  if (!(await repository.transitionAd(row.id, from, patch))) throw new ApiError(409, 'CONFLICT', 'This booking changed a moment ago; read it again');
}

export async function listMyAds(advertiserId: string, statuses?: readonly AdBookingRow['status'][]): Promise<AdView[]> {
  const rows = await repository.listAdsForAdvertiser(advertiserId, statuses);
  const [media, cities] = await Promise.all([repository.findMediaMany(rows.flatMap((row) => (row.mediaId ? [row.mediaId] : []))), citiesOf(rows)]);
  const mediaById = new Map(media.map((asset) => [asset.id, asset]));
  return rows.map((row) => toAdView(row, row.mediaId ? mediaById.get(row.mediaId) ?? null : null, cities));
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listAdsForDesk(query: AdminAdsQuery): Promise<ListPage<AdView>> {
  const { items, total, counts } = await repository.listAdsPage(query);
  const [media, advertisers, cities] = await Promise.all([
    repository.findMediaMany(items.flatMap((row) => (row.mediaId ? [row.mediaId] : []))),
    repository.advertiserLabels([...new Set(items.map((row) => row.advertiserId))]),
    citiesOf(items),
  ]);
  const mediaById = new Map(media.map((asset) => [asset.id, asset]));
  const advertiserById = new Map(advertisers.map((label) => [label.id, label]));
  return toListPage(
    items.map((row) => ({ ...toAdView(row, row.mediaId ? mediaById.get(row.mediaId) ?? null : null, cities), advertiser: advertiserById.get(row.advertiserId) ?? null })),
    total,
    counts,
    query,
  );
}

/**
 * `POST /promotions/admin/ads/:id/approve` — the artwork passes. SCHEDULED,
 * or straight to LIVE when its first day has come. A booking whose dates ran
 * out while it waited is refused: reject it, which refunds it.
 */
export async function approveAd(id: string, note: string | undefined, byUserId: string, now = new Date()): Promise<AdView> {
  const row = await findAdOrThrow(id);
  if (row.status !== 'PENDING_REVIEW') throw new ApiError(409, 'CONFLICT', `Only an ad waiting for review is approved; this one is ${row.status.toLowerCase().replace('_', ' ')}.`);
  if (!row.mediaId) throw new ApiError(409, 'ARTWORK_REQUIRED', 'There is no artwork to approve');
  const day = dayNumber(today(now));
  if (dayNumber(row.endDate) < day) throw new ApiError(409, 'CONFLICT', 'Its dates have passed while it waited. Reject it to refund the buyer.');
  const live = dayNumber(row.startDate) <= day;
  await moveAd(row, ['PENDING_REVIEW'], { status: live ? 'LIVE' : 'SCHEDULED', reviewNote: note?.trim() || null, reviewedById: byUserId, reviewedAt: now });
  await logActivity(byUserId, 'AD_BOOKING_APPROVED', { module: 'promotions', targetType: 'AdBooking', targetId: row.id, metadata: { displayId: row.displayId, live } });
  const reference = row.displayId ?? row.id;
  const dates = datesLabel(row.startDate, row.endDate);
  await noticeBuyer(buyerOf(row), 'APPROVED', {
    reference,
    what: whatOf(row),
    dates,
    relatedId: row.id,
    title: 'Your ad is approved',
    message: live ? `${whatOf(row)} is approved and running now, ${dates}.` : `${whatOf(row)} is approved and runs ${dates}.`,
  });
  if (live) await noticeBuyer(buyerOf(row), 'LIVE', { reference, what: whatOf(row), dates, relatedId: row.id, title: 'Your ad is live', message: `${whatOf(row)} is running now, until ${datesLabel(row.endDate, row.endDate)}.` });
  return adView(await findAdOrThrow(row.id));
}

/** `POST /promotions/admin/ads/:id/reject` — the artwork fails; the buyer is refunded in full and told why. */
export async function rejectAd(id: string, reason: string, byUserId: string, now = new Date()): Promise<AdView> {
  const row = await findAdOrThrow(id);
  const started = dayNumber(row.startDate) <= dayNumber(today(now));
  if (row.status !== 'PENDING_REVIEW' && !(row.status === 'SCHEDULED' && !started)) {
    throw new ApiError(409, 'CONFLICT', `An ad is rejected while it waits for review or before it starts; this one is ${row.status.toLowerCase().replace('_', ' ')}.`);
  }
  await moveAd(row, [row.status], { status: 'REJECTED', reviewNote: reason, reviewedById: byUserId, reviewedAt: now, refundedAt: now });
  await refundAd(row, `Rejected: ${reason}`, byUserId, now);
  await logActivity(byUserId, 'AD_BOOKING_REJECTED', { module: 'promotions', targetType: 'AdBooking', targetId: row.id, metadata: { displayId: row.displayId, reason, refunded: money(row.total) } });
  await noticeBuyer(buyerOf(row), 'REJECTED', {
    reference: row.displayId ?? row.id,
    what: whatOf(row),
    dates: datesLabel(row.startDate, row.endDate),
    relatedId: row.id,
    reason,
    amount: money(row.total),
    title: 'Your ad was not approved',
    message: `${whatOf(row)} was not approved: ${reason}. ${money(row.total)} is back in your wallet. Fix it and submit again.`,
  });
  return adView(await findAdOrThrow(row.id));
}

/* ── Payments (the gateway's door) ────────────────────────────────── */

export type PromotionPayer = { userId: string; isAdmin: boolean; advertiserId: string | null; publisherId: string | null; agentId: string | null };

export type PromotionPaymentTarget = { id: string; reference: string; payer: { kind: 'ADVERTISER' | 'PUBLISHER'; id: string }; amount: Money; description: string };

/**
 * `payments` asks this before it opens a gateway order for an ad: whose it
 * is, that it is waiting for payment, and what it costs. The advertiser, the
 * agent the account is attributed to, or ADX.
 */
export async function adPaymentTarget(adBookingId: string, actor: PromotionPayer): Promise<PromotionPaymentTarget> {
  if (!(await featureOn(ADS_FEATURE, actor.userId))) throw new ApiError(503, 'FEATURE_OFF', 'This feature is switched off', { key: ADS_FEATURE });
  const row = await findAdOrThrow(adBookingId);
  if (!actor.isAdmin && actor.advertiserId !== row.advertiserId) {
    const advertiser = await getAdvertiser(row.advertiserId);
    if (!actor.agentId || advertiser.agentId !== actor.agentId) throw new ApiError(403, 'FORBIDDEN', 'This ad booking belongs to someone else.');
  }
  if (isPaid(row)) throw new ApiError(409, 'CONFLICT', 'This ad booking is already paid');
  if (row.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', 'Submit the booking before paying for it');
  return {
    id: row.id,
    reference: row.displayId ?? row.id,
    payer: { kind: 'ADVERTISER', id: row.advertiserId },
    amount: money(row.total),
    description: `Ad ${row.displayId ?? row.id} — ${row.slot.label}, ${datesLabel(row.startDate, row.endDate)}`,
  };
}

/**
 * `payments` settles a captured gateway payment here, out of the wallet the
 * capture just credited. Idempotent: a booking already paid for this round
 * reads as settled. Answers the invoice it issued, for the payment to carry.
 */
export async function settleAdPayment(adBookingId: string, payment: { id: string; reference: string }, byUserId: string | null, now = new Date()): Promise<{ invoiceId: string | null }> {
  const row = await findAdOrThrow(adBookingId);
  if (isPaid(row)) return { invoiceId: await issueAdInvoice(row, row.paymentId ?? payment.id, byUserId, now) };
  if (row.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', `The ad booking was ${row.status.toLowerCase().replace('_', ' ')} before the payment arrived`);
  const paid = await takePayment(row, { paymentId: payment.id, paymentReference: payment.reference }, byUserId, now);
  const actor = byUserId ?? row.createdByUserId;
  await logActivity(actor, 'AD_BOOKING_PAID', { module: 'promotions', targetType: 'AdBooking', targetId: row.id, metadata: { displayId: row.displayId, total: money(row.total), via: 'GATEWAY', paymentId: payment.id } });
  return { invoiceId: await issueAdInvoice(paid, payment.id, byUserId, now) };
}

/* ── The lifecycle (the job) ──────────────────────────────────────── */

export async function startDueAds(now: Date): Promise<number> {
  const day = today(now);
  let moved = 0;
  for (const row of await repository.adsWhere({ status: 'SCHEDULED', startDate: { lte: day } })) {
    if (dayNumber(row.endDate) < dayNumber(day)) {
      if (await repository.transitionAd(row.id, ['SCHEDULED'], { status: 'ENDED' })) moved += 1;
      continue;
    }
    if (!(await repository.transitionAd(row.id, ['SCHEDULED'], { status: 'LIVE' }))) continue;
    moved += 1;
    const dates = datesLabel(row.startDate, row.endDate);
    await noticeBuyer(buyerOf(row), 'LIVE', { reference: row.displayId ?? row.id, what: whatOf(row), dates, relatedId: row.id, title: 'Your ad is live', message: `${whatOf(row)} is running now, ${dates}.` });
  }
  return moved;
}

export async function endFinishedAds(now: Date): Promise<number> {
  const day = today(now);
  let moved = 0;
  for (const row of await repository.adsWhere({ status: 'LIVE', endDate: { lt: day } })) {
    if (!(await repository.transitionAd(row.id, ['LIVE'], { status: 'ENDED' }))) continue;
    moved += 1;
    const stats = await statsForAd(row.id);
    await noticeBuyer(buyerOf(row), 'ENDED', {
      reference: row.displayId ?? row.id,
      what: whatOf(row),
      dates: datesLabel(row.startDate, row.endDate),
      relatedId: row.id,
      title: 'Your ad has finished',
      message: `${whatOf(row)} has finished: ${stats.impressions} views, ${stats.clicks} taps.`,
    });
  }
  return moved;
}

/** A priced booking left unpaid for an hour lets its days go. */
export async function cancelUnpaidAds(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PAY_WITHIN_MINUTES * 60_000);
  let moved = 0;
  for (const row of await repository.adsWhere({ status: 'PENDING_PAYMENT', updatedAt: { lt: cutoff } })) {
    if (await repository.transitionAd(row.id, ['PENDING_PAYMENT'], { status: 'CANCELLED', cancelledAt: now, cancelReason: `Not paid within ${PAY_WITHIN_MINUTES} minutes` })) moved += 1;
  }
  return moved;
}

/** A paid ad nobody reviewed before its last day passed never ran: cancelled and refunded in full. */
export async function expireUnreviewedAds(now: Date): Promise<number> {
  const day = today(now);
  let moved = 0;
  for (const row of await repository.adsWhere({ status: 'PENDING_REVIEW', endDate: { lt: day } })) {
    const reason = 'Its dates passed before ADX reviewed it';
    if (!(await repository.transitionAd(row.id, ['PENDING_REVIEW'], { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, refundedAt: now }))) continue;
    moved += 1;
    await refundAd(row, reason, null, now);
    await noticeBuyer(buyerOf(row), 'CANCELLED', {
      reference: row.displayId ?? row.id,
      what: whatOf(row),
      dates: datesLabel(row.startDate, row.endDate),
      relatedId: row.id,
      reason,
      amount: money(row.total),
      title: 'Your ad did not run',
      message: `${whatOf(row)} was not reviewed in time. ${money(row.total)} is back in your wallet.`,
    });
  }
  return moved;
}

/* ── The read the layouts resolve an `ad_slot` block with ────────── */

export type RunningAd = { adBookingId: string; displayId: string | null; media: { url: string; width: number | null; height: number | null; altText: string | null }; headline: string | null; ctaLabel: string | null; targetUrl: string | null };

/**
 * The ads running in a slot today that show in the city (an ad with no
 * cities shows everywhere), shuffled so they take turns. Empty while the
 * `promotions.ads` switch is off, the slot is inactive, or nothing is sold —
 * and an empty answer means the client draws nothing.
 */
export async function runningAdsForSlot(slotKey: string, options: { cityId?: string | null; now?: Date } = {}): Promise<{ slot: { key: string; label: string; spec: string } | null; ads: RunningAd[] }> {
  const slot = await repository.findSlotByKey(slotKey);
  if (!slot) return { slot: null, ads: [] };
  const summary = { key: slot.key, label: slot.label, spec: slot.spec };
  if (!slot.isActive || !(await featureOn(ADS_FEATURE))) return { slot: summary, ads: [] };
  const rows = await repository.runningAdsForSlot(slotKey, today(options.now));
  const ads = rows
    .filter((row) => row.media && !row.media.archivedAt)
    .filter((row) => row.cityIds.length === 0 || (options.cityId ? row.cityIds.includes(options.cityId) : false))
    .map((row) => ({
      adBookingId: row.id,
      displayId: row.displayId,
      media: { url: row.media!.url, width: row.media!.width, height: row.media!.height, altText: row.media!.altText },
      headline: row.headline,
      ctaLabel: row.ctaLabel,
      targetUrl: row.targetUrl,
    }));
  for (let index = ads.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [ads[index], ads[other]] = [ads[other]!, ads[index]!];
  }
  return { slot: summary, ads };
}
