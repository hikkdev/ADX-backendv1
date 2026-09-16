import type { Request } from 'express';
import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import type { Advertiser } from '../../../shared/database';
import { requestDigioKyc, type DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { applyKycDecision, applyKycDecisionByUserId, findAdvertiser, getAdvertiserForUser } from '../../advertisers';
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

/** What a session needs of the party: the key, and the customer Digio reaches. */
export type DigioParty = Pick<Advertiser, 'id' | 'userId' | 'name' | 'companyName' | 'email' | 'mobile'>;

const keyOf = (advertiser: DigioParty): AdvertiserKycKey => ({ advertiserProfileId: advertiser.id, advertiserId: advertiser.userId });

export async function initiateAdvertiserDigioKyc(advertiser: DigioParty, now = new Date()) {
  // N2 verifier: a verified advertiser has nothing to start — a fresh
  // session would re-point the row and its webhook would write over
  // VERIFIED. Refused like every other submit path (N2-B).
  const current = (await repository.findByProfileId(advertiser.id)) ?? (advertiser.userId ? await repository.findByAdvertiserId(advertiser.userId) : null);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This advertiser is already verified; there is nothing to start');
  }
  const referenceId = `${DIGIO_REFERENCE_PREFIX}${advertiser.id}-${now.getTime()}`;
  const session = await requestDigioKyc({
    referenceId,
    customerName: advertiser.companyName ?? advertiser.name,
    customerEmail: advertiser.email ?? '',
    customerMobile: advertiser.mobile,
  });
  // A legacy user-keyed row (no profile key yet) is written where it is — by its id — and adopts the profile key.
  const key: AdvertiserKycKey = current && !current.advertiserProfileId ? { id: current.id, ...keyOf(advertiser) } : keyOf(advertiser);
  await repository.upsertDigio(key, {
    method: 'DIGIO',
    digioRequestId: session.kycId,
    digioReferenceId: referenceId,
    digioStatus: 'pending',
    submittedAt: now,
  });
  return { kycId: session.kycId, accessToken: session.accessToken, validTill: session.validTill, sdkUrl: session.sdkUrl };
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
export async function restartAdvertiserDigioKyc(kycId: string, byUserId: string, req?: Request) {
  const row = await repository.findById(kycId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'KYC record not found');
  if (row.status === 'VERIFIED') {
    throw new ApiError(409, 'CONFLICT', 'This advertiser is already verified; there is nothing to restart');
  }
  const advertiser = await profileForRecord(row);
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'Advertiser profile not found');
  const session = await initiateAdvertiserDigioKyc(advertiser);
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

  const approved = payload.status === 'approved';
  const rejected = payload.status === 'rejected';
  const decision = approved ? 'VERIFIED' : rejected ? 'REJECTED' : 'PENDING';

  await repository.applyDigioWebhook(row.id, {
    digioStatus: payload.status,
    digioPayload: payload,
    digioVerifiedAt: payload.completed_at ? new Date(payload.completed_at) : approved ? new Date() : undefined,
    status: decision,
    reviewedAt: approved || rejected ? new Date() : undefined,
    rejectionReason: rejected ? (payload.message ?? 'KYC rejected by Digio') : undefined,
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
      ? 'Digio has verified your identity. You can book once the rest of your setup is done.'
      : rejected
        ? `Digio could not verify you. ${payload.message ?? 'You can try again, or upload your documents instead.'}`
        : `Your Digio check is ${payload.status}.`,
    relatedId: row.id,
  });

  return true;
}
