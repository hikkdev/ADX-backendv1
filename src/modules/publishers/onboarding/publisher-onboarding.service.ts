import { ApiError } from '../../../shared/errors';
import { isVerifiedParty, publisherReadiness } from '../../../shared/kyc-state';
import { dateOfBirthToDate, dateOfBirthToString } from '../../../shared/validation';
import { money, type Money } from '../../../shared/money';
import type { PublisherType } from '../../../shared/database';
import { allocateIdentifier } from '../../identifiers';
import {
  ONBOARDING_QR_TTL_SECONDS,
  deactivateQrsFor,
  decideOnboardingScan,
  findActiveQrFor,
  findPendingScan,
  generateQr,
} from '../../qr';
import { findAgentProfile, findAgentTier, requireAgentProfile } from '../../agents';
import { closeOnboardingGrants, openOnboardingGrant, accessLogFor } from '../../access-grants';
import { recordIncentiveOnce } from '../../payouts';
import { withCityKey } from '../../pricing';
import { getDigioKycStatus, initiateDigioKyc } from '../kyc/digio.service';
import { assertResubmissionCarriesDocuments, clearReviewsForResubmission, pinKycManifest, splitKycSubmission } from '../kyc/kyc-desk.service';
import { prismaPublishersRepository as repository } from '../prisma-publishers.repository';
import type { ClaimedPublisher } from '../../qr';
import type { KycDocuments, PublisherPatch } from '../publishers.repository';

/**
 * Publisher self-registration from the user app, called once OTP is verified.
 *
 * Idempotent: a second call returns the existing profile with 200 rather than
 * conflicting, because the app may retry.
 *
 * Two ways a number can already have a publisher row, and they are told
 * apart: a row *this user* owns is simply returned; a row with no user is one
 * an agent opened for this number at the door before its owner ever signed
 * in, and this is that owner arriving — it is linked, not refused. The
 * unique mobile on Publisher is what would otherwise turn that arrival into
 * a 500.
 *
 * The name is optional because DR 08 asks for it two steps after the account
 * type. Until it is given the profile is known by its number, and the User
 * row is left alone — only a name actually supplied is written there.
 */
