import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { KycEntityType, Publisher } from '../../../shared/database';
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
  type DigioKycAnswer,
  type PartyKycAnswer,
} from '../../../shared/verification';
import { effectiveEntityType } from '../../../shared/kyc-state';
import { prismaPublishersRepository } from '../prisma-publishers.repository';
import { digioDecisionOf, isStaleDigioCallback, trimDigioPayload } from '../../../shared/integrations/digio-callback';
import { entityTypeForKycStart } from '../../../shared/kyc-state';
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

/** What a Digio start needs of the publisher: the customer Digio reaches, and the facts that pick the workflow. */
export type DigioPublisher = Pick<Publisher, 'id' | 'name' | 'email' | 'mobile' | 'type' | 'entityType' | 'kycStatus'> & {
  /** Cashfree Phase 1: the publisher's own login — who may act on a Cashfree session. */
  userId?: string | null | undefined;
};

/**
 * Who asked, and what they said. `entityType` is the body's — required
 * when the publisher's legal form is not known yet (409
 * `ENTITY_TYPE_REQUIRED` otherwise), and the upgrade when a verified
 * individual names a business form.
 */
export type DigioStart = {
  byUserId: string;
  entityType?: KycEntityType | undefined;
  req?: Request | undefined;
  /**
   * Cashfree Phase 1 (E-bis): the publisher's OWN start (`self`), from a
   * client that can draw the Cashfree steps (`supports` names CASHFREE) —
   * the only start that is ever handed a Cashfree session.
   */
  self?: boolean | undefined;
  supports?: readonly string[] | undefined;
};

/**
 * The Digio start as every caller that wants Digio and nothing else has
 * always had it — the desk, the agent, the restart, the upgrade. Asked
 * through the verification router (the attempt is on record; with the
 * backup ON a technical failure marks the record PROVIDER_FAILED), and
 * answered exactly as before.
 */
export async function initiateDigioKyc(publisher: DigioPublisher, start: DigioStart, now = new Date()): Promise<DigioKycAnswer> {
  return digioAnswerOf(await startPublisherKyc(publisher, { ...start, self: false, supports: undefined }, now));
}

/**
 * The publisher's KYC start. Digio first; a Cashfree session in its place
 * only for the publisher's own start from a client that supports it, with
 * the backup switched ON, when Digio could not be asked and no Digio
 * request is already out (`shared/verification/hosted-kyc.ts`).
 */
export async function startPublisherKyc(publisher: DigioPublisher, start: DigioStart, now = new Date()): Promise<PartyKycAnswer> {
  // N2 verifier: a verified publisher has nothing to start — a fresh session
  // would re-point the row and its webhook would write over VERIFIED. Guarded
  // here so every caller (the publisher's own, the agent's, the desk's) is
  // covered; 409 like every other submit path (N2-B). Phase D: unless it is
  // the upgrade — an individual verifying again as the business they registered.
  const current = await repository.findByPublisherId(publisher.id);
  const entity = entityTypeForKycStart(
    { party: 'PUBLISHER', stored: publisher.entityType, legacyType: publisher.type, verified: current?.status === 'VERIFIED' || publisher.kycStatus === 'VERIFIED' },
    start.entityType,
  );
  if (!entity) {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This publisher is already verified; there is nothing to start');
  }
  // Phase D: the answer is the publisher's, kept whatever Digio says next — a
  // refused or failed request does not make them answer again.
  if (entity.change === 'SET') await storeEntityType(publisher.id, entity.previous, entity.entityType, start);

  const referenceId = `adx-${publisher.id}-${now.getTime()}`;
  const started = await startPartyKyc(
    {
      caseType: 'PUBLISHER_KYC',
      caseId: publisher.id,
      digio: {
        party: 'PUBLISHER',
        workflowKey: workflowKeyFor({ party: 'PUBLISHER', entityType: entity.entityType }),
        referenceId,
        customerName: publisher.name,
        customerEmail: publisher.email ?? '',
        customerMobile: publisher.mobile,
      },
      supports: start.supports,
      origin: start.self ? 'SELF' : 'DESK',
      digioRequestOpen: isDigioRequestOpen(current),
      ownerUserId: publisher.userId ?? null,
      subject: { name: publisher.name, party: 'PUBLISHER', business: entity.entityType !== 'INDIVIDUAL' },
      markProviderFailed: () => repository.markProviderFailed(publisher.id),
    },
    now,
  );
  const fields = { method: started.provider, digioRequestId: started.requestId, digioReferenceId: referenceId, digioStatus: 'pending', submittedAt: now };

  if (entity.change === 'UPGRADE') {
    // Only once Digio has the new request: a refused upgrade leaves the individual verified.
    await repository.restartForUpgrade(publisher.id, entity.entityType, fields);
    await logActivity(start.byUserId, 'KYC_ENTITY_UPGRADED', {
      req: start.req,
      targetType: 'Publisher',
      targetId: publisher.id,
      module: 'publishers',
      diff: upgradeDiff(entity.previous, entity.entityType, current, started.requestId),
      metadata: { party: 'PUBLISHER', kycId: current?.id ?? null },
    });
  } else {
    await repository.upsertDigioKyc(publisher.id, fields);
  }

  return partyKycAnswer(started, start.supports);
}

