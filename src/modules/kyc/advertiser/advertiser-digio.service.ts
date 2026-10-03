import { accountClosedAt, assertOpenForKyc } from '../../../shared/party-status';
import type { Request } from 'express';
import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { Advertiser, KycEntityType } from '../../../shared/database';
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
import { digioDecisionOf, isStaleDigioCallback, trimDigioPayload } from '../../../shared/integrations/digio-callback';
import { effectiveEntityType, entityTypeForKycStart, isUpgradeRequest } from '../../../shared/kyc-state';
import { applyKycDecision, applyKycDecisionByUserId, findAdvertiser, getAdvertiserForUser, setAdvertiserEntityType } from '../../advertisers';
import { createNotification } from '../../notifications';
import { prismaAdvertiserKycRepository as repository } from './prisma-advertiser-kyc.repository';
import type { AdvertiserKycKey } from './advertiser-kyc.repository';

/**
 * KYC by Digio for an advertiser — the demand side of U7.
 *
 * The publisher has had this since the integration was built; the advertiser
 * KYC module exposed manual review and nothing else, so an advertiser could
 * only ever upload. This is the same request through the shared client,
 * recorded on the advertiser's own KYC row — N3-B: keyed by the Advertiser
 * PROFILE, the user id riding along when the profile has one — and the same
 * answer: Digio calls ADX's one webhook, the publisher module finds no row of
 * its own, and hands the payload here.
 *
 * The customer Digio reaches is the profile's contact — its name, email and
 * mobile — so an advertiser ops created on the console, with no app account
 * yet, can be asked all the same (`POST /advertiser-kyc/:id/request`); the
 * reference ADX hands Digio is `adx-adv-<profileId>-<ts>`.
 *
 * A decision flips the advertiser's gate the way a manual review does —
 * `applyKycDecision` by the profile — so a Digio-verified advertiser can book.
 */

export const DIGIO_REFERENCE_PREFIX = 'adx-adv-';

/** What a session needs of the party: the key, the customer Digio reaches, and (Phase D) the facts that pick the workflow. */
export type DigioParty = Pick<Advertiser, 'id' | 'userId' | 'name' | 'companyName' | 'email' | 'mobile' | 'type' | 'entityType' | 'kycStatus'>;

/**
 * Phase D: who asked, and the legal form the body named — required when
 * the advertiser's is not known yet (409 `ENTITY_TYPE_REQUIRED`), the
 * upgrade when a verified individual names a business form.
 */
export type DigioStart = {
  byUserId: string;
  entityType?: KycEntityType | undefined;
  req?: Request | undefined;
  /**
   * Cashfree Phase 1 (E-bis): the advertiser's OWN start (`self`), from a
   * client that can draw the Cashfree steps (`supports` names CASHFREE) —
   * the only start that is ever handed a Cashfree session.
   */
  self?: boolean | undefined;
  supports?: readonly string[] | undefined;
};

const keyOf = (advertiser: DigioParty): AdvertiserKycKey => ({ advertiserProfileId: advertiser.id, advertiserId: advertiser.userId });

/**
 * The Digio start as every caller that wants Digio and nothing else has
 * always had it — the desk's request, the restart, the upgrade. Asked
 * through the verification router (the attempt is on record; with the
 * backup ON a technical failure marks the record PROVIDER_FAILED), and
 * answered exactly as before.
 */
export async function initiateAdvertiserDigioKyc(advertiser: DigioParty, start: DigioStart, now = new Date()): Promise<DigioKycAnswer> {
  return digioAnswerOf(await startAdvertiserKyc(advertiser, { ...start, self: false, supports: undefined }, now));
}

/**
 * The advertiser's KYC start. Digio first; a Cashfree session in its place
 * only for the advertiser's own start from a client that supports it, with
 * the backup switched ON, when Digio could not be asked and no Digio
 * request is already out (`shared/verification/hosted-kyc.ts`). An
 * advertiser's Cashfree steps have no bank check — refunds go back to the
 * source (the owner).
 */