export async function registerProfile(
  userId: string,
  input: { name?: string; email?: string; type?: PublisherType } = {},
) {
  const existing = await repository.findByUserId(userId);
  if (existing) return { publisher: existing, created: false };

  const user = await repository.findUserMobile(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const held = await repository.findByMobile(user.mobile);
  if (held) {
    if (held.userId) {
      throw new ApiError(409, 'CONFLICT', 'This number already belongs to another publisher account.');
    }
    return { publisher: await repository.attachUser(held.id, userId), created: false };
  }

  // The name and email supplied here also update the user record — the
  // publisher app collects them once, for both.
  if (input.name) await repository.setUserProfile(userId, input.name, input.email);

  // Self-registration is the other way a publisher comes into existence, so it
  // allocates too — otherwise app signups would arrive without an identifier.
  const displayId = await allocateIdentifier('PUBLISHER');
  const publisher = await repository.createSelfRegistered({
    displayId,
    userId,
    name: input.name ?? user.name ?? user.mobile,
    mobile: user.mobile,
    email: input.email,
    type: input.type,
  });

  return { publisher, created: true };
}

export async function getMyProfile(userId: string) {
  const publisher = await repository.findByUserIdWithKyc(userId);
  if (!publisher) {
    throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found. Complete registration first.');
  }
  // QR-3: the one figure the home draws and the checklist behind it — the
  // basics, the identity check, the terms — and the verified mark. Derived
  // here from the row so the app and the listing door read the same rule.
  const { user, ...row } = publisher;
  const dateOfBirth = dateOfBirthToString(user?.dateOfBirth);
  return {
    ...row,
    dateOfBirth,
    gender: user?.gender ?? null,
    // QR-7: the person's profile picture, off the User row, for the home's
    // avatar and the side menu.
    avatarUrl: user?.avatarUrl ?? null,
    readiness: publisherReadiness({ ...row, dateOfBirth }),
    // QR-22: the terms are taken at sign-up now; the home and the ladder's
    // last screen read this rather than asking twice.
    platformAgreementAcceptedAt: await repository.findPlatformAgreementAcceptedAt(publisher.id),
    verified: isVerifiedParty(publisher.kycStatus),
  };
}

/**
 * The onboarding QR a publisher shows an agent at the door.
 *
 * Ninety seconds, one-time. A live code is reused so the one on screen is not
 * pulled from under them; a code that has died is replaced — "show my code
 * again" reissues rather than extends. The phone's fix at generation rides
 * on the code so the agent's fix at scan can be measured against it.
 */
export async function getOrCreateOnboardingQr(
  userId: string,
  position?: { latitude: number; longitude: number },
) {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');

  if (publisher.onboardingStatus === 'IN_ONBOARDING') {
    throw new ApiError(409, 'CONFLICT', 'Your onboarding is already in progress with an agent.');
  }
  if (publisher.onboardingStatus === 'ONBOARDING_COMPLETE') {
    throw new ApiError(409, 'CONFLICT', 'Onboarding is already complete.');
  }

  const existing = await findActiveQrFor('PUBLISHER', publisher.id);
  if (existing && (existing.expiresAt === null || existing.expiresAt.getTime() > Date.now())) {
    return { qrId: existing.id, token: existing.token, expiresAt: existing.expiresAt, created: false };
  }
  if (existing) await deactivateQrsFor('PUBLISHER', publisher.id);

  const { qrId, token, expiresAt } = await generateQr(
    'PUBLISHER',
    publisher.id,
    ['AGENT_PUBLISHER'],
    undefined,
    { expiresInSeconds: ONBOARDING_QR_TTL_SECONDS, position },
  );
  return { qrId, token, expiresAt, created: true };
}

/**
 * What the phone polls while the code is on screen: whether the code is
 * still live, and — the moment an agent scans it — who that agent is, so
 * the owner can approve them by name, photo and id before anything is
 * claimed. The distance between the two fixes is shown, not enforced.
 */
export async function getOnboardingQrStatus(userId: string) {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');

  const qr = await findActiveQrFor('PUBLISHER', publisher.id);
  const live = qr !== null && (qr.expiresAt === null || qr.expiresAt.getTime() > Date.now());
  const pendingScan = qr ? await findPendingScan(qr.id) : null;

  let pending = null;
  if (pendingScan) {
    const agent = await findAgentProfile(pendingScan.scannedById);
    const person = agent ? await repository.findUserMobile(pendingScan.scannedById) : null;
    pending = {
      scanId: pendingScan.id,
      scannedAt: pendingScan.createdAt,
      distanceM: pendingScan.distanceM,
      agent: agent
        ? {
            id: agent.id,
            displayId: agent.displayId,
            city: agent.city,
            name: person?.name ?? null,
            avatarUrl: person?.avatarUrl ?? null,
          }
        : null,
    };
  }

  return {
    onboardingStatus: publisher.onboardingStatus,
    qr: qr ? { qrId: qr.id, expiresAt: qr.expiresAt, live } : null,
    pending,
  };
}

/** The owner's answer to a scan: approve the agent by name, or decline. */
export async function decideMyOnboardingScan(
  userId: string,
  scanId: string,
  decision: 'approve' | 'decline',
) {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');
  return decideOnboardingScan(scanId, publisher.id, decision);
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
  await closeOnboardingGrants({ publisherId });
  await repository.resetOnboardingState(publisherId);
}

/** What a completion answers with beside its own payload (Lot B, Q101). */
export type OnboardingIncentive = { id: string; amount: Money } | null;

/**
 * Lot B (Q101): the onboarding commission.
 *
 * Recorded whenever the publisher carries an agent — whoever pressed the last
 * button. Attribution is the scan the publisher approved, not the completion;
 * an owner who finished the documents alone was still brought in by somebody.
 * Once per publisher (`recordIncentiveOnce`), at the agent's tier,
 * PENDING_VERIFICATION for finance. Never blocks the completion: a rate that
 * cannot be priced is finance's problem, not the publisher's.
 */
async function recordOnboardingCommission(publisher: {
  id: string;
  agentId: string | null;
  displayId: string | null;
  name: string;
}): Promise<OnboardingIncentive> {
  if (!publisher.agentId) return null;
  try {
    const tier = (await findAgentTier(publisher.agentId)) ?? '*';
    const incentive = await recordIncentiveOnce({
      agentId: publisher.agentId,
      event: 'PUBLISHER_ONBOARDED',
      tier,
      publisherId: publisher.id,
      note: `Onboarded ${publisher.displayId ?? publisher.id}: ${publisher.name}`,
      // Lot F: the agent's INCENTIVE_RECORDED notice names the account.
      notice: { partyName: publisher.name },
    });
    return { id: incentive.id, amount: money(incentive.amount as never) };
  } catch {
    return null;
  }
}

export async function completeOnboarding(
  publisherId: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ incentive: OnboardingIncentive }> {
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
  // The authority ends when the onboarding does.
  await closeOnboardingGrants({ publisherId });
  return { incentive: await recordOnboardingCommission(publisher) };
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

/**
 * Write half of a QR claim, run once the owner has approved the scan.
 *
 * Two writes, kept apart on purpose: the claim is attribution — who brought
 * this publisher in, permanent — and the grant is authority — what the agent
 * may write, for how long, revocable. The grant id goes back to the scan.
 */
export async function commitClaim(
  publisherId: string,
  agentId: string,
  context: { qrId: string; scanId: string },
): Promise<{ grantId: string | null }> {
  await repository.claim(publisherId, agentId);
  const grant = await openOnboardingGrant({ subject: { publisherId }, agentId, qrId: context.qrId });
  return { grantId: grant.id };
}

// ── Self-service, DR 08 ─────────────────────────────────────────────────────
//
// The routes above this line were written for a publisher an agent brings in.
// These are for the one who does it themselves: the same rows, addressed by
// the session rather than by a publisher id somebody else holds.

async function mine(userId: string) {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');
  return publisher;
}

/**
 * U7 — KYC by Digio, chosen by the publisher rather than by an agent. The
 * same request the agent path makes, keyed on the caller's own profile; the
 * webhook that lands afterwards marks the row VERIFIED or REJECTED exactly
 * as it does for the agent path, and `completeMyOnboarding` closes on the
 * strength of `submittedAt`, which the initiation stamps.
 */
export async function initiateMyDigioKyc(userId: string) {
  const publisher = await mine(userId);
  return initiateDigioKyc(publisher.id, publisher.name, publisher.email ?? '', publisher.mobile);
}

export async function myDigioKycStatus(userId: string) {
  const publisher = await mine(userId);
  return getDigioKycStatus(publisher.id);
}

/** U9 — who has had access to this account, from the owner's side. */
export async function getMyAccessLog(userId: string) {
  const publisher = await mine(userId);
  return accessLogFor({ publisherId: publisher.id });
}

/** Steps 2–4: what the publisher types about themselves. */
export async function updateMyProfile(userId: string, input: PublisherPatch & { dateOfBirth?: string; gender?: string }) {
  // Lot X-B: the city key rides with the typed city.
  const publisher = await mine(userId);
  // QR-5: the person's own details go to their User row; the rest is the
  // publisher's. A pin is both halves or neither.
  const { dateOfBirth, gender, ...patch } = input;
  if ((patch.latitude === undefined) !== (patch.longitude === undefined)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Send latitude and longitude together, or neither.');
  }
  if (dateOfBirth !== undefined || gender !== undefined) {
    await repository.setUserDetails(userId, {
      ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirthToDate(dateOfBirth) } : {}),
      ...(gender !== undefined ? { gender } : {}),
    });
  }
  const updated = await repository.update(publisher.id, await withCityKey(patch));
  // QR-13: the basics in, the onboarding is done — no separate call needed.
  await settleOnboardingIfReady(publisher.id);
  return { ...updated, ...(dateOfBirth !== undefined ? { dateOfBirth } : {}), ...(gender !== undefined ? { gender } : {}) };
}

