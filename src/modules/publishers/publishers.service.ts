import { ApiError } from '../../shared/errors';
import type { KycStatus } from '../../shared/database';
import { prismaPublishersRepository as repository } from './prisma-publishers.repository';
import { assertAgentOwnsPublisher } from './publishers.policy';
import type { KycDocuments, NewPublisher, PublisherPatch } from './publishers.repository';

export async function createPublisher(data: NewPublisher) {
  return repository.create(data);
}

export async function getPublishersForAgent(agentId: string, category?: string) {
  return repository.findForAgent(agentId, category);
}

/**
 * Loads a publisher the calling agent owns, with its KYC and listings.
 *
 * Unknown publisher is 404; someone else's publisher is 403 — both inherited,
 * see publishers.policy.
 */
export async function getOwnedPublisher(publisherId: string, userId: string) {
  const publisher = await repository.findById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  await assertAgentOwnsPublisher(userId, publisher.agentId);
  return publisher;
}

/** Same check without the joins, for endpoints that only need to authorise. */
export async function assertOwnedPublisher(publisherId: string, userId: string) {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  await assertAgentOwnsPublisher(userId, publisher.agentId);
  return publisher;
}

export async function updatePublisher(
  publisherId: string,
  userId: string,
  data: PublisherPatch,
) {
  await getOwnedPublisher(publisherId, userId);
  return repository.update(publisherId, data);
}

export async function submitKyc(publisherId: string, userId: string, docs: KycDocuments) {
  await getOwnedPublisher(publisherId, userId);
  return repository.submitKyc(publisherId, docs);
}

/** Admin review — no agent-ownership check, unlike submission. */
export async function reviewKyc(
  publisherId: string,
  status: KycStatus,
  rejectionReason?: string,
) {
  return repository.reviewKyc(publisherId, status, rejectionReason);
}

export async function getOnboardingStatus(publisherId: string, userId: string) {
  const publisher = await getOwnedPublisher(publisherId, userId);
  return {
    kycStatus: publisher.kycStatus,
    listingsCount: publisher.listings.length,
    kycDocuments: publisher.kyc,
  };
}
