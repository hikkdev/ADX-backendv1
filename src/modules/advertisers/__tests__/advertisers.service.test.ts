import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdvertisersRepository } from '../advertisers.repository';

// vi.hoisted so the stub exists before vi.mock's factory runs during the static
// import below — same reason as the supply tests.
const repository = vi.hoisted(
  () =>
    ({
      findLabelsByIds: vi.fn(),
    createAdvertiser: vi.fn(),
  attachUser: vi.fn(),
  attachAgent: vi.fn(),
  findUserSummary: vi.fn(),
  findUserClosure: vi.fn(),
      findAdvertiserById: vi.fn(),
      findKycSummary: vi.fn(),
      findAdvertiserByMobile: vi.fn(),
      findAdvertiserByUserId: vi.fn(),
      findAdvertiserLabelsByUserIds: vi.fn(),
      updateAdvertiser: vi.fn(),
      listAdvertisers: vi.fn(),
  findAdvertisersForAgent: vi.fn(),
      findUserMobile: vi.fn(),
      findAgentProfileId: vi.fn(),
      funnel: vi.fn(),
      funnelRows: vi.fn(),
      createBrand: vi.fn(),
      findBrandById: vi.fn(),
      listBrands: vi.fn(),
      updateBrand: vi.fn(),
      activeTemplate: vi.fn(),
      refundableAmount: vi.fn(),
      findOpenRefundRequest: vi.fn(),
      findRefundRequest: vi.fn(),
      listRefundRequests: vi.fn(),
      listRefundRequestsPage: vi.fn(),
      createRefundRequest: vi.fn(),
      decideRefundRequest: vi.fn(),
      updateRefundRequest: vi.fn(),
      withdrawRefundRequest: vi.fn(),
      findDormantWallets: vi.fn(),
      findAcceptance: vi.fn(),
      createAcceptance: vi.fn(),
      ensureWallet: vi.fn(),
      walletSnapshot: vi.fn(),
      listWalletEntries: vi.fn(),
      findHoldById: vi.fn(),
      placeHold: vi.fn(),
      releaseHold: vi.fn(),
      createTopUp: vi.fn(),
      findTopUpByPayment: vi.fn(),
      listTopUps: vi.fn(),
      listTopUpsPage: vi.fn(),
      findTopUp: vi.fn(),
      findTopUpByUtr: vi.fn(),
      markTopUpReconciled: vi.fn(),
    }) satisfies Record<keyof AdvertisersRepository, ReturnType<typeof vi.fn>>,
);

const { allocateIdentifier, wallets, payouts, agents, agreements } = vi.hoisted(() => ({
  allocateIdentifier: vi.fn(),
  wallets: { move: vi.fn(), findWallet: vi.fn() },
  payouts: { findPayoutMethod: vi.fn(), recordIncentiveOnce: vi.fn() },
  agents: { findAgentTier: vi.fn() },
  // Lot D (Q123): the insertion order is rendered and recorded by `agreements`;
  // the re-acceptance rule is the real one, so the gate tests exercise it.
  agreements: {
    acceptInsertionOrder: vi.fn(),
    isCurrentAcceptance: (
      acceptance: { templateVersion: number } | null,
      template: { version: number; requiresReacceptance?: boolean } | null,
    ) => Boolean(acceptance) && (!template?.requiresReacceptance || acceptance!.templateVersion >= template.version),
  },
}));

vi.mock('../prisma-advertisers.repository', () => ({
  prismaAdvertisersRepository: repository,
}));
vi.mock('../../identifiers', () => ({ allocateIdentifier }));
vi.mock('../../wallets', () => wallets);
// Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) =>
    data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null },
}));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../payouts', () => payouts);
vi.mock('../../agents', () => agents);
vi.mock('../../agreements', () => agreements);

import {
  acceptInsertionOrder,
  acceptPlatformAgreement,
  applyKycDecision,
  applyKycDecisionByUserId,
  bookingEligibility,
  captureCampaignHold,
  holdForCampaign,
  isProfileComplete,
  registerAdvertiser,
  releaseCampaignHold,
  updateProfile,
} from '../advertisers.service';

