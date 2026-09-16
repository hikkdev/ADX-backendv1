import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import {
  OFFER_EXPIRED_REASON,
  getAgentOrderIdsAwaitingWork,
  notifyAdmins,
  notifyAgent,
  rejectionText,
  shortId,
  slotCandidates,
  updateAgentLocation,
  type AgentRejectionReason,
  type SlotCandidate,
} from '../../orders';
import { prismaOrderMilestonesRepository as repository } from '../prisma-order-milestones.repository';
import { autoAssignMilestones, isFrozen } from '../order/order-milestones.service';
import { checkEvidence } from '../order-milestones.evidence';
import type { EvidenceInput } from '../order-milestones.types';

/**
 * Issues the plans the agent's live jobs are owed.
 *
 * `autoAssignMilestones` materialises an order's checklist from the listing's
 * plan, or the default plan for its category — and until now nothing called it,
 * which is why the whole verification lane was built, routed, and had no
 * supply: an agent saw an empty list unless ops hand-created and dispatched
 * every step.
 *
 * Issued here, lazily, rather than at the moment the agent accepts the job,
 * because the dependency only runs one way: this module reads `orders`, and
 * `orders` must never read this one. A call from the accept would be a cycle.
 * The first read of the queue is in any case the first moment the plan is
 * needed, and `autoAssignMilestones` is idempotent, so re-reading issues
 * nothing twice.
 *
 * Never a gate. Every failure is logged and swallowed: an order whose plan
 * cannot be issued — a race with a concurrent read, a plan deleted mid-flight —
 * must still leave the agent looking at the rest of their queue.
 */
async function issueOwedPlans(agentId: string): Promise<void> {
  let orders: { id: string }[];
  try {
    orders = await getAgentOrderIdsAwaitingWork(agentId);
  } catch (err) {
    logger.error('Could not read the agent’s live jobs to issue milestone plans', { agentId, err });
    return;
  }

  for (const order of orders) {
    try {
      await autoAssignMilestones(order.id);
    } catch (err) {
      logger.error('autoAssignMilestones failed', { orderId: order.id, agentId, err });
    }
  }
}

/**
 * The agent's own work queue: dispatched and in-progress milestones only.
 *
 * Reading the queue is also what issues any plan the agent's live jobs are
 * still owed — see `issueOwedPlans`.
 */
export async function getAgentMilestones(agentId: string) {
  await issueOwedPlans(agentId);
  return repository.findForAgent(agentId);
}

export async function getMilestoneDetail(milestoneId: string, agentId: string) {
  const milestone = await repository.findDetail(milestoneId);
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (milestone.assignedAgentId !== agentId) {
    throw new ApiError(403, 'FORBIDDEN', 'This milestone is not assigned to you');
  }
  return milestone;
}