export async function startAdvertiserKyc(advertiser: DigioParty, start: DigioStart, now = new Date()): Promise<PartyKycAnswer> {
  // N2 verifier: a verified advertiser has nothing to start — a fresh
  // session would re-point the row and its webhook would write over
  // VERIFIED. Refused like every other submit path (N2-B). Phase D: unless
  // it is the upgrade — an individual verifying again as their business.
  const current = (await repository.findByProfileId(advertiser.id)) ?? (advertiser.userId ? await repository.findByAdvertiserId(advertiser.userId) : null);
  const entity = entityTypeForKycStart(
    { party: 'ADVERTISER', stored: advertiser.entityType, legacyType: advertiser.type, verified: current?.status === 'VERIFIED' || advertiser.kycStatus === 'VERIFIED' },
    start.entityType,
  );
  if (!entity) {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This advertiser is already verified; there is nothing to start');
  }
  // Phase D: the answer is the advertiser's, kept whatever Digio says next.
  if (entity.change === 'SET') {
    await setAdvertiserEntityType(advertiser.id, entity.entityType);
    await logActivity(start.byUserId, 'KYC_ENTITY_TYPE_SET', {
      req: start.req,
      targetType: 'Advertiser',
      targetId: advertiser.id,
      module: 'kyc',
      diff: auditDiff({ entityType: entity.previous }, { entityType: entity.entityType }),
      metadata: { party: 'ADVERTISER', at: 'KYC_START' },
    });
  }

  const referenceId = `${DIGIO_REFERENCE_PREFIX}${advertiser.id}-${now.getTime()}`;
  // A legacy user-keyed row (no profile key yet) is written where it is — by its id — and adopts the profile key.
  const key: AdvertiserKycKey = current && !current.advertiserProfileId ? { id: current.id, ...keyOf(advertiser) } : keyOf(advertiser);
  const started = await startPartyKyc(
    {
      caseType: 'ADVERTISER_KYC',
      caseId: advertiser.id,
      digio: {
        party: 'ADVERTISER',
        workflowKey: workflowKeyFor({ party: 'ADVERTISER', entityType: entity.entityType }),
        referenceId,
        customerName: advertiser.companyName ?? advertiser.name,
        customerEmail: advertiser.email ?? '',
        customerMobile: advertiser.mobile,
      },
      supports: start.supports,
      origin: start.self ? 'SELF' : 'DESK',
      digioRequestOpen: isDigioRequestOpen(current),
      ownerUserId: advertiser.userId ?? null,
      subject: { name: advertiser.companyName ?? advertiser.name, party: 'ADVERTISER', business: entity.entityType !== 'INDIVIDUAL' },
      markProviderFailed: () => repository.markProviderFailed(key),
    },
    now,
  );
  const fields = { method: started.provider, digioRequestId: started.requestId, digioReferenceId: referenceId, digioStatus: 'pending', submittedAt: now };

  if (entity.change === 'UPGRADE') {
    // Only once Digio has the new request: a refused upgrade leaves the individual verified.
    await repository.reopenDigioForUpgrade(key, fields);
    await setAdvertiserEntityType(advertiser.id, entity.entityType);
    await applyKycDecision(advertiser.id, 'PENDING');
    await logActivity(start.byUserId, 'KYC_ENTITY_UPGRADED', {
      req: start.req,
      targetType: 'Advertiser',
      targetId: advertiser.id,
      module: 'kyc',
      // The decision it reopens stays here, trimmed to the decision; the row no longer holds it.
      diff: auditDiff(
        { entityType: entity.previous, status: current?.status ?? 'VERIFIED', digioRequestId: current?.digioRequestId ?? null, digioPayload: current?.digioPayload ? trimDigioPayload(current.digioPayload) : null },
        { entityType: entity.entityType, status: 'PENDING', digioRequestId: started.requestId, digioPayload: null },
      ),
      metadata: { party: 'ADVERTISER', kycId: current?.id ?? null },
    });
  } else {
    await repository.upsertDigio(key, fields);
  }
  return partyKycAnswer(started, start.supports);
}

/**
 * Phase D: the desk's MANUAL request names the legal form too, when it is
 * given — stored the way a Digio start stores it; nothing is asked when it
 * is not (a manual request needs no workflow). The caller has refused a
 * verified advertiser already.
 */
