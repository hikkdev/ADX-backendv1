import { ApiError } from '../../shared/errors';
import { money } from '../../shared/money';
import { toListPage } from '../../shared/pagination';
import { dayWindowIST, dayWindowISTFor } from '../../shared/time';
import { assertAgentAcceptsWork, findAgentProfile, getAgentWithUser, requireAgentProfile } from '../agents';
import { allocateIdentifier } from '../identifiers';
import { notify } from '../notifications';
import { recordIncentive } from '../payouts';
import { cityKeyFor, withCityKey } from '../pricing';
import { prismaVisitsRepository as repository } from './prisma-visits.repository';
import { setVisitLocation } from './visit-location.store';
import {
  VISIT_OFFER_MINUTES,
  visitPillOf,
  type AdminVisitsQuery,
  type CreateVisitInput,
  type MyVisitsQuery,
  type VisitStatusValue,
} from './visits.schema';

/**
 * A visit as the card draws it.
 *
 * `expiresInSeconds` is the countdown on a NEW REQUEST card; `earned` is the
 * "₹145 earned" on a completed one, as a decimal string. Both are null when
 * they do not apply, never zero.
 */
export type VisitCard = {
  id: string;
  displayId: string | null;
  kind: string;
  status: VisitStatusValue;
  pill: { label: string; tone: string };
  businessName: string;
  locality: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  scheduledFor: string | null;
  offerExpiresAt: string | null;
  expiresInSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  earned: string | null;
  leadId: string | null;
  publisherId: string | null;
  advertiserId: string | null;
  agentId: string;
  /** Lot E (Q99): the drive this visit belongs to, or null. */
  campaignTag: string | null;
  notes: string | null;
  /**
   * Lot B (Q1): what came of the visit, on the detail read — the sales and
   * campaigns that carry this visit's id, and the line the card prints
   * ("1 sale, 1 campaign launched"). Absent on the list reads.
   */
  outcomes?: VisitOutcomes;
};

export type VisitOutcomes = { sales: number; campaigns: number; summary: string | null };

/** "1 sale, 1 campaign launched" — null when nothing came of it, never "0 sales". */
export function outcomeSummary(counts: { sales: number; campaigns: number }): string | null {
  const parts: string[] = [];
  if (counts.sales > 0) parts.push(`${counts.sales} sale${counts.sales === 1 ? '' : 's'}`);
  if (counts.campaigns > 0) {
    parts.push(`${counts.campaigns} campaign${counts.campaigns === 1 ? '' : 's'} launched`);
  }
  return parts.length ? parts.join(', ') : null;
}

/** The counts and the line, read off the rows that name the visit. */
export async function outcomesFor(visitId: string): Promise<VisitOutcomes> {
  const counts = await repository.countOutcomes(visitId);
  return { ...counts, summary: outcomeSummary(counts) };
}

/**
 * Lot B (Q1): whether a sale or a campaign may name this visit as the one it
 * was made on. The visit has to be the agent's own, and either in progress
 * now or completed today — an outcome recorded against last week's visit is
 * a story, not a record. Thrown as the API error the caller returns.
 */
export async function assertVisitOutcome(visitId: string, agentId: string | null, now = new Date()): Promise<void> {
  const visit = await repository.findById(visitId);
  if (!visit) throw new ApiError(404, 'NOT_FOUND', 'No such visit');
  if (!agentId || visit.agentId !== agentId) {
    throw new ApiError(403, 'FORBIDDEN', 'That visit is not yours');
  }
  const day = dayWindowIST(now);
  const inProgress = visit.status === 'IN_PROGRESS';
  const completedToday =
    visit.status === 'COMPLETED' &&
    visit.completedAt !== null &&
    visit.completedAt >= day.start &&
    visit.completedAt < day.end;
  if (!inProgress && !completedToday) {
    throw new ApiError(409, 'CONFLICT', 'An outcome can be recorded on a visit in progress, or one completed today');
  }
}

type Row = {
  id: string;
  displayId: string | null;
  kind: string;
  status: string;
  businessName: string;
  locality: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  scheduledFor: Date | null;
  offerExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  earnedAmount: unknown;
  leadId: string | null;
  publisherId: string | null;
  advertiserId: string | null;
  agentId: string;
  campaignTag?: string | null;
  notes: string | null;
};

