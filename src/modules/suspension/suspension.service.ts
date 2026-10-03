import { findActivity, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import type { PartySuspensionEvent, SuspensionScope } from '../../shared/database';
import { requestRefund } from '../advertisers';
import { revokeSessions } from '../auth';
import { cancelAdvertiserCampaigns, cancelSpotsForOrders, type CampaignRefund } from '../campaigns';
import { createNotification } from '../notifications';
import { cancelOrder, findOpenOrdersForListings, releaseAgentOffers } from '../orders';
import { releaseAgentMilestones } from '../order-milestones';
import { findUserLabels, type UserLabel } from '../users';
import { cancelAgentVisits } from '../visits';
import { freezeWallet, unfreezeWallet } from '../wallets';
import { revokeLiveGrantsForAgent, revokeLiveGrantsOnParty } from '../access-grants';
import { deactivateQrsFor } from '../qr';
import { releaseLeadsHeldBy } from '../leads';
import { accountClosedAt, assertNotClosed } from '../../shared/party-status';
import { prismaSuspensionRepository as repository } from './prisma-suspension.repository';
import type { PartyType } from './suspension.repository';

/**
 * Modular suspension — Lot A (Q40/Q48/Q52), 12 September 2026.
 *
 * ADX suspends *sections* of a party rather than the party: a listing may stop
 * taking bookings while the orders on it run to the end; a publisher's wallet
 * may be frozen while their spots keep earning. Five scopes say which section,
 * one vocabulary covers all four parties, and every step and every reversal is
 * a `PartySuspensionEvent` row with a reason and a name against it.
 *
 * The scopes, and what each one actually does:
 *
 *   BLOCK_NEW        nothing new starts. A listing goes SUSPENDED and takes no
 *                    bookings; a publisher's BLOCK_NEW cascades onto every
 *                    listing they own; an advertiser cannot authorize a
 *                    campaign or buy a package; an agent's profile goes
 *                    SUSPENDED and no offer, visit, milestone or lead reaches
 *                    them.
 *   STOP_OPEN_WORK   what is in flight stops. Orders are cancelled through the
 *                    ordinary cancel path and the unused days come back as ONE
 *                    refund request per campaign; an advertiser's live
 *                    campaigns are cancelled the same way; an agent's
 *                    unanswered offers are handed back and re-offered, their
 *                    open visits cancelled and their dispatched milestones
 *                    returned to ADX.
 *   STOP_ACCRUAL     the daily earning skips the listing. A publisher's is
 *                    cascaded onto their listings so the accrual run has one
 *                    place to look.
 *   FREEZE_WALLET    money may land and may not leave. Credits, accruals and
 *                    incentives still post; debits, holds and withdrawals are
 *                    refused with 409 WALLET_FROZEN.
 *   BLOCK_SIGNIN     `User.isActive` goes false and every refresh token is
 *                    revoked.
 *
 * Account lifecycle (2 Oct 2026): BLOCK_NEW and BLOCK_SIGNIN on a publisher,
 * an advertiser or an agent also close the doors — every live access grant
 * (an agent's own, or the ones ON a publisher's or advertiser's account) is
 * revoked and the party's QR codes are deactivated; STOP_OPEN_WORK on an
 * agent hands their open leads back to the pool. Neither comes back on
 * reinstatement: a grant is asked for again, a code is issued again.
 * Reinstating BLOCK_SIGNIN on a closed account is refused (409
 * ACCOUNT_CLOSED). A user deactivation suspends the user's profiles with
 * BLOCK_NEW (`suspendForUserDeactivation`), and the reactivation lifts
 * exactly what it placed (`reinstateAfterUserReactivation`).
 *
 * Two rules the whole module turns on. Nothing here touches a wallet balance:
 * money that has to come back goes through the refund desk, which is a
 * two-person decision, so a suspension can never quietly move money. And
 * nothing is undone by a reinstatement that cannot honestly be undone —
 * lifting STOP_OPEN_WORK does not un-cancel an order, and the README says so.
 */

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

export const PARTY_TYPES = ['LISTING', 'PUBLISHER', 'ADVERTISER', 'AGENT'] as const;

/**
 * Which scopes each party admits.
 *
 * A listing has no wallet and cannot sign in, so it takes the three that are
 * about the spot itself. An advertiser has no accrual — they pay, they do not
 * earn — so STOP_ACCRUAL would be a scope that did nothing. The rest of the
 * platform reads these lists rather than restating them.
 */
export const SCOPES_BY_PARTY: Record<PartyType, readonly SuspensionScope[]> = {
  LISTING: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL'],
  PUBLISHER: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
  ADVERTISER: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
  AGENT: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
};

/** The audit action each party writes, so one trail search finds a whole case. */
const ACTIONS: Record<PartyType, { suspended: string; reinstated: string; model: string }> = {
  LISTING: { suspended: 'LISTING_SUSPENDED', reinstated: 'LISTING_REINSTATED', model: 'Listing' },
  PUBLISHER: { suspended: 'PUBLISHER_SUSPENDED', reinstated: 'PUBLISHER_REINSTATED', model: 'Publisher' },
  ADVERTISER: { suspended: 'ADVERTISER_SUSPENDED', reinstated: 'ADVERTISER_REINSTATED', model: 'Advertiser' },
  AGENT: { suspended: 'AGENT_SUSPENDED', reinstated: 'AGENT_REINSTATED', model: 'AgentProfile' },
};

export type SuspensionView = {
  partyType: PartyType;
  partyId: string;
  scopes: SuspensionScope[];
  suspendedAt: Date | null;
  suspensionReason: string | null;
  suspendedById: string | null;
};

/** E10-1: the case read names the suspender beside the id; null while nobody has. */
export type SuspensionCaseView = SuspensionView & { suspendedBy: UserLabel | null };

/** What a suspension actually did, reported back and written into the audit row. */
export type SuspensionEffects = {
  /** Listings that took a cascaded scope from their publisher. */
  cascadedListingIds: string[];
  cancelledOrderIds: string[];
  cancelledCampaignIds: string[];
  releasedOrderIds: string[];
  cancelledVisitIds: string[];
  releasedMilestoneIds: string[];
  /** Account lifecycle: an agent's open leads handed back to the pool (STOP_OPEN_WORK). */
  releasedLeadIds: string[];
  /** Account lifecycle: live access grants revoked, and whether the party's QR codes were deactivated (BLOCK_NEW / BLOCK_SIGNIN). */
  grantsRevoked: number;
  qrDeactivated: boolean;
  /** One per campaign: what the refund desk was asked for, and whether it took. */
  refunds: { campaignId: string; amount: string; requested: boolean; note?: string }[];
  walletFrozen: boolean;
  signinBlocked: boolean;
};

const noEffects = (): SuspensionEffects => ({
  cascadedListingIds: [],
  cancelledOrderIds: [],
  cancelledCampaignIds: [],
  releasedOrderIds: [],
  cancelledVisitIds: [],
  releasedMilestoneIds: [],
  releasedLeadIds: [],
  grantsRevoked: 0,
  qrDeactivated: false,
  refunds: [],
  walletFrozen: false,
  signinBlocked: false,
});

/**
 * Account lifecycle: why a step happened when it was not ops pressing
 * Suspend — recorded on the event's metadata so the reactivation can tell
 * the BLOCK_NEW a deactivation placed from one ops placed.
 */
export type SuspensionCause = 'USER_DEACTIVATED' | 'USER_REACTIVATED';
export type SuspendInput = { scopes: SuspensionScope[]; reason: string; byUserId: string; cause?: SuspensionCause };
export type ReinstateInput = { scopes?: SuspensionScope[]; reason: string; byUserId: string; cause?: SuspensionCause };

const unique = (scopes: SuspensionScope[]): SuspensionScope[] => [...new Set(scopes)];

function assertAdmitted(partyType: PartyType, scopes: SuspensionScope[]): void {
  const allowed = SCOPES_BY_PARTY[partyType];
  const rejected = scopes.filter((scope) => !allowed.includes(scope));
  if (rejected.length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `A ${partyType.toLowerCase()} cannot be suspended on ${rejected.join(', ')}`,
      { partyType, rejected, allowed }
    );
  }
}

