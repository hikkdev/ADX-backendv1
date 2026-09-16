import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The publisher's side of the door-to-door grant.
 *
 * The code they show lives ninety seconds and is reissued rather than
 * extended; what their phone polls says who scanned it, by name and id, so
 * they can approve that person; approving records attribution and opens a
 * separate authority; and the authority ends when the onboarding does,
 * whichever way it ends.
 */

const { repository, qr, agents, grants } = vi.hoisted(() => ({
  repository: {
    findByUserId: vi.fn(),
    findByUserIdWithKyc: vi.fn(),
    findSummaryById: vi.fn(),
    findUserMobile: vi.fn(),
    claim: vi.fn(),
    completeOnboarding: vi.fn(),
    resetOnboardingState: vi.fn(),
  },
  qr: {
    ONBOARDING_QR_TTL_SECONDS: 90,
    findActiveQrFor: vi.fn(),
    deactivateQrsFor: vi.fn(),
    generateQr: vi.fn(),
    findPendingScan: vi.fn(),
    decideOnboardingScan: vi.fn(),
  },
  agents: { findAgentProfile: vi.fn(), requireAgentProfile: vi.fn(), findAgentTier: vi.fn() },
  grants: { openOnboardingGrant: vi.fn(), closeOnboardingGrants: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../qr', () => qr);
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
// Lot B: completion records the onboarding commission; these tests are about the grant.
vi.mock('../../payouts', () => ({ recordIncentiveOnce: vi.fn().mockResolvedValue({ id: 'inc_1', amount: '2000.00' }) }));

import {
  commitClaim,
  completeMyOnboarding,
  completeOnboarding,
  decideMyOnboardingScan,
  getOnboardingQrStatus,
  getOrCreateOnboardingQr,
} from '../onboarding/publisher-onboarding.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_1',
  agentId: null,
  onboardingStatus: 'PENDING_ONBOARDING',
  kyc: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByUserId.mockResolvedValue(publisher());
  repository.findByUserIdWithKyc.mockResolvedValue(publisher());
  repository.findSummaryById.mockResolvedValue(publisher({ agentId: 'agt_1', onboardingStatus: 'IN_ONBOARDING' }));
  repository.findUserMobile.mockResolvedValue({ mobile: '+919812340001', name: 'Rahul Kumar', avatarUrl: 'https://cdn/r.jpg' });
  repository.claim.mockResolvedValue({});
  repository.completeOnboarding.mockResolvedValue({ id: 'pub_1', onboardingStatus: 'ONBOARDING_COMPLETE' });
  qr.findActiveQrFor.mockResolvedValue(null);
  qr.generateQr.mockResolvedValue({ qrId: 'qr_new', token: 'tok_new', expiresAt: new Date(Date.now() + 90_000) });
  qr.findPendingScan.mockResolvedValue(null);
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1', displayId: 'AGT-1009-2601', city: 'Bengaluru' });
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1' });
  grants.openOnboardingGrant.mockResolvedValue({ id: 'grant_1' });
  grants.closeOnboardingGrants.mockResolvedValue(1);
});

describe('the code they show', () => {
  it('is minted for ninety seconds with the phone\'s fix', async () => {
    const result = await getOrCreateOnboardingQr('usr_1', { latitude: 12.97, longitude: 77.59 });
    expect(qr.generateQr).toHaveBeenCalledWith('PUBLISHER', 'pub_1', ['AGENT_PUBLISHER'], undefined, {
      expiresInSeconds: 90,
      position: { latitude: 12.97, longitude: 77.59 },
    });
    expect(result).toMatchObject({ qrId: 'qr_new', created: true });
  });

  it('is reused while live, and reissued once dead', async () => {
    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_live', token: 'tok_live', expiresAt: new Date(Date.now() + 30_000) });
    expect(await getOrCreateOnboardingQr('usr_1')).toMatchObject({ qrId: 'qr_live', created: false });
    expect(qr.generateQr).not.toHaveBeenCalled();

    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_dead', token: 'tok_dead', expiresAt: new Date(Date.now() - 1) });
    expect(await getOrCreateOnboardingQr('usr_1')).toMatchObject({ qrId: 'qr_new', created: true });
    expect(qr.deactivateQrsFor).toHaveBeenCalledWith('PUBLISHER', 'pub_1');
  });
});

describe('what the phone polls', () => {
  it('names the agent who scanned, with their id, photo and distance', async () => {
    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_live', expiresAt: new Date(Date.now() + 30_000) });
    qr.findPendingScan.mockResolvedValue({ id: 'scan_1', scannedById: 'usr_agent', createdAt: new Date(), distanceM: 42 });

    const status = await getOnboardingQrStatus('usr_1');

    expect(agents.findAgentProfile).toHaveBeenCalledWith('usr_agent');
    expect(repository.findUserMobile).toHaveBeenCalledWith('usr_agent');
    expect(status).toEqual({
      onboardingStatus: 'PENDING_ONBOARDING',
      qr: { qrId: 'qr_live', expiresAt: expect.any(Date), live: true },
      pending: {
        scanId: 'scan_1',
        scannedAt: expect.any(Date),
        distanceM: 42,
        agent: { id: 'agt_1', displayId: 'AGT-1009-2601', city: 'Bengaluru', name: 'Rahul Kumar', avatarUrl: 'https://cdn/r.jpg' },
      },
    });
  });

  it('says when the code has died and nobody has scanned', async () => {
    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_dead', expiresAt: new Date(Date.now() - 1) });
    const status = await getOnboardingQrStatus('usr_1');
    expect(status.qr).toMatchObject({ live: false });
    expect(status.pending).toBeNull();
  });

  it('routes the decision to the code module against this publisher', async () => {
    qr.decideOnboardingScan.mockResolvedValue({ outcome: 'GRANTED', grantId: 'grant_1' });
    await expect(decideMyOnboardingScan('usr_1', 'scan_1', 'approve')).resolves.toEqual({ outcome: 'GRANTED', grantId: 'grant_1' });
    expect(qr.decideOnboardingScan).toHaveBeenCalledWith('scan_1', 'pub_1', 'approve');
  });
});

describe('attribution and authority are two writes', () => {
  it('claims for the agent and opens the onboarding grant on the code', async () => {
    const result = await commitClaim('pub_1', 'agt_1', { qrId: 'qr_live', scanId: 'scan_1' });
    expect(repository.claim).toHaveBeenCalledWith('pub_1', 'agt_1');
    expect(grants.openOnboardingGrant).toHaveBeenCalledWith({ subject: { publisherId: 'pub_1' }, agentId: 'agt_1', qrId: 'qr_live' });
    expect(result).toEqual({ grantId: 'grant_1' });
  });

  it('closes the authority when the agent completes the onboarding', async () => {
    await completeOnboarding('pub_1', 'usr_agent', false);
    expect(repository.completeOnboarding).toHaveBeenCalledWith('pub_1');
    expect(grants.closeOnboardingGrants).toHaveBeenCalledWith({ publisherId: 'pub_1' });
  });

  it('closes it when the publisher completes on their own', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ kyc: { submittedAt: new Date() } }));
    await completeMyOnboarding('usr_1');
    expect(grants.closeOnboardingGrants).toHaveBeenCalledWith({ publisherId: 'pub_1' });
  });
});