export function toVisitCard(row: Row, now = new Date()): VisitCard {
  const status = row.status as VisitStatusValue;
  const expires = status === 'REQUESTED' && row.offerExpiresAt ? row.offerExpiresAt : null;
  return {
    id: row.id,
    displayId: row.displayId,
    kind: row.kind,
    status,
    pill: visitPillOf(status),
    businessName: row.businessName,
    locality: row.locality,
    city: row.city,
    latitude: row.latitude,
    longitude: row.longitude,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    offerExpiresAt: expires?.toISOString() ?? null,
    expiresInSeconds: expires ? Math.max(0, Math.round((expires.getTime() - now.getTime()) / 1000)) : null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    earned: row.earnedAmount === null || row.earnedAmount === undefined ? null : money(row.earnedAmount as never),
    leadId: row.leadId,
    publisherId: row.publisherId,
    advertiserId: row.advertiserId,
    agentId: row.agentId,
    campaignTag: row.campaignTag ?? null,
    notes: row.notes,
  };
}

const OFFER_MS = VISIT_OFFER_MINUTES * 60 * 1000;

/**
 * Books a visit.
 *
 * An agent booking for themselves is already accepted — nobody offers
 * themselves work — so it lands SCHEDULED (or, with no time yet, still
 * SCHEDULED with `scheduledFor` null: the day view puts it at the top). ADX
 * dispatching to a named agent is an OFFER, and it gets the same 25-minute
 * clock an order offer gets.
 */
export async function createVisit(
  input: CreateVisitInput,
  actor: { userId: string; isAdmin: boolean },
  now = new Date(),
) {
  let agentId: string;
  let status: 'REQUESTED' | 'SCHEDULED';
  let offerExpiresAt: Date | null = null;

  if (actor.isAdmin && input.agentId) {
    // Lot A BLOCK_NEW: ADX does not dispatch to a suspended agent.
    await assertAgentAcceptsWork(input.agentId);
    agentId = input.agentId;
    status = 'REQUESTED';
    offerExpiresAt = new Date(now.getTime() + OFFER_MS);
  } else {
    const me = await requireAgentProfile(actor.userId);
    // And a suspended agent does not book themselves one either.
    await assertAgentAcceptsWork(me.id);
    agentId = me.id;
    status = 'SCHEDULED';
  }

  const displayId = await allocateIdentifier('VISIT');
  // Lot X-B: the city key rides with the typed city (null for a town the catalogue lacks).
  const visit = await repository.create(await withCityKey({
    displayId,
    kind: input.kind,
    status,
    agentId,
    leadId: input.leadId ?? null,
    publisherId: input.publisherId ?? null,
    advertiserId: input.advertiserId ?? null,
    businessName: input.businessName,
    locality: input.locality ?? null,
    city: input.city ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    offerExpiresAt,
    scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
    campaignTag: input.campaignTag ?? null,
    notes: input.notes ?? null,
    requestedByUserId: actor.userId,
  }));

  if (status === 'REQUESTED') {
    const agent = await getAgentWithUser(agentId).catch(() => null);
    if (agent?.userId) {
      // Lot E1/F: one call — the in-app ORDER row, and the SMS the seeded
      // `visit-offer` template names (agentName, address, when), subject to
      // the agent's ORDER preference. The offer is ADX's, dispatched to a
      // named agent, so the template's `agentName` is the dispatcher's name.
      // Never a failure of the booking.
      const address = [input.businessName, input.locality, input.city].filter(Boolean).join(', ');
      const when = visit.scheduledFor ? visit.scheduledFor.toISOString() : 'a time to be agreed';
      await notify(
        'VISIT_OFFER',
        agent.userId,
        { agentName: 'ADX', address, when, minutes: VISIT_OFFER_MINUTES },
        {
          inApp: {
            type: 'ORDER',
            title: 'New visit request',
            message: `${input.businessName} — answer within ${VISIT_OFFER_MINUTES} minutes`,
            relatedId: visit.id,
          },
        },
      ).catch(() => undefined);
    }
  }

  return toVisitCard(visit, now);
}

async function own(visitId: string, userId: string, options: { isAdmin?: boolean } = {}) {
  const visit = await repository.findById(visitId);
  if (!visit) throw new ApiError(404, 'NOT_FOUND', 'No such visit');
  if (options.isAdmin) return visit;
  const me = await findAgentProfile(userId);
  if (!me || visit.agentId !== me.id) {
    throw new ApiError(403, 'FORBIDDEN', 'That visit is not yours');
  }
  return visit;
}

export async function myVisits(userId: string, query: MyVisitsQuery, now = new Date()) {
  const me = await requireAgentProfile(userId);
  const { items, total, counts } = await repository.findMine(me.id, query, dayWindowIST(now));
  return toListPage(items.map((row) => toVisitCard(row, now)), total, counts, query);
}

export async function visitsForAdmin(query: AdminVisitsQuery, now = new Date()) {
  const day = query.date ? dayWindowISTFor(query.date) : null;
  // Lot X-L: `?city=` is a slug (or a name) — matched by key, the spelling as the fallback for rows keyed to nothing.
  const keyed = query.city ? { ...query, cityId: (await cityKeyFor(query.city))?.cityId ?? null } : query;
  const { items, total, counts } = await repository.findForAdmin(keyed, day);
  return toListPage(items.map((row) => toVisitCard(row, now)), total, counts, query);
}