export async function noteEntityTypeForManualRequest(advertiser: DigioParty, start: DigioStart): Promise<void> {
  if (start.entityType === undefined) return;
  const entity = entityTypeForKycStart({ party: 'ADVERTISER', stored: advertiser.entityType, legacyType: advertiser.type, verified: false }, start.entityType);
  if (entity?.change !== 'SET') return;
  await setAdvertiserEntityType(advertiser.id, entity.entityType);
  await logActivity(start.byUserId, 'KYC_ENTITY_TYPE_SET', {
    req: start.req,
    targetType: 'Advertiser',
    targetId: advertiser.id,
    module: 'kyc',
    diff: auditDiff({ entityType: entity.previous }, { entityType: entity.entityType }),
    metadata: { party: 'ADVERTISER', at: 'KYC_REQUEST' },
  });
}

/**
 * Phase D: the Edit-details PATCH's upgrade, registered on the advertisers
 * module's port by bootstrap — the same start the desk's request makes,
 * with the new legal form.
 */
export async function upgradeAdvertiserKyc(advertiser: DigioParty, entityType: KycEntityType, by: { userId: string; req?: Request | undefined }) {
  return initiateAdvertiserDigioKyc(advertiser, { byUserId: by.userId, entityType, req: by.req });
}

/** The profile a record belongs to — by its profile key, else by its user. */
async function profileForRecord(row: { advertiserProfileId: string | null; advertiserId: string | null }): Promise<Advertiser | null> {
  if (row.advertiserProfileId) return findAdvertiser(row.advertiserProfileId);
  if (row.advertiserId) return getAdvertiserForUser(row.advertiserId);
  return null;
}

/**
 * The desk restarts an advertiser's Digio check, by the KYC row the queue
 * lists. Same session their phone would ask for, recorded on their row;
 * who asked is logged; the advertiser is told to open the app when they
 * have one. A verified advertiser has nothing to restart.
 */
export async function restartAdvertiserDigioKyc(kycId: string, byUserId: string, req?: Request, body: { entityType?: KycEntityType | undefined } = {}) {
  const row = await repository.findById(kycId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'KYC record not found');
  const advertiser = await profileForRecord(row);
  // Phase D: a verified individual registering a business is the one restart a verified advertiser may have.
  if (row.status === 'VERIFIED' && !(advertiser && isUpgradeRequest('ADVERTISER', advertiser, body.entityType))) {
    throw new ApiError(409, 'CONFLICT', 'This advertiser is already verified; there is nothing to restart');
  }
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'Advertiser profile not found');
  // Account lifecycle (2 Oct 2026): a closed account is never asked; one suspended from new work, not until reinstated.
  assertOpenForKyc({ closedAt: await accountClosedAt(advertiser.userId), suspensionScopes: advertiser.suspensionScopes });
  const session = await initiateAdvertiserDigioKyc(advertiser, { byUserId, entityType: body.entityType, req });
  await logActivity(byUserId, 'ADVERTISER_KYC_DIGIO_RESTARTED', req, { advertiserId: row.advertiserId, advertiserProfileId: advertiser.id, kycRowId: kycId, kycId: session.kycId });
  const userId = row.advertiserId ?? advertiser.userId;
  if (userId) {
    await createNotification({
      userId,
      type: 'KYC',
      title: 'Finish your Digio check',
      message: 'ADX has started a fresh Digio identity check for you. Open the app and finish it — it takes about a minute.',
      relatedId: kycId,
    });
  } else {
    logger.info('Digio restart notice skipped: the advertiser has no app account yet', { kycId, advertiserProfileId: advertiser.id });
  }
  return { kycId: session.kycId, validTill: session.validTill, digioStatus: 'pending' as const, notified: Boolean(userId) };
}

/** `GET /advertiser-kyc/me/digio/status` — N3-B: through the caller's profile, then the legacy user key. */
export async function advertiserDigioStatus(userId: string) {
  const advertiser = await getAdvertiserForUser(userId);
  const row = (advertiser ? await repository.findByProfileId(advertiser.id) : null) ?? (await repository.findByAdvertiserId(userId));
  if (!row) return null;
  return {
    method: row.method,
    digioStatus: row.digioStatus,
    kycStatus: row.status,
    digioVerifiedAt: row.digioVerifiedAt,
  };
}

/**
 * Claims a webhook whose request id is an advertiser's; false when it is
 * not. N3-B: the mirror moves by the profile the record names (else by its
 * user); the notice goes to the user, and is skipped with a logged reason
 * when the profile has none yet.
 */
