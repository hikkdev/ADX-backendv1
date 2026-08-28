import { ApiError } from '../../../shared/errors';
import { deactivateQrsFor, findActiveQrFor, generateQr } from '../../qr';
import { requireAgentProfile } from '../../agents';
import { prismaPublishersRepository as repository } from '../prisma-publishers.repository';
import type { ClaimedPublisher } from '../../qr';

/**
 * Publisher self-registration from the user app, called once OTP is verified.
 *
 * Idempotent: a second call returns the existing profile with 200 rather than
 * conflicting, because the app may retry.
 */
export async function registerProfile(userId: string, name: string, email?: string) {
  const existing = await repository.findByUserId(userId);
  if (existing) return { publisher: existing, created: false };

  const user = await repository.findUserMobile(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  // The name and email supplied here also update the user record — the
  // publisher app collects them once, for both.
  await repository.setUserProfile(userId, name, email);

  const publisher = await repository.createSelfRegistered({
    userId,
    name,
    mobile: user.mobile,
    email,
  });

  return { publisher, created: true };
}

export async function getMyProfile(userId: string) {
  const publisher = await repository.findByUserIdWithKyc(userId);
  if (!publisher) {
    throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found. Complete registration first.');
  }
  return publisher;
}

/**
 * The onboarding QR a publisher shows an agent.
 *
 * Reuses the active code if one exists — regenerating would invalidate a code
 * the publisher may already have on screen — and returns `created` so the
 * controller can answer 200 or 201 accordingly.
 */
export async function getOrCreateOnboardingQr(userId: string) {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');

  if (publisher.onboardingStatus === 'IN_ONBOARDING') {
    throw new ApiError(409, 'CONFLICT', 'Your onboarding is already in progress with an agent.');
  }
  if (publisher.onboardingStatus === 'ONBOARDING_COMPLETE') {
    throw new ApiError(409, 'CONFLICT', 'Onboarding is already complete.');
  }

  const existing = await findActiveQrFor('PUBLISHER', publisher.id);
  if (existing) {
    return { qrId: existing.id, token: existing.token, created: false };
  }

  const { qrId, token } = await generateQr('PUBLISHER', publisher.id, ['AGENT_PUBLISHER']);
  return { qrId, token, created: true };
}

export async function cancelMyOnboarding(userId: string) {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');

  if (
    publisher.onboardingStatus !== 'IN_ONBOARDING' &&
    publisher.onboardingStatus !== 'PENDING_ONBOARDING'
  ) {
    throw new ApiError(400, 'BAD_REQUEST', 'Nothing to cancel');
  }

  await resetOnboarding(publisher.id);
}

/** Agent- or admin-initiated cancellation. No ownership check, by design. */
export async function cancelOnboarding(publisherId: string) {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');

  await resetOnboarding(publisherId);
}

/**
 * Expires the publisher's live QR codes, then clears the claim. Order matters:
 * clearing the claim first would leave a scannable code pointing at a publisher
 * that is momentarily claimable again.
 */
async function resetOnboarding(publisherId: string): Promise<void> {
  await deactivateQrsFor('PUBLISHER', publisherId);
  await repository.resetOnboardingState(publisherId);
}

export async function completeOnboarding(publisherId: string, userId: string, isAdmin: boolean) {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');

  // Only the claiming agent may complete an onboarding — or an admin, who
  // bypasses the check entirely.
  if (!isAdmin) {
    const agent = await requireAgentProfile(userId).catch(() => null);
    if (!agent || publisher.agentId !== agent.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the claiming agent or admin can complete this onboarding',
      );
    }
  }

  if (publisher.onboardingStatus !== 'IN_ONBOARDING') {
    throw new ApiError(400, 'BAD_REQUEST', 'Onboarding is not in progress');
  }

  await repository.completeOnboarding(publisherId);
}

// ── The QR module's PublisherOnboardingPort ────────────────────────────────

/**
 * Validation half of a QR claim. Performs no writes, so a rejected claim never
 * burns the QR code. Throws the QR_* sentinels the QR controller maps.
 */
export async function prepareClaim(
  publisherId: string,
  scannedByUserId: string,
): Promise<{ publisher: ClaimedPublisher; agentId: string }> {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) throw new Error('QR_NOT_FOUND');

  if (publisher.onboardingStatus === 'IN_ONBOARDING') throw new Error('QR_ALREADY_CLAIMED');
  if (publisher.onboardingStatus === 'ONBOARDING_COMPLETE') throw new Error('QR_ALREADY_COMPLETE');

  const agent = await requireAgentProfile(scannedByUserId).catch(() => null);
  if (!agent) throw new Error('QR_ACCESS_DENIED');

  return {
    publisher: {
      id: publisher.id,
      name: publisher.name,
      mobile: publisher.mobile,
      type: publisher.type,
    },
    agentId: agent.id,
  };
}

/** Write half of a QR claim. */
export async function commitClaim(publisherId: string, agentId: string): Promise<void> {
  await repository.claim(publisherId, agentId);
}