async function requireParty(partyType: PartyType, partyId: string) {
  const party = await repository.findParty(partyType, partyId);
  if (!party) {
    throw new ApiError(404, 'NOT_FOUND', `No such ${partyType.toLowerCase()}`);
  }
  return party;
}

const viewOf = (
  partyType: PartyType,
  partyId: string,
  row: { scopes: SuspensionScope[]; suspendedAt: Date | null; suspensionReason: string | null; suspendedById: string | null }
): SuspensionView => ({
  partyType,
  partyId,
  scopes: row.scopes,
  suspendedAt: row.suspendedAt,
  suspensionReason: row.suspensionReason,
  suspendedById: row.suspendedById,
});

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const EVENT_LIMIT = 100;

/** E6: an event as the console reads it — the actor joined as `byUser`. */
export type SuspensionEventView = PartySuspensionEvent & { byUser: UserLabel };

export async function suspensionOf(
  partyType: PartyType,
  partyId: string
): Promise<SuspensionCaseView & { name: string | null; admits: readonly SuspensionScope[]; events: SuspensionEventView[] }> {
  const party = await requireParty(partyType, partyId);
  const events = await repository.listEvents(partyType, partyId, EVENT_LIMIT);
  // E6: who did it, by name — one query for the whole history through `users`;
  // E10-1: the current suspender rides the same lookup.
  const labels = await findUserLabels([...events.map((event) => event.byUserId), ...(party.suspendedById ? [party.suspendedById] : [])]);
  return {
    ...viewOf(partyType, partyId, party),
    suspendedBy: party.suspendedById ? labels.get(party.suspendedById) ?? { id: party.suspendedById, name: null } : null,
    name: party.name,
    admits: SCOPES_BY_PARTY[partyType],
    events: events.map((event) => ({
      ...event,
      byUser: labels.get(event.byUserId) ?? { id: event.byUserId, name: null },
    })),
  };
}