/** Only the fields the service reads; the rest of Advertiser is irrelevant. */
const advertiser = (over: Record<string, unknown> = {}) =>
  ({
    id: 'adv-1',
    name: 'Nilgiri Coffee',
    mobile: '9812345678',
    type: 'COMMERCIAL',
    companyName: 'Nilgiri Coffee Works Pvt Ltd',
    billingAddress: '12 Residency Road',
    city: 'Bengaluru',
    kycStatus: 'VERIFIED',
    activatedAt: null,
    agentId: null,
    ...over,
  }) as never;

const wallet = (over: Record<string, unknown> = {}) =>
  ({
    balance: '50000.00',
    goodwill: '0.00',
    held: '0.00',
    spendable: '50000.00',
    currency: 'INR',
    ...over,
  }) as never;

const template = { id: 'tpl-1', version: 3 } as never;

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAdvertiserById.mockResolvedValue(advertiser());
  repository.walletSnapshot.mockResolvedValue(wallet());
  repository.ensureWallet.mockResolvedValue({ id: 'wal-1', advertiserId: 'adv-1' });
  wallets.findWallet.mockResolvedValue({ id: 'wal-1', advertiserId: 'adv-1' });
  wallets.move.mockResolvedValue({ wallet: {}, entry: { id: 'ent-1' }, entries: [], ledgerTransactionId: 'ltx-1', created: true });
  repository.findAcceptance.mockResolvedValue({ id: 'acc-1', templateId: 'tpl-1', templateVersion: 3 });
  repository.activeTemplate.mockResolvedValue(template);
  agreements.acceptInsertionOrder.mockResolvedValue({ accepted: true, templateVersion: 1, acceptanceId: 'acc-io' });
  repository.updateAdvertiser.mockImplementation(
    async (_id: string, patch: Record<string, unknown>) => advertiser(patch)
  );
});

describe('isProfileComplete', () => {
  it('requires a company name from a company', () => {
    expect(isProfileComplete(advertiser({ companyName: null }))).toBe(false);
  });

  it('does not require one from an individual, who is already named', () => {
    expect(isProfileComplete(advertiser({ type: 'INDIVIDUAL', companyName: null }))).toBe(true);
  });

  it('always requires a billing address and city', () => {
    expect(isProfileComplete(advertiser({ billingAddress: null }))).toBe(false);
    expect(isProfileComplete(advertiser({ city: null }))).toBe(false);
  });
});

