import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot B (Q101): the onboarding commission.
 *
 * PUBLISHER_ONBOARDED is recorded when the onboarding closes and the publisher
 * carries an agent — on the agent's path and on the publisher's own, because
 * attribution is the scan, not who pressed the last button. Recorded once per
 * publisher, at the agent's tier, PENDING_VERIFICATION; and a rate that cannot
 * be priced never stops an onboarding from completing. Both completion
 * responses print `{ incentive: { id, amount } | null }` so the app can show
 * the figure without a party filter.
 */

const { repository, qr, agents, grants, payouts } = vi.hoisted(() => ({
  repository: {
    findByUserId: vi.fn(),
    findByUserIdWithKyc: vi.fn(),
    findSummaryById: vi.fn(),
    completeOnboarding: vi.fn(),
  },
  qr: { deactivateQrsFor: vi.fn(), findActiveQrFor: vi.fn(), generateQr: vi.fn(), findPendingScan: vi.fn(), decideOnboardingScan: vi.fn(), ONBOARDING_QR_TTL_SECONDS: 90 },
  agents: (() => { const o = { findAgentProfile: vi.fn(), requireAgentProfile: vi.fn(), findAgentTier: vi.fn() }; return { ...o, findWorkingAgentProfile: o.findAgentProfile, requireWorkingAgent: o.requireAgentProfile }; })(),
  grants: { openOnboardingGrant: vi.fn(), closeOnboardingGrants: vi.fn(), accessLogFor: vi.fn() },
  payouts: { recordIncentiveOnce: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../qr', () => qr);
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);
vi.mock('../../payouts', () => payouts);
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));

import { completeMyOnboarding, completeOnboarding } from '../onboarding/publisher-onboarding.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_1',
  displayId: 'PUB-1009-2601',
  name: 'Sharma Hoardings',
  agentId: 'agt_1',
  onboardingStatus: 'IN_ONBOARDING',
  kyc: { submittedAt: new Date() },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findSummaryById.mockResolvedValue(publisher());
  repository.findByUserIdWithKyc.mockResolvedValue(publisher({ onboardingStatus: 'PENDING_ONBOARDING' }));
  repository.completeOnboarding.mockImplementation(async (id: string) => ({ ...publisher(), id, onboardingStatus: 'ONBOARDING_COMPLETE' }));
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1', tier: 'SILVER' });
  agents.findAgentTier.mockResolvedValue('SILVER');
  payouts.recordIncentiveOnce.mockResolvedValue({ id: 'inc_1', amount: new Decimal('2000.00'), status: 'PENDING_VERIFICATION' });
});

describe('the agent closes the onboarding', () => {
  it('records PUBLISHER_ONBOARDED once, at the agent’s tier, and answers with the figure', async () => {
    const result = await completeOnboarding('pub_1', 'usr_agent', false);
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith({
      agentId: 'agt_1',
      event: 'PUBLISHER_ONBOARDED',
      tier: 'SILVER',
      publisherId: 'pub_1',
      note: expect.stringContaining('Sharma Hoardings'),
      // Lot F: the agent's INCENTIVE_RECORDED notice names the account.
      notice: { partyName: 'Sharma Hoardings' },
    });
    expect(result).toEqual({ incentive: { id: 'inc_1', amount: '2000.00' } });
    expect(grants.closeOnboardingGrants).toHaveBeenCalledWith({ publisherId: 'pub_1' });
  });

  it('completes anyway when the rate cannot be priced', async () => {
    payouts.recordIncentiveOnce.mockRejectedValue(new Error('No incentive rate is configured'));
    const result = await completeOnboarding('pub_1', 'usr_admin', true);
    expect(repository.completeOnboarding).toHaveBeenCalledWith('pub_1');
    expect(result).toEqual({ incentive: null });
  });
});

describe('the publisher closes it themselves', () => {
  it('still pays the agent who scanned them in (Q101)', async () => {
    const result = await completeMyOnboarding('usr_1');
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith(expect.objectContaining({ event: 'PUBLISHER_ONBOARDED', agentId: 'agt_1', publisherId: 'pub_1' }));
    expect(result).toMatchObject({ onboardingStatus: 'ONBOARDING_COMPLETE', incentive: { id: 'inc_1', amount: '2000.00' } });
  });

  it('records nothing for a publisher no agent brought in', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ onboardingStatus: 'PENDING_ONBOARDING', agentId: null }));
    repository.completeOnboarding.mockResolvedValue({ ...publisher({ agentId: null }), onboardingStatus: 'ONBOARDING_COMPLETE' });
    const result = await completeMyOnboarding('usr_1');
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
    expect(result).toMatchObject({ incentive: null });
  });

  it('a second completion is a read and records nothing new', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ onboardingStatus: 'ONBOARDING_COMPLETE' }));
    const result = await completeMyOnboarding('usr_1');
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
    expect(result).toMatchObject({ onboardingStatus: 'ONBOARDING_COMPLETE', incentive: null });
  });
});
