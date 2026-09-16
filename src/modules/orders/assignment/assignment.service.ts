import { logger } from '../../../shared/logging';
import { priorityOf, priorityWindowStart, type OfferPriority } from '../../../shared/dispatch';
import { Decimal } from '../../../shared/money';
import { agentAcceptsWork, assertAgentAcceptsWork, findAgentTier, findAssignableAgent, getAgentWithUser, getAgentZone, type AgentZone } from '../../agents';
import { recordAcceptance } from '../../agreements';
import { getListingWithPublisher } from '../../listings';
import { installationFeeFor } from '../../payouts';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, notifyAgent, shortId } from '../orders.notify';
import { OFFER_EXPIRED_REASON } from './rejection-reasons';

const MAX_AGENT_REJECTIONS = 3;

/**
 * How long an agent has to answer an offer before it is theirs to lose.
 *
 * Twenty-five minutes — the number DR 01 prints over the accept button
 * ("Expires in 25 Minutes"), kept here once so the sheet, the countdown and
 * the sweep all read the same figure. It used to be thirty, matched to the
 * publisher's window, while the sheet said twenty-five: two numbers for one
 * promise, and the one the agent could see was the wrong one.
 *
 * The stamp is enforced now. `agentAcceptOrder` refuses a tap after it, and
 * `expireAgentOffers` (run every minute by jobs/agent-timer) records the
 * silence as EXPIRED and offers the job to the next agent — the same re-offer
 * a rejection triggers, escalating to ops after three.
 */
export const AGENT_RESPONSE_WINDOW_MINUTES = 25;
export const AGENT_RESPONSE_WINDOW_MS = AGENT_RESPONSE_WINDOW_MINUTES * 60 * 1000;

/** When an offer made now stops being fresh. */
const agentDeadline = () => new Date(Date.now() + AGENT_RESPONSE_WINDOW_MS);

/**
 * Lot B (Q102): the installation figure the offer sheet shows, resolved now
 * and copied onto the assignment — so a rate change or a mode switch after
 * the agent accepted cannot re-price the job. Priced at the candidate's tier.
 *
 * Null when it cannot be priced. The offer still goes out: an agent with no
 * figure on the sheet is a smaller failure than an order nobody is offered.
 */
async function quoteFeeFor(
  order: { agentFeeAmount: Decimal | null },
  agentId: string,
): Promise<Decimal | null> {
  try {
    const tier = (await findAgentTier(agentId)) ?? '*';
    const fee = await installationFeeFor(order, tier);
    return fee === null ? null : new Decimal(fee);
  } catch (err) {
    logger.warn('Could not price the installation offer', { orderId: (order as { id?: string }).id, agentId, err });
    return null;
  }
}

/**
 * Picks an agent for an order and offers it to them.
 *
 * Priority 1 is the agent who onboarded the publisher — they already know the
 * site. Priority 2 is any active agent-publisher who has not already rejected
 * this order. After three rejections the order is escalated to admins instead
 * of cycling forever.
 *
 * Deliberately returns rather than throws: it runs fire-and-forget behind
 * print-ready and agent rejection, so a failure must not fail those.
 */
