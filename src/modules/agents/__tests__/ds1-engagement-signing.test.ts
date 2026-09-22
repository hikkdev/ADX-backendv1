import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DS-1 (Digio eSign, 22 Sep 2026): the agent's engagement terms, signed.
 *
 * What is pinned: the desk's ACTIVATE opens the signing request when the
 * policy asks (and never fails the activation when the rail cannot); an
 * agent who has not signed is ACTIVE but not working — the dashboard says
 * so, the agent-initiated writes answer 403 SIGNATURE_REQUIRED with the
 * request, dispatch skips them and the desk's assign hears why; with the
 * rail off nothing changes.
 */

const { agreements, repository, dashRepo, leads } = vi.hoisted(() => ({
  agreements: {
    signingStanding: vi.fn(),
    openSigningRequest: vi.fn(),
  },
  repository: { findWorkState: vi.fn(), findByUserId: vi.fn() },
  dashRepo: { findDashboardProfile: vi.fn(), countOnboarded: vi.fn(), countSales: vi.fn(), walletBalance: vi.fn(), countToday: vi.fn() },
  leads: { leadClusters: vi.fn(async () => []) },
}));

vi.mock('../../agreements', () => agreements);
vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: { ...repository, ...dashRepo } }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m }));
vi.mock('../lead-layer.port', () => ({ leadLayer: () => ({ clusters: leads.leadClusters }) }));
vi.mock('../milestones/agent-milestones.service', () => ({ activeMilestoneFor: vi.fn().mockResolvedValue(null) }));
vi.mock('../tier/tier.service', async () => {
  const { rungFor } = await import('../tier-ladder');
  return { syncTier: vi.fn(async (_profile: unknown, onboarded: number) => ({ position: rungFor(onboarded), event: null })) };
});

import { agentAcceptsWork, assertAgentAcceptsWork, requireWorkingAgent } from '../agents.service';
import { getAgentDashboard } from '../dashboard.service';
import { engagementSide, requestEngagementSignature } from '../engagement-signing';

const unsigned = (over: Record<string, unknown> = {}) => ({
  kind: 'AGENT_PUBLISHER_PLATFORM',
  required: true,
  satisfied: false,
  status: 'REQUESTED',
  currentVersion: 2,
  request: { id: 'sig_1', status: 'REQUESTED', signingUrl: 'https://gateway.test/#/login/x', mock: false, expiresAt: new Date('2026-10-07'), label: 'Field agent engagement terms' },
  ...over,
});
const off = { kind: 'AGENT_PUBLISHER_PLATFORM', required: false, satisfied: true, status: null, currentVersion: null, request: null };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWorkState.mockResolvedValue({ status: 'ACTIVE', scopes: [], stage: 'ACTIVE', roles: ['AGENT_PUBLISHER'] });
  repository.findByUserId.mockResolvedValue({ id: 'agt_1', stage: 'ACTIVE', userId: 'usr_1' });
  dashRepo.findDashboardProfile.mockResolvedValue({ id: 'agt_1', displayId: 'AGT-1', city: 'Bengaluru', state: 'Karnataka', tier: 'BRONZE', tierLevel: 'I', tierPinnedAt: null, name: 'Rahul', roles: ['AGENT_PUBLISHER'], stage: 'ACTIVE', activatedAt: new Date(), status: 'ACTIVE', suspensionScopes: [], suspensionReason: null, suspendedAt: null, grade: 'G2' });
  dashRepo.countOnboarded.mockResolvedValue({ publishers: 1, advertisers: 0 });
  dashRepo.walletBalance.mockResolvedValue({ balance: '0.00', currency: 'INR' });
  dashRepo.countToday.mockResolvedValue({ orders: 0, visits: 0 });
  dashRepo.countSales.mockResolvedValue({ packagesSold: 0, campaignsLaunched: 0 });
});

describe('the side', () => {
  it('is the publisher terms when the agent holds that role, the sales terms otherwise', () => {
    expect(engagementSide(['AGENT_PUBLISHER'])).toBe('PUBLISHER');
    expect(engagementSide(['AGENT_PUBLISHER', 'AGENT_ADVERTISER'])).toBe('PUBLISHER');
    expect(engagementSide(['AGENT_ADVERTISER'])).toBe('ADVERTISER');
    expect(engagementSide(undefined)).toBe('PUBLISHER');
  });
});