describe('registerAdvertiser', () => {
  it('issues an identifier, opens a wallet and creates the default brand', async () => {
    allocateIdentifier.mockResolvedValue('ADV-1909-2601');
    repository.findAdvertiserByMobile.mockResolvedValue(null);
    repository.createAdvertiser.mockResolvedValue(advertiser({ displayId: 'ADV-1909-2601' }));

    await registerAdvertiser({ name: 'Nilgiri Coffee', mobile: '9812345678' });

    expect(allocateIdentifier).toHaveBeenCalledWith('ADVERTISER');
    expect(repository.createAdvertiser).toHaveBeenCalledWith(
      expect.objectContaining({ displayId: 'ADV-1909-2601' })
    );
    expect(repository.ensureWallet).toHaveBeenCalledWith('adv-1');
    expect(repository.createBrand).toHaveBeenCalledWith({
      advertiserId: 'adv-1',
      name: 'Nilgiri Coffee Works Pvt Ltd',
    });
  });

  it('leaves an agency to name its own brands', async () => {
    allocateIdentifier.mockResolvedValue('ADV-1909-2602');
    repository.findAdvertiserByMobile.mockResolvedValue(null);
    repository.createAdvertiser.mockResolvedValue(advertiser({ type: 'AGENCY' }));

    await registerAdvertiser({ name: 'Madison OOH', mobile: '9812345679', type: 'AGENCY' });

    expect(repository.createBrand).not.toHaveBeenCalled();
  });

  it('takes the mobile from the session, ignoring whatever the body claimed', async () => {
    allocateIdentifier.mockResolvedValue('ADV-1909-2603');
    repository.findUserMobile.mockResolvedValue('9800000001');
    repository.findAdvertiserByMobile.mockResolvedValue(null);
    repository.createAdvertiser.mockResolvedValue(advertiser());

    await registerAdvertiser({
      name: 'Somebody Else',
      mobile: '9999999999',
      userId: 'usr-1',
    });

    expect(repository.findUserMobile).toHaveBeenCalledWith('usr-1');
    expect(repository.createAdvertiser).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: '9800000001' })
    );
  });

  it('requires a mobile when an agent opens the account for someone else', async () => {
    await expect(registerAdvertiser({ name: 'Zenith Motors' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('refuses a duplicate mobile', async () => {
    repository.findAdvertiserByMobile.mockResolvedValue(advertiser());
    await expect(
      registerAdvertiser({ name: 'Nilgiri', mobile: '9812345678' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('updateProfile', () => {
  it('ignores kycStatus and activatedAt, which are not the advertiser to set', async () => {
    await updateProfile('adv-1', {
      city: 'Chennai',
      kycStatus: 'VERIFIED',
      activatedAt: new Date(),
    } as never);

    // Lot X-B: the key rides with the city — null, Chennai being a typed town in this fixture.
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv-1', { city: 'Chennai', cityId: null });
  });

  it('Lot X-B: a city the catalogue knows, by its old spelling, is keyed; a patch without a city leaves the key alone', async () => {
    await updateProfile('adv-1', { city: 'Bangalore' });
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv-1', { city: 'Bangalore', cityId: 'city_bengaluru' });
    await updateProfile('adv-1', { name: 'Renamed' });
    expect(repository.updateAdvertiser).toHaveBeenLastCalledWith('adv-1', { name: 'Renamed' });
  });
});

describe('the city key on registration (Lot X-B)', () => {
  it('a create with the old spelling keys to the catalogue row; a typed town keeps its string with a null key', async () => {
    allocateIdentifier.mockResolvedValue('ADV-1909-2604');
    repository.findAdvertiserByMobile.mockResolvedValue(null);
    repository.createAdvertiser.mockResolvedValue(advertiser());
    await registerAdvertiser({ name: 'Nilgiri Coffee', mobile: '9812345678', city: 'Bangalore' });
    expect(repository.createAdvertiser).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bangalore', cityId: 'city_bengaluru' }));
    await registerAdvertiser({ name: 'Typed', mobile: '9812345670', city: 'Rameswaram' });
    expect(repository.createAdvertiser).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Rameswaram', cityId: null }));
  });
});

describe('acceptPlatformAgreement', () => {
  const ctx = { acceptedByUserId: 'usr-1' };

  it('refuses before KYC is verified', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ kycStatus: 'PENDING' }));
    repository.findAcceptance.mockResolvedValue(null);

    await expect(acceptPlatformAgreement('adv-1', ctx)).rejects.toMatchObject({
      code: 'KYC_REQUIRED',
    });
  });

  it('records the acceptance and activates the account', async () => {
    repository.findAcceptance.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'acc-1' });

    await acceptPlatformAgreement('adv-1', ctx);

    expect(repository.createAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ templateKind: 'ADVERTISER_PLATFORM', templateVersion: 3 })
    );
    expect(repository.updateAdvertiser).toHaveBeenCalledWith(
      'adv-1',
      expect.objectContaining({ activatedAt: expect.any(Date) })
    );
  });

  it('is idempotent — a second click accepts nothing new', async () => {
    await acceptPlatformAgreement('adv-1', ctx);
    expect(repository.createAcceptance).not.toHaveBeenCalled();
  });

  it('Lot D (Q55): a live version that demands re-acceptance takes a new click on the new version', async () => {
    repository.findAcceptance.mockResolvedValue({ id: 'acc-1', templateId: 'tpl-1', templateVersion: 3 });
    repository.activeTemplate.mockResolvedValue({ id: 'tpl-2', version: 4, requiresReacceptance: true } as never);

    await acceptPlatformAgreement('adv-1', ctx);

    expect(repository.createAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ templateKind: 'ADVERTISER_PLATFORM', templateVersion: 4 })
    );
  });

  it('a newer version that does not demand re-acceptance leaves the old click standing', async () => {
    repository.activeTemplate.mockResolvedValue({ id: 'tpl-2', version: 4, requiresReacceptance: false } as never);
    await acceptPlatformAgreement('adv-1', ctx);
    expect(repository.createAcceptance).not.toHaveBeenCalled();
  });

  it('reports a missing template as a configuration problem, not a user error', async () => {
    repository.findAcceptance.mockResolvedValue(null);
    repository.activeTemplate.mockResolvedValue(null);

    await expect(acceptPlatformAgreement('adv-1', ctx)).rejects.toMatchObject({
      code: 'NO_ACTIVE_TEMPLATE',
      statusCode: 503,
    });
  });
});

