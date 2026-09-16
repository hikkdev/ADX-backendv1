import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot B (Q1): the campaign assist, and the visit a campaign was launched on.
 *
 * An agent who runs the wizard for an advertiser is paid CAMPAIGN_ASSIST at
 * authorisation — once per campaign, keyed on `Campaign.assistIncentiveId`,
 * PENDING_VERIFICATION like everything else — and the authorise response
 * prints the figure. A draft may name the field visit it was made on, and the
 * visit has to be the agent's own and open today. The list rows carry the
 * advertiser so the agent app's Orders tab can print whose campaign it is.
 */

const {
  repository,
  revenueQuote,
  advertisers,
  placeOrder,
  issueTrackingCodes,
  payouts,
  agents,
  visits,
  settings,
} = vi.hoisted(() => ({
  repository: {
    createCampaign: vi.fn(),
    findCampaign: vi.fn(),
    findCampaignBare: vi.fn(),
    updateCampaign: vi.fn(),
    updateSpot: vi.fn(),
    clashingListingIds: vi.fn(),
    advertiserContext: vi.fn(),
    referenceExists: vi.fn(),
    replacePois: vi.fn(),
    listCampaignsPage: vi.fn(),
  },
  revenueQuote: vi.fn(),
  advertisers: {
    assertCanBook: vi.fn(),
    holdForCampaign: vi.fn(),
    captureCampaignHold: vi.fn(),
    releaseCampaignHold: vi.fn(),
  },
  placeOrder: vi.fn(),
  issueTrackingCodes: vi.fn(),
  payouts: { recordIncentive: vi.fn() },
  agents: { findAgentTier: vi.fn() },
  visits: { assertVisitOutcome: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../revenue', () => ({ quote: revenueQuote }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../orders', () => ({ placeOrder, notifyAdmins: vi.fn() }));
// Lot D (Q123): the insertion order is accepted on the version live now; these
// tests are about the money, so it has been.
vi.mock('../../agreements', () => ({
  transactionAcceptance: vi.fn(async (kind: string) => ({ kind, accepted: true, templateVersion: 1, currentVersion: 1, current: true })),
}));

vi.mock('../../payouts', () => payouts);
vi.mock('../../agents', () => agents);
vi.mock('../../visits', () => visits);
vi.mock('../../pricing', () => ({ assertCityAllows: vi.fn() }));
vi.mock('../../app-config', () => settings);
vi.mock('../tracking.service', () => ({ issueTrackingCodes }));

import { authorizeCampaign } from '../checkout.service';
import { createDraft, listCampaignsPage, patchDraft } from '../campaigns.service';
import { createCampaignSchema, listCampaignsQuerySchema, patchCampaignSchema } from '../campaigns.schema';

const AGENT = { userId: 'usr_agent', isAdmin: false, advertiserId: null, agentId: 'agt_1' };

const spot = () => ({
  id: 'spt_1',
  listingId: 'lst_1',
  status: 'RESERVED',
  ratePerDay: new Decimal('2000'),
  days: 14,
  quantity: 1,
  lineTotal: new Decimal('28000'),
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-14T00:00:00Z'),
  listing: { id: 'lst_1', title: 'MG Road Billboard', city: 'Bengaluru', widthFt: null, heightFt: null, estimatedDailyFootfall: null, mediaType: null, photos: [] },
});

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    advertiserId: 'adv_1',
    agentId: 'agt_1',
    assistIncentiveId: null,
    visitId: null,
    name: 'Anita coffee, October',
    status: 'DRAFT',
    brandName: "Anita's Coffee",
    industry: 'QSR',
    goal: 'BRAND_AWARENESS',
    awareness: 'BRAND_NEW',
    targetingMethod: 'RADIUS',
    targetLatitude: 12.97,
    targetLongitude: 77.6,
    targetRadiusKm: 5,
    strategy: 'GENERAL',
    persona: 'HIGH_INCOME_CONSUMERS',
    budget: new Decimal('100000'),
    startDate: new Date('2026-10-01T00:00:00Z'),
    endDate: new Date('2026-10-14T00:00:00Z'),
    creativePath: 'ADX_DESIGN_AGENCY',
    creativeConfig: { objective: 'Brand awareness', keyMessage: 'Open all weekend', style: 'CLEAN_AND_MINIMAL' },
    trackingMethod: 'NONE',
    fulfilment: 'ADX_PRINTS',
    discount: null,
    total: null,
    walletHoldId: null,
    spots: [spot()],
    pois: [],
    creatives: [],
    codes: [],
    ...over,
  }) as never;

function bill(input: { ratePerDay?: string; days: number; spots?: number }) {
  const media = new Decimal(input.ratePerDay ?? 0).times(input.days).times(input.spots ?? 1);
  const gst = media.times('0.18');
  return {
    lines: [{ kind: 'MEDIA', label: 'Media', taxableValue: media.toFixed(2) }],
    netValue: media.toFixed(2),
    gstAmount: gst.toFixed(2),
    grossTotal: media.plus(gst).toFixed(2),
    payable: media.plus(gst).toFixed(2),
    publisher: { commissionPct: '0.12', commissionSource: 'PLATFORM_DEFAULT', commissionAmount: '0.00', netEarnings: '0.00' },
  };
}

const NOW = new Date('2026-09-12T06:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  revenueQuote.mockImplementation(async (input) => bill(input));
  repository.clashingListingIds.mockResolvedValue([]);
  repository.updateCampaign.mockResolvedValue({});
  repository.updateSpot.mockResolvedValue({});
  repository.findCampaign.mockImplementation(async () => campaign({ status: 'SCHEDULED' }));
  repository.findCampaignBare.mockResolvedValue(campaign());
  repository.referenceExists.mockResolvedValue(false);
  repository.advertiserContext.mockResolvedValue({ id: 'adv_1', agentId: 'agt_1', userId: 'usr_adv' });
  repository.createCampaign.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'cmp_new', ...data }));
  advertisers.holdForCampaign.mockResolvedValue({ holdId: 'hold_1' });
  advertisers.captureCampaignHold.mockResolvedValue({ captured: true });
  placeOrder.mockResolvedValue({ id: 'ord_1' });
  issueTrackingCodes.mockResolvedValue([]);
  agents.findAgentTier.mockResolvedValue('SILVER');
  payouts.recordIncentive.mockResolvedValue({ id: 'inc_assist', amount: new Decimal('750.00'), status: 'PENDING_VERIFICATION' });
  visits.assertVisitOutcome.mockResolvedValue(undefined);
  settings.getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1 } });
});

