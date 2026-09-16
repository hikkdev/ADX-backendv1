import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The demand side of the door-to-door code.
 *
 * The same code the publisher shows, for an advertiser. What is pinned is
 * where the two differ: an advertiser has no onboarding status column, so
 * "an agent is mid-way" is read off the live ONBOARDING grant; attribution
 * is set once and never rewritten; and the code is minted for advertiser
 * agents only.
 */

const { repository, qr, agents, grants } = vi.hoisted(() => ({
  repository: {
    findAdvertiserByUserId: vi.fn(),
    findAdvertiserById: vi.fn(),
    findUserSummary: vi.fn(),
    attachAgent: vi.fn(),
  },
  qr: {
    ONBOARDING_QR_TTL_SECONDS: 90,
    findActiveQrFor: vi.fn(),
    deactivateQrsFor: vi.fn(),
    generateQr: vi.fn(),
    findPendingScan: vi.fn(),
    decideOnboardingScan: vi.fn(),
  },
  agents: { findAgentProfile: vi.fn() },
  grants: { openOnboardingGrant: vi.fn(), closeOnboardingGrants: vi.fn(), hasLiveOnboardingGrant: vi.fn() },
}));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../qr', () => qr);
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);

import {
  commitClaim,
  getOnboardingQrStatus,
  getOrCreateOnboardingQr,
  prepareClaim,
} from '../advertiser-onboarding.service';

const advertiser = { id: 'adv_1', userId: 'usr_1', agentId: null, name: 'Meera S', mobile: '+919812340001', type: 'COMMERCIAL' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAdvertiserByUserId.mockResolvedValue(advertiser);
  repository.findAdvertiserById.mockResolvedValue(advertiser);
  repository.findUserSummary.mockResolvedValue({ name: 'Rahul Kumar', avatarUrl: null });
  repository.attachAgent.mockResolvedValue(undefined);
  qr.findActiveQrFor.mockResolvedValue(null);
  qr.generateQr.mockResolvedValue({ qrId: 'qr_new', token: 'tok', expiresAt: new Date(Date.now() + 90_000) });
  qr.findPendingScan.mockResolvedValue(null);
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_adv', displayId: 'AGT-1009-2602', city: 'Pune' });
  grants.hasLiveOnboardingGrant.mockResolvedValue(false);
  grants.openOnboardingGrant.mockResolvedValue({ id: 'grant_adv' });
});

describe('the code they show', () => {
  it('is minted for advertiser agents, ninety seconds, with the fix', async () => {
    await getOrCreateOnboardingQr('usr_1', { latitude: 18.52, longitude: 73.85 });
    expect(qr.generateQr).toHaveBeenCalledWith('ADVERTISER', 'adv_1', ['AGENT_ADVERTISER'], undefined, {
      expiresInSeconds: 90,
      position: { latitude: 18.52, longitude: 73.85 },
    });
  });

  it('is refused while an agent is mid-way, read off the live grant', async () => {
    grants.hasLiveOnboardingGrant.mockResolvedValue(true);
    await expect(getOrCreateOnboardingQr('usr_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(grants.hasLiveOnboardingGrant).toHaveBeenCalledWith({ advertiserId: 'adv_1' });
  });

  it('names the scanning agent for the owner to approve', async () => {
    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_live', expiresAt: new Date(Date.now() + 30_000) });
    qr.findPendingScan.mockResolvedValue({ id: 'scan_1', scannedById: 'usr_agent', createdAt: new Date(), distanceM: 12 });
    const status = await getOnboardingQrStatus('usr_1');
    expect(status.pending).toMatchObject({
      scanId: 'scan_1',
      distanceM: 12,
      agent: { displayId: 'AGT-1009-2602', city: 'Pune', name: 'Rahul Kumar' },
    });
    expect(status.onboarding).toBe('SELF');
  });
});

describe('the claim port', () => {
  it('validates the agent and the account without writing', async () => {
    const prepared = await prepareClaim('adv_1', 'usr_agent');
    expect(prepared).toEqual({
      advertiser: { id: 'adv_1', name: 'Meera S', mobile: '+919812340001', type: 'COMMERCIAL' },
      agentId: 'agt_adv',
    });
    expect(repository.attachAgent).not.toHaveBeenCalled();
  });

  it('refuses a scanner who is not an agent, and an account already being onboarded', async () => {
    agents.findAgentProfile.mockResolvedValue(null);
    await expect(prepareClaim('adv_1', 'usr_nobody')).rejects.toThrow('QR_ACCESS_DENIED');
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_adv' });
    grants.hasLiveOnboardingGrant.mockResolvedValue(true);
    await expect(prepareClaim('adv_1', 'usr_agent')).rejects.toThrow('QR_ALREADY_CLAIMED');
  });

  it('attaches the agent once and opens the authority on the advertiser', async () => {
    const result = await commitClaim('adv_1', 'agt_adv', { qrId: 'qr_live', scanId: 'scan_1' });
    expect(repository.attachAgent).toHaveBeenCalledWith('adv_1', 'agt_adv');
    expect(grants.openOnboardingGrant).toHaveBeenCalledWith({ subject: { advertiserId: 'adv_1' }, agentId: 'agt_adv', qrId: 'qr_live' });
    expect(result).toEqual({ grantId: 'grant_adv' });
  });
});