describe('applyKycDecision', () => {
  it('activates an advertiser who signed while KYC was still pending', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ kycStatus: 'PENDING' }));

    await applyKycDecision('adv-1', 'VERIFIED');

    expect(repository.updateAdvertiser).toHaveBeenNthCalledWith(1, 'adv-1', {
      kycStatus: 'VERIFIED',
    });
    expect(repository.updateAdvertiser).toHaveBeenNthCalledWith(
      2,
      'adv-1',
      expect.objectContaining({ activatedAt: expect.any(Date) })
    );
  });

  it('resolves the profile from a User id for the KYC module', async () => {
    repository.findAdvertiserByUserId.mockResolvedValue(advertiser({ kycStatus: 'PENDING' }));

    await applyKycDecisionByUserId('usr-9', 'VERIFIED');

    expect(repository.findAdvertiserByUserId).toHaveBeenCalledWith('usr-9');
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv-1', { kycStatus: 'VERIFIED' });
  });

  it('no-ops when a User has no advertiser profile, rather than failing the review', async () => {
    repository.findAdvertiserByUserId.mockResolvedValue(null);

    await expect(applyKycDecisionByUserId('usr-9', 'VERIFIED')).resolves.toBeNull();
    expect(repository.updateAdvertiser).not.toHaveBeenCalled();
  });

  it('does not activate on rejection', async () => {
    repository.updateAdvertiser.mockResolvedValue(advertiser({ kycStatus: 'REJECTED' }));

    await applyKycDecision('adv-1', 'REJECTED');

    expect(repository.updateAdvertiser).toHaveBeenCalledTimes(1);
  });
});

