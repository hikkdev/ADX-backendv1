import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money } from '../../shared/money';
import { toListPage } from '../../shared/pagination';
import { getOrderSummary } from '../orders';
import { cityKeyFor } from '../pricing';
import { prismaPrintPartnersRepository as repository } from './prisma-print-partners.repository';
import { PRINTABLE_ORDER_STATUSES, openPrintJob } from './print-jobs.service';
import { hasRateCard } from './print-partners.service';
import { tellJobAssigned, tellOps, tellQuoteCancelled, tellQuoteRejected, tellQuoteReopened, tellQuoteRequested } from './print-partners.notify';
import type { JobWithPartner, OrderForPrint, PartnerRow, QuoteRequestListFilter, QuoteRequestWithQuotes, QuoteWithPartner } from './print-partners.repository';
import type { AwardInput, QuoteInput, QuoteRequestInput } from './print-partners.schema';
import { DEFAULT_QUOTE_WINDOW_HOURS } from './print-partners.schema';

/**
 * Quote requests — Lot H (Q147, the owner's 6 Sep mechanics).
 *
 * The print charge is the partner's quoted, mutually agreed price — never
 * predefined. A partner with a rate card is preferred and asked first;
 * otherwise a request goes out to the partners in reach that accept
 * requests and the LOWEST quote is accepted, unless ops award another with
 * a reason. The award opens the PrintJob at that partner with the quote as
 * `quotedCost`; from there the job is Lot B's ladder, walked by the partner
 * from the floor.
 *
 * The invite list rides in the request's `specs` JSON as an envelope —
 * `{ specs, invitedPartnerIds, inviteMode, reinvitedAt }` — until the
 * schema carries a column for it (README, schema note). `envelopeOf` is the
 * one place that reads it and `sealEnvelope` the one place that writes it.
 *
 * Defaults taken here, each awaiting the owner's later round (README):
 * AUTO invites the active partners that accept requests in the order's
 * city or within 50 km of the site, all at once, rate-card partners listed
 * first; the deadline is 48 hours; the award is ops' tap, defaulting to
 * the lowest; bids are sealed — a partner sees only their own quote; a
 * request past its deadline with no quote is re-invited once and then
 * expired by the nightly job, and one with quotes stays open for ops.
 */

export const AUTO_INVITE_RADIUS_KM = 50;

export type QuoteEnvelope = {
  specs: Record<string, unknown>;
  invitedPartnerIds: string[];
  inviteMode: 'AUTO' | 'MANUAL';
  reinvitedAt: string | null;
  /** G13-B: why and when ops cancelled it; null while it stands. */
  cancelReason: string | null;
  cancelledAt: string | null;
};

export function envelopeOf(request: Pick<QuoteRequestWithQuotes, 'specs'>): QuoteEnvelope {
  const raw = (request.specs ?? {}) as Partial<QuoteEnvelope>;
  return {
    specs: raw.specs && typeof raw.specs === 'object' ? (raw.specs as Record<string, unknown>) : {},
    invitedPartnerIds: Array.isArray(raw.invitedPartnerIds) ? raw.invitedPartnerIds.filter((id): id is string => typeof id === 'string') : [],
    inviteMode: raw.inviteMode === 'MANUAL' ? 'MANUAL' : 'AUTO',
    reinvitedAt: typeof raw.reinvitedAt === 'string' ? raw.reinvitedAt : null,
    cancelReason: typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
    cancelledAt: typeof raw.cancelledAt === 'string' ? raw.cancelledAt : null,
  };
}

const sealEnvelope = (envelope: QuoteEnvelope) => envelope as never;

/** Great-circle distance in kilometres — for the 50 km reach around the site. */
export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * The partners an AUTO invite reaches: active, accepting requests, in the
 * order's city or within 50 km of the site. Rate-card partners first — the
 * "asked first" of the owner's mechanics — then by name.
 *
 * Lot X-L: "in the order's city" is by the city key when the site's city
 * resolves to one (`site.cityId`) — a partner keyed to it is in, whatever
 * either side typed, so 'Bengaluru' and 'Bangalore' partners are one pool —
 * with the spelling as the fallback for a partner whose key is null. A site
 * in a town nobody catalogued matches by spelling alone, as before.
 */