/**
 * Whether one section of one party is suspended.
 *
 * The narrow read other modules use when they want the answer rather than the
 * whole case — a gate that has the id in its hand and only needs a yes or no.
 */
export async function isSuspended(
  partyType: PartyType,
  partyId: string,
  scope: SuspensionScope
): Promise<boolean> {
  const party = await repository.findParty(partyType, partyId);
  return Boolean(party?.scopes.includes(scope));
}

/* ------------------------------------------------------------------ */
/* Suspending                                                          */
/* ------------------------------------------------------------------ */

export async function suspendParty(
  partyType: PartyType,
  partyId: string,
  input: SuspendInput
): Promise<SuspensionView & { effects: SuspensionEffects }> {
  const scopes = unique(input.scopes);
  if (scopes.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Name at least one section to suspend');
  }
  assertAdmitted(partyType, scopes);

  const party = await requireParty(partyType, partyId);
  const before = party.scopes;
  const added = scopes.filter((scope) => !before.includes(scope));
  const next = unique([...before, ...scopes]);
  const at = new Date();

  await repository.setScopes(partyType, partyId, {
    scopes: next,
    // The date and the reason belong to the case, not to the last step: an
    // existing suspension keeps the moment it started.
    suspendedAt: party.suspendedAt ?? at,
    suspensionReason: party.suspensionReason ?? input.reason,
    suspendedById: party.suspendedById ?? input.byUserId,
  });

  await repository.createEvent({
    partyType,
    partyId,
    action: 'SUSPEND',
    scopes,
    reason: input.reason,
    byUserId: input.byUserId,
    at,
    ...(input.cause ? { metadata: { cause: input.cause, added } } : {}),
  });

  const effects = await applySuspension(partyType, party, scopes, input, at);

  await logActivity(input.byUserId, ACTIONS[partyType].suspended, {
    targetType: ACTIONS[partyType].model,
    targetId: partyId,
    module: 'suspension',
    diff: { suspensionScopes: { before, after: next } },
    metadata: {
      reason: input.reason,
      requested: scopes,
      added,
      // Read back by the reinstatement: the schema has no place for it on the
      // event, and the trail is the record that already survives everything.
      priorStatus: party.status,
      effects,
    },
  });

  await notifyParty(party.userId, {
    title: suspensionTitle(partyType, scopes),
    message: `${scopeWords(scopes)} ${scopes.length === 1 ? 'has' : 'have'} been suspended. Reason: ${input.reason}`,
  });

  const after = await requireParty(partyType, partyId);
  return { ...viewOf(partyType, partyId, after), effects };
}

