import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { Decimal, money, type Money } from '../../shared/money';
import type { PriceApprovalSource, PriceApprovalStatus, RateCardStatus, RateGrade } from '../../shared/database';
import { createNotification } from '../notifications';
import { findWorkingAgentProfile } from '../agents';
import { holdsLiveGrant } from '../access-grants';
import { listingEnforcementPort } from './listing-enforcement.port';
import { prismaRateCardsRepository as repository } from './prisma-rate-cards.repository';
import { toListPage, type ListPage } from '../../shared/pagination';
import type { ApprovalFilter, EntryInput, ImpactSubject, PriceApprovalRow, RateCardRow } from './rate-cards.repository';

/**
 * Rate cards: what ADX has agreed a kind of spot is worth, and the gate that
 * puts in front of publishing.
 *
 * This module is deliberately not the pricing engine. That one is a suggester —
 * it reports what the market near a spot is doing and never blocks anything,
 * and its README says so in the first line. This one is governance: a number a
 * person approved, and a rule about what may go live against it. Keeping them
 * apart is what lets both statements stay true.
 *
 * They meet in exactly one place. The simulator can trace a quote from either
 * base — the card, or the comparables midpoint — through the same pricing
 * factors, which is what makes a card rate comparable to a market rate rather
 * than a second opinion nobody reconciles.
 */

/** The grade a listing is priced at when nobody has graded it. */
const DEFAULT_GRADE: RateGrade = 'B';

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

export const listCards = (status?: RateCardStatus) => repository.listCards(status);

export async function getCard(id: string) {
  const card = await repository.findCard(id);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');
  return { ...card, sitesPriced: await repository.countSitesPriced(id) };
}

export async function createCard(input: {
  name: string;
  cityId?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  floorPct?: string;
  graceDays?: number;
  roundingRupees?: number;
  notes?: string | null;
}) {
  const version = (await repository.highestVersion(input.name)) + 1;
  const { floorPct, ...rest } = input;
  return repository.createCard({
    ...rest,
    version,
    ...(floorPct ? { floorPct: new Decimal(floorPct) } : {}),
  });
}

/** Only a draft is editable. An ACTIVE card is a number people relied on. */
async function requireDraft(id: string): Promise<RateCardRow> {
  const card = await repository.findCard(id);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');
  if (card.status !== 'DRAFT' && card.status !== 'PENDING_APPROVAL') {
    throw new ApiError(
      409,
      'CONFLICT',
      'An approved card cannot be edited. Create the next version instead — the one it replaces stays readable, because listings were published against it.'
    );
  }
  return card;
}

export async function updateCard(
  id: string,
  patch: {
    name?: string;
    cityId?: string | null;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
    floorPct?: string;
    graceDays?: number;
    roundingRupees?: number;
    notes?: string | null;
  }
) {
  await requireDraft(id);
  const { floorPct, ...rest } = patch;
  return repository.updateCard(id, {
    ...rest,
    ...(floorPct ? { floorPct: new Decimal(floorPct) } : {}),
  });
}

export async function setEntries(
  id: string,
  entries: { mediaTypeId: string; grade: RateGrade; ratePerDay: string | null }[]
) {
  await requireDraft(id);
  const shaped: EntryInput[] = entries.map((entry) => ({
    mediaTypeId: entry.mediaTypeId,
    grade: entry.grade,
    // Null is "not sold at this grade", which is a different statement from
    // zero and has to survive the round trip as one.
    ratePerDay: entry.ratePerDay === null ? null : new Decimal(entry.ratePerDay),
  }));
  await repository.replaceEntries(id, shaped);
  return getCard(id);
}

export async function submitCard(id: string, userId: string) {
  const card = await requireDraft(id);
  const full = await repository.findCard(card.id);
  if (!full?.entries?.some((entry) => entry.ratePerDay !== null)) {
    throw new ApiError(
      409,
      'CONFLICT',
      'A card with no rates in it cannot be submitted — there would be nothing to approve.'
    );
  }
  return repository.setStatus(id, 'PENDING_APPROVAL', { submittedById: userId });
}