export function partnersInReach(
  partners: readonly PartnerRow[],
  site: { city: string | null; cityId?: string | null; latitude: number | null; longitude: number | null },
): PartnerRow[] {
  const city = site.city?.trim().toLowerCase() ?? null;
  const sameCity = (partner: PartnerRow): boolean => {
    if (site.cityId && partner.cityId === site.cityId) return true;
    if (site.cityId && partner.cityId) return false;
    return Boolean(city && partner.city && partner.city.trim().toLowerCase() === city);
  };
  const inReach = partners.filter((partner) => {
    if (!partner.isActive || !partner.acceptsQuoteRequests) return false;
    if (sameCity(partner)) return true;
    if (site.latitude !== null && site.longitude !== null && partner.latitude !== null && partner.longitude !== null) {
      return distanceKm({ latitude: site.latitude, longitude: site.longitude }, { latitude: partner.latitude, longitude: partner.longitude }) <= AUTO_INVITE_RADIUS_KM;
    }
    return false;
  });
  return [...inReach].sort((a, b) => Number(hasRateCard(b)) - Number(hasRateCard(a)) || a.name.localeCompare(b.name));
}

/**
 * The order of preference among the quotes still standing: the lowest
 * amount; on a tie the shorter turnaround; then a rate-card partner; then
 * whoever quoted first. `ranked[0]` is what the award takes by default.
 * G13-B: "a rate-card partner" is `hasRateCard` — the one rule the reach
 * uses too — read off the columns the quote's partner slice carries.
 */
export function rankQuotes(quotes: readonly QuoteWithPartner[]): QuoteWithPartner[] {
  return quotes
    .filter((quote) => quote.status === 'SUBMITTED')
    .sort(
      (a, b) =>
        new Decimal(a.amount).comparedTo(new Decimal(b.amount)) ||
        a.turnaroundDays - b.turnaroundDays ||
        Number(hasRateCard(b.printPartner)) - Number(hasRateCard(a.printPartner)) ||
        a.submittedAt.getTime() - b.submittedAt.getTime(),
    );
}

const specsSummary = (specs: Record<string, unknown>): string => {
  const parts = Object.entries(specs)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .slice(0, 4)
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.length ? `${parts.join(', ')}.` : 'Print specs attached.';
};

/* ── Ops: raising a request ─────────────────────────────────────── */

export async function createQuoteRequest(
  orderId: string,
  input: QuoteRequestInput,
  byUserId: string,
  now = new Date(),
): Promise<{ request: QuoteRequestWithQuotes; invited: PartnerRow[] }> {
  const order = await getOrderSummary(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (!PRINTABLE_ORDER_STATUSES.has(order.status)) {
    throw new ApiError(409, 'CONFLICT', `An order that is ${order.status.toLowerCase().replace(/_/g, ' ')} is not ready to print.`);
  }
  const job = await repository.findJobByOrder(orderId);
  if (job && job.status !== 'CANCELLED') {
    throw new ApiError(409, 'CONFLICT', `This order already has a print job (${job.status.toLowerCase()}).`, { printJobId: job.id });
  }
  const latest = await repository.findLatestQuoteRequestForOrder(orderId);
  if (latest && latest.status === 'OPEN') {
    throw new ApiError(409, 'CONFLICT', 'This order already has an open quote request.', { quoteRequestId: latest.id });
  }

  const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt) : new Date(now.getTime() + DEFAULT_QUOTE_WINDOW_HOURS * 60 * 60 * 1000);
  if (deadlineAt.getTime() <= now.getTime()) throw new ApiError(400, 'BAD_REQUEST', 'The deadline has to be in the future.');

  const site = await repository.findOrderForPrint(orderId);
  const listing = site?.listing ?? { city: null, latitude: null, longitude: null };
  // Lot X-L: the site's typed city resolved to its key; the typed string itself stays on the request for display.
  const cityId = (await cityKeyFor(listing.city))?.cityId ?? null;

  let invited: PartnerRow[];
  if (input.invite === 'AUTO') {
    invited = partnersInReach(await repository.findPartnersInReach({ city: listing.city, cityId }), { ...listing, cityId });
    if (invited.length === 0) {
      throw new ApiError(409, 'NO_PARTNERS_IN_REACH', 'No active print partner accepting quote requests is in reach of this site. Invite partners by id.');
    }
  } else {
    const chosen = await repository.findPartnersInReach({ partnerIds: input.invite });
    const missing = input.invite.filter((id) => !chosen.some((partner) => partner.id === id));
    if (missing.length) throw new ApiError(404, 'NOT_FOUND', 'Print partner not found', { partnerIds: missing });
    const off = chosen.filter((partner) => !partner.isActive);
    if (off.length) throw new ApiError(409, 'CONFLICT', 'A partner named is off the roster.', { partnerIds: off.map((p) => p.id) });
    invited = [...chosen].sort((a, b) => Number(hasRateCard(b)) - Number(hasRateCard(a)) || a.name.localeCompare(b.name));
  }

  const request = await repository.createQuoteRequest({
    orderId,
    specs: sealEnvelope({
      specs: input.specs,
      invitedPartnerIds: invited.map((partner) => partner.id),
      inviteMode: input.invite === 'AUTO' ? 'AUTO' : 'MANUAL',
      reinvitedAt: null,
      cancelReason: null,
      cancelledAt: null,
    }),
    city: listing.city,
    deadlineAt,
    createdById: byUserId,
  });

  const summary = specsSummary(input.specs);
  await Promise.all(
    invited.map((partner) => tellQuoteRequested(partner.userId, { orderId, summary, deadline: deadlineAt, city: listing.city })),
  );
  return { request, invited };
}

