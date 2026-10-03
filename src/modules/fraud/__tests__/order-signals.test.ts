import { describe, expect, it } from 'vitest';
import {
  bandFor,
  combineOrderScore,
  duplicateOrder,
  firingKeys,
  linkedParties,
  linksBetween,
  newAccountBigOrder,
  ORDER_SIGNAL_WEIGHTS,
  orderSignals,
  orderVelocity,
  partyRows,
  paymentTrouble,
  priorConfirmedFraud,
  screeningOutcome,
  signalIdentity,
  type OrderFacts,
  type OrderSignalRow,
  type ScreeningSettings,
} from '../order-screening/order-signals';
import type { StoredSignal } from '../signals';

/**
 * Order fraud screening (the owner, 2 Oct 2026) — the arithmetic.
 *
 * Pinned: each of the six order signals fires on what it says and not
 * otherwise, in plain words; the score is the party score's rule over all
 * three sides; the bands follow the thresholds; and what a scoring does to
 * the review — watch mode never holds, automatic holds hold only when
 * switched on, a cleared order re-flags only on a NEW signal, a confirmed
 * verdict is never moved, and a flag is never lifted by the score alone.
 */

const SETTINGS: ScreeningSettings = {
  enabled: true,
  reviewThreshold: 0.5,
  holdThreshold: 0.8,
  autoHold: false,
  newAccountDays: 7,
  bigOrderAmount: 100_000,
  velocityCount: 5,
  velocityMinutes: 60,
};

const PLACED = new Date('2026-10-02T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const facts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  value: 50_000,
  placedAt: PLACED,
  advertiserSince: new Date(PLACED.getTime() - 400 * DAY),
  recentOrderCount: 1,
  duplicates: [],
  payments: { failedAttempts: 0, refunds: 0 },
  links: [],
  priorFraud: { advertiserCases: 0, publisherCases: 0, advertiserOrders: 0, publisherOrders: 0 },
  ...over,
});

describe('NEW_ACCOUNT_BIG_ORDER', () => {
  it('fires on an account younger than N days placing more than ₹X', () => {
    const signal = newAccountBigOrder(facts({ advertiserSince: new Date(PLACED.getTime() - 2 * DAY), value: 150_000 }), SETTINGS);
    expect(signal).toMatchObject({ key: 'NEW_ACCOUNT_BIG_ORDER', value: 1, weight: 0.35, side: 'ORDER' });
    expect(signal.detail).toBe('An account 2 days old placed ₹1,50,000 — younger than 7 days and over ₹1,00,000.');
  });

  it('does not fire on a young account with a small order, an old account with a big one, or no value', () => {
    expect(newAccountBigOrder(facts({ advertiserSince: new Date(PLACED.getTime() - 2 * DAY), value: 90_000 }), SETTINGS).value).toBe(0);
    expect(newAccountBigOrder(facts({ value: 500_000 }), SETTINGS).value).toBe(0);
    expect(newAccountBigOrder(facts({ value: null }), SETTINGS).value).toBe(0);
    expect(newAccountBigOrder(facts({ advertiserSince: null, value: 500_000 }), SETTINGS).value).toBe(0);
  });

  it('reads its thresholds from the settings', () => {
    const young = facts({ advertiserSince: new Date(PLACED.getTime() - 10 * DAY), value: 60_000 });
    expect(newAccountBigOrder(young, SETTINGS).value).toBe(0);
    expect(newAccountBigOrder(young, { ...SETTINGS, newAccountDays: 30, bigOrderAmount: 50_000 }).value).toBe(1);
  });
});

describe('ORDER_VELOCITY', () => {
  it('fires on more than N orders in M minutes, not on N', () => {
    expect(orderVelocity(facts({ recentOrderCount: 6 }), SETTINGS)).toMatchObject({ value: 1, detail: '6 orders by this advertiser in 60 minutes — more than 5.' });
    expect(orderVelocity(facts({ recentOrderCount: 5 }), SETTINGS).value).toBe(0);
  });
});

