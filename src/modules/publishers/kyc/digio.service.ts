import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { requestDigioKyc, type DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { createNotification } from '../../notifications';
import { prismaDigioRepository as repository } from './prisma-digio.repository';

export type { DigioWebhookPayload } from '../../../shared/integrations/digio-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DigioPurpose = 'AADHAAR_VERIFICATION' | 'PAN_VERIFICATION' | 'DRIVING_LICENCE';

/**
 * What answers a webhook no publisher row claims.
 *
 * Digio has one callback URL and ADX verifies more than one kind of party
 * through it. The publisher's module owns the endpoint because it was here
 * first; anyone else who initiates a Digio check registers here, at boot,
 * and is asked when a request id is not a publisher's. The advertiser's KYC
 * module is the first; the registration lives in bootstrap so neither module
 * has to import the other.
 */
type UnmatchedWebhookHandler = (payload: DigioWebhookPayload) => Promise<boolean>;
const unmatchedHandlers: UnmatchedWebhookHandler[] = [];

export function onUnmatchedDigioWebhook(handler: UnmatchedWebhookHandler): void {
  unmatchedHandlers.push(handler);
}

// ─── Initiate ─────────────────────────────────────────────────────────────────

export async function initiateDigioKyc(
  publisherId: string,
  customerName: string,
  customerEmail: string,
  customerMobile: string,
): Promise<{ kycId: string; accessToken: string; validTill: string; sdkUrl: string }> {
  // N2 verifier: a verified publisher has nothing to start — a fresh session
  // would re-point the row and its webhook would write over VERIFIED. Guarded
  // here so every caller (the publisher's own, the agent's, the desk's) is
  // covered; 409 like every other submit path (N2-B).
  const current = await repository.findByPublisherId(publisherId);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This publisher is already verified; there is nothing to start');
  }
  const referenceId = `adx-${publisherId}-${Date.now()}`;
  const session = await requestDigioKyc({ referenceId, customerName, customerEmail, customerMobile });

  await repository.upsertDigioKyc(publisherId, {
    method: 'DIGIO',
    digioRequestId: session.kycId,
    digioReferenceId: referenceId,
    digioStatus: 'pending',
    submittedAt: new Date(),
  });

  return { kycId: session.kycId, accessToken: session.accessToken, validTill: session.validTill, sdkUrl: session.sdkUrl };
}

// ─── Webhook Handler ──────────────────────────────────────────────────────────

/**
 * Applies Digio's answer to the publisher it belongs to. When no publisher
 * row carries the request id, the other parties registered above are asked
 * in turn. Returns whether anyone claimed it.
 */
export async function handleDigioWebhook(payload: DigioWebhookPayload): Promise<boolean> {
  const { id: kycId, status, completed_at } = payload;

  logger.info('Digio webhook received', { kycId, status });

  const kyc = await repository.findByRequestId(kycId);
  if (!kyc) {
    for (const handler of unmatchedHandlers) {
      if (await handler(payload)) return true;
    }
    logger.warn('Digio webhook: no KYC record found for kycId', { kycId });
    return false;
  }

  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  await repository.applyWebhook(kyc.id, {
    digioStatus: status,
    digioPayload: payload,
    digioVerifiedAt: completed_at ? new Date(completed_at) : isApproved ? new Date() : undefined,
    status: isApproved ? 'VERIFIED' : isRejected ? 'REJECTED' : 'PENDING',
    reviewedAt: isApproved || isRejected ? new Date() : undefined,
    rejectionReason: isRejected ? (payload.message ?? 'KYC rejected by Digio') : undefined,
  });

  // Notify the publisher's claiming agent. Raised through the notifications
  // module rather than writing the row here.
  const publisher = await repository.findPublisherAgent(kyc.publisherId);

  if (publisher) {
    await createNotification({
      userId: publisher.agentUserId,
      type: 'KYC',
      title: isApproved ? 'KYC Approved' : isRejected ? 'KYC Rejected' : 'KYC Update',
      subtitle: publisher.name,
      message: isApproved
        ? `KYC for publisher ${publisher.name} has been verified via Digio.`
        : isRejected
        ? `KYC for publisher ${publisher.name} was rejected. ${payload.message ?? ''}`
        : `KYC status updated to ${status} for ${publisher.name}.`,
      relatedId: publisher.id,
      relatedType: 'PUBLISHER',
    });
  }
  return true;
}

// ─── Status Check ─────────────────────────────────────────────────────────────

export async function getDigioKycStatus(publisherId: string): Promise<{
  method: string;
  digioStatus: string | null;
  kycStatus: string;
  digioVerifiedAt: Date | null;
} | null> {
  const kyc = await repository.findByPublisherId(publisherId);
  if (!kyc) return null;
  return {
    method: kyc.method,
    digioStatus: kyc.digioStatus,
    kycStatus: kyc.status,
    digioVerifiedAt: kyc.digioVerifiedAt,
  };
}