/** The request on an order — the latest, with every quote and the lowest named. */
export async function getQuoteRequestForOrder(orderId: string): Promise<QuoteRequestWithQuotes> {
  const request = await repository.findLatestQuoteRequestForOrder(orderId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'No quote request on this order');
  return request;
}

/* ── G13-B: the desk's list across orders, and the cancel ────────── */

/** One row of `GET /print-quote-requests` — enough for the desk to triage without opening each order. */
export type QuoteRequestListRow = {
  request: QuoteRequestWithQuotes;
  /** The order behind it — null when the order is gone. */
  order: OrderForPrint | null;
  invitedCount: number;
  standingQuotes: number;
  lowest: QuoteWithPartner | null;
};

/**
 * G13-B: every request under the filters, OPEN and nearest deadline first,
 * with the order behind each (one read for the page), how many partners
 * were invited, how many quotes stand and the lowest of them — so the desk
 * stops fanning out `GET /orders/:id/print-quote-request` per order.
 */
export async function listQuoteRequests(filter: QuoteRequestListFilter) {
  const { items, total, counts } = await repository.listQuoteRequests(filter);
  const orders = await repository.findOrdersForPrint([...new Set(items.map((request) => request.orderId))]);
  const byOrder = new Map(orders.map((order) => [order.id, order]));
  const rows: QuoteRequestListRow[] = items.map((request) => {
    const ranked = rankQuotes(request.quotes);
    return {
      request,
      order: byOrder.get(request.orderId) ?? null,
      invitedCount: envelopeOf(request).invitedPartnerIds.length,
      standingQuotes: ranked.length,
      lowest: ranked[0] ?? null,
    };
  });
  return toListPage(rows, total, counts, filter);
}

/**
 * G13-B: ops close an OPEN request — the order will be printed another
 * way, or not at all. The reason and the moment go into the envelope
 * (no column yet; README), the request reads CANCELLED, quoting is closed
 * by that status alone (the quotes are left as the record of who bid), and
 * every invited partner is told. Anything but OPEN is a 409: an awarded
 * request is undone through the job's decline, never by a cancel.
 */
export async function cancelQuoteRequest(orderId: string, reason: string, now = new Date()): Promise<QuoteRequestWithQuotes> {
  const request = await getQuoteRequestForOrder(orderId);
  if (request.status !== 'OPEN') {
    throw new ApiError(409, 'CONFLICT', `This request is ${request.status.toLowerCase()}.`, { quoteRequestId: request.id });
  }
  const envelope = envelopeOf(request);
  const cancelled = await repository.updateQuoteRequest(request.id, {
    status: 'CANCELLED',
    specs: sealEnvelope({ ...envelope, cancelReason: reason, cancelledAt: now.toISOString() }),
  });
  await Promise.all(
    envelope.invitedPartnerIds.map(async (id) => {
      const partner = await repository.findPartner(id);
      if (partner) await tellQuoteCancelled(partner.userId, { orderId, reason });
    }),
  );
  return cancelled;
}

