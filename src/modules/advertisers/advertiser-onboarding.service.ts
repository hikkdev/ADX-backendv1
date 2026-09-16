import { ApiError } from '../../shared/errors';
import {
  ONBOARDING_QR_TTL_SECONDS,
  deactivateQrsFor,
  decideOnboardingScan,
  findActiveQrFor,
  findPendingScan,
  generateQr,
} from '../qr';
import type { ClaimedAdvertiser } from '../qr';
import { findAgentProfile } from '../agents';
import { accessLogFor, closeOnboardingGrants, hasLiveOnboardingGrant, openOnboardingGrant } from '../access-grants';
import { getAdvertiserForUser } from './advertisers.service';
import { prismaAdvertisersRepository as repository } from './prisma-advertisers.repository';

/**
 * The door-to-door code, demand side.
 *
 * The same code the publisher shows, for an advertiser: ninety seconds,
 * one-time, claims nothing until its owner approves the named agent from
 * their own phone. Approval records attribution (`Advertiser.agentId`, set
 * once and kept) and opens a separate authority — an ONBOARDING grant on
 * the advertiser — which is what the agent's writes will run under.
 *
 * Advertisers carry no onboarding status column; whether an agent is mid-way
 * is read off the grant itself, which is the truer answer anyway.
 */

async function mine(userId: string) {
  const advertiser = await repository.findAdvertiserByUserId(userId);
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'Advertiser profile not found');
  return advertiser;
}

export async function getOrCreateOnboardingQr(
  userId: string,
  position?: { latitude: number; longitude: number },
) {
  const advertiser = await mine(userId);
  if (await hasLiveOnboardingGrant({ advertiserId: advertiser.id })) {
    throw new ApiError(409, 'CONFLICT', 'An agent is already onboarding you.');
  }

  const existing = await findActiveQrFor('ADVERTISER', advertiser.id);
  if (existing && (existing.expiresAt === null || existing.expiresAt.getTime() > Date.now())) {
    return { qrId: existing.id, token: existing.token, expiresAt: existing.expiresAt, created: false };
  }
  if (existing) await deactivateQrsFor('ADVERTISER', advertiser.id);

  const { qrId, token, expiresAt } = await generateQr(
    'ADVERTISER',
    advertiser.id,
    ['AGENT_ADVERTISER'],
    undefined,
    { expiresInSeconds: ONBOARDING_QR_TTL_SECONDS, position },
  );
  return { qrId, token, expiresAt, created: true };
}

export async function getOnboardingQrStatus(userId: string) {
  const advertiser = await mine(userId);
  const qr = await findActiveQrFor('ADVERTISER', advertiser.id);
  const live = qr !== null && (qr.expiresAt === null || qr.expiresAt.getTime() > Date.now());
  const pendingScan = qr ? await findPendingScan(qr.id) : null;

  let pending = null;
  if (pendingScan) {
    const agent = await findAgentProfile(pendingScan.scannedById);
    const person = agent ? await repository.findUserSummary(pendingScan.scannedById) : null;
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
    onboarding: (await hasLiveOnboardingGrant({ advertiserId: advertiser.id })) ? 'WITH_AGENT' : 'SELF',
    qr: qr ? { qrId: qr.id, expiresAt: qr.expiresAt, live } : null,
    pending,
  };
}

export async function decideMyOnboardingScan(
  userId: string,
  scanId: string,
  decision: 'approve' | 'decline',
) {
  const advertiser = await mine(userId);
  return decideOnboardingScan(scanId, advertiser.id, decision);
}

// ── The QR module's AdvertiserOnboardingPort ───────────────────────────────

/** Validation half of a claim. No writes. Throws the QR_* sentinels. */
export async function prepareClaim(
  advertiserId: string,
  scannedByUserId: string,
): Promise<{ advertiser: ClaimedAdvertiser; agentId: string }> {
  const advertiser = await repository.findAdvertiserById(advertiserId);
  if (!advertiser) throw new Error('QR_NOT_FOUND');
  if (await hasLiveOnboardingGrant({ advertiserId })) throw new Error('QR_ALREADY_CLAIMED');
  const agent = await findAgentProfile(scannedByUserId);
  if (!agent) throw new Error('QR_ACCESS_DENIED');
  return {
    advertiser: { id: advertiser.id, name: advertiser.name, mobile: advertiser.mobile, type: advertiser.type },
    agentId: agent.id,
  };
}

/**
 * Write half, once the owner has approved. Attribution is set once and kept
 * — a second agent later does not rewrite who brought them in — and the
 * authority is opened fresh each time.
 */
export async function commitClaim(
  advertiserId: string,
  agentId: string,
  context: { qrId: string; scanId: string },
): Promise<{ grantId: string | null }> {
  await repository.attachAgent(advertiserId, agentId);
  const grant = await openOnboardingGrant({ subject: { advertiserId }, agentId, qrId: context.qrId });
  return { grantId: grant.id };
}

/** Called when the advertiser's onboarding is done, whichever way. */
/** U9 — who has had access to this account, from the owner's side. */
export async function getMyAccessLog(userId: string) {
  const advertiser = await getAdvertiserForUser(userId);
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'Advertiser profile not found');
  return accessLogFor({ advertiserId: advertiser.id });
}

export async function closeOnboarding(advertiserId: string): Promise<number> {
  return closeOnboardingGrants({ advertiserId });
}