describe('CAMPAIGN_ASSIST at authorisation', () => {
  it('records it for the agent who ran the wizard, keys it on the campaign, and prints the figure', async () => {
    const result = await authorizeCampaign(campaign(), NOW);
    expect(payouts.recordIncentive).toHaveBeenCalledWith(
      {
        agentId: 'agt_1',
        event: 'CAMPAIGN_ASSIST',
        tier: 'SILVER',
        advertiserId: 'adv_1',
        note: 'ADX-CMP-2026-482913',
        // Lot F: the agent's INCENTIVE_RECORDED notice opens the campaign.
        notice: { campaignId: 'cmp_1', partyName: 'ADX-CMP-2026-482913' },
      },
      NOW,
    );
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', { assistIncentiveId: 'inc_assist' });
    expect(result.incentive).toEqual({ id: 'inc_assist', amount: '750.00' });
  });

  it('records nothing for a self-serve campaign', async () => {
    const result = await authorizeCampaign(campaign({ agentId: null }), NOW);
    expect(payouts.recordIncentive).not.toHaveBeenCalled();
    expect(result.incentive).toBeNull();
  });

  it('does not record twice for a campaign that already carries one', async () => {
    const result = await authorizeCampaign(campaign({ assistIncentiveId: 'inc_earlier' }), NOW);
    expect(payouts.recordIncentive).not.toHaveBeenCalled();
    expect(result.incentive).toBeNull();
  });

  it('launches anyway when the rate cannot be priced', async () => {
    payouts.recordIncentive.mockRejectedValue(new Error('No incentive rate is configured'));
    const result = await authorizeCampaign(campaign(), NOW);
    expect(advertisers.holdForCampaign).toHaveBeenCalled();
    expect(placeOrder).toHaveBeenCalled();
    expect(result.incentive).toBeNull();
  });
});

describe('the visit a campaign was made on', () => {
  it('is accepted on the create and the patch bodies', () => {
    expect(createCampaignSchema.parse({ advertiserId: 'adv_1', visitId: 'vst_1' }).visitId).toBe('vst_1');
    expect(patchCampaignSchema.parse({ visitId: null })).toMatchObject({ visitId: null });
  });

  it('is checked with the visits module before it is written on a draft', async () => {
    await createDraft({ advertiserId: 'adv_1', visitId: 'vst_1', actor: AGENT });
    expect(visits.assertVisitOutcome).toHaveBeenCalledWith('vst_1', 'agt_1');
    expect(repository.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ visitId: 'vst_1', agentId: 'agt_1' }));
  });

  it('is refused when the visits module says no, and the draft is not written', async () => {
    visits.assertVisitOutcome.mockRejectedValue(Object.assign(new Error('not yours'), { statusCode: 403 }));
    await expect(createDraft({ advertiserId: 'adv_1', visitId: 'vst_9', actor: AGENT })).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.createCampaign).not.toHaveBeenCalled();
  });

  it('can be set or cleared on a patch', async () => {
    await patchDraft('cmp_1', { visitId: 'vst_1' }, AGENT);
    expect(visits.assertVisitOutcome).toHaveBeenCalledWith('vst_1', 'agt_1');
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', { visitId: 'vst_1' });

    vi.clearAllMocks();
    repository.findCampaignBare.mockResolvedValue(campaign({ visitId: 'vst_1' }));
    await patchDraft('cmp_1', { visitId: null }, AGENT);
    expect(visits.assertVisitOutcome).not.toHaveBeenCalled();
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', { visitId: null });
  });
});

describe('GET /campaigns rows', () => {
  it('carry the advertiser for every caller', async () => {
    repository.listCampaignsPage.mockResolvedValue({
      items: [{ id: 'cmp_1', name: 'Diwali', status: 'LIVE', advertiser: { id: 'adv_1', displayId: 'ADV-1909-2601', name: 'Nilgiri Coffee' } }],
      total: 1,
      counts: {},
    });
    const page = await listCampaignsPage(AGENT, listCampaignsQuerySchema.parse({}));
    expect(page.items[0]).toMatchObject({ advertiser: { id: 'adv_1', displayId: 'ADV-1909-2601', name: 'Nilgiri Coffee' } });
  });
});
