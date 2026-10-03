import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../shared/money';
import { gateFacts } from './gate-facts.fixture';
import {
  campaignAdvertiserOf,
  daysLeftOf,
  isPaidUnlaunched,
  paidAmountOf,
  spotCountsOf,
  waitingFactsOf,
  waitingOnOf,
  waitingSinceOf,
  wholeDaysSince,
  WAITING_REASONS,
} from '../launch-gates';
import { heroTitleOf } from '../console.service';

/**
 * The Campaigns lot (2 Oct 2026): what stands between a campaign and going
 * live — one derivation for the list's `waitingOn`, the launch queue and
 * the overview's count. Each reason is a gate the platform already holds
 * (QR-16's KYC, Lot D's artwork, RF-1's fee, DQ-1's quote, the payment) or
 * a step a party still owes (the publisher's acceptance, an agent).
 */

describe('waitingOnOf', () => {
  it('is empty when nothing blocks, and for a draft or anything already live or over', () => {
    expect(waitingOnOf(gateFacts())).toEqual([]);
    for (const status of ['DRAFT', 'LIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const) {
      expect(waitingOnOf(gateFacts({ status, advertiser: { ...gateFacts().advertiser, kycStatus: 'PENDING' } }))).toEqual([]);
    }
  });

  it('says PAYMENT for a campaign sent to pay, and RESERVATION_FEE while the fee is due instead', () => {
    expect(waitingOnOf(gateFacts({ status: 'PENDING_PAYMENT', paidAt: null }))).toEqual(['PAYMENT']);
    expect(waitingOnOf(gateFacts({ status: 'PENDING_PAYMENT', paidAt: null, reservationFeeStatus: 'DUE' }))).toEqual(['RESERVATION_FEE']);
    // The fee paid: the balance is still owed.
    expect(waitingOnOf(gateFacts({ status: 'PENDING_PAYMENT', paidAt: null, reservationFeeStatus: 'PAID' }))).toEqual(['PAYMENT']);
  });

  it('says DESIGN_QUOTE on the ADX design path before payment while no quote stands or one awaits the answer', () => {
    const owed = { status: 'PENDING_PAYMENT' as const, paidAt: null, creativePath: 'ADX_DESIGN_AGENCY' as const };
    expect(waitingOnOf(gateFacts({ ...owed }))).toEqual(['PAYMENT', 'DESIGN_QUOTE']);
    expect(waitingOnOf(gateFacts({ ...owed, designQuoteStatus: 'QUOTED' }))).toEqual(['PAYMENT', 'DESIGN_QUOTE']);
    expect(waitingOnOf(gateFacts({ ...owed, designQuoteStatus: 'ACCEPTED' }))).toEqual(['PAYMENT']);
    expect(waitingOnOf(gateFacts({ ...owed, designQuoteStatus: 'DECLINED' }))).toEqual(['PAYMENT']);
  });

  it('says KYC only once paid (QR-16: verification holds the launch, not the booking)', () => {
    const unverified = { ...gateFacts().advertiser, kycStatus: 'PENDING' as const };
    expect(waitingOnOf(gateFacts({ advertiser: unverified }))).toEqual(['KYC']);
    expect(waitingOnOf(gateFacts({ status: 'PENDING_PAYMENT', paidAt: null, advertiser: unverified }))).toEqual(['PAYMENT']);
    expect(waitingOnOf(gateFacts({ status: 'PENDING_PAYMENT', paidAt: null, reservationFeeStatus: 'PAID', advertiser: unverified }))).toEqual(['PAYMENT', 'KYC']);
  });

  it('says ARTWORK for uploaded artwork not approved, ignoring one a resubmission superseded', () => {
    expect(waitingOnOf(gateFacts({ creatives: [{ id: 'cr_1', resubmissionOfId: null, fileUrl: 'https://cdn/a.png', status: 'IN_REVIEW', designedByAdx: false }] }))).toEqual(['ARTWORK']);
    // Refused, then replaced by an approved one: nothing outstanding.
    expect(
      waitingOnOf(
        gateFacts({
          creatives: [
            { id: 'cr_1', resubmissionOfId: null, fileUrl: 'https://cdn/a.png', status: 'REJECTED', designedByAdx: false },
            { id: 'cr_2', resubmissionOfId: 'cr_1', fileUrl: 'https://cdn/b.png', status: 'APPROVED', designedByAdx: false },
          ],
        }),
      ),
    ).toEqual([]);
    // A slot with no file yet is not a gate.
    expect(waitingOnOf(gateFacts({ creatives: [{ id: 'cr_1', resubmissionOfId: null, fileUrl: null, status: 'PENDING_UPLOAD', designedByAdx: false }] }))).toEqual([]);
  });

  it('says PUBLISHER and AGENT for a scheduled campaign whose standing spots wait on them', () => {
    const facts = gateFacts({
      spots: [
        { id: 'spt_1', status: 'BOOKED', order: { id: 'ord_1', status: 'PENDING_PUBLISHER' } },
        { id: 'spt_2', status: 'BOOKED', order: { id: 'ord_2', status: 'AGENT_REJECTED' } },
        { id: 'spt_3', status: 'CANCELLED', order: { id: 'ord_3', status: 'PENDING_AGENT' } },
      ],
    });
    expect(waitingOnOf(facts)).toEqual(['PUBLISHER', 'AGENT']);
    expect(waitingFactsOf(facts)).toEqual({ PUBLISHER: { spotIds: ['spt_1'], orderIds: ['ord_1'] }, AGENT: { spotIds: ['spt_2'], orderIds: ['ord_2'] } });
  });

  it('lists the reasons in the console order', () => {
    expect(WAITING_REASONS).toEqual(['RESERVATION_FEE', 'PAYMENT', 'DESIGN_QUOTE', 'KYC', 'ARTWORK', 'PUBLISHER', 'AGENT']);
  });
});

describe('waitingFactsOf', () => {
  it('names the fact each fix needs', () => {
    const facts = gateFacts({
      status: 'PENDING_PAYMENT',
      paidAt: null,
      reservationFeeStatus: 'PAID',
      reservationFeeAmount: new Decimal('2950.00') as never,
      reservationFeePaidAt: new Date('2026-09-26T10:00:00Z'),
      submittedForPaymentAt: new Date('2026-09-24T10:00:00Z'),
      creativePath: 'ADX_DESIGN_AGENCY',
      designQuoteStatus: 'QUOTED',
      designQuoteAmount: new Decimal('5000') as never,
      designQuotedAt: new Date('2026-09-24T12:00:00Z'),
      advertiser: { ...gateFacts().advertiser, kycStatus: 'NEEDS_INFO', suspensionScopes: ['BLOCK_NEW'] },
      creatives: [{ id: 'cr_9', resubmissionOfId: null, fileUrl: 'https://cdn/x.png', status: 'AWAITING_ADVERTISER', designedByAdx: true }],
    });
    expect(waitingOnOf(facts)).toEqual(['PAYMENT', 'DESIGN_QUOTE', 'KYC', 'ARTWORK']);
    expect(waitingFactsOf(facts)).toEqual({
      PAYMENT: { amountDue: '56050.00', sentForPaymentAt: new Date('2026-09-24T10:00:00Z'), reservationFeePaid: true },
      DESIGN_QUOTE: { state: 'QUOTED', amount: '5000.00', quotedAt: new Date('2026-09-24T12:00:00Z') },
      KYC: { advertiserId: 'adv_1', kycStatus: 'NEEDS_INFO', accountState: 'SUSPENDED' },
      ARTWORK: { creatives: [{ id: 'cr_9', status: 'AWAITING_ADVERTISER', designedByAdx: true }] },
    });
  });

  it('carries the reservation fee and its due time', () => {
    const facts = gateFacts({ status: 'PENDING_PAYMENT', paidAt: null, reservationFeeStatus: 'DUE', reservationFeeAmount: new Decimal('2950') as never, reservationFeeDueAt: new Date('2026-09-26T11:00:00Z') });
    expect(waitingFactsOf(facts)).toEqual({ RESERVATION_FEE: { amount: '2950.00', dueAt: new Date('2026-09-26T11:00:00Z') } });
  });
});

describe('the row columns', () => {
  it('shapes the advertiser as the orders’ placedBy — the person, their ADX id, the business', () => {
    expect(campaignAdvertiserOf(gateFacts().advertiser)).toEqual({
      userId: 'usr_adv',
      name: 'Anita Rao',
      displayId: 'ADX-0001',
      business: { id: 'adv_1', name: 'Anita Foods', displayId: 'ADV-1909-2601' },
    });
    const noNames = { ...gateFacts().advertiser, user: { ...gateFacts().advertiser.user!, firstName: null, lastName: ' ' } };
    expect(campaignAdvertiserOf(noNames).name).toBe('anita');
    // A desk-held account nobody has signed up to yet.
    expect(campaignAdvertiserOf({ ...gateFacts().advertiser, userId: null, user: null })).toEqual({
      userId: null,
      name: null,
      displayId: null,
      business: { id: 'adv_1', name: 'Anita Foods', displayId: 'ADV-1909-2601' },
    });
  });

  it('says what was paid: the total once paid, the fee while only that is, else nothing', () => {
    expect(paidAmountOf(gateFacts())).toBe('59000.00');
    expect(paidAmountOf(gateFacts({ paidAt: null, reservationFeeStatus: 'PAID', reservationFeeAmount: new Decimal('2950') as never }))).toBe('2950.00');
    expect(paidAmountOf(gateFacts({ paidAt: null }))).toBeNull();
  });

  it('counts the days left of a live flight, today included, and nothing otherwise', () => {
    const now = new Date('2026-10-20T15:00:00Z');
    expect(daysLeftOf(gateFacts({ status: 'LIVE' }), now)).toBe(6);
    expect(daysLeftOf(gateFacts({ status: 'LIVE' }), new Date('2026-10-25T20:00:00Z'))).toBe(1);
    expect(daysLeftOf(gateFacts({ status: 'LIVE' }), new Date('2026-10-26T01:00:00Z'))).toBe(0);
    expect(daysLeftOf(gateFacts({ status: 'SCHEDULED' }), now)).toBeNull();
  });

  it('counts the standing spots and the live ones', () => {
    expect(spotCountsOf([{ status: 'LIVE' }, { status: 'LIVE' }, { status: 'BOOKED' }, { status: 'CANCELLED' }])).toEqual({ spotsLive: 2, spotsTotal: 3 });
  });

  it('knows the queue’s population and since when each has waited', () => {
    expect(isPaidUnlaunched(gateFacts())).toBe(true);
    expect(isPaidUnlaunched(gateFacts({ status: 'PENDING_PAYMENT', reservationFeeStatus: 'PAID' }))).toBe(true);
    expect(isPaidUnlaunched(gateFacts({ status: 'PENDING_PAYMENT' }))).toBe(false);
    expect(waitingSinceOf(gateFacts())).toEqual(new Date('2026-09-25T10:00:00Z'));
    expect(waitingSinceOf(gateFacts({ paidAt: null, reservationFeePaidAt: new Date('2026-09-26T00:00:00Z') }))).toEqual(new Date('2026-09-26T00:00:00Z'));
    expect(wholeDaysSince(new Date('2026-09-25T10:00:00Z'), new Date('2026-09-28T09:00:00Z'))).toBe(2);
  });

  it('reads the landing page’s title off its hero block', () => {
    expect(heroTitleOf([{ type: 'offer', title: 'x' }, { type: 'hero', headline: '  Diwali at Anita’s ' }])).toBe('Diwali at Anita’s');
    expect(heroTitleOf([{ type: 'offer' }])).toBeNull();
    expect(heroTitleOf(null)).toBeNull();
  });
});
