import { ApiError } from '../../shared/errors';
import { digioAvailability } from '../../shared/integrations';
import { logger } from '../../shared/logging';
import { publisherKycReviewStateFor } from '../publishers';
import { advertiserKycReviewStateFor, livenessStateFor } from '../kyc';
import { getFlow, ONBOARDING_FLOW_KEY, onboardingTemplateSchema, type OnboardingTemplate } from '../app-config';
import { prismaUsersRepository as repository } from './prisma-users.repository';
import { buildOnboardingManifest, type ManifestKycContext, type OnboardingManifest } from './onboarding-manifest';
import type { AccountType, Party } from './users.schema';

/** The account types back out of each side's legal-form column. */
const PUBLISHER_ACCOUNT_TYPE: Record<string, AccountType> = {
  INDIVIDUAL: 'INDIVIDUAL',
  BUSINESS: 'BUSINESS',
  NGO: 'ORGANISATION',
  POLITICAL: 'ORGANISATION',
};
const ADVERTISER_ACCOUNT_TYPE: Record<string, AccountType> = {
  INDIVIDUAL: 'INDIVIDUAL',
  COMMERCIAL: 'BUSINESS',
  AGENCY: 'BUSINESS',
  NGO: 'ORGANISATION',
};

/**
 * GET /users/me/onboarding-manifest — the ladder for the caller's own side.
 *
 * An account with both sides gets the publisher one unless asked; an account
 * with neither has not answered Step 1 yet, which is a 409 rather than a
 * ladder with a hole in it.
 *
 * Lot D: the ladder now knows the record it climbs towards — while the
 * record is NEEDS_INFO it is the partial ladder of flagged tiles (Q42), it
 * carries the liveness video's state (Q131), and it says whether the Digio
 * branch may be offered right now (Q129).
 *
 * Q83: the ladder is composed from `flows.onboarding` when the row holds a
 * template that passes the validator, at the `version` the party started
 * on, so a console edit does not move the rungs under a party mid-climb.
 * Lot F: that pin is the server's — `PublisherKyc.manifestVersion` /
 * `AdvertiserKyc.manifestVersion`, stamped at the first KYC submission —
 * and this read answers it whenever the row has one and no `?version=` is
 * given. An explicit `?version=` (a phone from before the column) still
 * wins. With no key, or a key that fails the validator, it is the code ladder.
 */
export async function onboardingManifest(userId: string, party?: Party, version?: number): Promise<OnboardingManifest> {
  const user = await repository.findProfile(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  const publisher = user.publisherProfile as { type: string } | null;
  const advertiser = user.advertiserProfile as { type: string } | null;

  const side = party ?? (publisher ? 'PUBLISHER' : advertiser ? 'ADVERTISER' : null);
  if (side === 'PUBLISHER' && publisher) {
    const { context, pinnedVersion } = await contextFor('PUBLISHER', userId);
    const template = await templateAt(version ?? pinnedVersion);
    return buildOnboardingManifest('PUBLISHER', PUBLISHER_ACCOUNT_TYPE[publisher.type] ?? 'INDIVIDUAL', context, template);
  }
  if (side === 'ADVERTISER' && advertiser) {
    const { context, pinnedVersion } = await contextFor('ADVERTISER', userId);
    const template = await templateAt(version ?? pinnedVersion);
    return buildOnboardingManifest('ADVERTISER', ADVERTISER_ACCOUNT_TYPE[advertiser.type] ?? 'INDIVIDUAL', context, template);
  }
  throw new ApiError(409, 'CONFLICT', 'Choose which kind of account this is first.');
}

/**
 * The stored template at a version, or `undefined` for the code ladder. What
 * is served is the parser's output, not the row as read: a jsonb column
 * hands keys back in its own order, and the parser lays them out in the
 * schema's — which is the code ladder's, so the manifest is byte-identical
 * whichever it came from.
 */
async function templateAt(version?: number): Promise<OnboardingTemplate | undefined> {
  const flow = await getFlow(ONBOARDING_FLOW_KEY, version);
  if (!flow) return undefined;
  const parsed = onboardingTemplateSchema.safeParse(flow);
  if (!parsed.success) {
    logger.warn('flows.onboarding does not fit the ladder vocabulary; serving the code ladder', {
      version: flow['version'],
      issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return undefined;
  }
  return parsed.data;
}

/** The KYC record's state for the ladder, and (Lot F) the manifest version it pinned at its first submission. */
async function contextFor(party: Party, userId: string): Promise<{ context: ManifestKycContext; pinnedVersion: number | undefined }> {
  const [review, liveness, digio] = await Promise.all([
    party === 'PUBLISHER' ? publisherKycReviewStateFor(userId) : advertiserKycReviewStateFor(userId),
    livenessStateFor(userId),
    digioAvailability(),
  ]);
  const pinned = review?.manifestVersion;
  return {
    context: {
      status: review?.status ?? null,
      reviewNote: review?.reviewNote ?? null,
      flagged: review?.flagged ?? [],
      liveness: liveness ? { status: liveness.status, rejectionReason: liveness.rejectionReason } : null,
      digio,
    },
    pinnedVersion: typeof pinned === 'number' && pinned > 0 ? pinned : undefined,
  };
}
