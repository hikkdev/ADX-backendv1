import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * LM-1 — display ads, end to end on an in-memory store.
 *
 * Pinned: a draft is priced at the slot's rate + GST; submit re-checks the
 * slot per day (409 SLOT_FULL naming the days) and wants artwork; the wallet
 * pays once (the debit keyed on the booking, PROMOTION_DEBIT to
 * platform:revenue) and the ad waits for review; approve schedules it (or
 * runs it on its first day); reject refunds in full with a credit note;
 * cancel refunds before the start and not after; an hour unpaid lets it go;
 * the gateway's settlement is the wallet's charge, once; the artwork is
 * checked against the slot's spec.
 */

const { store, wallets, advertisers, invoices, notifications, audit, media, flags } = vi.hoisted(() => ({
  store: { ads: new Map<string, any>(), media: new Map<string, any>(), holds: [] as { startDate: Date; endDate: Date }[] },
  wallets: {
    ensureWallet: vi.fn(async () => ({ id: 'wal_adv' })),
    snapshot: vi.fn(async () => ({ balance: '50000.00', held: '0.00', openWithdrawals: '0.00', goodwill: '0.00', frozenAt: null })),
    move: vi.fn(async (input: { idempotencyKey: string }) => ({ entry: { id: `we:${input.idempotencyKey}` }, created: true })),
  },
  advertisers: {
    getAdvertiser: vi.fn(async () => ({ id: 'adv_1', name: 'Asha', companyName: 'Asha Foods', userId: 'usr_adv', agentId: 'agt_1' })),
    bookingEligibility: vi.fn(async () => ({ blockedBy: [] as string[] })),
  },
  invoices: { issueInvoiceForAdvertising: vi.fn(async () => ({ id: 'inv_1' })), creditNoteForAdvertising: vi.fn(async () => ({ id: 'cn_1' })) },
  notifications: { notify: vi.fn(async () => ({})) },
  audit: { logActivity: vi.fn(async () => undefined), auditDiff: vi.fn(() => ({})) },
  media: {
    storeMediaFile: vi.fn(async (_file: unknown, input: Record<string, unknown>) => ({ id: 'med_up', url: 'http://api/uploads/media/art.png', width: 600, height: 750, bytes: 1234, altText: input['altText'], archivedAt: null, archived: false })),
  },
  flags: { isFeatureEnabled: vi.fn(async () => true) },
}));

const BANNER = { id: 'slot_2', key: 'WEB_HOME_BANNER', label: 'Home page banner', description: null, surfaces: ['WEB_HOME'], spec: 'AD_BANNER', maxConcurrent: 2, ratePerDay: new Decimal('3000'), minDays: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() };
const SLOT = { id: 'slot_1', key: 'WEB_LISTING_SIDEBAR', label: 'Listing page sidebar', description: null, surfaces: ['WEB_LISTING'], spec: 'AD_SIDEBAR', maxConcurrent: 2, ratePerDay: new Decimal('1500'), minDays: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() };

const withSlot = (row: any) => ({ ...row, slot: row.slotId === BANNER.id ? BANNER : SLOT });
const CITIES = [
  { id: 'city_blr', slug: 'bengaluru', name: 'Bengaluru' },
  { id: 'city_mum', slug: 'mumbai', name: 'Mumbai' },
];

let clock = new Date('2026-10-01T09:00:00Z');
const tick = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));