/** The KYC row, or null before the first submission — a state the ladder routes on. */
export async function getMyKyc(userId: string) {
  const publisher = await repository.findByUserIdWithKyc(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');
  return publisher.kyc;
}

/**
 * Steps 6–11: the documents, in the publisher's own hands. Lot D (Q42):
 * while NEEDS_INFO the body may be partial — only the flagged documents —
 * and whatever was decided about the fields sent no longer applies; the
 * row returns to PENDING with a fresh `submittedAt` either way.
 */
/**
 * `POST /publishers/me/kyc` — first time and every time after: the columns
 * sent are written, the rest kept, the record goes (back) to PENDING. Lot D
 * (Q42) / Lot F: while NEEDS_INFO the body is partial — only the flagged DR
 * 08 columns — and the decisions on the fields sent are cleared; the fields
 * not sent keep their files and their decisions. The first submission pins
 * the manifest version the phone rendered.
 */
export async function submitMyKyc(userId: string, input: KycDocuments & { manifestVersion?: number | undefined }) {
  // With the KYC row: E9 refuses an empty resubmission while NEEDS_INFO.
  const publisher = await repository.findByUserIdWithKyc(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');
  const { docs, manifestVersion } = splitKycSubmission(input);
  assertResubmissionCarriesDocuments(publisher.kyc, Object.keys(docs));
  // Lot N: the publisher's own hand — who recorded it, and how.
  const kyc = await repository.submitKyc(publisher.id, docs, { recordedById: userId, recordedVia: 'SELF', method: 'MANUAL' });
  await pinKycManifest(publisher.id, manifestVersion);
  await clearReviewsForResubmission(kyc, Object.keys(docs));
  return kyc;
}

/**
 * The end of a self-run ladder.
 *
 * `completeOnboarding` above needs the claiming agent, which a publisher who
 * did it themselves never had — so they sat at PENDING_ONBOARDING for ever.
 * This closes it on their own submission: KYC must have been sent, and an
 * agent must not be mid-way through it on their behalf.
 */
export async function completeMyOnboarding(userId: string) {
  const publisher = await repository.findByUserIdWithKyc(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');
  if (publisher.onboardingStatus === 'ONBOARDING_COMPLETE') return { ...publisher, incentive: null as OnboardingIncentive };
  if (publisher.onboardingStatus === 'IN_ONBOARDING') {
    throw new ApiError(409, 'CONFLICT', 'An agent is completing your onboarding with you.');
  }
  // QR-13 (the owner, 17 Sep): KYC ranks, it does not gate — the basics are
  // what completes an onboarding, on this path and at the desk alike. A
  // publisher whose documents are already in has given them along the way.
  if (!onboardingBasicsIn(publisher) && !publisher.kyc?.submittedAt) {
    throw new ApiError(400, 'BAD_REQUEST', 'Your name, email, address and date of birth are needed first.');
  }
  const completed = await repository.completeOnboarding(publisher.id);
  await closeOnboardingGrants({ publisherId: publisher.id });
  // Q101: the agent who scanned them in is paid even when the owner finished alone.
  const incentive = await recordOnboardingCommission(publisher);
  return { ...(completed as object), incentive };
}

/** The four basics the readiness rule counts, off the row the KYC read joins. */
function onboardingBasicsIn(publisher: { name: string | null; email: string | null; address: string | null; user?: { dateOfBirth?: Date | null } | null }): boolean {
  return Boolean(publisher.name && publisher.email && publisher.address && publisher.user?.dateOfBirth);
}

/**
 * QR-13: an onboarding completes itself the moment the basics are in —
 * from the app's own profile edit or the desk's — with everything the
 * explicit call does (grants closed, the scanning agent paid). A row that
 * is complete, or that an agent is walking through, is left alone.
 */
export async function settleOnboardingIfReady(publisherId: string): Promise<boolean> {
  const publisher = await repository.findByIdWithUser(publisherId);
  if (!publisher || publisher.onboardingStatus !== 'PENDING_ONBOARDING') return false;
  if (!onboardingBasicsIn(publisher)) return false;
  await repository.completeOnboarding(publisher.id);
  await closeOnboardingGrants({ publisherId: publisher.id });
  await recordOnboardingCommission(publisher as never);
  return true;
}