describe('at activation', () => {
  it('opens the request for the side, by the admin', async () => {
    agreements.openSigningRequest.mockResolvedValue({ request: { id: 'sig_9' }, created: true });
    expect(await requestEngagementSignature('agt_1', 'ADVERTISER', 'adm_1')).toEqual({ opened: true, requestId: 'sig_9', reason: null });
    expect(agreements.openSigningRequest).toHaveBeenCalledWith({ kind: 'AGENT_ADVERTISER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'adm_1' });
  });

  it('is quiet when the policy does not ask, and reports rather than throws when the rail cannot', async () => {
    const { ApiError } = await import('../../../shared/errors');
    agreements.openSigningRequest.mockRejectedValueOnce(new ApiError(409, 'SIGNING_NOT_OPEN', 'not under the policy'));
    expect(await requestEngagementSignature('agt_1', 'PUBLISHER', 'adm_1')).toEqual({ opened: false, requestId: null, reason: null });
    agreements.openSigningRequest.mockRejectedValueOnce(new ApiError(503, 'NO_ACTIVE_TEMPLATE', 'No field agent engagement terms is published yet'));
    expect(await requestEngagementSignature('agt_1', 'PUBLISHER', 'adm_1')).toEqual({ opened: false, requestId: null, reason: 'No field agent engagement terms is published yet' });
  });
});

describe('until it is signed', () => {
  it('the dashboard says the agent may not work and carries the request', async () => {
    agreements.signingStanding.mockResolvedValue(unsigned());
    const view = await getAgentDashboard('usr_1');
    expect(view.application.mayWork).toBe(false);
    expect(view.signing).toMatchObject({ required: true, satisfied: false, status: 'REQUESTED', requestId: 'sig_1', signingUrl: 'https://gateway.test/#/login/x', label: 'Field agent engagement terms' });
    expect(agreements.signingStanding).toHaveBeenCalledWith('AGENT', 'agt_1', 'AGENT_PUBLISHER_PLATFORM');

    agreements.signingStanding.mockResolvedValue(unsigned({ satisfied: true, status: 'COMPLETED', request: { id: 'sig_1', status: 'COMPLETED', signingUrl: 'x', mock: false, expiresAt: null, label: 'Field agent engagement terms' } }));
    const signed = await getAgentDashboard('usr_1');
    expect(signed.application.mayWork).toBe(true);
    // A closed request offers no link to open.
    expect(signed.signing.signingUrl).toBeNull();
  });

  it('the agent-initiated writes answer 403 SIGNATURE_REQUIRED with the request', async () => {
    agreements.signingStanding.mockResolvedValue(unsigned());
    await expect(requireWorkingAgent('usr_1')).rejects.toMatchObject({ statusCode: 403, code: 'SIGNATURE_REQUIRED', details: { signing: expect.objectContaining({ id: 'sig_1' }), kind: 'AGENT_PUBLISHER_PLATFORM' } });
    agreements.signingStanding.mockResolvedValue({ ...unsigned(), satisfied: true });
    await expect(requireWorkingAgent('usr_1')).resolves.toMatchObject({ id: 'agt_1' });
  });

  it('dispatch skips the agent and the desk hears why', async () => {
    agreements.signingStanding.mockResolvedValue(unsigned());
    await expect(agentAcceptsWork('agt_1')).resolves.toBe(false);
    await expect(assertAgentAcceptsWork('agt_1')).rejects.toMatchObject({ statusCode: 409, code: 'SIGNATURE_REQUIRED' });
  });

  it('with the rail off, or the document switched off, nothing changes', async () => {
    agreements.signingStanding.mockResolvedValue(off);
    await expect(agentAcceptsWork('agt_1')).resolves.toBe(true);
    await expect(assertAgentAcceptsWork('agt_1')).resolves.toBeUndefined();
    await expect(requireWorkingAgent('usr_1')).resolves.toMatchObject({ id: 'agt_1' });
    const view = await getAgentDashboard('usr_1');
    expect(view.application.mayWork).toBe(true);
    expect(view.signing).toMatchObject({ required: false, satisfied: true, requestId: null });
  });
});