/* ── The partner's side ─────────────────────────────────────────── */

/** G13-B: one request as the partner sees it — 404 unless they were invited (sealed bids), whatever its status. */
export async function getQuoteRequestForPartner(partner: PartnerRow, requestId: string): Promise<QuoteRequestWithQuotes> {
  const request = await repository.findQuoteRequest(requestId);
  if (!request || !envelopeOf(request).invitedPartnerIds.includes(partner.id)) {
    throw new ApiError(404, 'NOT_FOUND', 'Quote request not found');
  }
  return request;
}

export async function listQuoteRequestsForPartner(
  partner: PartnerRow,
  query: { status?: readonly ('OPEN' | 'AWARDED' | 'CANCELLED' | 'EXPIRED')[]; page: number; pageSize: number },
) {
  const { items, total, counts } = await repository.listQuoteRequestsForPartner(partner.id, query);
  return toListPage(items, total, counts, query);
}

async function requireInvitedOpenRequest(partner: PartnerRow, requestId: string, now: Date): Promise<QuoteRequestWithQuotes> {
  const request = await repository.findQuoteRequest(requestId);
  if (!request || !envelopeOf(request).invitedPartnerIds.includes(partner.id)) {
    // A request the partner was not invited to reads as missing, never as forbidden — sealed bids.
    throw new ApiError(404, 'NOT_FOUND', 'Quote request not found');
  }
  if (request.status !== 'OPEN') {
    throw new ApiError(409, 'CONFLICT', `This request is ${request.status.toLowerCase()}; quotes are closed.`);
  }
  if (request.deadlineAt.getTime() <= now.getTime()) {
    throw new ApiError(409, 'DEADLINE_PASSED', 'The deadline for quotes on this request has passed.', { deadlineAt: request.deadlineAt });
  }
  return request;
}

/**
 * One quote per partner per request, edited freely until the deadline —
 * a re-submission replaces the amount, the turnaround and the note and
 * restarts the clock the tie-break reads. A partner off the roster cannot
 * quote; a withdrawn quote can be re-submitted.
 */
export async function submitQuote(partner: PartnerRow, requestId: string, input: QuoteInput, now = new Date()): Promise<QuoteWithPartner> {
  if (!partner.isActive) throw new ApiError(409, 'CONFLICT', 'Your account is off the roster; ADX will be in touch.');
  const request = await requireInvitedOpenRequest(partner, requestId, now);
  const mine = request.quotes.find((quote) => quote.printPartnerId === partner.id);
  const patch = { amount: new Decimal(input.amount), turnaroundDays: input.turnaroundDays, note: input.note ?? null };
  if (mine) {
    if (mine.status === 'ACCEPTED' || mine.status === 'REJECTED') {
      throw new ApiError(409, 'CONFLICT', 'This quote has already been decided.');
    }
    return repository.updateQuote(mine.id, { ...patch, status: 'SUBMITTED', submittedAt: now });
  }
  return repository.createQuote({ requestId: request.id, printPartnerId: partner.id, ...patch });
}

export async function withdrawQuote(partner: PartnerRow, requestId: string, now = new Date()): Promise<QuoteWithPartner> {
  const request = await requireInvitedOpenRequest(partner, requestId, now);
  const mine = request.quotes.find((quote) => quote.printPartnerId === partner.id);
  if (!mine || mine.status !== 'SUBMITTED') throw new ApiError(404, 'NOT_FOUND', 'You have no standing quote on this request');
  return repository.updateQuote(mine.id, { status: 'WITHDRAWN' });
}

/* ── Ops: the award ──────────────────────────────────────────────── */

export type AwardResult = {
  request: QuoteRequestWithQuotes;
  job: JobWithPartner;
  quote: QuoteWithPartner;
  lowest: QuoteWithPartner;
  /** True when ops awarded a quote that was not the lowest — a note was required. */
  overridden: boolean;
};