describe('the onboarding commission (Lot B, Q101)', () => {
  beforeEach(() => {
    agents.findAgentTier.mockResolvedValue('GOLD');
    payouts.recordIncentiveOnce.mockResolvedValue({ id: 'inc_1', amount: '2000.00', status: 'PENDING_VERIFICATION' });
    // The row keeps its attribution through the activation write.
    repository.updateAdvertiser.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => advertiser({ agentId: 'agt_1', ...patch })
    );
  });

  it('records ADVERTISER_ONBOARDED for the attributed agent when the account activates', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ kycStatus: 'PENDING', agentId: 'agt_1' }));

    const result = await applyKycDecision('adv-1', 'VERIFIED');

    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith({
      agentId: 'agt_1',
      event: 'ADVERTISER_ONBOARDED',
      tier: 'GOLD',
      advertiserId: 'adv-1',
      note: expect.stringContaining('Nilgiri Coffee'),
      // Lot F: the agent's INCENTIVE_RECORDED notice names the account.
      notice: { partyName: 'Nilgiri Coffee Works Pvt Ltd' },
    });
    expect(result.incentive).toEqual({ id: 'inc_1', amount: '2000.00' });
  });

  it('records nothing for a self-serve advertiser, and nothing on a second activation', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ kycStatus: 'PENDING' }));
    repository.updateAdvertiser.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => advertiser(patch)
    );
    const first = await applyKycDecision('adv-1', 'VERIFIED');
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
    expect(first.incentive).toBeNull();

    repository.findAdvertiserById.mockResolvedValue(advertiser({ agentId: 'agt_1', activatedAt: new Date() }));
    repository.updateAdvertiser.mockResolvedValue(advertiser({ agentId: 'agt_1', activatedAt: new Date() }));
    const again = await applyKycDecision('adv-1', 'VERIFIED');
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
    expect(again.incentive).toBeNull();
  });

  it('activates anyway when the rate cannot be priced', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ kycStatus: 'PENDING', agentId: 'agt_1' }));
    payouts.recordIncentiveOnce.mockRejectedValue(new Error('No incentive rate is configured'));

    const result = await applyKycDecision('adv-1', 'VERIFIED');

    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv-1', expect.objectContaining({ activatedAt: expect.any(Date) }));
    expect(result.incentive).toBeNull();
  });

  it('carries the figure on the agreement acceptance too', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ agentId: 'agt_1' }));
    repository.findAcceptance.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'acc-1' });

    const result = await acceptPlatformAgreement('adv-1', { acceptedByUserId: 'usr-1' });

    expect(result.incentive).toEqual({ id: 'inc_1', amount: '2000.00' });
  });
});

describe('acceptInsertionOrder', () => {
  const ctx = { acceptedByUserId: 'usr-1' };

  it('refuses without the platform agreement', async () => {
    repository.findAcceptance.mockResolvedValue(null);

    await expect(acceptInsertionOrder('adv-1', 'cmp-1', ctx)).rejects.toMatchObject({
      code: 'PLATFORM_AGREEMENT_REQUIRED',
    });
    expect(agreements.acceptInsertionOrder).not.toHaveBeenCalled();
  });

  it('refuses when the platform terms live now demand a re-acceptance the advertiser has not given', async () => {
    repository.activeTemplate.mockResolvedValue({ id: 'tpl-2', version: 4, requiresReacceptance: true } as never);

    await expect(acceptInsertionOrder('adv-1', 'cmp-1', ctx)).rejects.toMatchObject({
      code: 'PLATFORM_AGREEMENT_REQUIRED',
    });
  });

  /* Lot D (Q123): the words are rendered from the template and the campaign's
     spots by `agreements`, which also checks the campaign is this advertiser's.
     Nothing the client sends is recorded. */
  it('hands the click to agreements with the advertiser, the campaign and the context — never a document', async () => {
    const result = await acceptInsertionOrder('adv-1', 'cmp-1', { ...ctx, ipAddress: '10.0.0.1' });

    expect(agreements.acceptInsertionOrder).toHaveBeenCalledWith('cmp-1', 'adv-1', { ...ctx, ipAddress: '10.0.0.1' });
    expect(result).toEqual({ accepted: true, templateVersion: 1, acceptanceId: 'acc-io' });
    expect(repository.createAcceptance).not.toHaveBeenCalled();
  });
});

