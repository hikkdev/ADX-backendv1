import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A publisher doing it themselves.
 *
 * Every route the module had for profile, documents and completion was
 * addressed by a publisher id that an agent holds and gated to that agent,
 * so a publisher could not submit their own papers and could never finish —
 * they sat at PENDING_ONBOARDING for ever. These are the same rows, addressed
 * by the session. What is pinned: that completion needs a submitted KYC, and
 * steps aside while an agent is mid-way.
 */

const { repository, kyc } = vi.hoisted(() => ({
  kyc: {
    clearDocumentReviews: vi.fn(),
    resolveManifestVersion: vi.fn(async (sent?: number) => sent ?? 5),
  },
  repository: {
    findByUserId: vi.fn(),
    findByUserIdWithKyc: vi.fn(),
    update: vi.fn(),
    submitKyc: vi.fn(),
    pinKycManifestVersion: vi.fn(),
    completeOnboarding: vi.fn(),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
// Lot X-B: the city key beside the typed city.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) =>
    data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null },
}));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../qr', () => ({ deactivateQrsFor: vi.fn(), findActiveQrFor: vi.fn(), generateQr: vi.fn() }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentTier: vi.fn() }));
// Lot B: completion records the onboarding commission; these tests are about the ladder.
vi.mock('../../payouts', () => ({ recordIncentiveOnce: vi.fn().mockResolvedValue({ id: 'inc_1', amount: '2000.00' }) }));
// Lot D/F: the decisions cleared on a resubmission, and the manifest pin (the version sent, else the live one — 5 here).
vi.mock('../../kyc', () => ({
  clearDocumentReviews: kyc.clearDocumentReviews,
  resolveManifestVersion: kyc.resolveManifestVersion,
  flagDocuments: vi.fn(),
  flaggedDocuments: vi.fn(),
  listDocumentReviews: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  livenessStateFor: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
}));

import {
  completeMyOnboarding,
  getMyKyc,
  submitMyKyc,
  updateMyProfile,
} from '../onboarding/publisher-onboarding.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_1',
  onboardingStatus: 'PENDING_ONBOARDING',
  kyc: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByUserId.mockResolvedValue(publisher());
  repository.findByUserIdWithKyc.mockResolvedValue(publisher());
  repository.update.mockImplementation(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));
  repository.submitKyc.mockImplementation(async (publisherId: string, docs: unknown) => ({ publisherId, ...(docs as object), submittedAt: new Date() }));
  repository.completeOnboarding.mockImplementation(async (id: string) => ({ id, onboardingStatus: 'ONBOARDING_COMPLETE' }));
});