export async function autoAssignAgent(orderId: string) {
  const order = await repository.findById(orderId);
  if (!order) return;

  const assignments = await repository.findAssignments(orderId);
  const rejectedAgentIds = assignments
    .filter((a) => a.status === 'REJECTED')
    .map((a) => a.agentId);

  if (order.agentRejectionCount >= MAX_AGENT_REJECTIONS) {
    await repository.update(orderId, { agentEscalated: true });
    await notifyAdmins(
      'Order escalated — manual agent assignment needed',
      `Order ${shortId(orderId)} rejected by 3 agents.`,
      orderId,
    );
    logger.warn('Order escalated after 3 rejections', { orderId });
    return;
  }

  const listing = await getListingWithPublisher(order.listingId);
  const publisherAgentId = listing?.publisher?.agentId;

  let candidateId: string | null = null;
  // Lot A BLOCK_NEW: the agent who onboarded the publisher keeps priority only
  // while they are being offered work at all. A suspended one falls through to
  // the ordinary sweep, which skips them too.
  const publisherAgentAccepts =
    publisherAgentId && !rejectedAgentIds.includes(publisherAgentId)
      ? await agentAcceptsWork(publisherAgentId)
      : false;
  if (publisherAgentId && publisherAgentAccepts) {
    candidateId = publisherAgentId;
  } else {
    const candidate = await findAssignableAgent(rejectedAgentIds);
    candidateId = candidate?.id ?? null;
  }

  if (!candidateId) {
    logger.warn('No eligible agent for auto-assignment', { orderId });
    return;
  }

  await repository.createAssignment(orderId, candidateId, await quoteFeeFor(order, candidateId));
  await repository.update(orderId, {
    agentId: candidateId,
    agentTimerExpiry: agentDeadline(),
  });

  // DR 07's "Auto-accept in my zone": a spot in the agent's own zone is
  // theirs without the sheet. The offer is still recorded and answered — the
  // same rows, the same transition — so the history reads true.
  const zone = await getAgentZone(candidateId);
  const spot = listing ? { city: listing.city ?? null, address: listing.address ?? null } : null;
  if (zone?.autoAcceptInZone && spot && inZone(zone, spot)) {
    const assignment = await repository.findPendingAssignment(orderId, candidateId);
    if (assignment) {
      await repository.acceptAssignment(assignment.id, orderId, candidateId);
      await notifyAgent(
        candidateId,
        'Order accepted for you',
        `Order ${shortId(orderId)} is in your zone and was accepted for you. Propose a pickup time.`,
        orderId,
      );
      logger.info('Agent auto-accepted in zone', { orderId, agentId: candidateId });
      return;
    }
  }

  const agent = await getAgentWithUser(candidateId);
  if (agent) {
    await notifyAgent(
      candidateId,
      'New order assigned',
      `Order ${shortId(orderId)} has been assigned to you.`,
      orderId,
    );
  }

  logger.info('Agent auto-assigned', { orderId, agentId: candidateId });
}

/**
 * Whether a spot is in the agent's zone: the same city, and — when the agent
 * named a home zone — that zone named in the spot's address or city. A plain
 * word match, on purpose: nothing here maps zones to polygons, and a rule
 * that guessed would accept work the agent never meant to take.
 */
export function inZone(zone: AgentZone, spot: { city: string | null; address: string | null }): boolean {
  const norm = (value: string | null) => (value ?? '').trim().toLowerCase();
  if (!zone.city || norm(zone.city) !== norm(spot.city)) return false;
  if (!zone.homeZone) return true;
  const home = norm(zone.homeZone);
  return norm(spot.address).includes(home) || norm(spot.city).includes(home);
}

/**
 * Every offer an agent has had, folded for ops: how many were accepted,
 * declined by which of the five reasons, or left to expire. DR 07's rating
 * screen tells agents "frequent rejections lower your offer priority" — this
 * is the count behind that sentence, on the console's agent page.
 */
export type AgentOfferHistory = {
  offered: number;
  accepted: number;
  pending: number;
  declined: number;
  expired: number;
  /** Lot D (Q90): taken off them by ops — not a refusal, so not counted as one. */
  reassigned: number;
  byReason: Record<string, number>;
  /** DR 07's lane, over the last thirty days of these rows — the sweep's own rule. */
  priority: OfferPriority;
  recent: { orderId: string; status: string; reason: string | null; assignedAt: string; respondedAt: string | null }[];
};

export function foldOffers(
  rows: { orderId: string; status: string; rejectionReason: string | null; assignedAt: Date; respondedAt: Date | null }[],
  now: Date = new Date(),
): AgentOfferHistory {
  const byReason: Record<string, number> = {};
  let accepted = 0;
  let pending = 0;
  let declined = 0;
  let expired = 0;
  let reassigned = 0;
  for (const row of rows) {
    if (row.status === 'ACCEPTED') accepted += 1;
    else if (row.status === 'PENDING') pending += 1;
    else if (row.status === 'REASSIGNED') reassigned += 1;
    else if (row.rejectionReason === OFFER_EXPIRED_REASON) expired += 1;
    else {
      declined += 1;
      const code = (row.rejectionReason ?? 'OTHER').split(':')[0]!.trim();
      byReason[code] = (byReason[code] ?? 0) + 1;
    }
  }
  const windowStart = priorityWindowStart(now).getTime();
  return {
    offered: rows.length,
    accepted,
    pending,
    declined,
    expired,
    reassigned,
    byReason,
    priority: priorityOf(rows.filter((row) => row.assignedAt.getTime() >= windowStart && row.status !== 'REASSIGNED')),
    recent: rows.slice(0, 20).map((row) => ({
      orderId: row.orderId,
      status: row.status,
      reason: row.rejectionReason,
      assignedAt: row.assignedAt.toISOString(),
      respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    })),
  };
}