/**
 * Approving a card is what makes it decide things.
 *
 * The person is recorded because this is the answer to "no role can approve a
 * price": from here on, whether a listing may be published depends on a number
 * with somebody's name against it.
 *
 * Approving supersedes whatever it replaces in the same breath. Two ACTIVE
 * cards over one city is not a state the lookup can resolve honestly, and
 * leaving the old one active until someone remembers is how that happens.
 */
export async function approveCard(id: string, userId: string) {
  const card = await repository.findCard(id);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');
  if (card.status !== 'PENDING_APPROVAL') {
    throw new ApiError(409, 'CONFLICT', 'Only a card awaiting approval can be approved.');
  }

  for (const previous of await repository.activeCardsOverlapping(card.cityId)) {
    if (previous.id !== id) await repository.setStatus(previous.id, 'SUPERSEDED');
  }

  const active = await repository.setStatus(id, 'ACTIVE', { approvedById: userId });

  // Lot E (Q97): the listings this card just moved under its floor. Measured
  // after the status flip, so the effective-card check inside sees this one.
  const impact = await raiseCardRevisionCases(id, userId);

  return { ...active, impact };
}

/** The grace a CARD_REVISION case gives, from the card's own `graceDays`. */
function graceUntilFor(card: { graceDays: number }, now: Date): Date {
  return new Date(now.getTime() + card.graceDays * 86_400_000);
}

/**
 * Lot E (Q97): one PriceApproval per ACTIVE listing the card leaves under its
 * floor, unless a live case already stands on it. The card, its rate and its
 * floor are frozen on the row — the card can be revised again while this
 * sits in a queue — and the publisher is told what their two ways out are.
 *
 * Never unpublishes anything here. The case is the notice; the rejection,
 * after the grace, is the act — and even then not under a running order.
 */
async function raiseCardRevisionCases(
  cardId: string,
  userId: string,
  now = new Date()
): Promise<{ affected: number; raised: number; listingIds: string[] }> {
  const { card, rows } = await cardImpact(cardId, now);
  const raised: string[] = [];
  const graceUntil = graceUntilFor(card, now);

  for (const row of rows) {
    if (row.liveCase) continue;
    const created = await repository.createApproval({
      listingId: row.listingId,
      rateCardId: card.id,
      source: 'CARD_REVISION',
      graceUntil,
      requestedRatePerDay: new Decimal(row.ratePerDay),
      cardRatePerDay: new Decimal(row.cardRate),
      floorRatePerDay: new Decimal(row.floor),
      reason: `Rate card ${card.name} v${card.version} raised the floor for this kind of spot to ${row.floor} a day; the listing is at ${row.ratePerDay}.`,
      requestedById: userId,
    });
    raised.push(created.id);

    if (row.publisherUserId) {
      void createNotification({
        userId: row.publisherUserId,
        type: 'SYSTEM',
        title: 'Your rate is below the new floor',
        subtitle: row.title,
        message: `ADX's approved floor for this kind of spot is now ${row.floor} a day and "${row.title}" is listed at ${row.ratePerDay}. Raise the rate or ask ADX to keep it — you have until ${graceUntil.toISOString().slice(0, 10)} before the listing can be taken off the market.`,
        suggestedAction: 'Raise the rate or ask ADX to keep it',
        relatedId: row.listingId,
        relatedType: 'LISTING',
      }).catch(() => {});
    }
  }

  if (rows.length > 0) {
    await logActivity(userId, 'RATE_CARD_IMPACT_RAISED', {
      targetType: 'RateCard',
      targetId: card.id,
      module: 'rate-cards',
      metadata: {
        affected: rows.length,
        raised: raised.length,
        listingIds: rows.map((row) => row.listingId),
        priceApprovalIds: raised,
        graceDays: card.graceDays,
      },
    });
  }

  return { affected: rows.length, raised: raised.length, listingIds: rows.map((row) => row.listingId) };
}

/* ------------------------------------------------------------------ */
/* Impact                                                              */
/* ------------------------------------------------------------------ */

export type ImpactRow = {
  listingId: string;
  title: string;
  publisherId: string | null;
  publisherUserId: string | null;
  ratePerDay: Money;
  cardRate: Money;
  floor: Money;
  /** How far under the floor, a day. */
  shortfall: Money;
  /** The case already standing on the listing, when there is one. */
  liveCase: { id: string; status: PriceApprovalStatus; source: PriceApprovalSource } | null;
};