/**
 * The award: the lowest standing quote unless ops name another — and then
 * only with a note, because the owner's rule is "lowest is accepted" and
 * an exception has to say why. Opens the job at the winner with the
 * quote as `quotedCost` (through `openPrintJob`, so the same gates hold —
 * the order still printable, the partner still on the roster, one job per
 * order, a CANCELLED job reopened in place), marks the winner ACCEPTED and
 * every other standing quote REJECTED, closes the request AWARDED, and
 * tells both sides. A request past its deadline can still be awarded: the
 * deadline closes quoting, not deciding.
 */
/** G13-B: the per-request lock the award runs under — a Redis `SET NX`, held for the award and released after it. */
export const AWARD_LOCK_TTL_MS = 30_000;
export const awardLockKey = (requestId: string) => `print-partners:award:${requestId}`;

/**
 * G13-B: one award at a time per request. Two admins tapping Award
 * together would otherwise both read the request OPEN and both open a
 * job; the second is answered 409 instead. The lock is advisory — a Redis
 * `SET NX` with a TTL (a process that died mid-award frees it in thirty
 * seconds) — and Redis being down fails the award loudly rather than
 * letting it run unguarded.
 */
async function withAwardLock<T>(requestId: string, work: () => Promise<T>): Promise<T> {
  const key = awardLockKey(requestId);
  const acquired = await redis.set(key, '1', 'PX', AWARD_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    throw new ApiError(409, 'CONFLICT', 'This request is being awarded by someone else right now. Reload and try again.', { quoteRequestId: requestId });
  }
  try {
    return await work();
  } finally {
    await redis.del(key).catch((err: unknown) => logger.warn('Award lock not released; it expires on its own', { key, err }));
  }
}

export async function awardQuoteRequest(orderId: string, input: AwardInput, now = new Date()): Promise<AwardResult> {
  const latest = await getQuoteRequestForOrder(orderId);
  return withAwardLock(latest.id, () => awardLocked(orderId, input, now));
}

async function awardLocked(orderId: string, input: AwardInput, now: Date): Promise<AwardResult> {
  // Re-read under the lock: what the other admin did a moment ago is what counts.
  const request = await getQuoteRequestForOrder(orderId);
  if (request.status !== 'OPEN') {
    throw new ApiError(409, 'CONFLICT', `This request is ${request.status.toLowerCase()}.`, { quoteRequestId: request.id });
  }
  const ranked = rankQuotes(request.quotes);
  const lowest = ranked[0];
  if (!lowest) throw new ApiError(409, 'NO_QUOTES', 'No partner has quoted on this request yet.');

  let chosen = lowest;
  if (input.quoteId) {
    const named = request.quotes.find((quote) => quote.id === input.quoteId);
    if (!named) throw new ApiError(404, 'NOT_FOUND', 'Quote not found on this request');
    if (named.status !== 'SUBMITTED') throw new ApiError(409, 'CONFLICT', `That quote is ${named.status.toLowerCase()}.`);
    chosen = named;
  }
  const overridden = chosen.id !== lowest.id;
  if (overridden && !input.note) {
    throw new ApiError(400, 'NOTE_REQUIRED', `The lowest quote is ₹${money(lowest.amount)} from ${lowest.printPartner.name}. Awarding another needs a note saying why.`, {
      lowestQuoteId: lowest.id,
    });
  }

  const envelope = envelopeOf(request);
  const job = await openPrintJob(
    orderId,
    {
      printPartnerId: chosen.printPartnerId,
      quotedCost: money(chosen.amount),
      specs: envelope.specs,
      notes: input.note ?? null,
      awardedQuoteId: chosen.id,
    },
    now,
  );

  const quote = await repository.updateQuote(chosen.id, { status: 'ACCEPTED' });
  await repository.updateQuotesOnRequest(request.id, [chosen.id], 'SUBMITTED', { status: 'REJECTED' });
  const awarded = await repository.updateQuoteRequest(request.id, {
    status: 'AWARDED',
    awardedQuoteId: chosen.id,
    awardNote: input.note ?? null,
  });

  const losers = ranked.filter((row) => row.id !== chosen.id);
  const partner = await repository.findPartner(chosen.printPartnerId);
  await Promise.all([
    partner ? tellJobAssigned(partner.userId, { orderId, amount: money(chosen.amount), partnerName: partner.name }) : Promise.resolve(),
    ...losers.map(async (loser) => {
      const row = await repository.findPartner(loser.printPartnerId);
      if (row) await tellQuoteRejected(row.userId, orderId);
    }),
  ]);

  return { request: awarded, job, quote, lowest, overridden };
}

