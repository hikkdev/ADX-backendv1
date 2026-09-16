import { afterEach, describe, expect, it } from 'vitest';

/**
 * Lot G (Q118/138) — the fraud signals.
 *
 * Each signal is a pure function of what the read-only index answers, so
 * every case here is a hand-written index and a subject. What is pinned:
 * the shared signals link the other party and read 1; the rate signals
 * refuse to judge a thin sample; the fraction signals answer the share;
 * the photo hash answers null without a decoder and finds the duplicate
 * with one; the score is min(1, Σ weight × value) with nulls adding
 * nothing; and the fold names every signal that ties an account.
 */

import { CANDIDATES_PER_SIGNAL, cleanCandidates, evaluateSignals, FRAUD_SIGNALS, foldLinks, scoreOf } from '../signals';
import { sharedPanSignal } from '../signals/shared-pan.signal';
import { sharedBankSignal } from '../signals/shared-bank.signal';
import { sharedIpSubnetSignal, subnetOf } from '../signals/shared-ip-subnet.signal';
import { sharedPhoneAcrossRolesSignal } from '../signals/shared-phone-across-roles.signal';
import { sharedDeviceSignal } from '../signals/shared-device.signal';
import { bankNameMismatchSignal, holderMatchesParty } from '../signals/bank-name-mismatch.signal';
import { duplicateListingPhotosSignal } from '../signals/duplicate-listing-photos.signal';
import { proofFarFromSiteSignal } from '../signals/proof-far-from-site.signal';
import { selfDealingSignal } from '../signals/self-dealing.signal';
import { commissionFarmingSignal } from '../signals/commission-farming.signal';
import { refundDisputeRateSignal } from '../signals/refund-dispute-rate.signal';
import { withdrawAfterCreditSignal, quickWithdrawals } from '../signals/withdraw-after-credit.signal';
import { listingVelocitySignal, peakInWindow } from '../signals/listing-velocity.signal';
import { dhash, hammingDistance, registerThumbnailDecoder, type GrayImage } from '../signals/dhash';
import type { FraudSignalIndex, ResolvedSubject } from '../signals/types';

const now = new Date('2026-09-14T09:00:00.000Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const publisher: ResolvedSubject = {
  type: 'PUBLISHER',
  id: 'pub_1',
  userId: 'usr_pub',
  name: 'Ramesh Kumar',
  mobile: '+919999900001',
  pan: 'ABCDE1234F',
  kycStatus: 'PENDING',
  agentId: 'agt_1',
  listingId: null,
};
const advertiser: ResolvedSubject = { ...publisher, type: 'ADVERTISER', id: 'adv_1', userId: 'usr_adv', name: 'Ramesh Kumar', agentId: null };
const agent: ResolvedSubject = { ...publisher, type: 'AGENT', id: 'agt_1', userId: 'usr_agt', pan: null };

const other = { type: 'ADVERTISER' as const, id: 'adv_9', name: 'Suresh' };

/** An index that answers nothing — each test overrides what its signal reads. */
const empty = (): FraudSignalIndex => ({
  resolveSubject: async () => null,
  partiesWithPan: async () => [],
  payoutHandlesFor: async () => [],
  partiesWithPayoutHandle: async () => [],
  signInSubnetsFor: async () => [],
  partiesOnSubnets: async () => [],
  partiesWithMobile: async () => [],
  deviceTokensFor: async () => [],
  partiesWithDeviceTokens: async () => [],
  listingPhotosFor: async () => [],
  listingPhotosOfOthers: async () => [],
  proofPhotosFor: async () => [],
  onboardedPublishersOf: async () => [],
  bookingOutcomesFor: async () => ({ bookings: 0, refunds: 0, disputes: 0 }),
  walletMovementsFor: async () => ({ credits: [], withdrawals: [] }),
  listingCreatedAtFor: async () => [],
});

const ctx = (index: FraudSignalIndex) => ({ index, now });

afterEach(() => registerThumbnailDecoder(null));