/**
 * This card's own cell for a listing, and the floor it draws.
 *
 * Reads the card's grid rather than the effective-card lookup, because the
 * question is what THIS card would say — a draft's impact is read before it
 * is approved, when the lookup would still answer with the old one.
 */
function floorAgainstCard(
  card: RateCardRow,
  listing: ImpactSubject
): { cardRate: Decimal; floor: Decimal } | null {
  if (!listing.mediaTypeId || listing.ratePerDay === null) return null;
  const grade = listing.rateGrade ?? DEFAULT_GRADE;
  const entry = (card.entries ?? []).find(
    (cell) => cell.mediaTypeId === listing.mediaTypeId && cell.grade === grade
  );
  if (!entry?.ratePerDay) return null;
  const cardRate = new Decimal(entry.ratePerDay);
  return { cardRate, floor: cardRate.times(new Decimal(card.floorPct)) };
}

/**
 * Lot E (Q97): the ACTIVE listings this card leaves under its floor.
 *
 * Readable on a draft or a pending card, which is the point — ops see what
 * approving would do before they do it. On an ACTIVE card only listings this
 * card actually governs count: a national card does not reach a spot in a
 * city with its own card, and raising a case there would be the wrong card
 * asking.
 */
export async function cardImpact(
  cardId: string,
  now = new Date()
): Promise<{ card: RateCardRow; rows: ImpactRow[] }> {
  const card = await repository.findCard(cardId);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');
  return { card, rows: await measureImpact(card, now) };
}

/** E10-2: a grid the desk has typed but not saved, with the floor and grace it would carry. */
export type ImpactDraft = {
  entries: { mediaTypeId: string; grade: RateGrade; ratePerDay: string | null }[];
  floorPct?: string | undefined;
  graceDays?: number | undefined;
};

/**
 * E10-2: `POST /rate-cards/:id/impact/dry-run` — the same measurement over a
 * draft grid, nothing persisted. The card's identity, city and status stay
 * the stored card's (that is what picks the listings and, once ACTIVE, the
 * governance check); the cells, the floor and the grace are the draft's.
 */
export async function cardImpactDryRun(
  cardId: string,
  draft: ImpactDraft,
  now = new Date()
): Promise<{ card: RateCardRow; rows: ImpactRow[] }> {
  const stored = await repository.findCard(cardId);
  if (!stored) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');
  const card: RateCardRow = {
    ...stored,
    floorPct: draft.floorPct ? new Decimal(draft.floorPct) : stored.floorPct,
    graceDays: draft.graceDays ?? stored.graceDays,
    entries: draft.entries.map((entry, index) => ({
      id: `draft-${index}`,
      mediaTypeId: entry.mediaTypeId,
      grade: entry.grade,
      ratePerDay: entry.ratePerDay === null ? null : new Decimal(entry.ratePerDay),
    })),
  };
  return { card, rows: await measureImpact(card, now) };
}

async function measureImpact(card: RateCardRow, now: Date): Promise<ImpactRow[]> {
  const subjects = await repository.activeListingsPricedBy(card.id);
  const rows: ImpactRow[] = [];

  for (const listing of subjects) {
    const against = floorAgainstCard(card, listing);
    if (!against) continue;
    const rate = new Decimal(listing.ratePerDay!);
    if (rate.greaterThanOrEqualTo(against.floor)) continue;

    if (card.status === 'ACTIVE') {
      const effective = await repository.effectiveEntry(
        listing.mediaTypeId!,
        listing.rateGrade ?? DEFAULT_GRADE,
        listing.cityId,
        now
      );
      if (effective && effective.card.id !== card.id) continue;
    }

    const live = await repository.findLiveApprovalForListing(listing.id);
    rows.push({
      listingId: listing.id,
      title: listing.title,
      publisherId: listing.publisherId,
      publisherUserId: listing.publisherUserId,
      ratePerDay: money(rate),
      cardRate: money(against.cardRate),
      floor: money(against.floor),
      shortfall: money(against.floor.minus(rate)),
      liveCase: live ? { id: live.id, status: live.status, source: live.source } : null,
    });
  }

  return rows;
}

/**
 * Lot E: `belowFloor` for a page of listings, the admin table's chip.
 *
 * True when the rate sits under the floor of the card in force, whatever
 * case may stand on it — the chip says where the price is, the case says
 * what was decided about it. False where no card reaches.
 */
