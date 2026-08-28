import { ApiError } from '../../shared/errors';
import { findAgentProfile } from '../agents';

/**
 * Agent-facing publisher endpoints are scoped to the publishers an agent has
 * claimed.
 *
 * Note the two failure modes are different and both are contract: an unknown
 * publisher is **404**, while a publisher owned by a different agent — or a
 * caller with no agent profile at all — is **403**. That is the opposite of
 * the ownership checks in `banking` and `advertisements`, which report 404 for
 * both to avoid confirming an id exists.
 */
export async function assertAgentOwnsPublisher(
  userId: string,
  publisherAgentId: string | null,
): Promise<string> {
  const agent = await findAgentProfile(userId);
  if (!agent || publisherAgentId !== agent.id) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');
  }
  return agent.id;
}
