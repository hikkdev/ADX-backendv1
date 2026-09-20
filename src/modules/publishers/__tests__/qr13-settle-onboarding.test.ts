import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-13 — an onboarding completes itself the moment the basics are in.
 *
 * Pinned: a pending publisher whose name, email, address and date of birth
 * are in is marked complete, their grants closed and the scanning agent
 * paid — from the app's own profile edit or the desk's; a row with a basic
 * missing, one already complete, or one an agent is walking through is left
 * alone; and the explicit complete call takes the basics OR the documents.
 */

const { repository, grants, payouts } = vi.hoisted(() => ({
  repository: {
    findByUserId: vi.fn(),
    findByIdWithUser: vi.fn(),
    findByUserIdWithKyc: vi.fn(),
    update: vi.fn(),
    submitKyc: vi.fn(),
    pinKycManifestVersion: vi.fn(),
    completeOnboarding: vi.fn(),
    setUserDetails: vi.fn(),
  },
  grants: { closeOnboardingGrants: vi.fn(), openOnboardingGrant: vi.fn(), accessLogFor: vi.fn() },
  payouts: { recordIncentiveOnce: vi.fn().mockResolvedValue({ id: 'inc_1', amount: '2000.00' }) },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../pricing', () => ({
  cityKeyFor: async () => null,
  withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: null }),
}));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../qr', () => ({ deactivateQrsFor: vi.fn(), findActiveQrFor: vi.fn(), generateQr: vi.fn() }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentTier: vi.fn().mockResolvedValue(null), findAgentProfile: vi.fn().mockResolvedValue(null) }));
vi.mock('../../access-grants', () => grants);
vi.mock('../../payouts', () => payouts);
vi.mock('../../kyc', () => ({
  clearDocumentReviews: vi.fn(),
  resolveManifestVersion: vi.fn(async (sent?: number) => sent ?? 5),
  flagDocuments: vi.fn(),
  flaggedDocuments: vi.fn(),
  listDocumentReviews: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  livenessStateFor: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
}));

import { completeMyOnboarding, settleOnboardingIfReady, updateMyProfile } from '../onboarding/publisher-onboarding.service';

const pending = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  agentId: null,
  name: 'Sharma Hoardings',
  email: 'owner@sharma.in',
  address: '12 Mount Road',
  onboardingStatus: 'PENDING_ONBOARDING',
  user: { dateOfBirth: new Date('1980-05-14T00:00:00.000Z') },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.completeOnboarding.mockImplementation(async (id: string) => ({ id, onboardingStatus: 'ONBOARDING_COMPLETE' }));
});

describe('settleOnboardingIfReady', () => {
  it('completes a pending row whose basics are in, closes the grants and pays the agent', async () => {
    repository.findByIdWithUser.mockResolvedValue(pending({ agentId: 'agt_1' }));
    expect(await settleOnboardingIfReady('pub_1')).toBe(true);
    expect(repository.completeOnboarding).toHaveBeenCalledWith('pub_1');
    expect(grants.closeOnboardingGrants).toHaveBeenCalledWith({ publisherId: 'pub_1' });
  });

  it.each([
    ['a basic missing', pending({ address: null })],
    ['no date of birth', pending({ user: { dateOfBirth: null } })],
    ['already complete', pending({ onboardingStatus: 'ONBOARDING_COMPLETE' })],
    ['an agent walking them through', pending({ onboardingStatus: 'IN_ONBOARDING' })],
  ])('leaves the row alone with %s', async (_label, row) => {
    repository.findByIdWithUser.mockResolvedValue(row);
    expect(await settleOnboardingIfReady('pub_1')).toBe(false);
    expect(repository.completeOnboarding).not.toHaveBeenCalled();
  });

  it('runs off the publisher\'s own profile edit', async () => {
    repository.findByUserId.mockResolvedValue({ id: 'pub_1', userId: 'usr_1' });
    repository.update.mockResolvedValue({ id: 'pub_1', address: '12 Mount Road' });
    repository.findByIdWithUser.mockResolvedValue(pending());
    await updateMyProfile('usr_1', { address: '12 Mount Road' });
    expect(repository.completeOnboarding).toHaveBeenCalledWith('pub_1');
  });
});

describe('the explicit complete', () => {
  it('takes the basics without any document', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue({ ...pending(), kyc: { submittedAt: null } });
    const done = await completeMyOnboarding('usr_1');
    expect((done as { onboardingStatus: string }).onboardingStatus).toBe('ONBOARDING_COMPLETE');
  });

  it('still takes the documents alone, and refuses with neither', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue({ ...pending({ email: null }), kyc: { submittedAt: new Date() } });
    await expect(completeMyOnboarding('usr_1')).resolves.toBeTruthy();
    repository.findByUserIdWithKyc.mockResolvedValue({ ...pending({ email: null }), kyc: { submittedAt: null } });
    await expect(completeMyOnboarding('usr_1')).rejects.toMatchObject({ statusCode: 400 });
  });
});
