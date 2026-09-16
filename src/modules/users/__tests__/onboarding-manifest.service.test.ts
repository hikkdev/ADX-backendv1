import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D — the manifest composed for the caller's own record.
 *
 * What is pinned: the publisher side reads the publisher's review state and
 * the advertiser side the advertiser's; both read the liveness video and the
 * Digio switch; a NEEDS_INFO record comes back as the partial ladder; an
 * account with no side is 409.
 *
 * Q83: the ladder is `flows.onboarding` when the row holds one that fits the
 * vocabulary, at the version the phone asks for; the code ladder when the
 * key is absent or the row does not fit.
 */

const { repository, publishers, kyc, integrations, appConfig, logging } = vi.hoisted(() => ({
  repository: { findProfile: vi.fn() },
  publishers: { publisherKycReviewStateFor: vi.fn(), registerPublisher: vi.fn() },
  kyc: { advertiserKycReviewStateFor: vi.fn(), livenessStateFor: vi.fn() },
  integrations: { digioAvailability: vi.fn() },
  appConfig: { getFlow: vi.fn() },
  logging: { warn: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../publishers', () => publishers);
vi.mock('../../kyc', () => kyc);
vi.mock('../../../shared/integrations', () => integrations);
vi.mock('../../app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app-config')>()),
  getFlow: appConfig.getFlow,
}));
vi.mock('../../../shared/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/logging')>();
  return { ...actual, logger: { ...actual.logger, warn: logging.warn } };
});

import { onboardingManifest } from '../onboarding-manifest.service';
import { CODE_ONBOARDING_TEMPLATE } from '../onboarding-manifest';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findProfile.mockResolvedValue({ id: 'usr_1', publisherProfile: { type: 'BUSINESS' }, advertiserProfile: { type: 'INDIVIDUAL' } });
  publishers.publisherKycReviewStateFor.mockResolvedValue({ status: 'NEEDS_INFO', method: 'MANUAL', reviewNote: 'Blurry', flagged: [{ field: 'selfieUrl', note: null }] });
  kyc.advertiserKycReviewStateFor.mockResolvedValue(null);
  kyc.livenessStateFor.mockResolvedValue({ status: 'PENDING', rejectionReason: null });
  integrations.digioAvailability.mockResolvedValue({ available: false, provider: 'MANUAL', retryAfter: 3600 });
  appConfig.getFlow.mockResolvedValue(null);
});