const repository = vi.hoisted(() => ({}) as Record<string, unknown>);
Object.assign(repository, {
  findSlotByKey: vi.fn(async (key: string) => (key === SLOT.key ? SLOT : key === BANNER.key ? BANNER : null)),
  findSlot: vi.fn(async () => SLOT),
  createAd: vi.fn(async (data: Record<string, unknown>) => {
    const row = { ...data, id: `ad_${store.ads.size + 1}`, status: 'DRAFT', mediaId: null, reviewNote: null, reviewedById: null, reviewedAt: null, paidAt: null, paymentId: null, walletEntryId: null, refundedAt: null, cancelledAt: null, cancelReason: null, createdAt: clock, updatedAt: clock };
    store.ads.set(row.id as string, row);
    return withSlot(row);
  }),
  findAd: vi.fn(async (id: string) => (store.ads.has(id) ? withSlot(store.ads.get(id)) : null)),
  updateAd: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const row = { ...store.ads.get(id), ...patch, updatedAt: clock };
    store.ads.set(id, row);
    return withSlot(row);
  }),
  transitionAd: vi.fn(async (id: string, from: string[], patch: Record<string, unknown>) => {
    const row = store.ads.get(id);
    if (!row || !from.includes(row.status)) return false;
    store.ads.set(id, { ...row, ...patch, updatedAt: clock });
    return true;
  }),
  adHolds: vi.fn(async (_slotId: string, _from: Date, _to: Date, excludeId?: string) => [
    ...store.holds,
    ...[...store.ads.values()].filter((row) => row.id !== excludeId && ['PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE'].includes(row.status)).map((row) => ({ startDate: row.startDate, endDate: row.endDate })),
  ]),
  adsWhere: vi.fn(async (where: { status: string; startDate?: { lte: Date }; endDate?: { lt: Date }; updatedAt?: { lt: Date } }) =>
    [...store.ads.values()]
      .filter((row) => row.status === where.status)
      .filter((row) => !where.startDate || row.startDate <= where.startDate.lte)
      .filter((row) => !where.endDate || row.endDate < where.endDate.lt)
      .filter((row) => !where.updatedAt || row.updatedAt < where.updatedAt.lt)
      .map(withSlot),
  ),
  findMedia: vi.fn(async (id: string) => store.media.get(id) ?? null),
  createMedia: vi.fn(async (data: Record<string, unknown>) => {
    const row = { ...data, id: `med_${store.media.size + 1}`, archivedAt: null };
    store.media.set(row.id, row);
    return row;
  }),
  archiveMedia: vi.fn(async () => undefined),
  statsFor: vi.fn(async () => []),
  cityLabels: vi.fn(async (keys: string[]) => CITIES.filter((city) => keys.includes(city.id) || keys.includes(city.slug))),
});

vi.mock('../prisma-promotions.repository', () => ({ prismaPromotionsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../invoices', () => invoices);
vi.mock('../../notifications', () => notifications);
vi.mock('../../publishers', () => ({ findPublisherContact: vi.fn(async () => ({ userId: 'usr_pub' })) }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'ADB-0110-2601') }));
vi.mock('../../media', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../media')>()), ...media }));
vi.mock('../../revenue', () => ({ taxSettings: vi.fn(async () => ({ mediaGstPct: '0.18' })) }));
vi.mock('../../feature-flags', () => flags);
vi.mock('../../../shared/audit', () => audit);
/* AGE-1: the order gate, passing unless a test says otherwise. */
const ageGate = vi.hoisted(() => ({ assertPartyAdultForOrders: vi.fn() }));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), ...ageGate }));

import { ageRequiredError } from '../../../shared/age-gate';
import { adPaymentTarget, approveAd, cancelAd, cancelUnpaidAds, createAd, endFinishedAds, payAdFromWallet, rejectAd, settleAdPayment, startDueAds, submitAd, uploadArtwork } from '../ads.service';

const actor = { userId: 'usr_adv', isAdmin: false };
const input = { slotKey: 'WEB_LISTING_SIDEBAR', title: 'Diwali sale', targetUrl: 'https://asha.example/diwali', startDate: '2026-10-05', endDate: '2026-10-11' };

async function draftWithArtwork() {
  const view = await createAd('adv_1', input, actor, clock);
  store.ads.set(view.id, { ...store.ads.get(view.id), mediaId: 'med_seed' });
  store.media.set('med_seed', { id: 'med_seed', url: 'http://x/a.png', width: 600, height: 750, altText: 'Diwali', archivedAt: null });
  return view.id;
}
const row = async (id: string) => (await (repository.findAd as (id: string) => Promise<any>)(id))!;
const debits = () => wallets.move.mock.calls.map(([call]) => call as any).filter((call) => call.entryType === 'PROMOTION_DEBIT');
const refunds = () => wallets.move.mock.calls.map(([call]) => call as any).filter((call) => call.entryType === 'REFUND');

beforeEach(() => {
  vi.clearAllMocks();
  store.ads.clear();
  store.media.clear();
  store.holds = [];
  clock = new Date('2026-10-01T09:00:00Z');
});

describe('a draft', () => {
  it('is priced at the slot rate × days + 18% GST, and names the days already full', async () => {
    store.holds = [
      { startDate: new Date('2026-10-06T00:00:00Z'), endDate: new Date('2026-10-06T00:00:00Z') },
      { startDate: new Date('2026-10-06T00:00:00Z'), endDate: new Date('2026-10-08T00:00:00Z') },
    ];
    const view = await createAd('adv_1', input, actor, clock);
    expect(view).toMatchObject({ status: 'DRAFT', days: 7, ratePerDay: '1500.00', subtotal: '10500.00', gstAmount: '1890.00', total: '12390.00', slot: { key: 'WEB_LISTING_SIDEBAR', spec: 'AD_SIDEBAR' } });
    expect(view.quote).toMatchObject({ days: 7, gstPct: '18', total: '12390.00' });
    expect(view.fullDays).toEqual(['2026-10-06']);
  });
});