/** Loads a milestone, checking assignment and that the order is still live. */
async function requireWorkableMilestone(milestoneId: string, agentId: string, verb: string) {
  const milestone = await repository.findWithOrderStatus(milestoneId);
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (milestone.assignedAgentId !== agentId) {
    throw new ApiError(403, 'FORBIDDEN', 'This milestone is not assigned to you');
  }
  // Lot D (Q54/Q92): a re-install raised by a dispute is worked on a
  // completed order — that is what it is for.
  if (isFrozen(milestone, milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', `Cannot ${verb} a milestone for a finalized order`);
  }
  return milestone;
}

export async function startMilestone(milestoneId: string, agentId: string) {
  const milestone = await requireWorkableMilestone(milestoneId, agentId, 'work on');

  // Idempotent: the agent app retries this, so a second start returns the
  // current state rather than erroring.
  if (milestone.status === 'IN_PROGRESS') return milestone;

  if (milestone.status !== 'DISPATCHED') {
    throw new ApiError(400, 'BAD_REQUEST', 'Milestone must be DISPATCHED to start');
  }
  // A12: an offer is answered before it is worked.
  if (!milestone.acceptedAt && milestone.offerExpiresAt) {
    throw new ApiError(400, 'BAD_REQUEST', 'Accept the visit before starting it');
  }

  return repository.start(milestoneId);
}

/**
 * G12-B: the agent's live position on their way to a milestone visit —
 * the same ping the order lane takes on `POST /orders/:id/update-location`.
 *
 * A milestone has no location column and is a step on exactly one order,
 * so the ping is written onto that order's agent-location columns: the
 * store the order route writes and the publisher's
 * `GET /orders/:id/agent-location` reads, which is who is waiting for the
 * agent. Only the assigned agent may send it (404 / 403 otherwise). It is a
 * ping, not a state change, so a frozen order is not refused — a re-install
 * raised on a completed order (Lot D, Q54) is worked on one.
 */
export async function shareMilestoneLocation(
  milestoneId: string,
  agentId: string,
  coords: { latitude: number; longitude: number },
): Promise<void> {
  const milestone = await repository.findWithOrderStatus(milestoneId);
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (milestone.assignedAgentId !== agentId) {
    throw new ApiError(403, 'FORBIDDEN', 'This milestone is not assigned to you');
  }
  await updateAgentLocation(milestone.orderId, coords);
}

/* ── A12: the visit as an offer ─────────────────────────────────────────
 *
 * DR 01 draws the advertiser-side lane as three sheets: the offer with
 * "Expires in 25 Minutes" and Accept / Reject (3424:26829), the reject
 * reasons (3458:28301 — the same five the order lane uses), and "Available
 * slots" (3424:26873). A milestone dispatched to an agent who is not already
 * holding the order carries the window; these are the answers to it.
 */

/** The visit is theirs — inside the window only. A second accept is a read. */
export async function acceptMilestone(milestoneId: string, agentId: string, now = new Date()) {
  const milestone = await requireWorkableMilestone(milestoneId, agentId, 'accept');
  if (milestone.status !== 'DISPATCHED') {
    throw new ApiError(400, 'BAD_REQUEST', 'Only a dispatched visit can be accepted');
  }
  if (milestone.acceptedAt) return repository.findDetail(milestoneId);
  if (milestone.offerExpiresAt && milestone.offerExpiresAt.getTime() < now.getTime()) {
    throw new ApiError(410, 'OFFER_EXPIRED', 'This visit was offered for 25 minutes and the time has passed');
  }
  return repository.accept(milestoneId, now);
}

/**
 * Declined, with one of the five coded reasons. The visit goes back to ops
 * unassigned, the reason kept on it, and every admin is told: there is no
 * auto re-offer for visits — a visit is dispatched by hand.
 */
export async function rejectMilestone(
  milestoneId: string,
  agentId: string,
  rejection: { reason: AgentRejectionReason; note?: string },
) {
  const milestone = await requireWorkableMilestone(milestoneId, agentId, 'reject');
  if (milestone.status !== 'DISPATCHED') {
    throw new ApiError(400, 'BAD_REQUEST', 'Only a dispatched visit can be declined');
  }
  const text = rejectionText(rejection.reason, rejection.note);
  const updated = await repository.reject(milestoneId, text);
  await notifyAdmins(
    'Visit needs an agent',
    `${milestone.template.title} on order ${shortId(milestone.orderId)} was declined: ${text}`,
    milestone.orderId,
  );
  return updated;
}

/** The bands to offer: the order lane's derived slots, inside the order's dates, minus the order's other visits. */
export async function milestoneSlotCandidates(
  milestoneId: string,
  agentId: string,
  now = new Date(),
): Promise<SlotCandidate[]> {
  const milestone = await requireWorkableMilestone(milestoneId, agentId, 'schedule');
  const taken = await repository.findScheduledStartsForOrder(milestone.orderId, milestoneId);
  return slotCandidates({
    now,
    from: milestone.orderRecord.startDate,
    to: milestone.orderRecord.endDate,
    taken,
  });
}

/** "Confirm schedule": one of the offered bands, on an accepted visit. Sets the due date too. */
export async function scheduleMilestone(milestoneId: string, agentId: string, start: Date, now = new Date()) {
  const milestone = await requireWorkableMilestone(milestoneId, agentId, 'schedule');
  if (milestone.status !== 'DISPATCHED') {
    throw new ApiError(400, 'BAD_REQUEST', 'Only a dispatched visit can be scheduled');
  }
  if (!milestone.acceptedAt && milestone.offerExpiresAt) {
    throw new ApiError(400, 'BAD_REQUEST', 'Accept the visit before scheduling it');
  }
  const taken = await repository.findScheduledStartsForOrder(milestone.orderId, milestoneId);
  const offered = slotCandidates({
    now,
    from: milestone.orderRecord.startDate,
    to: milestone.orderRecord.endDate,
    taken,
  });
  const chosen = offered.find((candidate) => candidate.start === start.toISOString());
  if (!chosen) throw new ApiError(400, 'VALIDATION_ERROR', 'Pick one of the offered bands');
  return repository.schedule(milestoneId, new Date(chosen.start), new Date(chosen.end));
}

/**
 * The sweep behind "Expires in 25 Minutes": offers whose window closed in the
 * last tick are declined as EXPIRED, unassigned, and both sides are told.
 * Called by jobs/agent-timer beside the order lane's own sweep.
 */
export async function expireMilestoneOffers(windowStart: Date, now: Date) {
  const expired = await repository.findOfferExpired(windowStart, now);
  for (const milestone of expired) {
    await repository.reject(milestone.id, OFFER_EXPIRED_REASON);
    await notifyAgent(
      milestone.assignedAgentId,
      'Visit offer expired',
      `The visit on order ${shortId(milestone.orderId)} was not answered in time and has gone back to ADX.`,
      milestone.orderId,
    );
    await notifyAdmins(
      'Visit offer expired',
      `The visit on order ${shortId(milestone.orderId)} was not answered in 25 minutes and needs an agent.`,
      milestone.orderId,
    );
  }
  return expired;
}

/**
 * Lot A STOP_OPEN_WORK on an agent: every milestone dispatched to them goes
 * back to PENDING and unassigned, through the same `reject` the expiry sweep
 * uses — so ADX can dispatch it to somebody else and the reason is on the row.
 * Milestones already in progress or complete are left alone: the work happened.
 */
export async function releaseAgentMilestones(agentId: string, reason: string): Promise<string[]> {
  const held = await repository.findDispatchedForAgent(agentId);
  const released: string[] = [];
  for (const milestone of held) {
    await repository.reject(milestone.id, reason);
    released.push(milestone.id);
    await notifyAdmins(
      'Visit returned to ADX',
      `The visit on order ${shortId(milestone.orderId)} came back when its agent was suspended and needs another.`,
      milestone.orderId,
    ).catch(() => undefined);
  }
  return released;
}

/**
 * How many milestones this agent is holding — the closure review's "open agent
 * work" line (Lot A, Q21). Counted rather than released: closing an account
 * releases them through the suspension's STOP_OPEN_WORK.
 */
export async function countDispatchedMilestones(agentId: string): Promise<number> {
  return (await repository.findDispatchedForAgent(agentId)).length;
}

export async function completeMilestone(
  milestoneId: string,
  agentId: string,
  evidence: EvidenceInput[],
) {
  const milestone = await requireWorkableMilestone(milestoneId, agentId, 'complete');
  if (milestone.status !== 'IN_PROGRESS') {
    throw new ApiError(400, 'BAD_REQUEST', 'Milestone must be IN_PROGRESS to complete');
  }

  // Evidence is validated against the template before anything is written; the
  // repository then flips the status conditionally so two concurrent
  // completions cannot both succeed.
  const deduped = checkEvidence(milestone.template.requirements, evidence);

  return repository.complete(milestoneId, deduped);
}