export async function agentOfferHistory(agentId: string): Promise<AgentOfferHistory> {
  return foldOffers(await repository.findAssignmentsForAgent(agentId));
}

/**
 * The agent's tap on Accept.
 *
 * Lot D (Q123): the tap is also the agent's acceptance of the job terms —
 * the live JOB_TERMS version, recorded against the agent's own profile and
 * user in the same call, once per order per version. Never on their behalf:
 * the user is resolved from the profile, not taken from a body, and nothing
 * else records this kind. No published job terms refuses the tap with
 * NO_ACTIVE_TEMPLATE, the same stall the other parties meet, because a job
 * taken under no terms binds nobody. `ctx` is the click's provenance.
 */
export async function agentAcceptOrder(
  orderId: string,
  agentProfileId: string,
  ctx: { ipAddress?: string | null; userAgent?: string | null } = {},
) {
  const assignment = await repository.findPendingAssignment(orderId, agentProfileId);
  if (!assignment) throw new Error('ASSIGNMENT_NOT_FOUND');

  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');
  // The clock on the sheet is the clock ADX keeps: a late tap is refused, and
  // the sweep will have handed the job on. An offer placed by hand carries no
  // stamp and can always be taken.
  if (order.agentTimerExpiry && order.agentTimerExpiry.getTime() < Date.now()) {
    throw new Error('OFFER_EXPIRED');
  }

  const agent = await getAgentWithUser(agentProfileId);
  if (!agent) throw new Error('ASSIGNMENT_NOT_FOUND');
  await recordAcceptance({
    kind: 'JOB_TERMS',
    party: { agentId: agentProfileId },
    anchor: { orderId },
    ctx: { acceptedByUserId: agent.userId, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null },
  });

  await repository.acceptAssignment(assignment.id, orderId, agentProfileId);

  return repository.findById(orderId);
}

/**
 * Offers whose window closed inside [windowStart, now) and are still waiting
 * on the agent: recorded as EXPIRED on the assignment and re-offered, exactly
 * as a rejection would be. Returns the ids swept, for the job's log.
 *
 * An agent who answered between the stamp and the tick has no pending
 * assignment any more, and is left alone.
 */
export async function expireAgentOffers(windowStart: Date, now: Date): Promise<string[]> {
  const lapsed = await repository.findAgentTimerExpired(windowStart, now);
  const swept: string[] = [];
  for (const { id, agentId } of lapsed) {
    if (!agentId) continue;
    const assignment = await repository.findPendingAssignment(id, agentId);
    if (!assignment) continue;
    await repository.rejectAssignment(assignment.id, id, OFFER_EXPIRED_REASON);
    swept.push(id);
    await autoAssignAgent(id).catch((err) =>
      logger.error('autoAssignAgent after expiry failed', { orderId: id, err }),
    );
  }
  return swept;
}

export async function agentRejectOrder(
  orderId: string,
  agentProfileId: string,
  reason?: string,
) {
  const assignment = await repository.findPendingAssignment(orderId, agentProfileId);
  if (!assignment) throw new Error('ASSIGNMENT_NOT_FOUND');

  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  await repository.rejectAssignment(assignment.id, orderId, reason);

  autoAssignAgent(orderId).catch((err) =>
    logger.error('autoAssignAgent re-assign failed', { orderId, err }),
  );

  return repository.findById(orderId);
}

/**
 * Lot A STOP_OPEN_WORK on an agent: every offer they have not answered is
 * handed back with the given reason and re-offered through the ordinary
 * re-assignment path — the same rows and the same transition a rejection
 * writes, so the history reads true and no order is left holding a suspended
 * agent. Returns the order ids released, for the suspension record.
 */