/* ------------------------------------------------------------------ */
/* Reinstating                                                         */
/* ------------------------------------------------------------------ */

/**
 * Lifts scopes. With none named it lifts everything, which is what "reinstate"
 * means on a screen with one button; with scopes named it lifts only those, so
 * a wallet can be thawed while the listings stay blocked.
 */
export async function reinstateParty(
  partyType: PartyType,
  partyId: string,
  input: ReinstateInput
): Promise<SuspensionView & { lifted: SuspensionScope[] }> {
  const requested = unique(input.scopes ?? []);
  if (requested.length > 0) assertAdmitted(partyType, requested);

  const party = await requireParty(partyType, partyId);
  const before = party.scopes;
  const lifted = requested.length === 0 ? before : requested.filter((scope) => before.includes(scope));
  const next = before.filter((scope) => !lifted.includes(scope));

  // Account lifecycle (2 Oct 2026): a closed account never signs in again —
  // lifting its sign-in block is refused before anything is written.
  if (lifted.includes('BLOCK_SIGNIN') && party.userId) assertNotClosed(await accountClosedAt(party.userId));

  await repository.setScopes(partyType, partyId, {
    scopes: next,
    // The CHECK on each table ties the three columns to the scope list: no
    // scopes means no reason and no date, and a partial lift keeps both.
    suspendedAt: next.length === 0 ? null : party.suspendedAt,
    suspensionReason: next.length === 0 ? null : party.suspensionReason,
    suspendedById: next.length === 0 ? null : party.suspendedById,
  });

  await repository.createEvent({
    partyType,
    partyId,
    action: 'REINSTATE',
    scopes: lifted,
    reason: input.reason,
    byUserId: input.byUserId,
    ...(input.cause ? { metadata: { cause: input.cause } } : {}),
  });

  await applyReinstatement(partyType, party, lifted, input);

  await logActivity(input.byUserId, ACTIONS[partyType].reinstated, {
    targetType: ACTIONS[partyType].model,
    targetId: partyId,
    module: 'suspension',
    diff: { suspensionScopes: { before, after: next } },
    metadata: { reason: input.reason, lifted },
  });

  await notifyParty(party.userId, {
    title: `${partyLabel(partyType)} reinstated`,
    message: `${scopeWords(lifted)} ${lifted.length === 1 ? 'has' : 'have'} been reinstated. Reason: ${input.reason}`,
  });

  const after = await requireParty(partyType, partyId);
  return { ...viewOf(partyType, partyId, after), lifted };
}

/* ------------------------------------------------------------------ */
/* Consequences                                                        */
/* ------------------------------------------------------------------ */