describe('the shared signals', () => {
  it('SHARED_PAN links the other party holding the PAN', async () => {
    const index = { ...empty(), partiesWithPan: async () => [other] };
    expect(await sharedPanSignal.evaluate(publisher, ctx(index))).toMatchObject({ value: 1, links: [other] });
    expect(await sharedPanSignal.evaluate({ ...publisher, pan: null }, ctx(index))).toMatchObject({ value: 0 });
  });

  it('SHARED_BANK normalises the account number and UPI before asking', async () => {
    let asked: unknown;
    const index = {
      ...empty(),
      payoutHandlesFor: async () => [{ accountNumber: '1234-5678 90', upiVpa: 'Ramesh@OKSBI', accountHolder: null, nameMatchPct: null }],
      partiesWithPayoutHandle: async (handles: unknown) => {
        asked = handles;
        return [other];
      },
    };
    expect(await sharedBankSignal.evaluate(publisher, ctx(index))).toMatchObject({ value: 1, links: [other] });
    expect(asked).toEqual({ accountNumbers: ['1234567890'], upiVpas: ['ramesh@oksbi'] });
    expect(await sharedBankSignal.evaluate({ ...publisher, userId: null }, ctx(index))).toMatchObject({ value: 0 });
  });

  it('SHARED_IP_SUBNET reads the /24 and the thirty-day window', async () => {
    expect(subnetOf('::ffff:103.21.58.7')).toBe('103.21.58.0/24');
    expect(subnetOf('2401:4900:1f3a:2b::1')).toBe('2401:4900:1f3a:2b::/64');
    expect(subnetOf('garbage')).toBeNull();
    let since: Date | undefined;
    const index = {
      ...empty(),
      signInSubnetsFor: async (_u: string, s: Date) => {
        since = s;
        return ['103.21.58.0/24'];
      },
      partiesOnSubnets: async () => [other],
    };
    expect(await sharedIpSubnetSignal.evaluate(publisher, ctx(index))).toMatchObject({ value: 1 });
    expect(since).toEqual(daysAgo(30));
  });

  it('SHARED_PHONE_ACROSS_ROLES ignores a party of the same type', async () => {
    const same = { type: 'PUBLISHER' as const, id: 'pub_2', name: null };
    expect(await sharedPhoneAcrossRolesSignal.evaluate(publisher, ctx({ ...empty(), partiesWithMobile: async () => [same] }))).toMatchObject({ value: 0 });
    expect(await sharedPhoneAcrossRolesSignal.evaluate(publisher, ctx({ ...empty(), partiesWithMobile: async () => [same, other] }))).toMatchObject({ value: 1, links: [other] });
  });

  it('SHARED_DEVICE reads the push tokens and says the device id is a later addition', async () => {
    const index = { ...empty(), deviceTokensFor: async () => ['tok_1'], partiesWithDeviceTokens: async () => [] };
    const result = await sharedDeviceSignal.evaluate(publisher, ctx(index));
    expect(result.value).toBe(0);
    expect(result.detail).toMatch(/device id is a later addition/);
    expect(await sharedDeviceSignal.evaluate(publisher, ctx({ ...index, partiesWithDeviceTokens: async () => [other] }))).toMatchObject({ value: 1 });
  });
});

describe('BANK_NAME_MISMATCH', () => {
  it('uses the penny-drop match when the rail stored one, else the holder name', async () => {
    expect(holderMatchesParty('RAMESH KUMAR', 'Ramesh Kumar')).toBe(true);
    expect(holderMatchesParty('Kumar Enterprises Pvt Ltd', 'Ramesh Kumar')).toBe(true);
    expect(holderMatchesParty('Priya Sharma', 'Ramesh Kumar')).toBe(false);
    const pennyDropLow = { ...empty(), payoutHandlesFor: async () => [{ accountNumber: '1', upiVpa: null, accountHolder: 'Ramesh Kumar', nameMatchPct: 40 }] };
    expect(await bankNameMismatchSignal.evaluate(publisher, ctx(pennyDropLow))).toMatchObject({ value: 1 });
    const pennyDropHigh = { ...empty(), payoutHandlesFor: async () => [{ accountNumber: '1', upiVpa: null, accountHolder: 'Someone Else', nameMatchPct: 95 }] };
    expect(await bankNameMismatchSignal.evaluate(publisher, ctx(pennyDropHigh))).toMatchObject({ value: 0 });
    const holderOnly = { ...empty(), payoutHandlesFor: async () => [{ accountNumber: '1', upiVpa: null, accountHolder: 'Priya Sharma', nameMatchPct: null }] };
    expect(await bankNameMismatchSignal.evaluate(publisher, ctx(holderOnly))).toMatchObject({ value: 1 });
  });
});