export async function belowFloorFlags(listingIds: string[]): Promise<Record<string, boolean>> {
  const verdicts = await Promise.all(
    listingIds.map(async (id) => {
      try {
        return [id, isBelowFloor(await checkGate(id))] as const;
      } catch {
        return [id, false] as const;
      }
    })
  );
  return Object.fromEntries(verdicts);
}

export const isBelowFloor = (verdict: GateVerdict): boolean =>
  verdict.state === 'BELOW_FLOOR' ||
  verdict.state === 'AWAITING_APPROVAL' ||
  verdict.state === 'APPROVED_BELOW_FLOOR';

export async function rejectCard(id: string) {
  const card = await repository.findCard(id);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');
  if (card.status !== 'PENDING_APPROVAL') {
    throw new ApiError(409, 'CONFLICT', 'Only a card awaiting approval can be sent back.');
  }
  return repository.setStatus(id, 'DRAFT');
}

export async function archiveCard(id: string) {
  const card = await repository.findCard(id);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');
  return repository.setStatus(id, 'ARCHIVED');
}

/** The next version of a card, copied from the one it replaces. */
export async function reviseCard(id: string) {
  const card = await repository.findCard(id);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'Rate card not found');

  const next = await repository.createCard({
    name: card.name,
    cityId: card.cityId,
    effectiveFrom: card.effectiveFrom,
    effectiveTo: card.effectiveTo,
    floorPct: card.floorPct,
    roundingRupees: card.roundingRupees,
    notes: card.notes,
    version: (await repository.highestVersion(card.name)) + 1,
    supersedesId: card.id,
  });

  await repository.replaceEntries(
    next.id,
    (card.entries ?? []).map((entry) => ({
      mediaTypeId: entry.mediaTypeId,
      grade: entry.grade,
      ratePerDay: entry.ratePerDay,
    }))
  );

  return getCard(next.id);
}

/**
 * The card in force for a media type at a grade, in a city, on a date.
 *
 * Exported because the quote builder prices from the same entry this module
 * gates on. Two lookups would be two answers to one question, and the one the
 * advertiser was quoted has to be the one the listing is measured against.
 */
export const effectiveCardEntry = (
  mediaTypeId: string,
  grade: RateGrade,
  cityId: string | null,
  on: Date
) => repository.effectiveEntry(mediaTypeId, grade, cityId, on);

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

export type GateVerdict =
  /** No card prices this kind of spot here. Not a failure — a coverage gap. */
  | { state: 'NOT_COVERED' }
  | { state: 'OK'; cardId: string; cardRate: Money; floor: Money }
  | { state: 'BELOW_FLOOR'; cardId: string; cardRate: Money; floor: Money; rate: Money }
  /* E11-1: the two decided states carry the same numbers as BELOW_FLOOR, so a
   * screen can still print the floor while the case is open or kept. */
  | { state: 'APPROVED_BELOW_FLOOR'; approvalId: string; cardId: string; cardRate: Money; floor: Money; rate: Money }
  | { state: 'AWAITING_APPROVAL'; approvalId: string; cardId: string; cardRate: Money; floor: Money; rate: Money };

/**
 * Whether this listing's price is one ADX has agreed to.
 *
 * Answers rather than throws, because three different callers want three
 * different things from the same question: the publish path wants to refuse,
 * the console wants to show a badge, and the publisher's own screen wants to
 * explain. A verdict each of them can read is better than an exception two of
 * them have to catch.
 */