/** Stored on the publisher's row, with who chose it (audit `KYC_ENTITY_TYPE_SET`). */
async function storeEntityType(publisherId: string, previous: KycEntityType | null, next: KycEntityType, start: DigioStart): Promise<void> {
  await repository.setEntityType(publisherId, next);
  await logActivity(start.byUserId, 'KYC_ENTITY_TYPE_SET', {
    req: start.req,
    targetType: 'Publisher',
    targetId: publisherId,
    module: 'publishers',
    diff: auditDiff({ entityType: previous }, { entityType: next }),
    metadata: { party: 'PUBLISHER', at: 'KYC_START' },
  });
}

/**
 * Phase D: the desk's MANUAL request names the legal form too, when it is
 * given — stored the way a Digio start stores it, nothing asked when it is
 * not (a manual request needs no workflow). The caller has refused a
 * verified publisher already.
 */
export async function noteEntityTypeForManualRequest(publisher: DigioPublisher, start: DigioStart): Promise<void> {
  if (start.entityType === undefined) return;
  const entity = entityTypeForKycStart({ party: 'PUBLISHER', stored: publisher.entityType, legacyType: publisher.type, verified: false }, start.entityType);
  if (entity?.change === 'SET') await storeEntityType(publisher.id, entity.previous, entity.entityType, start);
}

/**
 * What the upgrade's audit keeps of the decision it reopens — the old
 * request and its payload, trimmed to the decision (no names, dates of
 * birth or numbers), since the row no longer holds it.
 */
function upgradeDiff(
  from: KycEntityType,
  to: KycEntityType,
  before: { status: string; digioRequestId: string | null; digioPayload: unknown } | null,
  nextRequestId: string,
) {
  return auditDiff(
    { entityType: from, status: before?.status ?? 'VERIFIED', digioRequestId: before?.digioRequestId ?? null, digioPayload: before?.digioPayload ? trimDigioPayload(before.digioPayload) : null },
    { entityType: to, status: 'PENDING', digioRequestId: nextRequestId, digioPayload: null },
  );
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

  const decision = digioDecisionOf(status);
  const isApproved = decision === 'VERIFIED';
  const isRejected = decision === 'REJECTED';

  // Phase D: a late or unknown status never un-decides the record (`digio-callback.ts`).
  if (isStaleDigioCallback(kyc.status, decision)) {
    logger.info('Digio webhook left a decided publisher record as it was', { kycId, status, recordStatus: kyc.status });
    return true;
  }

  // Cashfree Phase 1: a Cashfree session's outcome comes down this road too — its request id says so.
  const via = hostedProviderOf(kycId);
  const verifier = hostedProviderName(via);

  await repository.applyWebhook(kyc, {
    via,
    digioStatus: status,
    digioPayload: payload,
    digioVerifiedAt: completed_at ? new Date(completed_at) : isApproved ? new Date() : undefined,
    status: decision,
    reviewedAt: isApproved || isRejected ? new Date() : undefined,
    rejectionReason: isRejected ? (payload.message ?? `KYC rejected by ${verifier}`) : undefined,
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
        ? `KYC for publisher ${publisher.name} has been verified via ${verifier}.`
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

// ─── Cashfree Phase 1: the desk's "Resend on backup" ─────────────────────────

/**
 * A publisher's KYC case, for the verification service (registered by
 * bootstrap as `PUBLISHER_KYC`): who the publisher is and which workflow
 * they would have run, and the write that puts their record on the Cashfree
 * path — the same columns a Digio start writes, the session's id in the
 * request column.
 */
export const publisherBackupCase: BackupCasePort = {
  async load(publisherId) {
    const publisher = await prismaPublishersRepository.findByIdWithUser(publisherId);
    if (!publisher) return null;
    const record = await repository.findByPublisherId(publisherId);
    const entityType = effectiveEntityType('PUBLISHER', publisher);
    return {
      ownerUserId: publisher.userId ?? null,
      subject: { name: publisher.name, party: 'PUBLISHER', business: entityType !== null && entityType !== 'INDIVIDUAL' },
      workflowKey: workflowKeyFor({ party: 'PUBLISHER', entityType }),
      verified: record?.status === 'VERIFIED' || publisher.kycStatus === 'VERIFIED',
    };
  },
  stamp(publisherId, fields) {
    const { at, ...columns } = fields;
    return repository.upsertDigioKyc(publisherId, { ...columns, submittedAt: at });
  },
};
