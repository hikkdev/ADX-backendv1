import { ApiError } from '../../shared/errors';
import { findAgentProfile } from '../agents';
import { liveGrantFor } from '../access-grants';

/**
 * Agent-facing publisher endpoints are scoped to the publishers an agent has
 * claimed.
 *
 * Note the two failure modes are different and both are contract: an unknown
 * publisher is **404**, while a publisher owned by a different agent — or a
 * caller with no agent profile at all — is **403**. Other ownership checks in
 * the platform report 404 for both to avoid confirming an id exists; this one
 * deliberately does not.
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

/**
 * Writing is a different question from reading.
 *
 * Reading the publisher an agent brought in is attribution, above. Writing
 * to them — their details, their documents — is authority, and authority is
 * a live grant: the one the owner opened by approving the scan, or one they
 * lent later on a ticket. Attribution alone no longer writes. The grant id
 * comes back so the write can be recorded against it.
 */
export async function assertAgentMayWrite(
  userId: string,
  publisher: { id: string; agentId: string | null },
): Promise<{ agentId: string; grantId: string }> {
  const agentId = await assertAgentOwnsPublisher(userId, publisher.agentId);
  const grant = await liveGrantFor(agentId, { publisherId: publisher.id }, 'PROFILE');
  if (!grant) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Your access to this publisher has ended. Ask them to approve a fresh code.',
    );
  }
  return { agentId, grantId: grant.id };
}
