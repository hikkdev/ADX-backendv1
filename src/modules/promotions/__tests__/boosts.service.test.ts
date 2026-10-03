import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * LM-1 — sponsored listings, on an in-memory store.
 *
 * Pinned: only the publisher's own live listing is boosted; the price is the
 * placements' rates summed × days + GST; capacity is each placement's
 * `maxConcurrent` per day in the listing's city and category (409
 * PLACEMENT_FULL per placement); the publisher wallet pays once and the boost
 * is SCHEDULED (LIVE on its first day, no review); cancel refunds before the
 * start; ADX cancels with or without a refund; the gateway's settlement is
 * the wallet's charge; the browse port answers nothing while the switch is
 * off; events count only for what is running today.
 */

const { store, wallets, flags } = vi.hoisted(() => ({
  store: { boosts: new Map<string, any>(), holds: [] as { placement: string; startDate: Date; endDate: Date }[], stats: [] as any[] },
  wallets: {
    ensureWallet: vi.fn(async () => ({ id: 'wal_pub' })),
    snapshot: vi.fn(async () => ({ balance: '20000.00', held: '0.00', openWithdrawals: '0.00', goodwill: '0.00', frozenAt: null })),
    move: vi.fn(async (input: { idempotencyKey: string }) => ({ entry: { id: `we:${input.idempotencyKey}` }, created: true })),
  },
  flags: { isFeatureEnabled: vi.fn(async () => true) },
}));

const PLACEMENTS = [
  { placement: 'SEARCH_TOP', label: 'Top of search results', ratePerDay: new Decimal('800'), maxConcurrent: 2, minDays: 1, isActive: true, updatedAt: new Date() },
  { placement: 'SIMILAR_TOP', label: 'Top of similar', ratePerDay: new Decimal('400'), maxConcurrent: 3, minDays: 1, isActive: true, updatedAt: new Date() },
];
const LISTING = { id: 'lst_1', displayId: 'LST-0110-2601', title: 'MG Road hoarding', city: 'Bengaluru', cityId: 'city_blr', category: 'OUTDOOR', status: 'ACTIVE', publisherId: 'pub_1', rightsLapsedAt: null };

let clock = new Date('2026-10-01T09:00:00Z');

const repository = vi.hoisted(() => ({}) as Record<string, any>);
Object.assign(repository, {
  listPlacements: vi.fn(async () => PLACEMENTS),
  findPlacement: vi.fn(async (placement: string) => PLACEMENTS.find((row) => row.placement === placement) ?? null),
  listingLabels: vi.fn(async (ids: string[]) => (ids.includes('lst_1') ? [LISTING] : ids.includes('lst_draft') ? [{ ...LISTING, id: 'lst_draft', status: 'DRAFT' }] : [])),
  createBoost: vi.fn(async (data: Record<string, unknown>) => {
    const row = { ...data, id: `bst_${store.boosts.size + 1}`, reviewNote: null, paidAt: null, paymentId: null, walletEntryId: null, refundedAt: null, cancelledAt: null, cancelReason: null, createdAt: clock, updatedAt: clock };
    store.boosts.set(row.id as string, row);
    return row;
  }),
  findBoost: vi.fn(async (id: string) => store.boosts.get(id) ?? null),
  transitionBoost: vi.fn(async (id: string, from: string[], patch: Record<string, unknown>) => {
    const row = store.boosts.get(id);
    if (!row || !from.includes(row.status)) return false;
    store.boosts.set(id, { ...row, ...patch, updatedAt: clock });
    return true;
  }),
  boostHolds: vi.fn(async (scope: { placement: string; cityId: string | null; category: string }, _from: Date, _to: Date, excludeId?: string) => [
    ...store.holds.filter((hold) => hold.placement === scope.placement),
    ...[...store.boosts.values()]
      .filter((row) => row.id !== excludeId && row.placements.includes(scope.placement) && row.cityId === scope.cityId && row.category === scope.category)
      .filter((row) => ['PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE'].includes(row.status)),
  ]),
  runningBoosts: vi.fn(async () => [...store.boosts.values()].filter((row) => ['LIVE', 'SCHEDULED'].includes(row.status)).map((row) => ({ id: row.id, listingId: row.listingId }))),
  runningAdIds: vi.fn(async () => []),
  runningBoostIds: vi.fn(async (ids: string[]) => ids.filter((id) => ['LIVE', 'SCHEDULED'].includes(store.boosts.get(id)?.status))),
  addStat: vi.fn(async (entry: unknown) => void store.stats.push(entry)),
  statsFor: vi.fn(async () => []),
});