export async function getVisit(visitId: string, userId: string, isAdmin: boolean): Promise<VisitCard> {
  const visit = await own(visitId, userId, { isAdmin });
  return { ...toVisitCard(visit), outcomes: await outcomesFor(visit.id) };
}

/** A12 accept: inside the window, or 410. A second accept is a read. */
export async function acceptVisit(visitId: string, userId: string, now = new Date()) {
  const visit = await own(visitId, userId);
  if (visit.status === 'SCHEDULED') return toVisitCard(visit, now);
  if (visit.status !== 'REQUESTED') throw new ApiError(409, 'CONFLICT', 'That visit is not open to accept');
  if (visit.offerExpiresAt && visit.offerExpiresAt.getTime() < now.getTime()) {
    throw new ApiError(410, 'OFFER_EXPIRED', 'That request has expired');
  }
  return toVisitCard(await repository.update(visitId, { status: 'SCHEDULED', offerExpiresAt: null }), now);
}

export async function rejectVisit(visitId: string, userId: string, reason: string, now = new Date()) {
  const visit = await own(visitId, userId);
  if (visit.status !== 'REQUESTED') throw new ApiError(409, 'CONFLICT', 'Only a request can be declined');
  return toVisitCard(
    await repository.update(visitId, { status: 'DECLINED', declinedReason: reason, offerExpiresAt: null }),
    now,
  );
}

export async function scheduleVisit(visitId: string, userId: string, at: Date, now = new Date()) {
  const visit = await own(visitId, userId);
  if (visit.status !== 'SCHEDULED' && visit.status !== 'REQUESTED') {
    throw new ApiError(409, 'CONFLICT', 'That visit can no longer be moved');
  }
  return toVisitCard(await repository.update(visitId, { scheduledFor: at }), now);
}

export async function startVisit(visitId: string, userId: string, now = new Date()) {
  const visit = await own(visitId, userId);
  if (visit.status === 'IN_PROGRESS') return toVisitCard(visit, now);
  if (visit.status !== 'SCHEDULED') throw new ApiError(409, 'CONFLICT', 'Accept the visit before starting it');
  return toVisitCard(await repository.update(visitId, { status: 'IN_PROGRESS', startedAt: now }), now);
}

/**
 * G12-B: the agent's live position on the way to the visit — the order
 * lane's ping (`POST /orders/:id/update-location`), for a visit that is not
 * a step on an order. The visit's own agent only (404 / 403 like every
 * other verb here); a ping, not a state change, so a settled visit is not
 * refused. Kept in the live-position store, not on the row — see
 * `visit-location.store`.
 */
export async function shareVisitLocation(
  visitId: string,
  userId: string,
  coords: { latitude: number; longitude: number },
  now = new Date(),
): Promise<void> {
  const visit = await own(visitId, userId);
  await setVisitLocation(visit.id, coords, now);
}

/**
 * Done — and paid.
 *
 * `IncentiveRate` has priced SITE_VISIT since DR 04 and nothing ever recorded
 * one: a completed visit paid nothing until an admin typed it in. Completion
 * records the incentive itself, at the agent's tier, landing PENDING for
 * finance to release the way every other incentive does. The amount is copied
 * onto the visit so "₹145 earned" on the card is the figure the wallet will
 * show, not a second calculation.
 */
export async function completeVisit(
  visitId: string,
  userId: string,
  notes: string | undefined,
  /** LH10: the proof — a photo and the fix the phone had. Absent, the visit still completes and the QA sample says so. */
  proof: { proofFileId?: string | undefined; latitude?: number | undefined; longitude?: number | undefined } = {},
  now = new Date(),
) {
  const visit = await own(visitId, userId);
  if (visit.status === 'COMPLETED') return toVisitCard(visit, now);
  if (visit.status !== 'IN_PROGRESS' && visit.status !== 'SCHEDULED') {
    throw new ApiError(409, 'CONFLICT', 'That visit is not in progress');
  }

  const me = await requireAgentProfile(userId);
  let earned: string | null = null;
  let incentiveId: string | null = null;
  try {
    const incentive = await recordIncentive(
      {
        agentId: me.id,
        event: 'SITE_VISIT',
        tier: me.tier,
        publisherId: visit.publisherId,
        advertiserId: visit.advertiserId,
        note: `Visit ${visit.displayId ?? visit.id}: ${visit.businessName}`,
      },
      now,
    );
    earned = money(incentive.amount as never);
    incentiveId = incentive.id;
  } catch {
    // No rate configured for this tier. The visit is still done; it just
    // earned nothing the platform can name, and the card prints nothing.
  }

  const hasProof = proof.proofFileId !== undefined || (proof.latitude !== undefined && proof.longitude !== undefined);
  return toVisitCard(
    await repository.update(visitId, {
      status: 'COMPLETED',
      completedAt: now,
      ...(notes !== undefined ? { notes } : {}),
      earnedAmount: earned,
      incentiveId,
      // LH10: stamped only when something was sent — a completion with no
      // proof leaves the columns null, which is what the QA draw reads.
      ...(proof.proofFileId !== undefined ? { proofFileId: proof.proofFileId } : {}),
      ...(proof.latitude !== undefined && proof.longitude !== undefined ? { proofLatitude: proof.latitude, proofLongitude: proof.longitude } : {}),
      ...(hasProof ? { proofAt: now } : {}),
    }),
    now,
  );
}