async function applySuspension(
  partyType: PartyType,
  party: Awaited<ReturnType<typeof requireParty>>,
  scopes: SuspensionScope[],
  input: SuspendInput,
  at: Date
): Promise<SuspensionEffects> {
  const effects = noEffects();

  if (partyType === 'LISTING') {
    if (scopes.includes('BLOCK_NEW') && party.status !== 'SUSPENDED') {
      await repository.setListingStatus(party.id, 'SUSPENDED');
    }
    if (scopes.includes('STOP_OPEN_WORK')) {
      await stopWorkOnListings([party.id], input, effects, 'PUBLISHER_WITHDREW');
    }
  }

  if (partyType === 'PUBLISHER') {
    // BLOCK_NEW and STOP_ACCRUAL cascade onto the spots: the booking gate and
    // the accrual run both read a listing, and cascading is what lets them
    // keep reading one thing rather than two.
    const cascading: SuspensionScope[] = scopes.filter(
      (scope) => scope === 'BLOCK_NEW' || scope === 'STOP_ACCRUAL'
    );
    if (cascading.length > 0) {
      const listings = await repository.listingsForPublisher(party.id);
      for (const listing of listings) {
        const nextScopes = unique([...listing.scopes, ...cascading]);
        if (nextScopes.length === listing.scopes.length) continue;
        await repository.setScopes('LISTING', listing.id, {
          scopes: nextScopes,
          suspendedAt: at,
          suspensionReason: input.reason,
          suspendedById: input.byUserId,
        });
        if (cascading.includes('BLOCK_NEW') && listing.status !== 'SUSPENDED') {
          await repository.setListingStatus(listing.id, 'SUSPENDED');
        }
        await repository.createEvent({
          partyType: 'LISTING',
          partyId: listing.id,
          action: 'SUSPEND',
          scopes: cascading,
          reason: `Cascade from publisher suspension: ${input.reason}`,
          byUserId: input.byUserId,
          at,
        });
        effects.cascadedListingIds.push(listing.id);
      }
    }
    if (scopes.includes('STOP_OPEN_WORK')) {
      const listings = await repository.listingsForPublisher(party.id);
      await stopWorkOnListings(
        listings.map((listing) => listing.id),
        input,
        effects,
        'PUBLISHER_WITHDREW'
      );
    }
  }

  if (partyType === 'ADVERTISER' && scopes.includes('STOP_OPEN_WORK')) {
    const refunds = await cancelAdvertiserCampaigns(party.id, `Advertiser suspended: ${input.reason}`);
    effects.cancelledCampaignIds.push(...refunds.map((refund) => refund.campaignId));
    await raiseRefunds(refunds, input, effects, 'OTHER');
  }

  if (partyType === 'AGENT') {
    if (scopes.includes('BLOCK_NEW') && party.status !== 'SUSPENDED') {
      await repository.setAgentStatus(party.id, 'SUSPENDED');
    }
    if (scopes.includes('STOP_OPEN_WORK')) {
      effects.releasedOrderIds.push(...(await releaseAgentOffers(party.id, 'SUSPENDED')));
      effects.cancelledVisitIds.push(...(await cancelAgentVisits(party.id, 'SUSPENDED')));
      effects.releasedMilestoneIds.push(...(await releaseAgentMilestones(party.id, 'SUSPENDED')));
      // Account lifecycle (2 Oct 2026): and the leads they hold go back to the pool.
      effects.releasedLeadIds.push(
        ...(await releaseLeadsHeldBy(party.id, `Agent suspended: ${input.reason}`, at).catch((err) => {
          logger.warn('Suspension could not release the agent\'s leads', { agentId: party.id, err: String(err) });
          return [] as string[];
        })),
      );
    }
  }

  // Account lifecycle (2 Oct 2026): nothing new and no sign-in means no way
  // in on somebody else's authority either — the grants close and the codes go.
  if (partyType !== 'LISTING' && (scopes.includes('BLOCK_NEW') || scopes.includes('BLOCK_SIGNIN'))) {
    await closeDoors(partyType, party.id, input.byUserId, effects);
  }

  if (scopes.includes('FREEZE_WALLET')) {
    const owner = walletOwnerFor(partyType, party.id);
    if (owner) {
      const wallet = await freezeWallet(owner, { reason: input.reason, byUserId: input.byUserId, at });
      effects.walletFrozen = wallet !== null;
    }
  }

  if (scopes.includes('BLOCK_SIGNIN') && party.userId) {
    await repository.setUserActive(party.userId, false);
    // `revokeSessions` takes the refresh tokens AND writes the revocation
    // marker `authenticate()` reads, so an access token already in flight
    // stops working now rather than at its next refresh.
    await revokeSessions(party.userId, 'SUSPENDED');
    effects.signinBlocked = true;
  }

  return effects;
}