describe('submit', () => {
  it('wants the artwork first', async () => {
    const view = await createAd('adv_1', input, actor, clock);
    await expect(submitAd(await row(view.id), actor, clock)).rejects.toMatchObject({ statusCode: 409, code: 'ARTWORK_REQUIRED' });
  });

  it('409 SLOT_FULL with the full days when the slot is at its limit on any of them', async () => {
    const id = await draftWithArtwork();
    store.holds = [
      { startDate: new Date('2026-10-09T00:00:00Z'), endDate: new Date('2026-10-20T00:00:00Z') },
      { startDate: new Date('2026-10-10T00:00:00Z'), endDate: new Date('2026-10-10T00:00:00Z') },
    ];
    await expect(submitAd(await row(id), actor, clock)).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_FULL', details: { fullDays: ['2026-10-10'] } });
    expect((await row(id)).status).toBe('DRAFT');
  });

  it('holds the days while the buyer pays: PENDING_PAYMENT, with a pay-by an hour out', async () => {
    const id = await draftWithArtwork();
    const view = await submitAd(await row(id), actor, clock);
    expect(view.status).toBe('PENDING_PAYMENT');
    expect(view.payBy).toBe('2026-10-01T10:00:00.000Z');
  });
});

describe('paying from the wallet', () => {
  it('debits once, PROMOTION_DEBIT to platform:revenue, invoices it, and waits for review', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    const view = await payAdFromWallet(await row(id), actor, clock);
    expect(view.status).toBe('PENDING_REVIEW');
    expect(debits()).toHaveLength(1);
    expect(debits()[0]).toMatchObject({ amount: '-12390.00', ledgerKind: 'PROMOTION_SPEND', idempotencyKey: `promotion-debit:ad:${id}`, counterLegs: [{ accountCode: 'platform:revenue', amount: '12390.00' }] });
    expect(invoices.issueInvoiceForAdvertising).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1', reference: 'ADB-0110-2601', quantity: 7, taxableValue: '10500.00', gstPct: '0.18' }));
    // Paying again answers the paid booking and charges nothing more.
    await payAdFromWallet(await row(id), actor, clock);
    expect(debits()).toHaveLength(1);
  });

  it('402 INSUFFICIENT_FUNDS on settled money alone — goodwill does not buy an ad', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    wallets.snapshot.mockResolvedValueOnce({ balance: '1000.00', held: '0.00', openWithdrawals: '0.00', goodwill: '50000.00', frozenAt: null });
    await expect(payAdFromWallet(await row(id), actor, clock)).rejects.toMatchObject({ statusCode: 402, code: 'INSUFFICIENT_FUNDS', details: { shortfall: '11390.00' } });
    expect(debits()).toHaveLength(0);
  });

  it('the platform agreement gates the purchase', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    advertisers.bookingEligibility.mockResolvedValueOnce({ blockedBy: ['AGREEMENT'] });
    await expect(payAdFromWallet(await row(id), actor, clock)).rejects.toMatchObject({ statusCode: 403, code: 'PLATFORM_AGREEMENT_REQUIRED' });
  });
});

