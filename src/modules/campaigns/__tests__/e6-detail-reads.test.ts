import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * E6: the two campaign reads the console asked for — the refund standing
 * against a campaign on GET /campaigns/:id, and the invoice the authorise
 * issued on POST /campaigns/:id/authorize.
 */

const { repository, issueInvoice } = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    updateSpot: vi.fn(),
    clashingListingIds: vi.fn(),
    findCampaignRefundByCampaign: vi.fn(),
  },
  issueInvoice: vi.fn(),
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../revenue', () => ({
  quote: vi.fn(async () => ({
    lines: [{ kind: 'MEDIA', label: 'Media', taxableValue: '28000.00' }],
    netValue: '28000.00',
    gstAmount: '5040.00',
    grossTotal: '33040.00',
    payable: '33040.00',
    publisher: { commissionPct: '0.12', commissionSource: 'PLATFORM_DEFAULT', commissionAmount: '3360.00', netEarnings: '24640.00' },
  })),
}));
vi.mock('../../advertisers', () => ({
  assertCanBook: vi.fn(),
  holdForCampaign: vi.fn(async () => ({ holdId: 'hold_1' })),
  captureCampaignHold: vi.fn(),
  releaseCampaignHold: vi.fn(),
}));
vi.mock('../../orders', () => ({ placeOrder: vi.fn(async () => ({ id: 'ord_1' })), notifyAdmins: vi.fn() }));
vi.mock('../tracking.service', () => ({ issueTrackingCodes: vi.fn(async () => []) }));
vi.mock('../../agreements', () => ({
  transactionAcceptance: vi.fn(async (kind: string) => ({ kind, accepted: true, templateVersion: 1, currentVersion: 1, current: true })),
}));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));

import { authorizeCampaign } from '../checkout.service';
import { campaignRefundSummary } from '../campaigns.service';
import { registerCampaignInvoicingPort } from '../invoicing.port';

const campaign = () =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    advertiserId: 'adv_1',
    agentId: null,
    createdByUserId: 'usr_adv',
    name: 'Anita coffee, April',
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
    startDate: new Date('2026-04-01T00:00:00Z'),
    endDate: new Date('2026-04-14T00:00:00Z'),
    creativePath: 'ADX_DESIGN_AGENCY',
    creativeConfig: { objective: 'Brand awareness', keyMessage: 'Open all weekend', style: 'CLEAN_AND_MINIMAL' },
    trackingMethod: 'NONE',
    fulfilment: 'ADX_PRINTS',
    discount: null,
    total: null,
    walletHoldId: null,
    spots: [
      {
        id: 'spt_1',
        listingId: 'lst_1',
        status: 'RESERVED',
        ratePerDay: new Decimal('2000'),
        days: 14,
        quantity: 1,
        lineTotal: new Decimal('28000'),
        startDate: new Date('2026-04-01T00:00:00Z'),
        endDate: new Date('2026-04-14T00:00:00Z'),
        listing: {
          id: 'lst_1',
          title: 'MG Road Billboard',
          city: 'Bengaluru',
          widthFt: new Decimal('20'),
          heightFt: new Decimal('10'),
          estimatedDailyFootfall: null,
          mediaType: { id: 'mt_1', name: 'Billboard', category: 'OUTDOOR' },
          photos: [],
        },
      },
    ],
    pois: [],
    creatives: [],
    codes: [],
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repository.clashingListingIds.mockResolvedValue([]);
  repository.updateCampaign.mockResolvedValue({});
  repository.updateSpot.mockResolvedValue({});
  repository.findCampaign.mockImplementation(async () => campaign());
});

describe('GET /campaigns/:id — refund', () => {
  it('is the CampaignRefund row, money as a decimal string', async () => {
    repository.findCampaignRefundByCampaign.mockResolvedValue({
      id: 'crf_1',
      campaignId: 'cmp_1',
      amount: new Decimal('1234.5'),
      status: 'PENDING',
      reason: 'Cancelled after capture',
      releasedAt: null,
    });
    await expect(campaignRefundSummary('cmp_1')).resolves.toEqual({
      id: 'crf_1',
      amount: '1234.50',
      status: 'PENDING',
      reason: 'Cancelled after capture',
      releasedAt: null,
    });
  });

  it('is null when nothing was recorded', async () => {
    repository.findCampaignRefundByCampaign.mockResolvedValue(null);
    await expect(campaignRefundSummary('cmp_1')).resolves.toBeNull();
  });
});

describe('POST /campaigns/:id/authorize — invoice', () => {
  it('carries the invoice the port issued', async () => {
    issueInvoice.mockResolvedValue({ id: 'inv_1', number: 'INV/2026-27/000018', kind: 'TAX_INVOICE', status: 'ISSUED', lines: [] });
    registerCampaignInvoicingPort({
      issueForCampaign: issueInvoice,
      markCampaignPaid: vi.fn(),
      creditNoteForCampaign: vi.fn(),
    });
    const result = await authorizeCampaign(campaign(), new Date('2026-03-20T10:00:00Z'));
    expect(issueInvoice).toHaveBeenCalledWith('cmp_1', 'usr_adv');
    expect(result.invoice).toEqual({ id: 'inv_1', number: 'INV/2026-27/000018', kind: 'TAX_INVOICE', status: 'ISSUED' });
  });

  it('is null when the issue failed — the booking stands, the desk catches up', async () => {
    issueInvoice.mockRejectedValue(new Error('sequence locked'));
    registerCampaignInvoicingPort({
      issueForCampaign: issueInvoice,
      markCampaignPaid: vi.fn(),
      creditNoteForCampaign: vi.fn(),
    });
    const result = await authorizeCampaign(campaign(), new Date('2026-03-20T10:00:00Z'));
    expect(result.invoice).toBeNull();
    expect(result.campaign.id).toBe('cmp_1');
  });
});
