import { ApiError } from '../../shared/errors';
import type { AgentProfile } from '../../shared/database';
import { prismaAgentsRepository as repository } from './prisma-agents.repository';
import type { AgentFilter } from './agents.repository';

export async function listAgents(filter: AgentFilter, limit: number, offset: number) {
  const { items, total } = await repository.findPage(filter, limit, offset);
  // Note the meta shape here is { total, limit, offset } — not the
  // { page, pageSize, total, totalPages } used by the paginated admin listings.
  return { items, meta: { total, limit, offset } };
}

export async function getAgentById(id: string) {
  const agent = await repository.findById(id);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  return agent;
}

/**
 * Resolves the calling user's agent profile, or throws 404.
 *
 * This replaces a `findUnique({ where: { userId } })` + 404 pair that was
 * copy-pasted into twelve handlers across five modules. Exported from the
 * module index so `orders`, `order-milestones`, `earnings` and `publishers`
 * share one definition and one error message.
 */
export async function requireAgentProfile(userId: string): Promise<AgentProfile> {
  const agent = await repository.findByUserId(userId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  return agent;
}

/** Same lookup without the throw, for callers that treat absence as normal. */
export async function findAgentProfile(userId: string): Promise<AgentProfile | null> {
  return repository.findByUserId(userId);
}

/**
 * Directory lookups the `orders` module needs for assignment and notification,
 * so it never queries AgentProfile itself.
 */
export async function getAgentWithUser(agentId: string) {
  return repository.findWithUser(agentId);
}

/** Whether an agent profile id exists — used before assigning work to it. */
export async function agentExists(agentId: string): Promise<boolean> {
  return repository.exists(agentId);
}

export async function findAssignableAgent(excludeIds: string[]) {
  return repository.findAssignable(excludeIds);
}