describe('bookingEligibility', () => {
  it('passes a fully onboarded, funded advertiser', async () => {
    const result = await bookingEligibility('adv-1', '10000.00');
    expect(result).toMatchObject({ eligible: true, blockedBy: [] });
  });

  it('reports every unmet gate, not just the first', async () => {
    repository.findAdvertiserById.mockResolvedValue(
      advertiser({ kycStatus: 'PENDING', billingAddress: null })
    );
    repository.findAcceptance.mockResolvedValue(null);
    repository.walletSnapshot.mockResolvedValue(wallet({ spendable: '0.00' }));

    const result = await bookingEligibility('adv-1');

    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toEqual(['PROFILE', 'KYC', 'AGREEMENT', 'FUNDS']);
  });

  it('Lot D (Q55): an old click is behind a live version that demands re-acceptance', async () => {
    repository.activeTemplate.mockResolvedValue({ id: 'tpl-2', version: 4, requiresReacceptance: true } as never);
    expect((await bookingEligibility('adv-1', '10000.00')).blockedBy).toEqual(['AGREEMENT']);

    repository.activeTemplate.mockResolvedValue({ id: 'tpl-2', version: 4, requiresReacceptance: false } as never);
    expect((await bookingEligibility('adv-1', '10000.00')).blockedBy).toEqual([]);
  });

  it('counts funds against the campaign value when one is given', async () => {
    repository.walletSnapshot.mockResolvedValue(wallet({ spendable: '9000.00' }));

    expect((await bookingEligibility('adv-1', '10000.00')).blockedBy).toEqual(['FUNDS']);
    expect((await bookingEligibility('adv-1', '8000.00')).blockedBy).toEqual([]);
  });
});

describe('holdForCampaign', () => {
  it('checks every gate before touching the wallet', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ kycStatus: 'PENDING' }));

    await expect(holdForCampaign('adv-1', 'cmp-1', '10000.00')).rejects.toMatchObject({
      code: 'KYC_REQUIRED',
    });
    expect(repository.placeHold).not.toHaveBeenCalled();
  });

  it('turns a short balance into INSUFFICIENT_FUNDS rather than a generic error', async () => {
    repository.placeHold.mockResolvedValue(null);

    await expect(holdForCampaign('adv-1', 'cmp-1', '10000.00')).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      statusCode: 402,
    });
  });

  it('rejects a zero or negative amount', async () => {
    await expect(holdForCampaign('adv-1', 'cmp-1', '0.00')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('places the hold when the gates are clear', async () => {
    repository.placeHold.mockResolvedValue({ id: 'hld-1' });

    await expect(holdForCampaign('adv-1', 'cmp-1', '10000.00')).resolves.toEqual({
      holdId: 'hld-1',
    });
  });
});

describe('capture and release', () => {
  it('capturing twice is a no-op rather than a double debit', async () => {
    repository.findHoldById.mockResolvedValue({ id: 'hld-1', status: 'CAPTURED' });

    await expect(captureCampaignHold('hld-1')).resolves.toEqual({ captured: true });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  // Lot B: the capture is one movement — goodwill first, the hold settled,
  // and the CAMPAIGN_SPEND legs against payables — through the wallets
  // service, which is also where a frozen wallet refuses it.
  it('captures through the wallets service with the hold, goodwill-first and the payables leg', async () => {
    repository.findHoldById.mockResolvedValue({ id: 'hld-1', status: 'HELD', walletId: 'wal-1', campaignId: 'cmp-1', amount: '10000.00' });

    await expect(captureCampaignHold('hld-1')).resolves.toEqual({ captured: true });
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal-1',
        amount: '-10000.00',
        entryType: 'CAMPAIGN_DEBIT',
        ledgerKind: 'CAMPAIGN_SPEND',
        idempotencyKey: 'campaign-capture:hld-1',
        spendGoodwillFirst: true,
        captureHoldId: 'hld-1',
        campaignId: 'cmp-1',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:payables', amount: '10000.00' })],
      })
    );
  });

  it('refuses to capture a released hold', async () => {
    repository.findHoldById.mockResolvedValue({ id: 'hld-1', status: 'RELEASED' });

    await expect(captureCampaignHold('hld-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to release a captured hold — that would be a refund', async () => {
    repository.findHoldById.mockResolvedValue({ id: 'hld-1', status: 'CAPTURED' });

    await expect(releaseCampaignHold('hld-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('releasing twice is a no-op', async () => {
    repository.findHoldById.mockResolvedValue({ id: 'hld-1', status: 'RELEASED' });

    await expect(releaseCampaignHold('hld-1')).resolves.toEqual({ released: true });
    expect(repository.releaseHold).not.toHaveBeenCalled();
  });
});