export async function checkGate(listingId: string, on = new Date()): Promise<GateVerdict> {
  const listing = await repository.findGateSubject(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  // Nothing to check against: an unpriced or unclassified listing is stopped
  // by the listing rules long before this one would have anything to say.
  if (!listing.mediaTypeId || listing.ratePerDay === null) return { state: 'NOT_COVERED' };

  const found = await repository.effectiveEntry(
    listing.mediaTypeId,
    listing.rateGrade ?? DEFAULT_GRADE,
    listing.cityId,
    on
  );
  if (!found?.entry.ratePerDay) return { state: 'NOT_COVERED' };

  const cardRate = new Decimal(found.entry.ratePerDay);
  const floor = cardRate.times(new Decimal(found.card.floorPct));
  const rate = new Decimal(listing.ratePerDay);

  if (rate.greaterThanOrEqualTo(floor)) {
    return {
      state: 'OK',
      cardId: found.card.id,
      cardRate: money(cardRate),
      floor: money(floor),
    };
  }

  // Below the floor. A decision may already exist for it.
  const numbers = { cardId: found.card.id, cardRate: money(cardRate), floor: money(floor), rate: money(rate) };
  const existing = await repository.findLiveApprovalForListing(listingId);
  if (existing?.status === 'APPROVED') {
    return { state: 'APPROVED_BELOW_FLOOR', approvalId: existing.id, ...numbers };
  }
  if (existing?.status === 'PENDING') {
    return { state: 'AWAITING_APPROVAL', approvalId: existing.id, ...numbers };
  }

  return { state: 'BELOW_FLOOR', ...numbers };
}

/**
 * Lot U: the floor for a kind of spot, before a listing exists to gate.
 *
 * The listing importer warns per row where a rate sits under ADX's floor
 * — the publish gate stays the guard — and a row has no listing id yet. The
 * same lookup `checkGate` makes, at the default grade (nobody has graded a
 * spot that is not on the platform), and null wherever the gate would say
 * NOT_COVERED: no card, or a card that does not sell this kind at that grade.
 */
export async function floorFor(mediaTypeId: string, cityId: string | null, on = new Date()): Promise<{ cardId: string; cardRate: Money; floor: Money } | null> {
  const found = await repository.effectiveEntry(mediaTypeId, DEFAULT_GRADE, cityId, on);
  if (!found?.entry.ratePerDay) return null;
  const cardRate = new Decimal(found.entry.ratePerDay);
  return { cardId: found.card.id, cardRate: money(cardRate), floor: money(cardRate.times(new Decimal(found.card.floorPct))) };
}

/* ------------------------------------------------------------------ */
/* The gate route's answer — E11-1                                     */
/* ------------------------------------------------------------------ */

/** The case standing on a listing, as the gate route names it. */
export type GateCase = {
  id: string;
  status: PriceApprovalStatus;
  source: PriceApprovalSource;
  graceUntil: Date | null;
  heldByRunningOrder: boolean;
};

/**
 * What `GET /rate-cards/gate/:listingId` answers: the verdict as ever, the
 * one-word badge beside it, the two numbers a phone prints — the floor of
 * the card in force and how far under it the rate sits — and the case
 * standing on the listing, whichever side raised it.
 */
export type GateView = GateVerdict & {
  belowFloor: boolean;
  /** The floor of the card in force; null where no card reaches. */
  floorRatePerDay: Money | null;
  /** Floor minus rate, a day, whenever the rate is under the floor — the case's state notwithstanding. */
  shortfall: Money | null;
  /**
   * The live PriceApproval on the listing — PENDING or APPROVED, CARD_REVISION
   * or PUBLISH_REQUEST — or null. Looked up on its own rather than through the
   * verdict, because a CARD_REVISION case stays open after the publisher has
   * raised the rate, and the phone should still be able to say so.
   */
  case: GateCase | null;
};

const gateCase = (row: PriceApprovalView): GateCase => ({
  id: row.id,
  status: row.status,
  source: row.source,
  graceUntil: row.graceUntil,
  heldByRunningOrder: row.heldByRunningOrder,
});

/** Who is asking the gate, and whether they are ADX. */
export type GateActor = { userId: string; isAdmin: boolean };

/**
 * E11 verify: who may ask the gate about a listing — and open a price case on
 * it. The route lets every PUBLISHER and AGENT_PUBLISHER account through, and
 * the gate view names the floor ADX set, the rate the publisher asked for and
 * the case standing between them, which is that publisher's business and
 * nobody else's. The line is the one `listings` draws for an edit: ADX, the
 * publisher from their own login, the agent who onboarded them
 * (`Publisher.agentId`), or an agent holding a live LISTINGS grant that
 * reaches this listing. An unclaimed listing belongs to nobody but ADX.
 */
export async function assertMayAskGate(listingId: string, actor: GateActor): Promise<void> {
  if (actor.isAdmin) return;

  const listing = await repository.findListingOwner(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  const publisher = listing.publisher;
  if (!publisher) {
    throw new ApiError(403, 'FORBIDDEN', 'This listing has no publisher yet, so only ADX can ask about its price');
  }
  if (publisher.userId === actor.userId) return;

  const agent = await findWorkingAgentProfile(actor.userId);
  if (agent) {
    if (publisher.agentId === agent.id) return;
    if (await holdsLiveGrant(agent.id, publisher.id, 'LISTINGS', listingId)) return;
  }

  throw new ApiError(403, 'FORBIDDEN', 'This is not your publisher. Ask them to raise a support ticket and scan you in.');
}

export async function gateView(listingId: string): Promise<GateView> {
  const verdict = await checkGate(listingId);
  const live = await repository.findLiveApprovalForListing(listingId);
  const belowFloor = isBelowFloor(verdict);
  const floorRatePerDay = 'floor' in verdict ? verdict.floor : null;
  const shortfall =
    belowFloor && 'rate' in verdict ? money(new Decimal(verdict.floor).minus(new Decimal(verdict.rate))) : null;
  return { ...verdict, belowFloor, floorRatePerDay, shortfall, case: live ? gateCase(withHoldFlag(live)) : null };
}

/**
 * The gate as the publish path uses it.
 *
 * `NOT_COVERED` passes. A deployment with no rate cards — which is every
 * deployment until somebody builds one — must keep working, and refusing to
 * publish because ADX has not yet decided what a spot is worth would punish the
 * publisher for an ADX omission. The gate bites only where there is a card to
 * bite with.
 */
export async function assertPublishable(listingId: string): Promise<void> {
  const verdict = await checkGate(listingId);

  if (verdict.state === 'BELOW_FLOOR') {
    throw new ApiError(
      409,
      'BELOW_RATE_CARD_FLOOR',
      `This price is below the approved floor of ${verdict.floor} a day for this kind of spot. Ask for it to be signed off, or raise the rate.`
    );
  }
  if (verdict.state === 'AWAITING_APPROVAL') {
    throw new ApiError(
      409,
      'BELOW_RATE_CARD_FLOOR',
      'This price is waiting on a decision from ADX. It can go live as soon as that comes through.'
    );
  }
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Lot E (Q97): a rejection a running order stopped. E7-2 (Lot E addendum 2):
 * `PriceApproval.heldByRunningOrder` is the column; the note is prose and
 * nothing is derived from it. Rows held before the column existed carry the
 * old `HELD_BY_RUNNING_ORDER` note prefix instead, which is still read for
 * one release so an open hold does not lose its flag on the desk.
 */
const LEGACY_HELD_PREFIX = 'HELD_BY_RUNNING_ORDER';

export type PriceApprovalView = PriceApprovalRow & { heldByRunningOrder: boolean };

const withHoldFlag = (row: PriceApprovalRow): PriceApprovalView => ({
  ...row,
  heldByRunningOrder:
    row.status === 'PENDING' && (row.heldByRunningOrder === true || (row.decisionNote ?? '').startsWith(LEGACY_HELD_PREFIX)),
});

export const listApprovals = async (filter: ApprovalFilter = {}): Promise<PriceApprovalView[]> =>
  (await repository.listApprovals(filter)).map(withHoldFlag);

/** E10-2: the list contract over the same filter, for a desk that pages. */
export async function listApprovalsPage(filter: ApprovalFilter, page: { page: number; pageSize: number }): Promise<ListPage<PriceApprovalView>> {
  const { items, total, counts } = await repository.listApprovalsPage(filter, page);
  return toListPage(items.map(withHoldFlag), total, counts, page);
}

export async function requestApproval(
  listingId: string,
  userId: string,
  reason?: string
): Promise<{ id: string }> {
  const verdict = await checkGate(listingId);

  if (verdict.state === 'OK' || verdict.state === 'NOT_COVERED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'This price is already within the approved range, so there is nothing to sign off.'
    );
  }
  if (verdict.state === 'AWAITING_APPROVAL' || verdict.state === 'APPROVED_BELOW_FLOOR') {
    return { id: verdict.approvalId };
  }

  const listing = await repository.findGateSubject(listingId);
  const created = await repository.createApproval({
    listingId,
    rateCardId: verdict.cardId,
    requestedRatePerDay: new Decimal(listing!.ratePerDay!),
    cardRatePerDay: new Decimal(verdict.cardRate),
    floorRatePerDay: new Decimal(verdict.floor),
    reason: reason ?? null,
    requestedById: userId,
  });
  return { id: created.id };
}

/**
 * Lot E (Q125): a case for a rate the engine proposed but may not write.
 *
 * A BINDING pricing factor that would move a rate by more than the cap is
 * refused, and this is where the refusal lands — a PENDING case carrying the
 * rate the factor wanted, frozen against the card in force (when one is),
 * for a person to decide. PUBLISH_REQUEST rather than a third source: the
 * question is the same one a publisher asks, "may this price stand?", only
 * asked by ADX's own engine.
 *
 * A PENDING case already on the listing is returned rather than doubled.
 */
export async function raisePriceCase(input: {
  listingId: string;
  requestedRatePerDay: Money;
  requestedById: string;
  reason: string;
}): Promise<{ id: string }> {
  const listing = await repository.findGateSubject(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  const existing = await repository.findLiveApprovalForListing(input.listingId);
  if (existing?.status === 'PENDING') return { id: existing.id };

  const found = listing.mediaTypeId
    ? await repository.effectiveEntry(
        listing.mediaTypeId,
        listing.rateGrade ?? DEFAULT_GRADE,
        listing.cityId,
        new Date()
      )
    : null;
  const cardRate = found?.entry.ratePerDay ? new Decimal(found.entry.ratePerDay) : null;

  const created = await repository.createApproval({
    listingId: input.listingId,
    rateCardId: found?.card.id ?? null,
    source: 'PUBLISH_REQUEST',
    requestedRatePerDay: new Decimal(input.requestedRatePerDay),
    cardRatePerDay: cardRate,
    floorRatePerDay: cardRate === null || !found ? null : cardRate.times(new Decimal(found.card.floorPct)),
    reason: input.reason,
    requestedById: input.requestedById,
  });
  return { id: created.id };
}

/**
 * A person's decision on a price case.
 *
 * APPROVED keeps the price whatever raised the case. REJECTED on a
 * PUBLISH_REQUEST is a decision on paper — the listing was never live under
 * it. REJECTED on a CARD_REVISION case (Lot E, Q97) is the act the case
 * warned about: after the grace, the listing is taken off the market
 * through `listings`. Two things stop that. The grace still running — the
 * publisher was told a date and the platform keeps it. And an order running
 * on the listing — the case is held PENDING with a note, because nothing
 * goes dark under a paying advertiser; ops decide again once it completes.
 */
export async function decideApproval(
  id: string,
  approve: boolean,
  userId: string,
  note?: string,
  now = new Date()
): Promise<PriceApprovalView> {
  const approval = await repository.findApproval(id);
  if (!approval) throw new ApiError(404, 'NOT_FOUND', 'Price approval not found');
  if (approval.status !== 'PENDING') {
    throw new ApiError(409, 'CONFLICT', 'This request has already been decided.');
  }

  if (!approve && approval.source === 'CARD_REVISION') {
    if (approval.graceUntil && approval.graceUntil > now) {
      throw new ApiError(
        409,
        'GRACE_PERIOD_RUNNING',
        `The publisher was given until ${approval.graceUntil.toISOString().slice(0, 10)} to raise the rate. Approve to keep the price, or decide after that date.`
      );
    }

    const listing = await repository.findGateSubject(approval.listingId);
    const stillUnder =
      listing !== null &&
      listing.status === 'ACTIVE' &&
      listing.ratePerDay !== null &&
      approval.floorRatePerDay !== null &&
      new Decimal(listing.ratePerDay).lessThan(new Decimal(approval.floorRatePerDay));

    if (stillUnder) {
      if (await repository.hasNonTerminalOrder(approval.listingId)) {
        const held = await repository.holdApproval(
          id,
          `An order is still running on this listing, so it stays live and the case stays open.${note ? ` ${note}` : ''}`
        );
        await logActivity(userId, 'PRICE_APPROVAL_HELD', {
          targetType: 'PriceApproval',
          targetId: id,
          module: 'rate-cards',
          metadata: { listingId: approval.listingId, reason: 'RUNNING_ORDER', note: note ?? null },
        });
        return withHoldFlag(held);
      }
      await listingEnforcementPort().unpublish({
        listingId: approval.listingId,
        reason: `Priced at ${money(new Decimal(listing.ratePerDay!))} a day, under the approved floor of ${money(new Decimal(approval.floorRatePerDay!))}; ADX declined to keep it and the grace has passed.`,
        actorUserId: userId,
      });
    }
  }

  const decided = await repository.decideApproval(id, approve ? 'APPROVED' : 'REJECTED', userId, note);
  await logActivity(userId, 'PRICE_APPROVAL_DECIDED', {
    targetType: 'PriceApproval',
    targetId: id,
    module: 'rate-cards',
    metadata: {
      listingId: approval.listingId,
      source: approval.source,
      status: decided.status,
      note: note ?? null,
    },
  });
  return withHoldFlag(decided);
}

/* ------------------------------------------------------------------ */
/* The simulator                                                       */
/* ------------------------------------------------------------------ */

export type QuoteStep = {
  step: string;
  rule: string;
  /** How this step changed the running total, as it should read on screen. */
  factor: string;
  running: Money;
};

export type Quote = {
  base: Money;
  ratePerDay: Money;
  /** Which card supplied the base, when one did. */
  cardId: string | null;
  cardName: string | null;
  floor: Money | null;
  belowFloor: boolean;
  steps: QuoteStep[];
};

/**
 * A quote, traced step by step.
 *
 * The trace is the requirement rather than the number — DR 10's simulator shows
 * base, then each multiplier, then the running total, because the screen exists
 * to explain a price to somebody arguing about it months later. Every step
 * therefore names the rule that produced it.
 */
export async function quoteFromCard(input: {
  mediaTypeId: string;
  grade?: RateGrade;
  cityId?: string | null;
  /** Multipliers and rupee adjustments already resolved by the caller. */
  factors?: { name: string; kind: 'MULTIPLIER' | 'BASE_ADJUST'; value: string }[];
  on?: Date;
}): Promise<Quote> {
  const grade = input.grade ?? DEFAULT_GRADE;
  const found = await repository.effectiveEntry(
    input.mediaTypeId,
    grade,
    input.cityId ?? null,
    input.on ?? new Date()
  );

  if (!found?.entry.ratePerDay) {
    throw new ApiError(
      409,
      'CONFLICT',
      'No approved rate card prices this media type at this grade, so there is no base to quote from.'
    );
  }

  const base = new Decimal(found.entry.ratePerDay);
  const steps: QuoteStep[] = [
    {
      step: 'Card rate',
      rule: `${found.card.name} v${found.card.version} · grade ${grade}`,
      factor: money(base),
      running: money(base),
    },
  ];

  let running = base;

  // Rupee adjustments before multipliers, so a multiplier applies to the whole
  // adjusted figure. The comparables engine composes them the same way.
  for (const factor of (input.factors ?? []).filter((f) => f.kind === 'BASE_ADJUST')) {
    running = running.plus(new Decimal(factor.value));
    steps.push({
      step: 'Adjustment',
      rule: factor.name,
      factor: `${new Decimal(factor.value).isNegative() ? '' : '+'}${factor.value}`,
      running: money(running),
    });
  }

  for (const factor of (input.factors ?? []).filter((f) => f.kind === 'MULTIPLIER')) {
    running = running.times(new Decimal(factor.value));
    steps.push({
      step: 'Multiplier',
      rule: factor.name,
      factor: `${factor.value}x`,
      running: money(running),
    });
  }

  // Rounding is last and is part of the card, because a card that quotes to the
  // nearest hundred and a quote that does not are the same card disagreeing
  // with itself.
  const rounding = new Decimal(found.card.roundingRupees);
  if (rounding.greaterThan(0)) {
    const rounded = running.dividedBy(rounding).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(rounding);
    if (!rounded.equals(running)) {
      running = rounded;
      steps.push({
        step: 'Rounding',
        rule: `Nearest ${found.card.roundingRupees}`,
        factor: '—',
        running: money(running),
      });
    }
  }

  const floor = base.times(new Decimal(found.card.floorPct));

  return {
    base: money(base),
    ratePerDay: money(running),
    cardId: found.card.id,
    cardName: `${found.card.name} v${found.card.version}`,
    floor: money(floor),
    belowFloor: running.lessThan(floor),
    steps,
  };
}