/**
 * A partner declined the job the award opened: the request goes back to
 * OPEN with the declined partner's quote WITHDRAWN and the other standing
 * quotes back to SUBMITTED, the deadline pushed out by the default window
 * when it has passed, and the others told it is open again. Ops award
 * again from the console. Called by the floor's decline; a no-op for a
 * job opened by hand.
 */
export async function reopenRequestAfterDecline(job: Pick<JobWithPartner, 'orderId' | 'awardedQuoteId' | 'printPartnerId'>, now = new Date()): Promise<QuoteRequestWithQuotes | null> {
  if (!job.awardedQuoteId) return null;
  const quote = await repository.findQuote(job.awardedQuoteId);
  if (!quote) return null;
  const request = await repository.findQuoteRequest(quote.requestId);
  if (!request || request.status !== 'AWARDED') return null;

  await repository.updateQuote(quote.id, { status: 'WITHDRAWN' });
  await repository.updateQuotesOnRequest(request.id, [quote.id], 'REJECTED', { status: 'SUBMITTED' });
  const deadlineAt =
    request.deadlineAt.getTime() > now.getTime() ? request.deadlineAt : new Date(now.getTime() + DEFAULT_QUOTE_WINDOW_HOURS * 60 * 60 * 1000);
  const reopened = await repository.updateQuoteRequest(request.id, { status: 'OPEN', awardedQuoteId: null, awardNote: null, deadlineAt });

  const envelope = envelopeOf(request);
  await Promise.all(
    envelope.invitedPartnerIds
      .filter((id) => id !== job.printPartnerId)
      .map(async (id) => {
        const partner = await repository.findPartner(id);
        if (partner) await tellQuoteReopened(partner.userId, { orderId: job.orderId, deadline: deadlineAt });
      }),
  );
  return reopened;
}

/* ── The nightly job ─────────────────────────────────────────────── */

export type ExpirySummary = { checked: number; reinvited: string[]; expired: string[]; awaitingAward: string[] };

/**
 * OPEN requests past their deadline. No quote and never re-invited: the
 * deadline moves out by the default window, `reinvitedAt` is stamped and
 * every invited partner is told once more. No quote after that: EXPIRED,
 * and ops told to invite by hand or open a job. Quotes standing: the
 * request stays OPEN for ops to award — the deadline closes quoting, not
 * deciding — and ops are reminded.
 */
export async function expireQuoteRequests(now = new Date()): Promise<ExpirySummary> {
  const due = await repository.findOpenRequestsPastDeadline(now);
  const summary: ExpirySummary = { checked: due.length, reinvited: [], expired: [], awaitingAward: [] };
  for (const request of due) {
    const envelope = envelopeOf(request);
    const standing = rankQuotes(request.quotes);
    if (standing.length > 0) {
      summary.awaitingAward.push(request.id);
      await tellOps('Print quotes await award', `${standing.length} quote(s) on order ${request.orderId.slice(-6).toUpperCase()} are past the deadline and waiting for an award.`, request.orderId);
      continue;
    }
    if (!envelope.reinvitedAt) {
      const deadlineAt = new Date(now.getTime() + DEFAULT_QUOTE_WINDOW_HOURS * 60 * 60 * 1000);
      await repository.updateQuoteRequest(request.id, {
        deadlineAt,
        specs: sealEnvelope({ ...envelope, reinvitedAt: now.toISOString() }),
      });
      await Promise.all(
        envelope.invitedPartnerIds.map(async (id) => {
          const partner = await repository.findPartner(id);
          if (partner) await tellQuoteReopened(partner.userId, { orderId: request.orderId, deadline: deadlineAt });
        }),
      );
      summary.reinvited.push(request.id);
      continue;
    }
    await repository.updateQuoteRequest(request.id, { status: 'EXPIRED' });
    await tellOps('Print quote request expired', `No partner quoted on order ${request.orderId.slice(-6).toUpperCase()} after two rounds. Invite partners by hand or open a job directly.`, request.orderId);
    summary.expired.push(request.id);
  }
  return summary;
}