async function applyReinstatement(
  partyType: PartyType,
  party: Awaited<ReturnType<typeof requireParty>>,
  lifted: SuspensionScope[],
  input: ReinstateInput
): Promise<void> {
  if (partyType === 'LISTING' && lifted.includes('BLOCK_NEW')) {
    await restoreListing(party.id, party.publishedAt, party.verificationExpiresAt);
  }

  if (partyType === 'PUBLISHER') {
    const cascading: SuspensionScope[] = lifted.filter(
      (scope) => scope === 'BLOCK_NEW' || scope === 'STOP_ACCRUAL'
    );
    if (cascading.length > 0) {
      const listings = await repository.listingsForPublisher(party.id);
      for (const listing of listings) {
        const next = listing.scopes.filter((scope) => !cascading.includes(scope));
        if (next.length === listing.scopes.length) continue;
        await repository.setScopes('LISTING', listing.id, {
          scopes: next,
          suspendedAt: next.length === 0 ? null : new Date(),
          suspensionReason: next.length === 0 ? null : input.reason,
          suspendedById: next.length === 0 ? null : input.byUserId,
        });
        await repository.createEvent({
          partyType: 'LISTING',
          partyId: listing.id,
          action: 'REINSTATE',
          scopes: cascading,
          reason: `Cascade from publisher reinstatement: ${input.reason}`,
          byUserId: input.byUserId,
        });
        if (cascading.includes('BLOCK_NEW')) {
          const row = await repository.findParty('LISTING', listing.id);
          if (row) await restoreListing(row.id, row.publishedAt, row.verificationExpiresAt);
        }
      }
    }
  }

  if (partyType === 'AGENT' && lifted.includes('BLOCK_NEW')) {
    await repository.setAgentStatus(party.id, await priorAgentStatus(party.id));
  }

  if (lifted.includes('FREEZE_WALLET')) {
    const owner = walletOwnerFor(partyType, party.id);
    if (owner) await unfreezeWallet(owner);
  }

  if (lifted.includes('BLOCK_SIGNIN') && party.userId) {
    await repository.setUserActive(party.userId, true);
  }
}

/**
 * Account lifecycle (2 Oct 2026): the live access grants and the QR codes of
 * a party blocked from new work or from signing in. An agent's own grants
 * (the accounts they were lent) close; a publisher's or advertiser's grants
 * are the ones ON their account. Never fails the suspension — a door left
 * open is logged for ops, and the suspension still stands.
 */
async function closeDoors(
  partyType: Exclude<PartyType, 'LISTING'>,
  partyId: string,
  byUserId: string,
  effects: SuspensionEffects,
): Promise<void> {
  try {
    effects.grantsRevoked +=
      partyType === 'AGENT'
        ? await revokeLiveGrantsForAgent(partyId, byUserId)
        : await revokeLiveGrantsOnParty(partyType === 'PUBLISHER' ? { publisherId: partyId } : { advertiserId: partyId }, byUserId);
  } catch (err) {
    logger.warn('Suspension could not revoke the live access grants', { partyType, partyId, err: String(err) });
  }
  try {
    await deactivateQrsFor(partyType, partyId);
    effects.qrDeactivated = true;
  } catch (err) {
    logger.warn('Suspension could not deactivate the QR codes', { partyType, partyId, err: String(err) });
  }
}

/* ------------------------------------------------------------------ */
/* A user deactivation and its reactivation                            */
/* ------------------------------------------------------------------ */

const DEACTIVATION_SCOPES: SuspensionScope[] = ['BLOCK_NEW'];

/**
 * Account lifecycle (2 Oct 2026): "Deactivate" on a user also stops their
 * publisher, advertiser and agent profiles taking new work — listings stop
 * being bookable, campaigns do not start, no offer reaches the agent. Each is
 * an ordinary BLOCK_NEW suspension, with `cause: USER_DEACTIVATED` on its
 * event; a profile already blocked from new work is left alone, so the
 * reactivation never lifts a block somebody else placed.
 */