export async function handleAdvertiserDigioWebhook(payload: DigioWebhookPayload): Promise<boolean> {
  const row = await repository.findByDigioRequestId(payload.id);
  if (!row) return false;

  const decision = digioDecisionOf(payload.status);
  const approved = decision === 'VERIFIED';
  const rejected = decision === 'REJECTED';

  // Phase D: a late or unknown status never un-decides the record (`digio-callback.ts`).
  if (isStaleDigioCallback(row.status, decision)) {
    logger.info('Digio webhook left a decided advertiser record as it was', { kycId: payload.id, status: payload.status, recordStatus: row.status });
    return true;
  }

  // Cashfree Phase 1: a Cashfree session's outcome comes down this road too — its request id says so.
  const via = hostedProviderOf(payload.id);
  const verifier = hostedProviderName(via);

  await repository.applyDigioWebhook(row.id, {
    via,
    digioStatus: payload.status,
    digioPayload: payload,
    digioVerifiedAt: payload.completed_at ? new Date(payload.completed_at) : approved ? new Date() : undefined,
    status: decision,
    reviewedAt: approved || rejected ? new Date() : undefined,
    rejectionReason: rejected ? (payload.message ?? `KYC rejected by ${verifier}`) : undefined,
  });

  if (decision !== 'PENDING') {
    if (row.advertiserProfileId) await applyKycDecision(row.advertiserProfileId, decision);
    else if (row.advertiserId) await applyKycDecisionByUserId(row.advertiserId, decision);
  }

  logger.info('Digio webhook applied to an advertiser', { kycId: payload.id, status: payload.status });

  if (!row.advertiserId) {
    logger.info('KYC_DECISION notice skipped: the advertiser has no app account yet', { kycId: row.id, advertiserProfileId: row.advertiserProfileId, status: payload.status });
    return true;
  }

  await createNotification({
    userId: row.advertiserId,
    type: 'KYC',
    title: approved ? 'Identity verified' : rejected ? 'Identity check did not clear' : 'Identity check update',
    message: approved
      ? `${verifier} has verified your identity. You can book once the rest of your setup is done.`
      : rejected
        ? `${verifier} could not verify you. ${payload.message ?? 'You can try again, or upload your documents instead.'}`
        : via === 'CASHFREE'
          ? cashfreeProgressLine(payload.status)
          : `Your Digio check is ${payload.status}.`,
    relatedId: row.id,
  });

  return true;
}

/** What a person is told while their Cashfree steps are with ADX: the checks are in and a person is reading the papers, or a check did not pass. */
function cashfreeProgressLine(status: string): string {
  return status === 'in_review' ? 'Your identity checks are in. ADX is reviewing your documents.' : 'Your identity check needs another look. ADX will be in touch.';
}

/**
 * Cashfree Phase 1: an advertiser's KYC case, for the desk's "Resend on
 * backup" (registered as `ADVERTISER_KYC`, keyed by the Advertiser PROFILE
 * id). The write is the one a Digio start makes, with the session's id in
 * the request column.
 */
export const advertiserBackupCase: BackupCasePort = {
  async load(advertiserProfileId) {
    const advertiser = await findAdvertiser(advertiserProfileId);
    if (!advertiser) return null;
    const record = (await repository.findByProfileId(advertiser.id)) ?? (advertiser.userId ? await repository.findByAdvertiserId(advertiser.userId) : null);
    const entityType = effectiveEntityType('ADVERTISER', advertiser);
    return {
      ownerUserId: advertiser.userId ?? null,
      subject: { name: advertiser.companyName ?? advertiser.name, party: 'ADVERTISER', business: entityType !== null && entityType !== 'INDIVIDUAL' },
      workflowKey: workflowKeyFor({ party: 'ADVERTISER', entityType }),
      verified: record?.status === 'VERIFIED' || advertiser.kycStatus === 'VERIFIED',
    };
  },
  async stamp(advertiserProfileId, fields) {
    const advertiser = await findAdvertiser(advertiserProfileId);
    if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'Advertiser profile not found');
    const current = (await repository.findByProfileId(advertiser.id)) ?? (advertiser.userId ? await repository.findByAdvertiserId(advertiser.userId) : null);
    // A legacy user-keyed row is written where it is — by its id — and adopts the profile key, as a Digio start does.
    const key: AdvertiserKycKey = current && !current.advertiserProfileId ? { id: current.id, ...keyOf(advertiser) } : keyOf(advertiser);
    const { at, ...columns } = fields;
    return repository.upsertDigio(key, { ...columns, submittedAt: at });
  },
};