describe('profile and documents', () => {
  it('writes the details to the row this session owns', async () => {
    await updateMyProfile('usr_1', { gstin: '29ABCDE1234F1Z5', contactName: 'Asha Rao' });
    expect(repository.update).toHaveBeenCalledWith('pub_1', { gstin: '29ABCDE1234F1Z5', contactName: 'Asha Rao' });
  });

  it('submits the documents against that row', async () => {
    const kyc = await submitMyKyc('usr_1', { govIdType: 'AADHAAR', govIdFrontUrl: 'https://x/a.jpg', panNumber: 'ABCDE1234F' });
    // Lot N: the publisher's own hand is stamped on the row.
    expect(repository.submitKyc).toHaveBeenCalledWith('pub_1', expect.objectContaining({ govIdType: 'AADHAAR', panNumber: 'ABCDE1234F' }), { recordedById: 'usr_1', recordedVia: 'SELF', method: 'MANUAL' });
    expect(kyc).toMatchObject({ publisherId: 'pub_1' });
  });

  /* Lot F (E7-1): the flagged-only resubmission on the publisher's own route,
     and the manifest pin — the version the phone sent, else the live one,
     never part of the columns. */
  it('takes a PARTIAL body while NEEDS_INFO: only the columns sent go to the row, only their decisions are cleared, the pin is written once', async () => {
    repository.submitKyc.mockResolvedValue({ id: 'kyc_1', publisherId: 'pub_1', status: 'PENDING' });
    await submitMyKyc('usr_1', { govIdFrontUrl: 'https://x/new-front.jpg', selfieUrl: 'https://x/new-selfie.jpg', manifestVersion: 3 });
    expect(repository.submitKyc).toHaveBeenLastCalledWith('pub_1', { govIdFrontUrl: 'https://x/new-front.jpg', selfieUrl: 'https://x/new-selfie.jpg' }, { recordedById: 'usr_1', recordedVia: 'SELF', method: 'MANUAL' });
    expect(repository.pinKycManifestVersion).toHaveBeenLastCalledWith('pub_1', 3);
    expect(kyc.clearDocumentReviews).toHaveBeenLastCalledWith('PUBLISHER', 'kyc_1', ['govIdFrontUrl', 'selfieUrl']);

    await submitMyKyc('usr_1', { panSignatureUrl: 'https://x/sig.jpg' });
    expect(repository.pinKycManifestVersion).toHaveBeenLastCalledWith('pub_1', 5);
    expect(kyc.clearDocumentReviews).toHaveBeenLastCalledWith('PUBLISHER', 'kyc_1', ['panSignatureUrl']);
  });

  /* E9 (the E7 verifier): a resubmission that attaches nothing must not bounce
     a NEEDS_INFO case back to PENDING with the same files. */
  it('refuses 400 EMPTY_RESUBMISSION while NEEDS_INFO when the body names no document field, and writes nothing', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ kyc: { id: 'kyc_1', status: 'NEEDS_INFO' } }));
    await expect(submitMyKyc('usr_1', { govIdType: 'AADHAAR', manifestVersion: 3 })).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_RESUBMISSION' });
    await expect(submitMyKyc('usr_1', {})).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_RESUBMISSION' });
    expect(repository.submitKyc).not.toHaveBeenCalled();
    expect(repository.pinKycManifestVersion).not.toHaveBeenCalled();
    expect(kyc.clearDocumentReviews).not.toHaveBeenCalled();

    // A document attached goes through as before; a PENDING case is not bound by the rule.
    repository.submitKyc.mockResolvedValue({ id: 'kyc_1', publisherId: 'pub_1', status: 'PENDING' });
    await submitMyKyc('usr_1', { selfieUrl: 'https://x/new-selfie.jpg' });
    expect(repository.submitKyc).toHaveBeenLastCalledWith('pub_1', { selfieUrl: 'https://x/new-selfie.jpg' }, { recordedById: 'usr_1', recordedVia: 'SELF', method: 'MANUAL' });
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ kyc: { id: 'kyc_1', status: 'PENDING' } }));
    await submitMyKyc('usr_1', { govIdType: 'AADHAAR' });
    expect(repository.submitKyc).toHaveBeenLastCalledWith('pub_1', { govIdType: 'AADHAAR' }, { recordedById: 'usr_1', recordedVia: 'SELF', method: 'MANUAL' });
  });

  it('answers null before the first submission, and 404 with no publisher at all', async () => {
    expect(await getMyKyc('usr_1')).toBeNull();
    repository.findByUserIdWithKyc.mockResolvedValue(null);
    repository.findByUserId.mockResolvedValue(null);
    await expect(getMyKyc('usr_none')).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateMyProfile('usr_none', {})).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('finishing on their own', () => {
  it('needs a submitted KYC', async () => {
    await expect(completeMyOnboarding('usr_1')).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.completeOnboarding).not.toHaveBeenCalled();
  });

  it('closes the onboarding once the documents are in', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ kyc: { submittedAt: new Date() } }));
    const result = await completeMyOnboarding('usr_1');
    expect(repository.completeOnboarding).toHaveBeenCalledWith('pub_1');
    expect(result).toMatchObject({ onboardingStatus: 'ONBOARDING_COMPLETE' });
  });

  it('steps aside while an agent is mid-way, and is a no-op once complete', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ onboardingStatus: 'IN_ONBOARDING', kyc: { submittedAt: new Date() } }));
    await expect(completeMyOnboarding('usr_1')).rejects.toMatchObject({ statusCode: 409 });

    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ onboardingStatus: 'ONBOARDING_COMPLETE' }));
    await completeMyOnboarding('usr_1');
    expect(repository.completeOnboarding).not.toHaveBeenCalled();
  });
});

describe('the city key (Lot X-B)', () => {
  it('PATCH /publishers/me with a city stamps the key beside it; a typed town keeps a null key', async () => {
    await updateMyProfile('usr_1', { city: 'Bangalore' });
    expect(repository.update).toHaveBeenCalledWith('pub_1', { city: 'Bangalore', cityId: 'city_bengaluru' });
    await updateMyProfile('usr_1', { city: 'Rameswaram' });
    expect(repository.update).toHaveBeenLastCalledWith('pub_1', { city: 'Rameswaram', cityId: null });
  });
});