describe('DUPLICATE_LISTING_PHOTOS', () => {
  const gradient = (seed: number): GrayImage => ({ width: 18, height: 16, pixels: Array.from({ length: 18 * 16 }, (_, i) => ((i % 18) * 14 + seed) % 256) });
  const noise = (): GrayImage => ({ width: 18, height: 16, pixels: Array.from({ length: 18 * 16 }, (_, i) => ((i * 7919) % 251)) });

  it('answers null without an image decoder, so it adds nothing to the score', async () => {
    const result = await duplicateListingPhotosSignal.evaluate(publisher, ctx({ ...empty(), listingPhotosFor: async () => [{ listingId: 'l1', publisherId: 'pub_1', url: 'a' }] }));
    expect(result.value).toBeNull();
    expect(result.detail).toMatch(/sharp/);
  });

  it('hashes the thumbnails and links the publisher whose photo is the same', async () => {
    expect(hammingDistance(dhash(gradient(0)), dhash(gradient(3)))).toBeLessThanOrEqual(6);
    expect(hammingDistance(dhash(gradient(0)), dhash(noise()))).toBeGreaterThan(6);
    registerThumbnailDecoder(async (url) => (url === 'mine' || url === 'theirs' ? gradient(url === 'mine' ? 0 : 2) : noise()));
    const index = {
      ...empty(),
      listingPhotosFor: async () => [{ listingId: 'l1', publisherId: 'pub_1', url: 'mine' }],
      listingPhotosOfOthers: async () => [
        { listingId: 'l7', publisherId: 'pub_7', url: 'theirs' },
        { listingId: 'l8', publisherId: 'pub_8', url: 'different' },
      ],
    };
    expect(await duplicateListingPhotosSignal.evaluate(publisher, ctx(index))).toMatchObject({ value: 1, links: [{ type: 'PUBLISHER', id: 'pub_7' }] });
  });

  it('G13-B: names every publisher whose photos were compared as a candidate, matched or not', async () => {
    registerThumbnailDecoder(async (url) => (url === 'mine' ? gradient(0) : noise()));
    const index = {
      ...empty(),
      listingPhotosFor: async () => [{ listingId: 'l1', publisherId: 'pub_1', url: 'mine' }],
      listingPhotosOfOthers: async () => [
        { listingId: 'l7', publisherId: 'pub_7', publisherName: 'Seven', url: 'a' },
        { listingId: 'l7b', publisherId: 'pub_7', publisherName: 'Seven', url: 'b' },
        { listingId: 'l8', publisherId: 'pub_8', url: 'c' },
      ],
    };
    const result = await duplicateListingPhotosSignal.evaluate(publisher, ctx(index));
    expect(result.value).toBe(0);
    expect(result.candidates).toEqual([
      { type: 'PUBLISHER', id: 'pub_7', name: 'Seven' },
      { type: 'PUBLISHER', id: 'pub_8', name: null },
    ]);
  });
});

describe('PROOF_FAR_FROM_SITE', () => {
  it('answers the share of proofs taken far from the listing or outside the booking window', async () => {
    const base = { orderId: 'o', listingLatitude: 12.9716, listingLongitude: 77.5946, slotStart: daysAgo(10), slotEnd: daysAgo(3) };
    const index = {
      ...empty(),
      proofPhotosFor: async () => [
        { ...base, capturedAt: daysAgo(9), latitude: 12.9717, longitude: 77.5947 }, // 15 m, in window
        { ...base, capturedAt: daysAgo(9), latitude: 12.99, longitude: 77.62 }, // ~3 km
        { ...base, capturedAt: daysAgo(20), latitude: null, longitude: null }, // no geo, ten days early
        { ...base, capturedAt: daysAgo(9), latitude: null, longitude: null }, // nothing to say
      ],
    };
    expect(await proofFarFromSiteSignal.evaluate(publisher, ctx(index))).toMatchObject({ value: 0.5 });
    expect(await proofFarFromSiteSignal.evaluate(advertiser, ctx(index))).toMatchObject({ value: 0 });
  });
});

describe('SELF_DEALING', () => {
  it('links only the opposite role sharing the PAN or the bank, naming what was shared', async () => {
    const index = {
      ...empty(),
      partiesWithPan: async () => [other, { type: 'PUBLISHER' as const, id: 'pub_2', name: null }],
      payoutHandlesFor: async () => [{ accountNumber: '99', upiVpa: null, accountHolder: null, nameMatchPct: null }],
      partiesWithPayoutHandle: async () => [other],
    };
    const result = await selfDealingSignal.evaluate(publisher, ctx(index));
    expect(result).toMatchObject({ value: 1, links: [other] });
    expect(result.detail).toMatch(/PAN, bank/);
    expect(await selfDealingSignal.evaluate(agent, ctx(index))).toMatchObject({ value: 0 });
  });
});