export async function suspendForUserDeactivation(
  userId: string,
  byUserId: string,
  reason = 'The account was deactivated',
): Promise<{ partyType: PartyType; partyId: string }[]> {
  const suspended: { partyType: PartyType; partyId: string }[] = [];
  for (const { partyType, partyId } of await repository.partiesOfUser(userId)) {
    const party = await repository.findParty(partyType, partyId);
    if (!party || DEACTIVATION_SCOPES.every((scope) => party.scopes.includes(scope))) continue;
    await suspendParty(partyType, partyId, { scopes: DEACTIVATION_SCOPES, reason, byUserId, cause: 'USER_DEACTIVATED' });
    suspended.push({ partyType, partyId });
  }
  return suspended;
}

/**
 * The reactivation's half: lifts BLOCK_NEW from each profile only where the
 * newest event that touched BLOCK_NEW is the deactivation's own suspension.
 * A later reinstatement means there is nothing to lift; a later (or earlier,
 * un-lifted) suspension by ops means the block is theirs and stays.
 */
export async function reinstateAfterUserReactivation(
  userId: string,
  byUserId: string,
  reason = 'The account was reactivated',
): Promise<{ partyType: PartyType; partyId: string }[]> {
  const reinstated: { partyType: PartyType; partyId: string }[] = [];
  for (const { partyType, partyId } of await repository.partiesOfUser(userId)) {
    const party = await repository.findParty(partyType, partyId);
    if (!party?.scopes.includes('BLOCK_NEW')) continue;
    const events = await repository.listEvents(partyType, partyId, EVENT_LIMIT);
    const last = events.find((event) => event.scopes.includes('BLOCK_NEW'));
    const cause = (last?.metadata as { cause?: unknown } | null | undefined)?.cause;
    if (last?.action !== 'SUSPEND' || cause !== 'USER_DEACTIVATED') continue;
    await reinstateParty(partyType, partyId, { scopes: DEACTIVATION_SCOPES, reason, byUserId, cause: 'USER_REACTIVATED' });
    reinstated.push({ partyType, partyId });
  }
  return reinstated;
}

/**
 * Cancels every open order on these spots and asks the refund desk for the
 * unused days, one request per campaign.
 *
 * The cancel goes through the order module's own path, so the listing is freed
 * and the three parties are told, exactly as an ordinary cancellation does.
 */
async function stopWorkOnListings(
  listingIds: string[],
  input: SuspendInput,
  effects: SuspensionEffects,
  reason: 'PUBLISHER_WITHDREW' | 'OTHER'
): Promise<void> {
  if (listingIds.length === 0) return;
  const open = await findOpenOrdersForListings(listingIds);
  for (const order of open) {
    await cancelOrder(order.id, `Suspended: ${input.reason}`).catch((err) =>
      logger.warn('Suspension could not cancel an order', { orderId: order.id, err: String(err) })
    );
    effects.cancelledOrderIds.push(order.id);
  }
  const refunds = await cancelSpotsForOrders(effects.cancelledOrderIds);
  await raiseRefunds(refunds, input, effects, reason);
}

/**
 * One refund request per campaign, through the ordinary support path.
 *
 * Never a wallet write: the request freezes the amount and a second admin
 * decides it. A request that cannot be raised — one is already open, or the
 * cap is lower than what was lost — is recorded as a note on the suspension
 * rather than swallowed, so ops has something to act on.
 */
async function raiseRefunds(
  refunds: CampaignRefund[],
  input: SuspendInput,
  effects: SuspensionEffects,
  reason: 'PUBLISHER_WITHDREW' | 'OTHER'
): Promise<void> {
  for (const refund of refunds) {
    if (!refund.refundNeeded || Number(refund.amount) <= 0) {
      effects.refunds.push({
        campaignId: refund.campaignId,
        amount: refund.amount,
        requested: false,
        note: refund.refundNeeded ? 'Nothing unused to refund' : 'Held money released, no refund needed',
      });
      continue;
    }
    try {
      await requestRefund(
        refund.advertiserId,
        {
          amount: refund.amount,
          reason,
          note: `Campaign ${refund.reference} stopped by suspension: ${input.reason}`,
        },
        input.byUserId
      );
      effects.refunds.push({ campaignId: refund.campaignId, amount: refund.amount, requested: true });
    } catch (error) {
      const note = error instanceof ApiError ? error.message : 'Refund request failed';
      logger.warn('Suspension could not raise a refund request', {
        campaignId: refund.campaignId,
        amount: refund.amount,
        note,
      });
      effects.refunds.push({ campaignId: refund.campaignId, amount: refund.amount, requested: false, note });
    }
  }
}