export async function patchVisit(
  visitId: string,
  patch: { agentId?: string; scheduledFor?: string | null; status?: 'CANCELLED'; notes?: string },
  now = new Date(),
) {
  const visit = await repository.findById(visitId);
  if (!visit) throw new ApiError(404, 'NOT_FOUND', 'No such visit');
  const update: Record<string, unknown> = {};
  if (patch.agentId && patch.agentId !== visit.agentId) {
    // Reassigning is a fresh offer to the new agent, with a fresh clock — and
    // a fresh offer is new work, so BLOCK_NEW refuses it.
    await assertAgentAcceptsWork(patch.agentId);
    update['agentId'] = patch.agentId;
    update['status'] = 'REQUESTED';
    update['offerExpiresAt'] = new Date(now.getTime() + OFFER_MS);
  }
  if (patch.scheduledFor !== undefined) {
    update['scheduledFor'] = patch.scheduledFor ? new Date(patch.scheduledFor) : null;
  }
  if (patch.status === 'CANCELLED') {
    if (visit.status === 'COMPLETED') throw new ApiError(409, 'CONFLICT', 'A completed visit cannot be cancelled');
    update['status'] = 'CANCELLED';
    update['offerExpiresAt'] = null;
  }
  if (patch.notes !== undefined) update['notes'] = patch.notes;
  return toVisitCard(await repository.update(visitId, update), now);
}

/**
 * The 25-minute sweep, for `jobs/agent-timer` — the same tick that expires
 * order and milestone offers. Takes only the window that closed since the last
 * tick, like the others, so a restart cannot re-expire history.
 */
export async function expireVisitOffers(window: { start: Date; end: Date }) {
  const expired = await repository.findExpiredOffers(window.end, window.start);
  for (const visit of expired) {
    await repository.update(visit.id, { status: 'EXPIRED', offerExpiresAt: null });
  }
  return expired.length;
}

/**
 * Lot A STOP_OPEN_WORK on an agent: every visit still ahead of them is
 * cancelled with the reason, through the same column the dispatch board reads.
 * A visit already in progress or finished is left alone — the work happened,
 * and rewriting it would be a lie about the day.
 */
export async function cancelAgentVisits(agentId: string, reason: string): Promise<string[]> {
  const open = await repository.findOpenForAgent(agentId);
  const cancelled: string[] = [];
  for (const visit of open) {
    await repository.update(visit.id, {
      status: 'CANCELLED',
      offerExpiresAt: null,
      declinedReason: reason,
    });
    cancelled.push(visit.id);
  }
  return cancelled;
}

/**
 * How many visits this agent still has ahead of them — the closure review's
 * "open agent work" line (Lot A, Q21). Counted rather than cancelled: closing
 * an account releases them through the suspension's STOP_OPEN_WORK.
 */
export async function countOpenVisitsForAgent(agentId: string): Promise<number> {
  return (await repository.findOpenForAgent(agentId)).length;
}

/** Everything the agent holds today, for the day view. */
export async function visitsToday(agentId: string, now = new Date()) {
  const rows = await repository.findInWindow(agentId, dayWindowIST(now));
  return rows.map((row) => toVisitCard(row, now));
}

/**
 * P-B: the visits made to one publisher — scheduled, in progress or
 * completed, newest first, at most `limit` — as cards, for the party's
 * detail card in `publishers`. A declined or expired offer never happened to
 * them and is not listed.
 */
export async function visitsForPublisher(publisherId: string, limit = 30, now = new Date()): Promise<VisitCard[]> {
  const rows = await repository.findForPublisher(publisherId, Math.min(limit, 200));
  return rows.map((row) => toVisitCard(row, now));
}

/** Lot E (Q99): the agent's slotted visits across a range, for the diary overlay. */
export async function visitsInRange(agentId: string, window: { start: Date; end: Date }, now = new Date()) {
  const rows = await repository.findScheduledInRange(agentId, window);
  return rows.map((row) => toVisitCard(row, now));
}