vi.mock('../prisma-promotions.repository', () => ({ prismaPromotionsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../advertisers', () => ({ getAdvertiser: vi.fn(), bookingEligibility: vi.fn() }));
vi.mock('../../invoices', () => ({ issueInvoiceForAdvertising: vi.fn(), creditNoteForAdvertising: vi.fn() }));
vi.mock('../../notifications', () => ({ notify: vi.fn(async () => ({})) }));
vi.mock('../../publishers', () => ({ findPublisherContact: vi.fn(async () => ({ userId: 'usr_pub' })) }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'BST-0110-2601') }));
vi.mock('../../media', () => ({ storeMediaFile: vi.fn(), specFor: vi.fn(() => null), MEDIA_SPEC_KEYS: ['PROMO_WIDE', 'PROMO_SQUARE', 'TILE', 'AD_SIDEBAR', 'AD_BANNER'] }));
vi.mock('../../revenue', () => ({ taxSettings: vi.fn(async () => ({ mediaGstPct: '0.18' })) }));
vi.mock('../../feature-flags', () => flags);
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(async () => undefined), auditDiff: vi.fn(() => ({})) }));
/* AGE-1: the order gate, passing unless a test says otherwise. */
const ageGate = vi.hoisted(() => ({ assertPartyAdultForOrders: vi.fn() }));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), ...ageGate }));

import { ageRequiredError } from '../../../shared/age-gate';
import { adminCancelBoost, boostPaymentTarget, cancelBoost, clearSponsoredCache, createBoost, payBoostFromWallet, quoteBoost, runningSponsored, settleBoostPayment } from '../boosts.service';
import { recordEvents } from '../stats.service';

const owner = { userId: 'usr_pub', isAdmin: false, publisherId: 'pub_1' };
const input = { listingId: 'lst_1', placements: ['SEARCH_TOP', 'SIMILAR_TOP'] as ('SEARCH_TOP' | 'SIMILAR_TOP')[], startDate: '2026-10-05', endDate: '2026-10-09' };
const moves = (type: string) => wallets.move.mock.calls.map(([call]) => call as any).filter((call) => call.entryType === type);

beforeEach(() => {
  vi.clearAllMocks();
  store.boosts.clear();
  store.holds = [];
  store.stats = [];
  clock = new Date('2026-10-01T09:00:00Z');
  flags.isFeatureEnabled.mockResolvedValue(true);
  clearSponsoredCache();
});

