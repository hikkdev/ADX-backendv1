import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-5 (17 Sep 2026) — the details the ladder collects before the first
 * listing: a date of birth and a gender (the person's, on the User row) and
 * the pin behind the address (the publisher's).
 *
 * Pinned: `PATCH /publishers/me` takes `dateOfBirth` (YYYY-MM-DD, eighteen
 * or over) and `gender` and writes them to the person, never to the
 * publisher row; the pin is both halves or neither, null clears; the own
 * read carries `dateOfBirth` as YYYY-MM-DD and `gender`, and the readiness
 * counts the date of birth among the basics — so a publisher with name,
 * email and address and no date of birth may not list, and with all four
 * may list and go live whatever the identity check says.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findByUserId: vi.fn(),
    // QR-13: the settle rule's read — null leaves the status alone.
    findByIdWithUser: vi.fn().mockResolvedValue(null),
    findByUserIdWithKyc: vi.fn(),
    findPlatformAgreementAcceptedAt: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    setUserDetails: vi.fn(),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../pricing', () => ({
  cityKeyFor: async () => null,
  withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: null }),
}));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../qr', () => ({ deactivateQrsFor: vi.fn(), findActiveQrFor: vi.fn(), generateQr: vi.fn() }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentTier: vi.fn(), findAgentProfile: vi.fn() }));
vi.mock('../../payouts', () => ({ recordIncentiveOnce: vi.fn() }));
vi.mock('../../access-grants', () => ({ closeOnboardingGrants: vi.fn(), openOnboardingGrant: vi.fn(), accessLogFor: vi.fn() }));
vi.mock('../../kyc', () => ({
  clearDocumentReviews: vi.fn(),
  resolveManifestVersion: vi.fn(),
  flagDocuments: vi.fn(),
  flaggedDocuments: vi.fn(),
  listDocumentReviews: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  livenessStateFor: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
}));

import { getMyProfile, updateMyProfile } from '../onboarding/publisher-onboarding.service';
import { updateMyProfileSchema } from '../publishers.schema';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_1',
  name: 'Asha Rao',
  mobile: '+919876543210',
  email: 'asha@example.com',
  address: '12 MG Road, Bengaluru',
  latitude: null,
  longitude: null,
  kycStatus: 'PENDING',
  activatedAt: null,
  onboardingStatus: 'PENDING_ONBOARDING',
  kyc: null,
  user: { dateOfBirth: null, gender: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByUserId.mockResolvedValue(publisher());
  repository.findByUserIdWithKyc.mockResolvedValue(publisher());
  repository.update.mockImplementation(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));
  repository.setUserDetails.mockResolvedValue({});
});

describe('the schema', () => {
  it('takes a date of birth as YYYY-MM-DD, eighteen or over, and a gender in any casing', () => {
    expect(updateMyProfileSchema.safeParse({ dateOfBirth: '1990-04-12', gender: 'female' }).data).toEqual({ dateOfBirth: '1990-04-12', gender: 'FEMALE' });
    expect(updateMyProfileSchema.safeParse({ dateOfBirth: '12/04/1990' }).success).toBe(false);
    expect(updateMyProfileSchema.safeParse({ dateOfBirth: '1990-13-40' }).success).toBe(false);
    const lastYear = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    expect(updateMyProfileSchema.safeParse({ dateOfBirth: lastYear }).success).toBe(false);
    expect(updateMyProfileSchema.safeParse({ dateOfBirth: '1850-01-01' }).success).toBe(false);
    expect(updateMyProfileSchema.safeParse({ gender: 'UNSAID' }).success).toBe(false);
    expect(updateMyProfileSchema.safeParse({ gender: 'prefer_not_to_say' }).data).toEqual({ gender: 'PREFER_NOT_TO_SAY' });
  });

  it('takes the pin as two numbers in range, null to clear', () => {
    expect(updateMyProfileSchema.safeParse({ latitude: 12.97, longitude: 77.59 }).success).toBe(true);
    expect(updateMyProfileSchema.safeParse({ latitude: null, longitude: null }).success).toBe(true);
    expect(updateMyProfileSchema.safeParse({ latitude: 91, longitude: 77.59 }).success).toBe(false);
    expect(updateMyProfileSchema.safeParse({ latitude: 12.97, longitude: 181 }).success).toBe(false);
  });
});

describe('PATCH /publishers/me', () => {
  it("writes the date of birth and gender to the person, the rest to the publisher's row", async () => {
    const out = await updateMyProfile('usr_1', { address: '12 MG Road', latitude: 12.97, longitude: 77.59, dateOfBirth: '1990-04-12', gender: 'FEMALE' });
    expect(repository.setUserDetails).toHaveBeenCalledWith('usr_1', { dateOfBirth: new Date('1990-04-12T00:00:00Z'), gender: 'FEMALE' });
    expect(repository.update).toHaveBeenCalledWith('pub_1', { address: '12 MG Road', latitude: 12.97, longitude: 77.59 });
    expect(out).toMatchObject({ id: 'pub_1', address: '12 MG Road', dateOfBirth: '1990-04-12', gender: 'FEMALE' });
  });

  it('touches the person only when one of the two is sent', async () => {
    await updateMyProfile('usr_1', { address: '12 MG Road' });
    expect(repository.setUserDetails).not.toHaveBeenCalled();
    await updateMyProfile('usr_1', { gender: 'OTHER' });
    expect(repository.setUserDetails).toHaveBeenLastCalledWith('usr_1', { gender: 'OTHER' });
    expect(repository.update).toHaveBeenLastCalledWith('pub_1', {});
  });

  it('refuses a pin with one half missing, and clears both with null', async () => {
    await expect(updateMyProfile('usr_1', { latitude: 12.97 })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(updateMyProfile('usr_1', { longitude: 77.59 })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(repository.update).not.toHaveBeenCalled();
    await updateMyProfile('usr_1', { latitude: null, longitude: null });
    expect(repository.update).toHaveBeenLastCalledWith('pub_1', { latitude: null, longitude: null });
  });
});

describe('GET /publishers/me', () => {
  it('carries the date of birth as YYYY-MM-DD and the gender, and counts the date among the basics', async () => {
    const without = await getMyProfile('usr_1');
    expect(without).toMatchObject({ dateOfBirth: null, gender: null, verified: false });
    expect(without.readiness).toMatchObject({ profile: { missing: ['dateOfBirth'], percent: 75 }, canList: false, canGoLive: false });
    expect(without).not.toHaveProperty('user');

    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ user: { dateOfBirth: new Date('1990-04-12T00:00:00Z'), gender: 'FEMALE' } }));
    const withDob = await getMyProfile('usr_1');
    expect(withDob).toMatchObject({ dateOfBirth: '1990-04-12', gender: 'FEMALE' });
    // QR-5: the basics are enough to list AND go live; PENDING no longer holds either.
    expect(withDob.readiness).toMatchObject({ profile: { missing: [], percent: 100 }, percent: 70, canList: true, canGoLive: true });
  });
});