export async function releaseAgentOffers(agentProfileId: string, reason: string): Promise<string[]> {
  const pending = await repository.findPendingAssignmentsForAgent(agentProfileId);
  const released: string[] = [];
  for (const assignment of pending) {
    await repository.rejectAssignment(assignment.id, assignment.orderId, reason);
    released.push(assignment.orderId);
    await autoAssignAgent(assignment.orderId).catch((err) =>
      logger.error('autoAssignAgent after suspension failed', { orderId: assignment.orderId, err }),
    );
  }
  return released;
}

/**
 * Admin override — clears the escalation flag the auto-assigner may have set.
 *
 * `agentFee` (Lot B, Q102) is the per-order figure ops typed on the assign
 * sheet. It lands on the order first, so the quote resolved for this offer
 * reads it when the platform is on PER_ORDER.
 */
export async function adminAssignAgent(
  orderId: string,
  agentProfileId: string,
  options: { agentFee?: string | null } = {},
) {
  let order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  if (options.agentFee !== undefined && options.agentFee !== null) {
    order = await repository.update(orderId, { agentFeeAmount: new Decimal(options.agentFee) });
  }

  await repository.createAssignment(orderId, agentProfileId, await quoteFeeFor(order, agentProfileId));
  await repository.update(orderId, {
    agentId: agentProfileId,
    agentEscalated: false,
    // A hand-placed offer is still an offer, so it gets the same window.
    agentTimerExpiry: agentDeadline(),
  });

  await notifyAgent(
    agentProfileId,
    'New order assigned',
    `Order ${shortId(orderId)} has been assigned to you.`,
    orderId,
  ).catch(() => {});

  return repository.findById(orderId);
}

/** Where ops may still move the job to another agent: an offer out, or a job accepted but not yet proved. */
export const REASSIGNABLE_STATUSES = ['PENDING_AGENT', 'AGENT_REJECTED', 'SLOT_PROPOSED', 'SLOT_CONFIRMED', 'IN_PROGRESS'] as const;

/**
 * Lot D (Q51/Q90): ops moves the order to another agent.
 *
 * From any state before the proof — an offer nobody has answered, a job
 * accepted and then abandoned, an agent who has collected the prints and gone
 * quiet. The assignment the current agent holds is closed as REASSIGNED (not a
 * refusal, so it neither bumps the strike count nor lowers their priority),
 * and the new agent gets the same 25-minute offer any offer carries — the
 * order returns to PENDING_AGENT and walks the ordinary path from there, the
 * slot negotiation included, because the new agent's diary is not the old
 * one's. Both agents are told. Never past IN_PROGRESS: the OTP and the
 * photographs are the old agent's proof, and nobody else can give them.
 */
export async function reassignAgent(orderId: string, newAgentId: string, reason: string) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (!(REASSIGNABLE_STATUSES as readonly string[]).includes(order.status)) throw new Error('WRONG_STATUS');
  if (order.agentId === newAgentId) throw new Error('SAME_AGENT');
  // Lot A BLOCK_NEW: a hand-placed offer is still new work.
  await assertAgentAcceptsWork(newAgentId);

  const previousAgentId = order.agentId;
  if (previousAgentId) {
    const current = await repository.findCurrentAssignment(orderId, previousAgentId);
    if (current) await repository.reassignAssignment(current.id, reason);
  }

  await repository.createAssignment(orderId, newAgentId, await quoteFeeFor(order, newAgentId));
  await repository.update(orderId, {
    status: 'PENDING_AGENT',
    agentId: newAgentId,
    agentEscalated: false,
    agentTimerExpiry: agentDeadline(),
    // The old agent's slot is not the new agent's; the negotiation starts over.
    slotTime: null,
    slotProposedAt: null,
    slotConfirmedAt: null,
  });

  await Promise.all([
    previousAgentId
      ? notifyAgent(
          previousAgentId,
          'Order reassigned',
          `Order ${shortId(orderId)} has been reassigned by ADX. Reason: ${reason}`,
          orderId,
        )
      : Promise.resolve(),
    notifyAgent(newAgentId, 'New order assigned', `Order ${shortId(orderId)} has been assigned to you.`, orderId),
  ]).catch(() => {});

  return repository.findById(orderId);
}