describe('quote and create', () => {
  it('prices both placements summed × days + GST, for the publisher\'s own listing', async () => {
    const quote = await quoteBoost(input, owner, clock);
    expect(quote).toMatchObject({ days: 5, ratePerDay: { SEARCH_TOP: '800.00', SIMILAR_TOP: '400.00' }, subtotal: '6000.00', gstAmount: '1080.00', total: '7080.00', full: [] });
    await expect(quoteBoost(input, { ...owner, publisherId: 'pub_other' }, clock)).rejects.toMatchObject({ statusCode: 403 });
    await expect(quoteBoost({ ...input, listingId: 'lst_draft' }, owner, clock)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('creates it PENDING_PAYMENT with the listing\'s city and category', async () => {
    const view = await createBoost(input, owner, clock);
    expect(view).toMatchObject({ status: 'PENDING_PAYMENT', displayId: 'BST-0110-2601', cityId: 'city_blr', category: 'OUTDOOR', total: '7080.00', listing: { title: 'MG Road hoarding' } });
  });

  it('409 PLACEMENT_FULL naming the full days per placement', async () => {
    store.holds = [
      { placement: 'SEARCH_TOP', startDate: new Date('2026-10-07T00:00:00Z'), endDate: new Date('2026-10-08T00:00:00Z') },
      { placement: 'SEARCH_TOP', startDate: new Date('2026-10-08T00:00:00Z'), endDate: new Date('2026-10-12T00:00:00Z') },
    ];
    await expect(createBoost(input, owner, clock)).rejects.toMatchObject({ statusCode: 409, code: 'PLACEMENT_FULL', details: { full: ['2026-10-08'], fullByPlacement: { SEARCH_TOP: ['2026-10-08'], SIMILAR_TOP: [] } } });
    // SIMILAR_TOP alone is free.
    await expect(createBoost({ ...input, placements: ['SIMILAR_TOP'] }, owner, clock)).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });
  });
});

describe('paying and running', () => {
  it('the publisher wallet pays once; no review — SCHEDULED, or LIVE on its first day', async () => {
    const view = await createBoost(input, owner, clock);
    const paid = await payBoostFromWallet(store.boosts.get(view.id), owner, clock);
    expect(paid.status).toBe('SCHEDULED');
    expect(moves('PROMOTION_DEBIT')).toEqual([expect.objectContaining({ amount: '-7080.00', ledgerKind: 'PROMOTION_SPEND', idempotencyKey: `promotion-debit:boost:${view.id}` })]);
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_1' }, 'Publisher wallet');
    await payBoostFromWallet(store.boosts.get(view.id), owner, clock);
    expect(moves('PROMOTION_DEBIT')).toHaveLength(1);

    const today = await createBoost({ ...input, startDate: '2026-10-01', endDate: '2026-10-02', placements: ['SIMILAR_TOP'] }, owner, clock);
    expect((await payBoostFromWallet(store.boosts.get(today.id), owner, clock)).status).toBe('LIVE');
  });

  it('another publisher cannot pay or cancel it', async () => {
    const view = await createBoost(input, owner, clock);
    await expect(payBoostFromWallet(store.boosts.get(view.id), { ...owner, publisherId: 'pub_other' }, clock)).rejects.toMatchObject({ statusCode: 403 });
    await expect(cancelBoost(store.boosts.get(view.id), undefined, { ...owner, publisherId: 'pub_other' }, clock)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('cancel before the start refunds in full; ADX may stop a running one without a refund', async () => {
    const early = await createBoost(input, owner, clock);
    await payBoostFromWallet(store.boosts.get(early.id), owner, clock);
    expect((await cancelBoost(store.boosts.get(early.id), 'Changed my mind', owner, clock)).status).toBe('CANCELLED');
    expect(moves('REFUND')).toEqual([expect.objectContaining({ amount: '7080.00', idempotencyKey: `promotion-refund:boost:${early.id}` })]);

    const running = await createBoost({ ...input, startDate: '2026-10-01', endDate: '2026-10-03' }, owner, clock);
    await payBoostFromWallet(store.boosts.get(running.id), owner, clock);
    await adminCancelBoost(running.id, { reason: 'Misleading title', refund: false }, 'usr_desk', clock);
    expect(store.boosts.get(running.id)).toMatchObject({ status: 'CANCELLED', refundedAt: null });
    expect(moves('REFUND')).toHaveLength(1);
  });
});

describe('the gateway', () => {
  it('only the listing\'s publisher opens an intent; the capture is settled once', async () => {
    const view = await createBoost(input, owner, clock);
    const payer = { userId: 'usr_pub', isAdmin: false, advertiserId: null, publisherId: 'pub_1', agentId: null };
    await expect(boostPaymentTarget(view.id, payer)).resolves.toMatchObject({ payer: { kind: 'PUBLISHER', id: 'pub_1' }, amount: '7080.00' });
    await expect(boostPaymentTarget(view.id, { ...payer, publisherId: null, isAdmin: true })).rejects.toMatchObject({ statusCode: 403 });
    await settleBoostPayment(view.id, { id: 'pay_9', reference: 'PAY-2026-000009' }, null, clock);
    await settleBoostPayment(view.id, { id: 'pay_9', reference: 'PAY-2026-000009' }, null, clock);
    expect(moves('PROMOTION_DEBIT')).toHaveLength(1);
    expect(store.boosts.get(view.id)).toMatchObject({ status: 'SCHEDULED', paymentId: 'pay_9' });
  });

  it('503 FEATURE_OFF while the boosts switch is off', async () => {
    const view = await createBoost(input, owner, clock);
    flags.isFeatureEnabled.mockResolvedValue(false);
    await expect(boostPaymentTarget(view.id, { userId: 'usr_pub', isAdmin: false, advertiserId: null, publisherId: 'pub_1', agentId: null })).rejects.toMatchObject({ statusCode: 503, code: 'FEATURE_OFF' });
  });
});

describe('the browse port and the counter', () => {
  it('answers the running boosts and the placement\'s limit — nothing while the switch is off', async () => {
    const view = await createBoost(input, owner, clock);
    await payBoostFromWallet(store.boosts.get(view.id), owner, clock);
    await expect(runningSponsored('SEARCH_TOP', clock)).resolves.toEqual({ max: 2, boosts: [{ boostId: view.id, listingId: 'lst_1' }] });
    clearSponsoredCache();
    flags.isFeatureEnabled.mockResolvedValue(false);
    await expect(runningSponsored('SEARCH_TOP', clock)).resolves.toEqual({ max: 0, boosts: [] });
  });

  it('counts events for what is running and drops the rest, one write per item, surface and kind', async () => {
    const view = await createBoost(input, owner, clock);
    await payBoostFromWallet(store.boosts.get(view.id), owner, clock);
    const result = await recordEvents(
      [
        { kind: 'IMPRESSION', boostId: view.id, surface: 'WEB_EXPLORE' },
        { kind: 'IMPRESSION', boostId: view.id, surface: 'WEB_EXPLORE' },
        { kind: 'CLICK', boostId: view.id, surface: 'WEB_EXPLORE' },
        { kind: 'IMPRESSION', boostId: 'bst_gone', surface: 'WEB_EXPLORE' },
        { kind: 'IMPRESSION', adBookingId: 'ad_gone', surface: 'WEB_HOME' },
      ],
      clock,
    );
    expect(result).toEqual({ counted: 3, dropped: 2 });
    expect(store.stats).toEqual([
      expect.objectContaining({ boostId: view.id, kind: 'IMPRESSION', count: 2, date: new Date('2026-10-01T00:00:00Z') }),
      expect.objectContaining({ boostId: view.id, kind: 'CLICK', count: 1 }),
    ]);
  });
});

describe("AGE-1 — sponsoring a listing is the publisher's order", () => {
  it("create asks the publisher's account holder, and a refusal books nothing", async () => {
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('MISSING'));
    await expect(createBoost(input, owner, clock)).rejects.toMatchObject({ statusCode: 403, code: 'AGE_REQUIRED', details: { reason: 'MISSING' } });
    expect(ageGate.assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_1' }, { actorUserId: 'usr_pub' });
    expect(store.boosts.size).toBe(0);
  });

  it('paying from the wallet is refused before any money moves', async () => {
    const view = await createBoost(input, owner, clock);
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('UNDER_18'));
    await expect(payBoostFromWallet(store.boosts.get(view.id), owner, clock)).rejects.toMatchObject({ code: 'AGE_REQUIRED', details: { reason: 'UNDER_18' } });
    expect(moves('PROMOTION_DEBIT')).toHaveLength(0);
  });
});
