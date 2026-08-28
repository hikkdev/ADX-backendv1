import { ApiError } from '../../../shared/errors';
import { prismaOrderMilestonesRepository as repository } from '../prisma-order-milestones.repository';
import { checkEvidence } from '../order-milestones.evidence';
import type { EvidenceInput } from '../order-milestones.types';

const FINALISED = ['CANCELLED', 'COMPLETED'];

/** The agent's own work queue: dispatched and in-progress milestones only. */
export async function getAgentMilestones(agentId: string) {
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
  if (FINALISED.includes(milestone.orderRecord.status)) {
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

  return repository.start(milestoneId);
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
