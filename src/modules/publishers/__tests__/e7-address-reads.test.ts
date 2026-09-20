import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-2 — the phones' publisher reads keep the address.
 *
 * The agent's book (`GET /publishers`) and the publisher's own profile
 * (`GET /publishers/me`) both answer the whole row, so `address`, `city` and
 * `state` ride on it as the repository read them. Pinned here so a later
 * projection cannot quietly drop the three fields the cards print.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findForAgent: vi.fn(), findAllForAdmin: vi.fn(), findByUserIdWithKyc: vi.fn(), findByUserId: vi.fn(), findPlatformAgreementAcceptedAt: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn(), requireAgentProfile: vi.fn(), findAgentTier: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../qr', () => ({ deactivateQrsFor: vi.fn(), findActiveQrFor: vi.fn(), generateQr: vi.fn() }));
vi.mock('../../payouts', () => ({ recordIncentiveOnce: vi.fn() }));
vi.mock('../../kyc', () => ({
  listDocumentReviews: vi.fn(async () => []),
  flaggedDocuments: vi.fn(),
  clearDocumentReviews: vi.fn(),
  flagDocuments: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  livenessStateFor: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
}));

import { getAllPublishers, getPublishersForAgent } from '../publishers.service';
import { getMyProfile } from '../onboarding/publisher-onboarding.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_1',
  agentId: 'agt_1',
  name: 'Suraj Kumar Prints',
  mobile: '+919800000002',
  address: '12 Koramangala 5th Block',
  city: 'Bengaluru',
  state: 'Karnataka',
  kycStatus: 'VERIFIED',
  onboardingStatus: 'ONBOARDING_COMPLETE',
  kyc: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findForAgent.mockResolvedValue([publisher(), publisher({ id: 'pub_2', address: null, city: null, state: null })]);
  repository.findAllForAdmin.mockResolvedValue([publisher()]);
  repository.findByUserIdWithKyc.mockResolvedValue(publisher());
});

describe('GET /publishers — the agent book', () => {
  it('keeps address, city and state on every row, null where the publisher gave none', async () => {
    const rows = await getPublishersForAgent('agt_1');
    expect(repository.findForAgent).toHaveBeenCalledWith('agt_1', undefined);
    expect(rows[0]).toMatchObject({ id: 'pub_1', address: '12 Koramangala 5th Block', city: 'Bengaluru', state: 'Karnataka' });
    expect(rows[1]).toMatchObject({ id: 'pub_2', address: null, city: null, state: null });
    expect(rows[1]).toHaveProperty('state');
  });

  it('and the roster ADX reads is the same row', async () => {
    const rows = await getAllPublishers();
    expect(rows[0]).toMatchObject({ address: '12 Koramangala 5th Block', city: 'Bengaluru', state: 'Karnataka' });
  });
});

describe('GET /publishers/me', () => {
  it('keeps address, city and state on the profile', async () => {
    const me = await getMyProfile('usr_1');
    expect(me).toMatchObject({ id: 'pub_1', address: '12 Koramangala 5th Block', city: 'Bengaluru', state: 'Karnataka' });
  });
});
