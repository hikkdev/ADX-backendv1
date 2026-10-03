import { Decimal } from '../../../shared/money';
import type { CampaignGateFacts } from '../campaigns.repository';

/** The Campaigns lot: one campaign's gate facts — scheduled, paid, verified, nothing waiting — to vary per test. */
export const gateFacts = (over: Partial<CampaignGateFacts> = {}): CampaignGateFacts => ({
  id: 'cmp_1',
  reference: 'ADX-CMP-2026-482913',
  name: 'Diwali push',
  status: 'SCHEDULED',
  brandName: 'Anita',
  startDate: new Date('2026-10-12T00:00:00Z'),
  endDate: new Date('2026-10-25T00:00:00Z'),
  total: new Decimal('59000.00') as never,
  createdAt: new Date('2026-09-20T10:00:00Z'),
  submittedForPaymentAt: null,
  paidAt: new Date('2026-09-25T10:00:00Z'),
  reservationFeeStatus: null,
  reservationFeeAmount: null,
  reservationFeeDueAt: null,
  reservationFeePaidAt: null,
  creativePath: 'STATIC_IMAGES',
  designQuoteStatus: null,
  designQuoteAmount: null,
  designQuotedAt: null,
  advertiser: {
    id: 'adv_1',
    name: 'Anita Foods',
    companyName: 'Anita Foods Pvt Ltd',
    displayId: 'ADV-1909-2601',
    kycStatus: 'VERIFIED',
    userId: 'usr_adv',
    suspensionScopes: [],
    user: { id: 'usr_adv', name: 'anita', firstName: 'Anita', lastName: 'Rao', displayId: 'ADX-0001', isActive: true, closedAt: null },
  },
  creatives: [],
  spots: [{ id: 'spt_1', status: 'BOOKED', order: { id: 'ord_1', status: 'SLOT_CONFIRMED' } }],
  landingPage: null,
  ...over,
});