describe('review', () => {
  async function paid() {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    await payAdFromWallet(await row(id), actor, clock);
    return id;
  }

  it('approve before the start: SCHEDULED; the job runs it on its first day and ends it after its last', async () => {
    const id = await paid();
    expect((await approveAd(id, undefined, 'usr_desk', clock)).status).toBe('SCHEDULED');
    expect(notifications.notify).toHaveBeenCalledWith('PROMOTION_APPROVED', 'usr_adv', expect.objectContaining({ reference: 'ADB-0110-2601' }), expect.anything());
    clock = new Date('2026-10-05T00:10:00Z');
    expect(await startDueAds(clock)).toBe(1);
    expect((await row(id)).status).toBe('LIVE');
    clock = new Date('2026-10-11T23:00:00Z');
    expect(await endFinishedAds(clock)).toBe(0);
    clock = new Date('2026-10-12T00:10:00Z');
    expect(await endFinishedAds(clock)).toBe(1);
    expect((await row(id)).status).toBe('ENDED');
    expect(notifications.notify).toHaveBeenCalledWith('PROMOTION_ENDED', 'usr_adv', expect.anything(), expect.anything());
  });

  it('approve on or after the first day: LIVE at once', async () => {
    const id = await paid();
    clock = new Date('2026-10-06T08:00:00Z');
    expect((await approveAd(id, undefined, 'usr_desk', clock)).status).toBe('LIVE');
  });

  it('reject: REJECTED, the whole amount back as a REFUND keyed on the payment, a credit note, the buyer told why', async () => {
    const id = await paid();
    const view = await rejectAd(id, 'The artwork shows a competitor\'s logo', 'usr_desk', clock);
    expect(view).toMatchObject({ status: 'REJECTED', reviewNote: 'The artwork shows a competitor\'s logo' });
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]).toMatchObject({ amount: '12390.00', ledgerKind: 'REFUND', counterLegs: [{ accountCode: 'platform:revenue', amount: '-12390.00' }] });
    expect(invoices.creditNoteForAdvertising).toHaveBeenCalledWith('adv_1', 'ADB-0110-2601', expect.stringContaining('competitor'), 'usr_desk');
    expect(notifications.notify).toHaveBeenCalledWith('PROMOTION_REJECTED', 'usr_adv', expect.objectContaining({ amount: '12390.00' }), expect.anything());
  });

  it('a rejected booking fixed and paid again is a second charge, keyed apart from the first', async () => {
    const id = await paid();
    await rejectAd(id, 'Blurry', 'usr_desk', clock);
    const { updateAd } = await import('../ads.service');
    await updateAd(await row(id), { title: 'Diwali sale — sharper' }, actor, clock);
    expect((await row(id)).status).toBe('DRAFT');
    await submitAd(await row(id), actor, clock);
    await payAdFromWallet(await row(id), actor, clock);
    expect(debits()).toHaveLength(2);
    expect(debits()[1].idempotencyKey).not.toBe(debits()[0].idempotencyKey);
  });
});

describe('cancel', () => {
  it('before the start: refunded in full; after the start: stopped, nothing refunded', async () => {
    const early = await draftWithArtwork();
    await submitAd(await row(early), actor, clock);
    await payAdFromWallet(await row(early), actor, clock);
    await approveAd(early, undefined, 'usr_desk', clock);
    expect((await cancelAd(await row(early), 'Plans changed', actor, clock)).status).toBe('CANCELLED');
    expect(refunds()).toHaveLength(1);

    store.ads.clear();
    vi.clearAllMocks();
    const late = await draftWithArtwork();
    await submitAd(await row(late), actor, clock);
    await payAdFromWallet(await row(late), actor, clock);
    await approveAd(late, undefined, 'usr_desk', clock);
    clock = new Date('2026-10-07T10:00:00Z');
    await startDueAds(clock);
    const view = await cancelAd(await row(late), 'Stop it', actor, clock);
    expect(view).toMatchObject({ status: 'CANCELLED', refundedAt: null });
    expect(refunds()).toHaveLength(0);
  });

  it('an hour unpaid lets the days go', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    tick(59);
    expect(await cancelUnpaidAds(clock)).toBe(0);
    tick(2);
    expect(await cancelUnpaidAds(clock)).toBe(1);
    expect((await row(id))).toMatchObject({ status: 'CANCELLED', cancelReason: 'Not paid within 60 minutes' });
  });
});

describe('the gateway', () => {
  it('prices the intent for the owner, its agent or ADX — nobody else', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    const payer = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', publisherId: null, agentId: null };
    await expect(adPaymentTarget(id, payer)).resolves.toMatchObject({ payer: { kind: 'ADVERTISER', id: 'adv_1' }, amount: '12390.00', reference: 'ADB-0110-2601' });
    await expect(adPaymentTarget(id, { ...payer, advertiserId: null, agentId: 'agt_1' })).resolves.toBeTruthy();
    await expect(adPaymentTarget(id, { ...payer, advertiserId: 'adv_other' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('settles a capture out of the wallet once, however often it is replayed', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    await expect(settleAdPayment(id, { id: 'pay_1', reference: 'PAY-2026-000001' }, null, clock)).resolves.toEqual({ invoiceId: 'inv_1' });
    await settleAdPayment(id, { id: 'pay_1', reference: 'PAY-2026-000001' }, null, clock);
    expect(debits()).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: 'PENDING_REVIEW', paymentId: 'pay_1' });
  });

  it('a capture for a booking that lapsed is refused, so payments leaves the money in the wallet', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    tick(61);
    await cancelUnpaidAds(clock);
    await expect(settleAdPayment(id, { id: 'pay_1', reference: 'PAY-2026-000001' }, null, clock)).rejects.toMatchObject({ statusCode: 409 });
    expect(debits()).toHaveLength(0);
  });
});