describe('DUPLICATE_ORDER', () => {
  it('fires on the same spot ordered twice for overlapping dates, naming the other orders', () => {
    const signal = duplicateOrder(facts({ duplicates: [{ id: 'ord_2', displayId: 'BKG-0210-2601' }] }));
    expect(signal).toMatchObject({ value: 1, detail: 'Also ordered this spot for overlapping dates: BKG-0210-2601.' });
    expect(duplicateOrder(facts()).value).toBe(0);
  });
});

describe('PAYMENT_TROUBLE', () => {
  it('rises with failed attempts and with refunds, capped at 1', () => {
    expect(paymentTrouble(facts({ payments: { failedAttempts: 1, refunds: 0 } })).value).toBeCloseTo(0.333, 3);
    expect(paymentTrouble(facts({ payments: { failedAttempts: 3, refunds: 0 } })).value).toBe(1);
    expect(paymentTrouble(facts({ payments: { failedAttempts: 0, refunds: 1 } })).value).toBe(0.5);
    expect(paymentTrouble(facts({ payments: { failedAttempts: 9, refunds: 9 } })).value).toBe(1);
    expect(paymentTrouble(facts({ payments: { failedAttempts: 2, refunds: 1 } })).detail).toBe('2 failed payment attempts and 1 refund in 90 days.');
  });

  it('is 0 with nothing recorded, or nothing to read', () => {
    expect(paymentTrouble(facts()).value).toBe(0);
    expect(paymentTrouble(facts({ payments: null })).value).toBe(0);
  });
});

describe('LINKED_PARTIES and PRIOR_CONFIRMED_FRAUD', () => {
  it('fire on any tie and any prior verdict, in plain words', () => {
    expect(linkedParties(facts({ links: ['the same PAN', 'the same agent onboarded both'] }))).toMatchObject({
      value: 1,
      weight: 0.5,
      detail: 'The advertiser and the publisher share: the same PAN; the same agent onboarded both.',
    });
    expect(linkedParties(facts()).value).toBe(0);
    const prior = priorConfirmedFraud(facts({ priorFraud: { advertiserCases: 1, publisherCases: 0, advertiserOrders: 0, publisherOrders: 2 } }));
    expect(prior.value).toBe(1);
    expect(prior.detail).toBe('The advertiser has 1 confirmed fraud case; the publisher’s spots have 2 orders confirmed as fraud.');
    expect(priorConfirmedFraud(facts()).value).toBe(0);
  });
});

describe('linksBetween', () => {
  const advertiser = { id: 'adv_1', userId: 'usr_a', agentId: null, onboardedByAgentUserId: null };
  const publisher = { id: 'pub_1', userId: 'usr_p', agentId: 'agt_1', onboardedByAgentUserId: null };
  const shared = (key: string, links: StoredSignal['links']): StoredSignal => ({ key, weight: 0.35, value: 1, detail: '', links });

  it('reads a shared signal on either side that names the other party', () => {
    expect(
      linksBetween({
        advertiserSignals: [shared('SHARED_PAN', [{ type: 'PUBLISHER', id: 'pub_1', name: 'P' }]), shared('SHARED_BANK', [{ type: 'PUBLISHER', id: 'pub_other', name: 'X' }])],
        publisherSignals: [shared('SHARED_DEVICE', [{ type: 'ADVERTISER', id: 'adv_1', name: 'A' }])],
        advertiser,
        publisher,
      }),
    ).toEqual(['the same PAN', 'the same device']);
  });

  it('reads the same login on both sides and the same agent behind both', () => {
    expect(linksBetween({ advertiserSignals: [], publisherSignals: [], advertiser: { ...advertiser, userId: 'usr_p' }, publisher })).toEqual(['the same login placed the order and owns the spot']);
    expect(linksBetween({ advertiserSignals: [], publisherSignals: [], advertiser: { ...advertiser, agentId: 'agt_1' }, publisher })).toEqual(['the same agent onboarded both']);
    expect(
      linksBetween({ advertiserSignals: [], publisherSignals: [], advertiser: { ...advertiser, onboardedByAgentUserId: 'usr_ag' }, publisher: { ...publisher, agentId: null, onboardedByAgentUserId: 'usr_ag' } }),
    ).toEqual(['the same agent onboarded both']);
  });

  it('is empty with a party missing, or nothing shared', () => {
    expect(linksBetween({ advertiserSignals: [], publisherSignals: [], advertiser: null, publisher })).toEqual([]);
    expect(linksBetween({ advertiserSignals: [], publisherSignals: [], advertiser, publisher })).toEqual([]);
  });
});