/**
 * What a listing goes back to when BLOCK_NEW is lifted.
 *
 * ACTIVE only when the spot was on the marketplace and its verification has
 * not lapsed; otherwise it stays SUSPENDED and the supply funnel decides,
 * because a listing whose verification expired while it was suspended must not
 * be let back on by a reinstatement that was only about the booking block.
 */
async function restoreListing(
  listingId: string,
  publishedAt: Date | null,
  verificationExpiresAt: Date | null,
  now = new Date()
): Promise<void> {
  const verified = !verificationExpiresAt || verificationExpiresAt > now;
  if (publishedAt && verified) await repository.setListingStatus(listingId, 'ACTIVE');
}

/**
 * The status an agent had before they were suspended.
 *
 * Read back from the audit trail, which is where the suspension recorded it:
 * `PartySuspensionEvent` has no metadata column, and an agent who was ON_LEAVE
 * must not come back ACTIVE and start being offered work they are away from.
 * ACTIVE when nothing says otherwise.
 */
async function priorAgentStatus(agentId: string): Promise<'ACTIVE' | 'ON_LEAVE'> {
  const trail = await findActivity(
    { action: 'AGENT_SUSPENDED', targetType: 'AgentProfile', targetId: agentId },
    { page: 1, pageSize: 1, sort: 'newest' }
  ).catch(() => null);
  const metadata = trail?.items[0]?.metadata as { priorStatus?: unknown } | null | undefined;
  return metadata?.priorStatus === 'ON_LEAVE' ? 'ON_LEAVE' : 'ACTIVE';
}

function walletOwnerFor(
  partyType: PartyType,
  partyId: string
): { kind: 'PUBLISHER' | 'AGENT' | 'ADVERTISER'; id: string } | null {
  switch (partyType) {
    case 'PUBLISHER':
      return { kind: 'PUBLISHER', id: partyId };
    case 'ADVERTISER':
      return { kind: 'ADVERTISER', id: partyId };
    case 'AGENT':
      return { kind: 'AGENT', id: partyId };
    default:
      // A listing has no wallet, and the scope list already refuses it here.
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

const SCOPE_WORDS: Record<SuspensionScope, string> = {
  BLOCK_NEW: 'New work',
  STOP_OPEN_WORK: 'Work in progress',
  STOP_ACCRUAL: 'Daily earnings',
  FREEZE_WALLET: 'Wallet withdrawals',
  BLOCK_SIGNIN: 'Sign-in',
};

const partyLabel = (partyType: PartyType): string =>
  partyType === 'AGENT' ? 'Agent' : partyType.charAt(0) + partyType.slice(1).toLowerCase();

export const scopeWords = (scopes: SuspensionScope[]): string =>
  scopes.length === 0 ? 'Nothing' : scopes.map((scope) => SCOPE_WORDS[scope]).join(', ');

const suspensionTitle = (partyType: PartyType, scopes: SuspensionScope[]): string =>
  scopes.length === SCOPES_BY_PARTY[partyType].length
    ? `${partyLabel(partyType)} suspended`
    : `${partyLabel(partyType)} partially suspended`;

/** Never fails the suspension: an undelivered notice is not a reason to leave a party running. */
async function notifyParty(
  userId: string | null,
  message: { title: string; message: string }
): Promise<void> {
  if (!userId) return;
  await createNotification({
    userId,
    type: 'SYSTEM',
    title: message.title,
    message: message.message,
    suggestedAction: 'Contact ADX support',
  }).catch((err) => logger.warn('Suspension notice not delivered', { userId, err: String(err) }));
}