describe('COMMISSION_FARMING', () => {
  it('needs three publishers, then reads the rejected share and the idle share', async () => {
    const thin = { ...empty(), onboardedPublishersOf: async () => [{ id: 'p', kycStatus: 'REJECTED', createdAt: daysAgo(90), bookings: 0 }] };
    expect(await commissionFarmingSignal.evaluate(agent, ctx(thin))).toMatchObject({ value: 0 });
    const rejected = {
      ...empty(),
      onboardedPublishersOf: async () => [
        { id: 'a', kycStatus: 'REJECTED', createdAt: daysAgo(5), bookings: 0 },
        { id: 'b', kycStatus: 'REJECTED', createdAt: daysAgo(5), bookings: 0 },
        { id: 'c', kycStatus: 'VERIFIED', createdAt: daysAgo(5), bookings: 2 },
        { id: 'd', kycStatus: 'VERIFIED', createdAt: daysAgo(5), bookings: 2 },
      ],
    };
    expect(await commissionFarmingSignal.evaluate(agent, ctx(rejected))).toMatchObject({ value: 1 });
    const idle = {
      ...empty(),
      onboardedPublishersOf: async () => [
        { id: 'a', kycStatus: 'VERIFIED', createdAt: daysAgo(90), bookings: 0 },
        { id: 'b', kycStatus: 'VERIFIED', createdAt: daysAgo(90), bookings: 0 },
        { id: 'c', kycStatus: 'VERIFIED', createdAt: daysAgo(90), bookings: 1 },
      ],
    };
    expect(await commissionFarmingSignal.evaluate(agent, ctx(idle))).toMatchObject({ value: 1 });
    expect(await commissionFarmingSignal.evaluate(publisher, ctx(idle))).toMatchObject({ value: 0 });
  });

  it('G13-B: the publishers the agent onboarded are the candidates it judged', async () => {
    const index = {
      ...empty(),
      onboardedPublishersOf: async () => [
        { id: 'a', name: 'Anil', kycStatus: 'VERIFIED', createdAt: daysAgo(5), bookings: 2 },
        { id: 'b', kycStatus: 'VERIFIED', createdAt: daysAgo(5), bookings: 2 },
        { id: 'c', kycStatus: 'VERIFIED', createdAt: daysAgo(5), bookings: 2 },
      ],
    };
    expect((await commissionFarmingSignal.evaluate(agent, ctx(index))).candidates).toEqual([
      { type: 'PUBLISHER', id: 'a', name: 'Anil' },
      { type: 'PUBLISHER', id: 'b', name: null },
      { type: 'PUBLISHER', id: 'c', name: null },
    ]);
  });
});

describe('REFUND_DISPUTE_RATE', () => {
  it('is over 30 % of at least three bookings', async () => {
    const hot = { ...empty(), bookingOutcomesFor: async () => ({ bookings: 10, refunds: 2, disputes: 2 }) };
    expect(await refundDisputeRateSignal.evaluate(advertiser, ctx(hot))).toMatchObject({ value: 1 });
    const fine = { ...empty(), bookingOutcomesFor: async () => ({ bookings: 10, refunds: 1, disputes: 1 }) };
    expect(await refundDisputeRateSignal.evaluate(advertiser, ctx(fine))).toMatchObject({ value: 0 });
    const thin = { ...empty(), bookingOutcomesFor: async () => ({ bookings: 2, refunds: 2, disputes: 0 }) };
    expect(await refundDisputeRateSignal.evaluate(advertiser, ctx(thin))).toMatchObject({ value: 0 });
  });
});

describe('WITHDRAW_AFTER_CREDIT', () => {
  it('counts each withdrawal once and reads full at three', async () => {
    const credits = [{ at: hoursAgo(50) }, { at: hoursAgo(40) }, { at: hoursAgo(30) }, { at: hoursAgo(20) }];
    const withdrawals = [{ requestedAt: hoursAgo(49.5) }, { requestedAt: hoursAgo(39.9) }, { requestedAt: hoursAgo(25) }];
    expect(quickWithdrawals(credits, withdrawals)).toBe(2);
    const index = { ...empty(), walletMovementsFor: async () => ({ credits, withdrawals }) };
    expect(await withdrawAfterCreditSignal.evaluate(publisher, ctx(index))).toMatchObject({ value: 0.667 });
    const three = { ...empty(), walletMovementsFor: async () => ({ credits, withdrawals: [...withdrawals, { requestedAt: hoursAgo(19.5) }] }) };
    expect(await withdrawAfterCreditSignal.evaluate(publisher, ctx(three))).toMatchObject({ value: 1 });
  });
});