describe('the score', () => {
  const party = (key: string, value: number | null, weight = 0.2): StoredSignal => ({ key, weight, value, detail: `${key} detail`, candidates: [{ type: 'PUBLISHER', id: 'x', name: null }] });

  it('stamps each party signal with its side and drops the candidates', () => {
    const rows = partyRows([party('SHARED_PAN', 1, 0.35)], 'PUBLISHER');
    expect(rows).toEqual([{ key: 'SHARED_PAN', weight: 0.35, value: 1, detail: 'SHARED_PAN detail', side: 'PUBLISHER' }]);
  });

  it('is min(1, Σ weight × value) over every side, a null adding nothing', () => {
    const rows: OrderSignalRow[] = [
      ...partyRows([party('SHARED_IP_SUBNET', 1, 0.15), party('DUPLICATE_LISTING_PHOTOS', null, 0.3)], 'ADVERTISER'),
      ...partyRows([party('WITHDRAW_AFTER_CREDIT', 0.5, 0.2)], 'PUBLISHER'),
      ...orderSignals(facts({ advertiserSince: new Date(PLACED.getTime() - DAY), value: 200_000 }), SETTINGS),
    ];
    // 0.15 + 0.1 + 0.35 (new account, big order)
    expect(combineOrderScore(rows)).toBe(0.6);
    expect(combineOrderScore([...rows, ...orderSignals(facts({ links: ['the same PAN'], priorFraud: { advertiserCases: 1, publisherCases: 0, advertiserOrders: 0, publisherOrders: 0 } }), SETTINGS)])).toBe(1);
    expect(combineOrderScore(orderSignals(facts(), SETTINGS))).toBe(0);
  });

  it('runs the six order signals in the order the desk prints them, with their weights', () => {
    expect(orderSignals(facts(), SETTINGS).map((s) => [s.key, s.weight])).toEqual(Object.entries(ORDER_SIGNAL_WEIGHTS));
  });

  it('bands against the thresholds', () => {
    expect(bandFor(0.49, SETTINGS)).toBe('LOW');
    expect(bandFor(0.5, SETTINGS)).toBe('REVIEW');
    expect(bandFor(0.8, SETTINGS)).toBe('HOLD');
    expect(bandFor(0.6, { reviewThreshold: 0.3, holdThreshold: 0.6 })).toBe('HOLD');
  });

  it('names a signal by side and key, and lists the firing ones', () => {
    const rows: OrderSignalRow[] = [
      { key: 'SHARED_PAN', weight: 0.35, value: 1, detail: '', side: 'ADVERTISER' },
      { key: 'SHARED_PAN', weight: 0.35, value: 0, detail: '', side: 'PUBLISHER' },
      { key: 'DUPLICATE_LISTING_PHOTOS', weight: 0.3, value: null, detail: '', side: 'PUBLISHER' },
      { key: 'DUPLICATE_ORDER', weight: 0.3, value: 1, detail: '', side: 'ORDER' },
    ];
    expect(signalIdentity(rows[0]!)).toBe('ADVERTISER:SHARED_PAN');
    expect(firingKeys(rows)).toEqual(['ADVERTISER:SHARED_PAN', 'ORDER:DUPLICATE_ORDER']);
  });
});