describe('onboardingManifest', () => {
  it('composes the publisher ladder from the publisher review state, the video and the switch', async () => {
    const manifest = await onboardingManifest('usr_1');
    expect(manifest).toMatchObject({ party: 'PUBLISHER', accountType: 'BUSINESS', mode: 'partial' });
    expect(manifest.steps.map((s) => s.key)).toEqual(['selfie', 'checklist']);
    expect(manifest.verification).toEqual({
      digio: { available: false, provider: 'MANUAL', retryAfter: 3600 },
      liveness: { required: true, status: 'PENDING' },
      kycStatus: 'NEEDS_INFO',
      reviewNote: 'Blurry',
    });
    expect(kyc.advertiserKycReviewStateFor).not.toHaveBeenCalled();
  });

  it('asks the advertiser side when told to, and gives the full ladder before a first submission', async () => {
    const manifest = await onboardingManifest('usr_1', 'ADVERTISER');
    expect(manifest).toMatchObject({ party: 'ADVERTISER', accountType: 'INDIVIDUAL', mode: 'full' });
    expect(kyc.advertiserKycReviewStateFor).toHaveBeenCalledWith('usr_1');
    expect(publishers.publisherKycReviewStateFor).not.toHaveBeenCalled();
    expect(manifest.verification.kycStatus).toBeNull();
  });

  it('is 409 for an account that has not chosen a side', async () => {
    repository.findProfile.mockResolvedValue({ id: 'usr_1', publisherProfile: null, advertiserProfile: null });
    await expect(onboardingManifest('usr_1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the template behind the ladder (Q83)', () => {
  it('is the code ladder, version 1, when the row has no onboarding key', async () => {
    const manifest = await onboardingManifest('usr_1', 'ADVERTISER');
    expect(appConfig.getFlow).toHaveBeenCalledWith('onboarding', undefined);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.steps).toHaveLength(10);
  });

  it('is the stored template when the row holds one, at the version the phone asks for', async () => {
    const stored = JSON.parse(JSON.stringify(CODE_ONBOARDING_TEMPLATE)) as typeof CODE_ONBOARDING_TEMPLATE;
    stored.version = 3;
    stored.steps['selfie'] = { ...stored.steps['selfie']!, title: 'A photo of you' };
    appConfig.getFlow.mockResolvedValue(stored);

    const manifest = await onboardingManifest('usr_1', 'ADVERTISER', 3);
    expect(appConfig.getFlow).toHaveBeenCalledWith('onboarding', 3);
    expect(manifest.manifestVersion).toBe(3);
    expect(manifest.steps.find((s) => s.key === 'selfie')).toMatchObject({ title: 'A photo of you' });
    expect(logging.warn).not.toHaveBeenCalled();
  });

  /* Lot F: the pin is the server's. The KYC row remembers the version the
     party started on; the read serves it when the phone does not ask. */
  it('serves the version pinned on the KYC row when the phone asks for none; an explicit ?version= still wins', async () => {
    const stored = JSON.parse(JSON.stringify(CODE_ONBOARDING_TEMPLATE)) as typeof CODE_ONBOARDING_TEMPLATE;
    stored.version = 2;
    appConfig.getFlow.mockResolvedValue(stored);
    kyc.advertiserKycReviewStateFor.mockResolvedValue({ status: 'PENDING', method: 'MANUAL', reviewNote: null, manifestVersion: 2, flagged: [] });

    const pinned = await onboardingManifest('usr_1', 'ADVERTISER');
    expect(appConfig.getFlow).toHaveBeenCalledWith('onboarding', 2);
    expect(pinned.manifestVersion).toBe(2);

    appConfig.getFlow.mockClear();
    await onboardingManifest('usr_1', 'ADVERTISER', 5);
    expect(appConfig.getFlow).toHaveBeenCalledWith('onboarding', 5);

    // The publisher row pins the same way.
    appConfig.getFlow.mockClear();
    publishers.publisherKycReviewStateFor.mockResolvedValue({ status: 'PENDING', method: 'MANUAL', reviewNote: null, manifestVersion: 4, flagged: [] });
    await onboardingManifest('usr_1', 'PUBLISHER');
    expect(appConfig.getFlow).toHaveBeenCalledWith('onboarding', 4);

    // No row yet, nothing asked: today's template.
    appConfig.getFlow.mockClear();
    kyc.advertiserKycReviewStateFor.mockResolvedValue(null);
    await onboardingManifest('usr_1', 'ADVERTISER');
    expect(appConfig.getFlow).toHaveBeenCalledWith('onboarding', undefined);
  });

  it('falls back to the code ladder, and says so, when the stored template does not fit the vocabulary', async () => {
    const broken = JSON.parse(JSON.stringify(CODE_ONBOARDING_TEMPLATE)) as typeof CODE_ONBOARDING_TEMPLATE;
    broken.version = 2;
    broken.ladders.ADVERTISER.INDIVIDUAL = broken.ladders.ADVERTISER.INDIVIDUAL.filter((id) => id !== 'pan');
    appConfig.getFlow.mockResolvedValue(broken);

    const manifest = await onboardingManifest('usr_1', 'ADVERTISER');
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.steps.map((s) => s.key)).toContain('pan');
    expect(logging.warn).toHaveBeenCalledWith(
      'flows.onboarding does not fit the ladder vocabulary; serving the code ladder',
      expect.objectContaining({ version: 2 }),
    );
  });
});
