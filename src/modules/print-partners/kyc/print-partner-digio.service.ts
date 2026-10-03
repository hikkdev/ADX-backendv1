import { accountClosedAt, assertOpenForKyc } from '../../../shared/party-status';
import type { Request } from 'express';
import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { KycEntityType } from '../../../shared/database';
import type { DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { workflowKeyFor } from '../../../shared/integrations/digio-workflows';
import {
  digioAnswerOf,
  hostedProviderName,
  hostedProviderOf,
  isDigioRequestOpen,
  partyKycAnswer,
  startPartyKyc,
  type BackupCasePort,
  type PartyKycAnswer,
} from '../../../shared/verification';
import { prismaPrintPartnersRepository } from '../prisma-print-partners.repository';
import { digioDecisionOf, isStaleDigioCallback, trimDigioPayload } from '../../../shared/integrations/digio-callback';
import { entityTypeForEdit, entityTypeForKycStart, isUpgradeRequest } from '../../../shared/kyc-state';
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

/** What a Digio start needs of the partner: the customer Digio reaches, and (Phase D) the facts that pick the workflow. */
export type DigioPartner = Pick<PartnerRow, 'id' | 'name' | 'email' | 'mobile' | 'entityType' | 'kycStatus'> & {
  /** Cashfree Phase 1: the partner's own login — who may act on a Cashfree session. */
  userId?: string | null | undefined;
};

/**
 * Who asked and on whose behalf; Phase D: the legal form the body named —
 * required when the partner's is not known yet (409
 * `ENTITY_TYPE_REQUIRED`; a print partner's `type` says nothing), the
 * upgrade when a verified individual names a business form.
 */
export type DigioStart = {
  onBehalf: boolean;
  byUserId: string;
  entityType?: KycEntityType | undefined;
  req?: Request | undefined;
  /**
   * Cashfree Phase 1 (E-bis): what the partner's own client can draw
   * besides Digio's page. Only the partner's own start (`onBehalf: false`)
   * that names CASHFREE is ever handed a Cashfree session.
   */
  supports?: readonly string[] | undefined;
};

/**
 * The Digio start as every caller that wants Digio and nothing else has
 * always had it — the desk's request, the restart, the upgrade. Asked
 * through the verification router (the attempt is on record; with the
 * backup ON a technical failure marks the record PROVIDER_FAILED), and
 * answered exactly as before.
 */
export async function initiatePrintPartnerDigioKyc(partner: DigioPartner, start: DigioStart, now = new Date()): Promise<DigioSession> {
  return digioAnswerOf(await startPrintPartnerKyc(partner, { ...start, supports: undefined }, now));
}

/**
 * The partner's KYC start. Digio first; a Cashfree session in its place
 * only for the partner's own start from a client that supports it, with the
 * backup switched ON, when Digio could not be asked and no Digio request is
 * already out (`shared/verification/hosted-kyc.ts`).
 */
export async function startPrintPartnerKyc(partner: DigioPartner, start: DigioStart, now = new Date()): Promise<PartyKycAnswer> {
  // N2 verifier: a verified partner has nothing to start — a fresh session
  // would re-point the row and its webhook would write over VERIFIED.
  // Refused like every other submit path (N2-B); the desk's restart already did.
  // Phase D: unless it is the upgrade — an individual verifying again as their business.
  const current = await repository.findByPartnerId(partner.id);
  const entity = entityTypeForKycStart(
    { party: 'PRINT_PARTNER', stored: partner.entityType, verified: current?.status === 'VERIFIED' || partner.kycStatus === 'VERIFIED' },
    start.entityType,
  );
  if (!entity) {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This partner is already verified; there is nothing to start');
  }
  // Phase D: the answer is the partner's, kept whatever Digio says next.
  if (entity.change === 'SET') await storeEntityType(partner.id, entity.previous, entity.entityType, start);

  const referenceId = `${DIGIO_REFERENCE_PREFIX}${partner.id}-${now.getTime()}`;
  const started = await startPartyKyc(
    {
      caseType: 'PRINT_PARTNER_KYC',
      caseId: partner.id,
      digio: {
        party: 'PRINT_PARTNER',
        workflowKey: workflowKeyFor({ party: 'PRINT_PARTNER', entityType: entity.entityType }),
        referenceId,
        customerName: partner.name,
        customerEmail: partner.email ?? '',
        customerMobile: partner.mobile,
      },
      supports: start.supports,
      origin: start.onBehalf ? 'DESK' : 'SELF',
      digioRequestOpen: isDigioRequestOpen(current),
      ownerUserId: partner.userId ?? null,
      subject: { name: partner.name, party: 'PRINT_PARTNER', business: entity.entityType !== 'INDIVIDUAL' },
      markProviderFailed: () => repository.markProviderFailed(partner.id),
    },
    now,
  );
  const fields = {
    method: started.provider,
    digioRequestId: started.requestId,
    digioReferenceId: referenceId,
    digioStatus: 'pending',
    ...(start.onBehalf ? {} : { submittedAt: now }),
  };

  if (entity.change === 'UPGRADE') {
    // Only once Digio has the new request: a refused upgrade leaves the individual verified.
    await repository.reopenDigioForUpgrade(partner.id, entity.entityType, fields);
    await logActivity(start.byUserId, 'KYC_ENTITY_UPGRADED', {
      req: start.req,
      module: 'print-partners',
      targetType: 'PrintPartner',
      targetId: partner.id,
      // The decision it reopens stays here, trimmed to the decision; the row no longer holds it.
      diff: auditDiff(
        { entityType: entity.previous, status: current?.status ?? 'VERIFIED', digioRequestId: current?.digioRequestId ?? null, digioPayload: current?.digioPayload ? trimDigioPayload(current.digioPayload) : null },
        { entityType: entity.entityType, status: 'PENDING', digioRequestId: started.requestId, digioPayload: null },
      ),
      metadata: { party: 'PRINT_PARTNER', kycId: current?.id ?? null },
    });
  } else {
    await repository.upsertDigio(partner.id, fields);
  }
  return partyKycAnswer(started, start.supports);
}

/** Phase D: stored on the partner, with who chose it (audit `KYC_ENTITY_TYPE_SET`). */
export async function storeEntityType(
  partnerId: string,
  previous: KycEntityType | null,
  next: KycEntityType | null,
  by: { byUserId: string; req?: Request | undefined },
  at: 'KYC_START' | 'KYC_REQUEST' | 'EDIT' = 'KYC_START',
): Promise<void> {
  await repository.setEntityType(partnerId, next);
  await logActivity(by.byUserId, 'KYC_ENTITY_TYPE_SET', {
    req: by.req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: partnerId,
    diff: auditDiff({ entityType: previous }, { entityType: next }),
    metadata: { party: 'PRINT_PARTNER', at },
  });
}

/**
 * Phase D: `PATCH /print-partners/:id { entityType }` — the Edit-details
 * drawer. An unverified partner's type is stored (null clears it); a
 * verified one may only take the upgrade, which goes out as a fresh Digio
 * request on the business's workflow; anything else is 409 KYC_LOCKED.
 */
export async function editPrintPartnerEntityType(partner: DigioPartner, requested: KycEntityType | null, by: { byUserId: string; req?: Request | undefined }): Promise<void> {
  const change = entityTypeForEdit({ party: 'PRINT_PARTNER', stored: partner.entityType, verified: partner.kycStatus === 'VERIFIED' }, requested);
  if (!change || change.change === 'KEEP') return;
  if (change.change === 'UPGRADE') {
    await initiatePrintPartnerDigioKyc(partner, { onBehalf: true, ...by, entityType: change.entityType });
    return;
  }
  await storeEntityType(partner.id, change.previous, change.change === 'CLEAR' ? null : change.entityType, by, 'EDIT');
}

/**
 * Phase D: the desk's MANUAL request names the legal form too, when it is
 * given — stored the way a Digio start stores it; nothing is asked when it
 * is not. The caller has refused a verified partner already.
 */
export async function noteEntityTypeForManualRequest(partner: DigioPartner, start: DigioStart): Promise<void> {
  if (start.entityType === undefined) return;
  const entity = entityTypeForKycStart({ party: 'PRINT_PARTNER', stored: partner.entityType, verified: false }, start.entityType);
  if (entity?.change === 'SET') await storeEntityType(partner.id, entity.previous, entity.entityType, start, 'KYC_REQUEST');
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
export async function restartPrintPartnerDigioKyc(row: PrintPartnerKycWithPartner, byUserId: string, req?: Request, body: { entityType?: KycEntityType | undefined } = {}) {
  // Phase D: a verified individual registering a business is the one restart a verified partner may have.
  if (row.status === 'VERIFIED' && !isUpgradeRequest('PRINT_PARTNER', row.printPartner, body.entityType)) {
    throw new ApiError(409, 'CONFLICT', 'This partner is already verified; there is nothing to restart');
  }
  // Account lifecycle (2 Oct 2026): a closed account is never asked for KYC.
  assertOpenForKyc({ closedAt: await accountClosedAt(row.printPartner.userId) });
  const session = await initiatePrintPartnerDigioKyc(row.printPartner, { onBehalf: true, byUserId, entityType: body.entityType, req });
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

  const decision = digioDecisionOf(payload.status);
  const approved = decision === 'VERIFIED';
  const rejected = decision === 'REJECTED';
  const completedAt = payload.completed_at ? new Date(payload.completed_at) : undefined;

  // Phase D: a late or unknown status never un-decides the record (`digio-callback.ts`).
  if (isStaleDigioCallback(row.status, decision)) {
    logger.info('Digio webhook left a decided print partner record as it was', { kycId: payload.id, status: payload.status, recordStatus: row.status });
    return true;
  }

  // Cashfree Phase 1: a Cashfree session's outcome comes down this road too — its request id says so.
  const via = hostedProviderOf(payload.id);
  const verifier = hostedProviderName(via);

  await repository.applyDigioWebhook(row.id, {
    digioStatus: payload.status,
    digioPayload: payload,
    digioVerifiedAt: completedAt ?? (approved ? now : undefined),
    status: decision,
    reviewedAt: approved || rejected ? now : undefined,
    rejectionReason: rejected ? (payload.message ?? `KYC rejected by ${verifier}`) : undefined,
    submittedAt: row.submittedAt ?? completedAt ?? now,
    recordedVia: via,
  });

  logger.info('Digio webhook applied to a print partner', { kycId: payload.id, status: payload.status, printPartnerId: row.printPartnerId });
  // DS-2: the service agreement is asked for the moment KYC verifies, when the policy says so.
  if (approved) await requestServiceAgreement(row.printPartnerId, null);

  if (decision === 'PENDING') {
    await createNotification({
      userId: row.printPartner.userId,
      type: 'KYC',
      title: 'Identity check update',
      message:
        via === 'CASHFREE'
          ? payload.status === 'in_review'
            ? 'Your identity checks are in. ADX is reviewing your documents.'
            : 'Your identity check needs another look. ADX will be in touch.'
          : `Your Digio check is ${payload.status}.`,
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
          ? `${verifier} has verified your identity. Your shop can be paid for print jobs.`
          : `${verifier} could not verify you. ${payload.message ?? 'You can try again, or upload your documents instead.'}`,
        suggestedAction: approved ? 'Open your floor' : 'Open KYC',
        relatedId: row.id,
      },
    },
  );
  return true;
}

/**
 * Cashfree Phase 1: a print partner's KYC case, for the desk's "Resend on
 * backup" (registered by bootstrap as `PRINT_PARTNER_KYC`). Like the desk's
 * Digio request, `submittedAt` is left for the outcome.
 */
export const printPartnerBackupCase: BackupCasePort = {
  async load(partnerId) {
    const partner = await prismaPrintPartnersRepository.findPartner(partnerId);
    if (!partner) return null;
    const record = await repository.findByPartnerId(partnerId);
    return {
      ownerUserId: partner.userId ?? null,
      subject: { name: partner.name, party: 'PRINT_PARTNER', business: partner.entityType !== null && partner.entityType !== 'INDIVIDUAL' },
      workflowKey: workflowKeyFor({ party: 'PRINT_PARTNER', entityType: partner.entityType }),
      verified: record?.status === 'VERIFIED' || partner.kycStatus === 'VERIFIED',
    };
  },
  stamp(partnerId, fields) {
    const { at: _at, ...columns } = fields;
    return repository.upsertDigio(partnerId, columns);
  },
};