describe('what a scoring does to the review', () => {
  const fired = (keys: string[]): OrderSignalRow[] =>
    keys.map((identity) => {
      const [side, key] = identity.split(':') as [OrderSignalRow['side'], string];
      return { key, side, weight: 0.3, value: 1, detail: '' };
    });
  const open = { status: 'PENDING_PUBLISHER', reviewStatus: null, clearedKeys: [] as string[], heldAt: null };

  it('watch mode: flags at the review threshold and never holds, even at 1', () => {
    expect(screeningOutcome(open, { score: 0.55, signals: fired(['ORDER:DUPLICATE_ORDER']) }, SETTINGS)).toMatchObject({ band: 'REVIEW', reviewStatus: 'FLAGGED', newlyFlagged: true, hold: false });
    expect(screeningOutcome(open, { score: 1, signals: fired(['ORDER:LINKED_PARTIES']) }, SETTINGS)).toMatchObject({ band: 'HOLD', reviewStatus: 'FLAGGED', hold: false });
  });

  it('automatic holds on: holds at the hold threshold, not below it', () => {
    const on = { ...SETTINGS, autoHold: true };
    expect(screeningOutcome(open, { score: 0.8, signals: fired(['ORDER:LINKED_PARTIES']) }, on).hold).toBe(true);
    expect(screeningOutcome(open, { score: 0.79, signals: fired(['ORDER:LINKED_PARTIES']) }, on).hold).toBe(false);
  });

  it('automatic holds on: never holds a finished or an already-held order', () => {
    const on = { ...SETTINGS, autoHold: true };
    const signals = fired(['ORDER:LINKED_PARTIES']);
    expect(screeningOutcome({ ...open, status: 'COMPLETED' }, { score: 0.9, signals }, on).hold).toBe(false);
    expect(screeningOutcome({ ...open, heldAt: new Date() }, { score: 0.9, signals }, on).hold).toBe(false);
  });

  it('below the review threshold: nothing flagged, and an existing flag stands', () => {
    expect(screeningOutcome(open, { score: 0.2, signals: [] }, SETTINGS)).toMatchObject({ band: 'LOW', reviewStatus: null, newlyFlagged: false, hold: false });
    expect(screeningOutcome({ ...open, reviewStatus: 'FLAGGED' }, { score: 0.1, signals: [] }, SETTINGS)).toMatchObject({ reviewStatus: 'FLAGGED', newlyFlagged: false });
  });

  it('a flagged order flagged again is not news', () => {
    expect(screeningOutcome({ ...open, reviewStatus: 'FLAGGED' }, { score: 0.7, signals: fired(['ORDER:DUPLICATE_ORDER']) }, SETTINGS)).toMatchObject({ reviewStatus: 'FLAGGED', newlyFlagged: false });
  });

  it('a cleared order stays cleared on the same reasons, and re-flags on a new one', () => {
    const cleared = { ...open, reviewStatus: 'CLEARED' as const, clearedKeys: ['ORDER:DUPLICATE_ORDER', 'ADVERTISER:SHARED_IP_SUBNET'] };
    const on = { ...SETTINGS, autoHold: true };
    expect(screeningOutcome(cleared, { score: 0.9, signals: fired(['ORDER:DUPLICATE_ORDER', 'ADVERTISER:SHARED_IP_SUBNET']) }, on)).toMatchObject({
      reviewStatus: 'CLEARED',
      newlyFlagged: false,
      hold: false,
      newSignals: [],
    });
    expect(screeningOutcome(cleared, { score: 0.9, signals: fired(['ORDER:DUPLICATE_ORDER', 'PUBLISHER:SHARED_BANK']) }, on)).toMatchObject({
      reviewStatus: 'FLAGGED',
      newlyFlagged: true,
      hold: true,
      newSignals: ['PUBLISHER:SHARED_BANK'],
    });
  });

  it('never moves a confirmed verdict', () => {
    const confirmed = { ...open, reviewStatus: 'CONFIRMED_FRAUD' as const };
    expect(screeningOutcome(confirmed, { score: 1, signals: fired(['ORDER:LINKED_PARTIES']) }, { ...SETTINGS, autoHold: true })).toMatchObject({ reviewStatus: 'CONFIRMED_FRAUD', newlyFlagged: false, hold: false });
  });
});