describe('LISTING_VELOCITY', () => {
  it('is more than ten listings inside any ten-minute window', async () => {
    const burst = Array.from({ length: 11 }, (_, i) => new Date(now.getTime() - i * 30_000));
    expect(peakInWindow(burst)).toBe(11);
    expect(peakInWindow(Array.from({ length: 11 }, (_, i) => new Date(now.getTime() - i * 120_000)))).toBe(6);
    expect(await listingVelocitySignal.evaluate(publisher, ctx({ ...empty(), listingCreatedAtFor: async () => burst }))).toMatchObject({ value: 1 });
    expect(await listingVelocitySignal.evaluate(publisher, ctx({ ...empty(), listingCreatedAtFor: async () => burst.slice(0, 10) }))).toMatchObject({ value: 0 });
  });
});

describe('the registry', () => {
  it('has every signal once, with the README weights', () => {
    const keys = FRAUD_SIGNALS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      'SHARED_PAN',
      'SHARED_BANK',
      'SHARED_IP_SUBNET',
      'SHARED_PHONE_ACROSS_ROLES',
      'SHARED_DEVICE',
      'BANK_NAME_MISMATCH',
      'DUPLICATE_LISTING_PHOTOS',
      'PROOF_FAR_FROM_SITE',
      'SELF_DEALING',
      'COMMISSION_FARMING',
      'REFUND_DISPUTE_RATE',
      'WITHDRAW_AFTER_CREDIT',
      'LISTING_VELOCITY',
    ]);
    for (const signal of FRAUD_SIGNALS) expect(signal.weight).toBeGreaterThan(0);
  });

  it('scores min(1, Σ weight × value) with nulls adding nothing', () => {
    expect(scoreOf([{ weight: 0.35, value: 1 }, { weight: 0.3, value: null }, { weight: 0.2, value: 0.5 }])).toBe(0.45);
    expect(scoreOf([{ weight: 0.4, value: 1 }, { weight: 0.35, value: 1 }, { weight: 0.35, value: 1 }])).toBe(1);
  });

  it('evaluates every signal, records one that throws as not computed, and folds the links by account', async () => {
    const index = {
      ...empty(),
      partiesWithPan: async () => [other],
      payoutHandlesFor: async () => [{ accountNumber: '99', upiVpa: null, accountHolder: null, nameMatchPct: null }],
      partiesWithPayoutHandle: async () => [other],
      partiesWithMobile: async () => {
        throw new Error('users down');
      },
    };
    const { signals, score } = await evaluateSignals(publisher, ctx(index));
    expect(signals).toHaveLength(FRAUD_SIGNALS.length);
    expect(signals.find((s) => s.key === 'SHARED_PHONE_ACROSS_ROLES')).toMatchObject({ value: null, detail: 'Not computed: users down' });
    expect(signals.find((s) => s.key === 'DUPLICATE_LISTING_PHOTOS')?.value).toBeNull();
    // PAN .35 + bank .35 + self-dealing .4 = 1.1 → capped.
    expect(score).toBe(1);
    expect(foldLinks(signals)).toEqual([{ party: other, via: ['SHARED_PAN', 'SHARED_BANK', 'SELF_DEALING'] }]);
  });

  it('G13-B: stores at most twenty candidates per signal, and the clean set is the candidates no signal linked', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, kycStatus: 'VERIFIED', createdAt: daysAgo(5), bookings: 1 }));
    const index = { ...empty(), onboardedPublishersOf: async () => many, partiesWithMobile: async () => [{ type: 'PUBLISHER' as const, id: 'p3', name: 'Three' }] };
    const { signals } = await evaluateSignals(agent, ctx(index));
    const farming = signals.find((s) => s.key === 'COMMISSION_FARMING')!;
    expect(CANDIDATES_PER_SIGNAL).toBe(20);
    expect(farming.candidates).toHaveLength(20);
    expect(signals.find((s) => s.key === 'SHARED_PAN')!.candidates).toBeUndefined();
    // p3 is linked through the phone, so it is not clean; the other nineteen stored are.
    const clean = cleanCandidates(signals, foldLinks(signals));
    expect(clean).toHaveLength(19);
    expect(clean.map((p) => p.id)).not.toContain('p3');
    expect(clean[0]).toEqual({ type: 'PUBLISHER', id: 'p0', name: null });
  });
});
