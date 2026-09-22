import type { Request } from 'express';
import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import { requestDigioKyc, type DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { createNotification, notify } from '../../notifications';
import type { PartnerRow } from '../print-partners.repository';
import { prismaPrintPartnerKycRepository as repository } from './prisma-print-partner-kyc.repository';
import type { PrintPartnerKycWithPartner } from './print-partner-kyc.repository';
import { requestServiceAgreement } from '../service-agreement';

/**
 * KYC by Digio for a print partner — Lot N.
 *
 * The same request the publisher and the advertiser make through
 * `shared/integrations/digio-client`, recorded on the partner's own row.
 * The reference ADX hands Digio is `adx-pp-<partnerId>-<ts>` — the `pp`
 * says which table it belongs to when someone reads the Digio console —
 * and the webhook is routed the way every party's is: by the request id
 * Digio minted. ADX has one callback, owned by `publishers`; a request id no
 * publisher row claims is offered to the handlers registered at boot, and
 * `handlePrintPartnerDigioWebhook` is one of them (`bootstrap/register-modules`).
 *
 * Two doors open a session: the partner's own phone
 * (`POST /print-partners/me/kyc/digio/initiate`, `submittedAt` stamped —
 * the request is the submission in flight) and the desk asking on the
 * partner's behalf (`POST /print-partner-kyc/:id/request { channel: DIGIO }`,
 * `submittedAt` left for the webhook — the queue's "requested" facet is
 * the desk's ask with nothing back yet). Digio sends its link to the
 * partner's own email or mobile (`notify_customer`), never to the admin.
 */

export const DIGIO_REFERENCE_PREFIX = 'adx-pp-';

export type DigioSession = { kycId: string; accessToken: string; validTill: string; sdkUrl: string };

export async function initiatePrintPartnerDigioKyc(
  partner: Pick<PartnerRow, 'id' | 'name' | 'email' | 'mobile'>,
  opts: { onBehalf: boolean } = { onBehalf: false },
  now = new Date(),
): Promise<DigioSession> {
  // N2 verifier: a verified partner has nothing to start — a fresh session
  // would re-point the row and its webhook would write over VERIFIED.
  // Refused like every other submit path (N2-B); the desk's restart already did.
  const current = await repository.findByPartnerId(partner.id);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This partner is already verified; there is nothing to start');
  }
  const referenceId = `${DIGIO_REFERENCE_PREFIX}${partner.id}-${now.getTime()}`;
  const session = await requestDigioKyc({ referenceId, customerName: partner.name, customerEmail: partner.email ?? '', customerMobile: partner.mobile });
  await repository.upsertDigio(partner.id, {
    method: 'DIGIO',
    digioRequestId: session.kycId,
    digioReferenceId: referenceId,
    digioStatus: 'pending',
    ...(opts.onBehalf ? {} : { submittedAt: now }),
  });
  return { kycId: session.kycId, accessToken: session.accessToken, validTill: session.validTill, sdkUrl: session.sdkUrl };
}

/** `GET /print-partners/me/kyc/digio/status` — null before any record. */
export async function printPartnerDigioStatus(partnerId: string) {
  const row = await repository.findByPartnerId(partnerId);
  if (!row) return null;
  return { method: row.method, digioStatus: row.digioStatus, kycStatus: row.status, digioVerifiedAt: row.digioVerifiedAt };
}

/**
 * `POST /print-partner-kyc/:id/digio/restart` — the desk asks Digio again
 * for this row; who asked is logged; the partner is told to open the app.
 * A verified partner has nothing to restart.
 */
export async function restartPrintPartnerDigioKyc(row: PrintPartnerKycWithPartner, byUserId: string, req?: Request) {
  if (row.status === 'VERIFIED') {
    throw new ApiError(409, 'CONFLICT', 'This partner is already verified; there is nothing to restart');
  }
  const session = await initiatePrintPartnerDigioKyc(row.printPartner, { onBehalf: true });
  await logActivity(byUserId, 'PRINT_PARTNER_KYC_DIGIO_RESTARTED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
    metadata: { printPartnerId: row.printPartnerId, kycId: session.kycId },
  });
  await createNotification({
    userId: row.printPartner.userId,
    type: 'KYC',
    title: 'Finish your Digio check',
    message: 'ADX has started a fresh Digio identity check for your shop. Open the app and finish it — it takes about a minute.',
    suggestedAction: 'Open KYC',
    relatedId: row.id,
  });
  return { kycId: session.kycId, validTill: session.validTill, digioStatus: 'pending' as const, notified: true };
}

/**
 * Claims a webhook whose request id is a print partner's; false when it is
 * not. A decision lands on the row and the partner's mirror
 * (`recordedVia: DIGIO`), stamps `submittedAt` when the desk's request left
 * it empty, and tells the partner through `KYC_DECISION`.
 */
export async function handlePrintPartnerDigioWebhook(payload: DigioWebhookPayload, now = new Date()): Promise<boolean> {
  const row = await repository.findByDigioRequestId(payload.id);
  if (!row) return false;

  const approved = payload.status === 'approved';
  const rejected = payload.status === 'rejected';
  const decision = approved ? 'VERIFIED' : rejected ? 'REJECTED' : 'PENDING';
  const completedAt = payload.completed_at ? new Date(payload.completed_at) : undefined;

  await repository.applyDigioWebhook(row.id, {
    digioStatus: payload.status,
    digioPayload: payload,
    digioVerifiedAt: completedAt ?? (approved ? now : undefined),
    status: decision,
    reviewedAt: approved || rejected ? now : undefined,
    rejectionReason: rejected ? (payload.message ?? 'KYC rejected by Digio') : undefined,
    submittedAt: row.submittedAt ?? completedAt ?? now,
    recordedVia: 'DIGIO',
  });

  logger.info('Digio webhook applied to a print partner', { kycId: payload.id, status: payload.status, printPartnerId: row.printPartnerId });
  // DS-2: the service agreement is asked for the moment KYC verifies, when the policy says so.
  if (approved) await requestServiceAgreement(row.printPartnerId, null);

  if (decision === 'PENDING') {
    await createNotification({
      userId: row.printPartner.userId,
      type: 'KYC',
      title: 'Identity check update',
      message: `Your Digio check is ${payload.status}.`,
      relatedId: row.id,
    });
    return true;
  }

  await notify(
    'KYC_DECISION',
    row.printPartner.userId,
    {
      partyName: row.printPartner.name,
      decision: approved ? 'verified' : 'not verified',
      reason: approved ? 'Your shop can be paid for print jobs.' : (payload.message ?? 'You can try again, or upload your documents instead.'),
    },
    {
      inApp: {
        type: 'KYC',
        title: approved ? 'Identity verified' : 'Identity check did not clear',
        message: approved
          ? 'Digio has verified your identity. Your shop can be paid for print jobs.'
          : `Digio could not verify you. ${payload.message ?? 'You can try again, or upload your documents instead.'}`,
        suggestedAction: approved ? 'Open your floor' : 'Open KYC',
        relatedId: row.id,
      },
    },
  );
  return true;
}