describe('artwork', () => {
  it('goes to the media library against the slot spec, owned by the advertiser; the old one is archived', async () => {
    const view = await createAd('adv_1', input, actor, clock);
    const file = { path: '/tmp/x.png', filename: 'x.png', originalname: 'diwali.png', mimetype: 'image/png', size: 1234 };
    const saved = await uploadArtwork(await row(view.id), file, { altText: 'Diwali offer' }, actor, 'http://api', clock);
    expect(saved.media).toMatchObject({ id: 'med_up', width: 600, height: 750, altText: 'Diwali offer' });
    expect(media.storeMediaFile).toHaveBeenCalledWith(file, expect.objectContaining({ spec: 'AD_SIDEBAR', ownerAdvertiserId: 'adv_1' }), expect.objectContaining({ userId: 'usr_adv', baseUrl: 'http://api' }));
    expect((await row(view.id)).mediaId).toBe('med_up');
  });

  it('is fixed once the ad is approved', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    await payAdFromWallet(await row(id), actor, clock);
    await approveAd(id, undefined, 'usr_desk', clock);
    const file = { path: '/tmp/nope.png', filename: 'nope.png', originalname: 'n.png', mimetype: 'image/png', size: 1 };
    await expect(uploadArtwork(await row(id), file, {}, actor, 'http://api', clock)).rejects.toMatchObject({ statusCode: 409 });
    expect(media.storeMediaFile).not.toHaveBeenCalled();
  });
});

describe('cities and the slot', () => {
  it('stores cities as catalogue ids whether named by slug or id, names them in the view, 400 on an unknown one', async () => {
    const view = await createAd('adv_1', { ...input, cityIds: ['bengaluru', 'city_mum', 'Bengaluru'] }, actor, clock);
    expect(view.cityIds).toEqual(['city_blr', 'city_mum']);
    expect(view.cities).toEqual([
      { id: 'city_blr', slug: 'bengaluru', name: 'Bengaluru' },
      { id: 'city_mum', slug: 'mumbai', name: 'Mumbai' },
    ]);
    await expect(createAd('adv_1', { ...input, cityIds: ['atlantis'] }, actor, clock)).rejects.toMatchObject({ statusCode: 400, details: { unknownCities: ['atlantis'] } });
  });

  it('changes the slot while a draft — re-priced, artwork of another spec let go — and refuses after', async () => {
    const id = await draftWithArtwork();
    const { updateAd } = await import('../ads.service');
    const moved = await updateAd(await row(id), { slotKey: 'WEB_HOME_BANNER' }, actor, clock);
    expect(moved).toMatchObject({ slot: { key: 'WEB_HOME_BANNER', spec: 'AD_BANNER' }, ratePerDay: '3000.00', subtotal: '21000.00', total: '24780.00', media: null });
    expect(repository.archiveMedia).toHaveBeenCalledWith('med_seed', clock);

    const other = await draftWithArtwork();
    await submitAd(await row(other), actor, clock);
    await payAdFromWallet(await row(other), actor, clock);
    await rejectAd(other, 'Blurry', 'usr_desk', clock);
    await expect(updateAd(await row(other), { slotKey: 'WEB_HOME_BANNER' }, actor, clock)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('AGE-1 — buying an ad is placing an order', () => {
  it("submit asks the advertiser's account holder, and a refusal holds no days", async () => {
    const id = await draftWithArtwork();
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('MISSING'));
    await expect(submitAd(await row(id), actor, clock)).rejects.toMatchObject({ statusCode: 403, code: 'AGE_REQUIRED', details: { reason: 'MISSING', self: true } });
    expect(ageGate.assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_adv' });
    expect((await row(id)).status).toBe('DRAFT');
  });

  it('paying from the wallet is refused before any money moves', async () => {
    const id = await draftWithArtwork();
    await submitAd(await row(id), actor, clock);
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('UNDER_18'));
    await expect(payAdFromWallet(await row(id), actor, clock)).rejects.toMatchObject({ code: 'AGE_REQUIRED', details: { reason: 'UNDER_18' } });
    expect(debits()).toHaveLength(0);
    expect((await row(id)).status).toBe('PENDING_PAYMENT');
  });

  it('a draft asks nothing — building one is using ADX', async () => {
    ageGate.assertPartyAdultForOrders.mockRejectedValue(ageRequiredError('MISSING'));
    await expect(createAd('adv_1', input, actor, clock)).resolves.toMatchObject({ status: 'DRAFT' });
    expect(ageGate.assertPartyAdultForOrders).not.toHaveBeenCalled();
    ageGate.assertPartyAdultForOrders.mockReset();
  });
});
