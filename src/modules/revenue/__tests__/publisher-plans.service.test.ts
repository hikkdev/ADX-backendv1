import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublisherPlansRepository } from '../publisher-plans.repository';

/**
 * Lot J (B1) — publisher subscription plans and self-service orders;
 * Lot J2 — the purchase rules as configuration.
 *
 * What is pinned: the seed writes the owner's three defaults and derives
 * each tier's rate from the platform default commission (never below 5%);
 * the editor audits with the diff and re-rates nothing already sold; the
 * quote prices a cycle the way packages does, GST from revenue's tax row
 * and the discount from the policy, and refuses a cycle the policy does not
 * offer; every term rule under both change policies, with the proration
 * credit's amount; the wallet pay refuses a short withdrawable balance
 * before any money moves, refuses the rail the policy closed, and posts the
 * double entry when it does; markPaid is idempotent; the grace-aware
 * entitled reads; the trial refusals and activation; the auto-renew switch;
 * the phone's read; the console's list; and the sweep's duties, the
 * renewal charged once, the short-wallet path and the policy-off path.
 *
 * Lot K (B2), the J2 verifier's leftovers: the proration credit is capped
 * at what the replaced term's order paid, over the term's own days (a
 * trial and a grant earn none); two concurrent trial starts are one trial
 * and one 409 (the lock's re-check); a trial never auto-renews — the
 * switch refuses, both sweep duties skip it; a renewal whose debit posted
 * on a run that then failed completes on the next run; the grace block on
 * the phone's read and the console's rows.
 */

const { repository, revenue, wallets, notifications, audit, settings } = vi.hoisted(() => ({
  repository: {
    listPlans: vi.fn(),
    findPlan: vi.fn(),
    upsertPlan: vi.fn(),
    updatePlan: vi.fn(),
    referenceExists: vi.fn(),
    createOrder: vi.fn(),
    findOrder: vi.fn(),
    listOrdersForPublisher: vi.fn(),
    listOrdersPage: vi.fn(),
    cancelOrder: vi.fn(),
    expireStaleOrders: vi.fn(),
    findOrderStartingAt: vi.fn(),
    activateOrder: vi.fn(),
    listSubscriptionsForPublisher: vi.fn(),
    listSubscriptionsPage: vi.fn(),
    setSubscriptionAutoRenew: vi.fn(),
    findEndingBetween: vi.fn(),
    hasSuccessor: vi.fn(),
    noticeSent: vi.fn(),
    findOrderBySubscription: vi.fn(),
    startTrial: vi.fn(),
    debitPosted: vi.fn(),
  } satisfies Record<keyof PublisherPlansRepository, ReturnType<typeof vi.fn>>,
  revenue: {
    listCommissionRates: vi.fn(),
    findRunningSubscription: vi.fn(),
    findRunningSubscriptions: vi.fn(),
    findLapsedSubscription: vi.fn(),
    findLapsedSubscriptions: vi.fn(),
    getTaxSettings: vi.fn(),
  },
  wallets: { ensureWallet: vi.fn(), snapshot: vi.fn(), move: vi.fn() },
  notifications: { notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: null, deliveries: [] })) },
  audit: { logActivity: vi.fn(async () => undefined) },
  settings: { getSubscriptionPolicy: vi.fn() },
}));

vi.mock('../prisma-publisher-plans.repository', () => ({ prismaPublisherPlansRepository: repository }));
vi.mock('../prisma-revenue.repository', () => ({ prismaRevenueRepository: revenue }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../notifications', () => notifications);
vi.mock('../../app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app-config')>()),
  ...settings,
}));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));

import { DEFAULT_PLATFORM_SETTINGS, type SubscriptionPolicy } from '../../app-config';
import { Decimal } from '../../../shared/money';
import {
  ACTIVATED_TITLE,
  DEFAULT_PLANS,
  ENDED_TITLE,
  EXPIRING_TITLE,
  RENEWAL_FAILED_TITLE,
  RENEWED_TITLE,
  TRIAL_TITLE,
  assertCycleOffered,
  assertMayPaySubscriptionOrder,
  assertSubscriptionOrderActivatable,
  assertSubscriptionOrderPayable,
  createSubscriptionOrder,
  ensurePlans,
  entitledSubscriptionForPublisher,
  entitledSubscriptionsForPublishers,
  listPlans,
  listSubscriptionsPage,
  markSubscriptionOrderPaid,
  mySubscription,
  paySubscriptionOrderFromWallet,
  priceSubscription,
  prorationAmount,
  publisherPlansByTier,
  quoteSubscriptionOrder,
  recordSubscriptionOrderPayment,
  resolveTerm,
  runPublisherSubscriptionSweep,
  setMySubscriptionAutoRenew,
  startSubscriptionTrial,
  tierRate,
  updatePlan,
} from '../publisher-plans.service';

const NOW = new Date('2026-09-14T06:00:00.000Z');
const D = (value: string | number) => new Decimal(value);
const DAY = 24 * 60 * 60 * 1000;
const RATES = { gstPct: '18', annualDiscountPct: 20 };

const DEFAULT_POLICY = DEFAULT_PLATFORM_SETTINGS.subscriptions.publisher;
const policy = (over: Partial<SubscriptionPolicy> = {}): SubscriptionPolicy => ({ ...DEFAULT_POLICY, ...over });

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'plan_plus',
  tier: 'PLUS' as const,
  name: 'Plus',
  pricePerMonth: D('2499'),
  ratePct: D('0.1250'),
  description: 'Live chat with ADX.',
  isPopular: true,
  entitlements: { liveChat: true, featuredListings: 1 },
  isActive: true,
  sortOrder: 2,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const PRO = () => plan({ id: 'plan_pro', tier: 'PRO', name: 'Pro', pricePerMonth: D('4999'), ratePct: D('0.1000'), isPopular: false, sortOrder: 3 });
const STANDARD = () => plan({ id: 'plan_std', tier: 'STANDARD', name: 'Standard', pricePerMonth: D('999'), ratePct: D('0.1400'), entitlements: { liveChat: false }, isPopular: false, sortOrder: 1 });

const PUBLISHER = { id: 'pub_1', name: 'Asha Hoardings', userId: 'usr_pub', displayId: 'PUB-1409-2601' };

const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  reference: 'SUB-2026-000001',
  publisherId: 'pub_1',
  createdByUserId: 'usr_pub',
  tier: 'PLUS' as const,
  planName: 'Plus',
  pricePerMonth: D('2499'),
  ratePct: D('0.1250'),
  cycle: 'MONTHLY' as const,
  months: 1,
  subtotal: D('2499'),
  discountPct: D('0'),
  discountAmount: D('0'),
  gstPct: D('18'),
  gstAmount: D('449.82'),
  total: D('2948.82'),
  status: 'PENDING_PAYMENT' as const,
  startsAt: NOW,
  paidAt: null,
  paidMethod: null,
  paidReference: null,
  cancelledAt: null,
  subscriptionId: null,
  createdAt: NOW,
  updatedAt: NOW,
  publisher: PUBLISHER,
  ...over,
});

const subscription = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  publisherId: 'pub_1',
  tier: 'PLUS' as const,
  ratePct: D('0.1250'),
  pricePerMonth: D('2499'),
  startsAt: new Date('2026-08-14T06:00:00.000Z'),
  endsAt: new Date('2026-09-30T06:00:00.000Z'),
  source: 'SELF_SERVICE' as const,
  autoRenew: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const OWNER = { userId: 'usr_pub', isAdmin: false, publisherId: 'pub_1' };
const ADMIN = { userId: 'usr_admin', isAdmin: true, publisherId: null };

beforeEach(() => {
  vi.clearAllMocks();
  settings.getSubscriptionPolicy.mockResolvedValue(policy());
  repository.listPlans.mockResolvedValue([STANDARD(), plan(), PRO()]);
  repository.findPlan.mockImplementation(async (tier: string) => (tier === 'PLUS' ? plan() : tier === 'PRO' ? PRO() : STANDARD()));
  repository.upsertPlan.mockImplementation(async (data: Record<string, unknown>) => plan(data));
  repository.updatePlan.mockImplementation(async (_tier: string, patch: Record<string, unknown>) => plan(patch));
  repository.referenceExists.mockResolvedValue(false);
  repository.createOrder.mockImplementation(async (data: Record<string, unknown>) => order({ ...data, id: 'ord_new', publisher: PUBLISHER }));
  repository.findOrder.mockImplementation(async (id: string) => order({ id }));
  repository.findOrderStartingAt.mockResolvedValue(null);
  repository.listOrdersForPublisher.mockResolvedValue([]);
  repository.listSubscriptionsForPublisher.mockResolvedValue([]);
  repository.listSubscriptionsPage.mockResolvedValue({ items: [], total: 0, counts: { RUNNING: 0, UPCOMING: 0, ENDED: 0 } });
  repository.setSubscriptionAutoRenew.mockImplementation(async (id: string, autoRenew: boolean) => subscription({ id, autoRenew }));
  repository.findEndingBetween.mockResolvedValue([]);
  repository.hasSuccessor.mockResolvedValue(false);
  repository.noticeSent.mockResolvedValue(false);
  repository.expireStaleOrders.mockResolvedValue(0);
  repository.findOrderBySubscription.mockResolvedValue(null);
  repository.debitPosted.mockResolvedValue(false);
  repository.startTrial.mockImplementation(async (input: { order: Record<string, unknown>; now: Date; startsAt: Date; endsAt: Date }) => {
    const sub = subscription({ id: 'sub_new', startsAt: input.startsAt, endsAt: input.endsAt, autoRenew: false });
    return {
      started: true,
      order: order({ ...input.order, id: 'ord_new', status: 'PAID', paidAt: input.now, paidMethod: 'TRIAL', paidReference: null, subscriptionId: sub.id, publisher: PUBLISHER }),
      subscription: sub,
    };
  });
  repository.activateOrder.mockImplementation(async (input: { orderId: string; now: Date; method: string; reference: string | null; startsAt: Date; endsAt: Date; autoRenew?: boolean }) => {
    const sub = subscription({ id: 'sub_new', startsAt: input.startsAt, endsAt: input.endsAt, autoRenew: input.autoRenew ?? false });
    return {
      order: order({ id: input.orderId, status: 'PAID', paidAt: input.now, paidMethod: input.method, paidReference: input.reference, startsAt: input.startsAt, subscriptionId: sub.id }),
      subscription: sub,
      activated: true,
    };
  });
  revenue.listCommissionRates.mockResolvedValue([{ id: 'cr_1', category: null, mediaTypeId: null, ratePct: D('0.1500'), isActive: true }]);
  revenue.findRunningSubscription.mockResolvedValue(null);
  revenue.findRunningSubscriptions.mockResolvedValue([]);
  revenue.findLapsedSubscription.mockResolvedValue(null);
  revenue.findLapsedSubscriptions.mockResolvedValue([]);
  revenue.getTaxSettings.mockResolvedValue({ id: 'default', mediaGstPct: D('0.18'), mediaSacCode: null });
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_pub' });
  wallets.snapshot.mockResolvedValue({ walletId: 'wal_pub', balance: '5000.00', withdrawable: '5000.00', spendable: '5000.00' });
  wallets.move.mockResolvedValue({ entry: { id: 'we_1' }, transaction: { id: 'lt_1' } });
});

/* ── the seed and its defaults ───────────────────────────────────── */

describe('the seed', () => {
  it('writes the three plans with the owner\'s default pricing, entitlements and the POPULAR flag on Plus', async () => {
    repository.listPlans.mockResolvedValueOnce([]);
    await ensurePlans();
    expect(repository.upsertPlan).toHaveBeenCalledTimes(3);
    const written = repository.upsertPlan.mock.calls.map(([data]) => data as { tier: string; name: string; pricePerMonth: Decimal; isPopular: boolean; entitlements: Record<string, unknown>; sortOrder: number });
    expect(written.map((p) => [p.tier, p.name, p.pricePerMonth.toString(), p.isPopular, p.sortOrder])).toEqual([
      ['STANDARD', 'Standard', '999', false, 1],
      ['PLUS', 'Plus', '2499', true, 2],
      ['PRO', 'Pro', '4999', false, 3],
    ]);
    expect(written[0]!.entitlements).toEqual({ liveChat: false, prioritySupport: false, featuredListings: 0, analytics: 'BASIC', bookingReportPdf: true });
    expect(written[1]!.entitlements).toEqual({ liveChat: true, prioritySupport: false, featuredListings: 1, analytics: 'ADVANCED', bookingReportPdf: true });
    expect(written[2]!.entitlements).toEqual({ liveChat: true, prioritySupport: true, featuredListings: 3, analytics: 'ADVANCED', bookingReportPdf: true });
    expect(DEFAULT_PLANS.map((p) => p.tier)).toEqual(['STANDARD', 'PLUS', 'PRO']);
  });

  it('derives each tier\'s rate from revenue\'s platform default commission: −1, −2.5 and −5 points', async () => {
    repository.listPlans.mockResolvedValueOnce([]);
    await ensurePlans();
    const rates = repository.upsertPlan.mock.calls.map(([data]) => (data as { ratePct: Decimal }).ratePct.toString());
    expect(rates).toEqual(['0.14', '0.125', '0.1']);
  });

  it('falls back to 15% when revenue has no active null-category row, and never goes below 5%', async () => {
    revenue.listCommissionRates.mockResolvedValueOnce([{ id: 'cr_cat', category: 'OUTDOOR', mediaTypeId: null, ratePct: D('0.2000'), isActive: true }]);
    repository.listPlans.mockResolvedValueOnce([]);
    await ensurePlans();
    expect(repository.upsertPlan.mock.calls.map(([data]) => (data as { ratePct: Decimal }).ratePct.toString())).toEqual(['0.14', '0.125', '0.1']);

    expect(tierRate('0.06', 'PRO')).toBe('0.0500');
    expect(tierRate('0.06', 'STANDARD')).toBe('0.0500');
    expect(tierRate('0.10', 'PLUS')).toBe('0.0750');
  });

  it('is idempotent — an existing catalogue is left alone, edits included', async () => {
    await ensurePlans();
    expect(repository.upsertPlan).not.toHaveBeenCalled();
  });

  it('lists the catalogue as money strings, active only unless asked, with the enforced keys named', async () => {
    const plans = await listPlans();
    expect(repository.listPlans).toHaveBeenLastCalledWith(false);
    expect(plans[1]).toMatchObject({ tier: 'PLUS', pricePerMonth: '2499.00', ratePct: '0.1250', isPopular: true, enforced: false, enforcedKeys: ['liveChat'] });
    await listPlans({ includeInactive: true });
    expect(repository.listPlans).toHaveBeenLastCalledWith(true);
  });

  it('publisherPlansByTier answers every tier in one read, retired rows included', async () => {
    const byTier = await publisherPlansByTier();
    expect(repository.listPlans).toHaveBeenLastCalledWith(true);
    expect(byTier.get('STANDARD')).toMatchObject({ name: 'Standard', entitlements: { liveChat: false } });
    expect(byTier.get('PRO')?.name).toBe('Pro');
  });
});

/* ── the editor ──────────────────────────────────────────────────── */

describe('the editor', () => {
  it('writes the patch and audits PUBLISHER_PLAN_UPDATED with the diff', async () => {
    repository.updatePlan.mockResolvedValueOnce(plan({ pricePerMonth: D('2999'), ratePct: D('0.1200'), entitlements: { liveChat: false } }));
    const view = await updatePlan('PLUS', { pricePerMonth: '2999', ratePct: '0.12', entitlements: { liveChat: false } }, { userId: 'usr_admin' });
    expect(repository.updatePlan).toHaveBeenCalledWith('PLUS', expect.objectContaining({ entitlements: { liveChat: false } }));
    expect(view.pricePerMonth).toBe('2999.00');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'PUBLISHER_PLAN_UPDATED',
      expect.objectContaining({
        module: 'revenue',
        targetType: 'PublisherSubscriptionPlan',
        diff: expect.objectContaining({
          pricePerMonth: { before: '2499.00', after: '2999.00' },
          ratePct: { before: '0.1250', after: '0.1200' },
        }),
        metadata: { tier: 'PLUS' },
      }),
    );
  });

  it('never re-rates a subscription already sold — the order keeps the copies it was made with', async () => {
    await updatePlan('PLUS', { ratePct: '0.05' }, { userId: 'usr_admin' });
    expect(repository.activateOrder).not.toHaveBeenCalled();
    expect(repository.updatePlan).toHaveBeenCalledWith('PLUS', { ratePct: D('0.05') });
    const paid = await markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW);
    expect(paid.ratePct.toString()).toBe('0.125');
  });

  it('refuses a rate that is not a fraction, and a tier that is not in the catalogue', async () => {
    await expect(updatePlan('PLUS', { ratePct: '1.5' }, { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 400 });
    repository.findPlan.mockResolvedValueOnce(null);
    await expect(updatePlan('PRO', { name: 'x' }, { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ── the quote ───────────────────────────────────────────────────── */

describe('the quote', () => {
  it('prices a month at face value plus GST, as money strings', () => {
    expect(priceSubscription({ pricePerMonth: '2499.00', cycle: 'MONTHLY', rates: RATES })).toEqual({
      cycle: 'MONTHLY',
      months: 1,
      pricePerMonth: '2499.00',
      subtotal: '2499.00',
      discountPct: '0.00',
      discountAmount: '0.00',
      gstPct: '18.00',
      gstAmount: '449.82',
      total: '2948.82',
    });
  });

  it('prices a year as twelve months less the policy\'s discount, GST on what is left', () => {
    const priced = priceSubscription({ pricePerMonth: '2499.00', cycle: 'ANNUAL', rates: RATES });
    expect(priced).toMatchObject({ months: 12, subtotal: '29988.00', discountPct: '20.00', discountAmount: '5997.60', gstAmount: '4318.27', total: '28308.67' });
    // Lot J2: the discount is the policy's number, not a constant.
    expect(priceSubscription({ pricePerMonth: '2499.00', cycle: 'ANNUAL', rates: { gstPct: '18', annualDiscountPct: 10 } })).toMatchObject({ discountPct: '10.00', discountAmount: '2998.80' });
  });

  it('quotes the live plan, says when the term would start, and prints the policy beside the money', async () => {
    const quote = await quoteSubscriptionOrder({ publisherId: 'pub_1', tier: 'PLUS', cycle: 'MONTHLY', now: NOW });
    expect(quote).toMatchObject({ total: '2948.82', plan: { tier: 'PLUS', name: 'Plus' }, term: { rule: 'STARTS_NOW', startsAt: NOW, credit: null } });
    expect(quote.term.endsAt.toISOString()).toBe('2026-10-14T06:00:00.000Z');
    expect(quote.policy).toEqual({
      cyclesOffered: ['MONTHLY', 'ANNUAL'],
      annualDiscountPct: 20,
      changePolicy: 'REPLACE_NOW',
      prorateOnChange: false,
      graceDays: 0,
      trialDays: 0,
      payment: { walletAllowed: true, gatewaysAllowed: ['RAZORPAY', 'CASHFREE', 'CCAVENUE'] },
      autoRenewAllowed: false,
    });
  });

  /* Lot J2 (2): GST is revenue's tax row — change the row, the quote follows. */
  it('reads GST from revenue\'s tax row: change the row and the quote follows', async () => {
    revenue.getTaxSettings.mockResolvedValue({ id: 'default', mediaGstPct: D('0.05'), mediaSacCode: null });
    const quote = await quoteSubscriptionOrder({ publisherId: 'pub_1', tier: 'PLUS', cycle: 'MONTHLY', now: NOW });
    expect(quote).toMatchObject({ gstPct: '5.00', gstAmount: '124.95', total: '2623.95' });
    // No row at all: the 18% fallback the campaign quote uses.
    revenue.getTaxSettings.mockResolvedValue(null);
    expect((await quoteSubscriptionOrder({ publisherId: 'pub_1', tier: 'PLUS', cycle: 'MONTHLY', now: NOW })).gstPct).toBe('18.00');
  });

  /* Lot J2 (2): a cycle the policy does not offer is refused, naming the offered ones. */
  it('refuses a cycle the policy does not offer, 400, naming the offered ones — before anything is priced', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ cyclesOffered: ['MONTHLY'] }));
    await expect(quoteSubscriptionOrder({ publisherId: 'pub_1', tier: 'PLUS', cycle: 'ANNUAL', now: NOW })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CYCLE_NOT_OFFERED',
      message: 'The ANNUAL cycle is not offered. Choose MONTHLY.',
    });
    expect(repository.findPlan).not.toHaveBeenCalled();
    expect(() => assertCycleOffered('ANNUAL', { cyclesOffered: ['MONTHLY', 'ANNUAL'] })).not.toThrow();
    await expect(createSubscriptionOrder({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', cycle: 'ANNUAL', now: NOW })).rejects.toMatchObject({ code: 'CYCLE_NOT_OFFERED' });
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('refuses a retired plan', async () => {
    repository.findPlan.mockResolvedValueOnce(plan({ isActive: false }));
    await expect(quoteSubscriptionOrder({ publisherId: 'pub_1', tier: 'PLUS', cycle: 'MONTHLY', now: NOW })).rejects.toMatchObject({ statusCode: 409 });
  });
});

/* ── the term rule ───────────────────────────────────────────────── */

describe('the term rule', () => {
  it('nothing running: starts now', async () => {
    const term = await resolveTerm('pub_1', 'PLUS', 12, NOW);
    expect(term).toMatchObject({ rule: 'STARTS_NOW', startsAt: NOW, replaces: null, credit: null });
    expect(term.endsAt.toISOString()).toBe('2027-09-14T06:00:00.000Z');
  });

  it('the same tier running with an end: the renewal queues at that end', async () => {
    revenue.findRunningSubscription.mockResolvedValueOnce(subscription());
    const term = await resolveTerm('pub_1', 'PLUS', 1, NOW);
    expect(term).toMatchObject({ rule: 'QUEUED_AFTER_CURRENT', startsAt: new Date('2026-09-30T06:00:00.000Z'), replaces: null });
    expect(term.endsAt.toISOString()).toBe('2026-10-30T06:00:00.000Z');
  });

  it('the same tier running open-ended: refused 409 Already on this plan', async () => {
    revenue.findRunningSubscription.mockResolvedValue(subscription({ endsAt: null, source: 'ADMIN_GRANT' }));
    await expect(resolveTerm('pub_1', 'PLUS', 1, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_ON_PLAN', message: 'Already on this plan' });
    await expect(createSubscriptionOrder({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', cycle: 'MONTHLY', now: NOW })).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('REPLACE_NOW (the default): a different tier starts now and the running one ends now, no proration', async () => {
    revenue.findRunningSubscription.mockResolvedValue(subscription({ id: 'sub_std', tier: 'STANDARD', endsAt: null }));
    const term = await resolveTerm('pub_1', 'PLUS', 1, NOW);
    expect(term).toMatchObject({ rule: 'REPLACES_CURRENT', startsAt: NOW, replaces: { id: 'sub_std', tier: 'STANDARD' }, credit: null });

    await markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW);
    expect(repository.activateOrder).toHaveBeenCalledWith(expect.objectContaining({ endRunningId: 'sub_std', startsAt: NOW }));
    expect(wallets.move).not.toHaveBeenCalled();
  });

  /* Lot J2 (3): the other change policy. */
  it('QUEUE_AFTER_TERM: a different tier starts at the running term\'s end, like a same-tier renewal, and nothing ends early', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ changePolicy: 'QUEUE_AFTER_TERM' }));
    revenue.findRunningSubscription.mockResolvedValue(subscription({ id: 'sub_std', tier: 'STANDARD' }));
    const term = await resolveTerm('pub_1', 'PLUS', 1, NOW);
    expect(term).toMatchObject({ rule: 'QUEUED_AFTER_CURRENT', startsAt: new Date('2026-09-30T06:00:00.000Z'), replaces: null, credit: null });
    expect(term.endsAt.toISOString()).toBe('2026-10-30T06:00:00.000Z');

    await markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW);
    expect(repository.activateOrder).toHaveBeenCalledWith(expect.objectContaining({ endRunningId: null, startsAt: new Date('2026-09-30T06:00:00.000Z') }));
  });

  it('QUEUE_AFTER_TERM behind an open-ended grant of another tier: refused 409, there is no end to queue after', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ changePolicy: 'QUEUE_AFTER_TERM' }));
    revenue.findRunningSubscription.mockResolvedValue(subscription({ id: 'sub_std', tier: 'STANDARD', endsAt: null, source: 'ADMIN_GRANT' }));
    await expect(resolveTerm('pub_1', 'PLUS', 1, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_ON_PLAN' });
  });

  /* Lot J2 (3): the proration credit, pinned to the paisa. */
  /* Lot K (B2): the credit is what the term paid, pro rata over the term's own days, and never more. */
  it('prorates: paidTotal × remaining whole days ÷ the term\'s whole days, rounded down to the paisa; nothing for an open-ended term, under a whole day, or a term that paid nothing', () => {
    // Pro's order paid ₹5,898.82 (4999 + GST) for 31 Aug → 30 Sep, 30 days; 16 whole days left: 5898.82 × 16 / 30 = 3146.037…
    const term = { paidTotal: D('5898.82'), startsAt: new Date('2026-08-31T06:00:00.000Z'), endsAt: new Date('2026-09-30T06:00:00.000Z') };
    expect(prorationAmount(term, NOW)).toEqual({ amount: '3146.03', remainingDays: 16, termDays: 30, paidTotal: '5898.82' });
    // The month's length plays no part: the same term straddling a 31-day month divides by 30 all the same.
    expect(prorationAmount(term, new Date('2026-08-31T06:00:00.000Z'))).toEqual({ amount: '5898.82', remainingDays: 30, termDays: 30, paidTotal: '5898.82' });
    // Less than a whole day left is nothing.
    expect(prorationAmount({ ...term, endsAt: new Date('2026-09-14T20:00:00.000Z') }, NOW)).toBeNull();
    expect(prorationAmount({ ...term, endsAt: null }, NOW)).toBeNull();
    expect(prorationAmount({ ...term, endsAt: new Date('2026-09-01T00:00:00.000Z') }, NOW)).toBeNull();
    // A free term earns no credit: a trial (no paid total) or a zero total.
    expect(prorationAmount({ ...term, paidTotal: null }, NOW)).toBeNull();
    expect(prorationAmount({ ...term, paidTotal: D('0') }, NOW)).toBeNull();
  });

  it('a 12-month annual term replaced after one day credits at most its paid total less one day\'s share — never twelve months of list price', () => {
    // Plus annual: 2499 × 12 less 20%, plus GST = 28308.67, paid for 13 Sep 2026 → 13 Sep 2027 (365 days). Replaced at NOW, one day in.
    const startsAt = new Date('2026-09-13T06:00:00.000Z');
    const endsAt = new Date('2027-09-13T06:00:00.000Z');
    const credit = prorationAmount({ paidTotal: D('28308.67'), startsAt, endsAt }, NOW);
    expect(credit).toEqual({ amount: '28231.11', remainingDays: 364, termDays: 365, paidTotal: '28308.67' });
    const ceiling = D('28308.67').minus(D('28308.67').dividedBy(365));
    expect(D(credit!.amount).lessThanOrEqualTo(ceiling)).toBe(true);
    expect(D(credit!.amount).lessThan(D('28308.67'))).toBe(true);
    // Under the old month-based rule this would have been 2499 × 364 / 30 — nearly ₹30,000 for a ₹28,308.67 purchase.
    expect(D(credit!.amount).lessThan(D('2499').times(364).dividedBy(30))).toBe(true);
  });

  it('REPLACE_NOW with prorateOnChange: the running term\'s unused days come back as a wallet credit — capped at its order\'s total — double entry against platform:revenue, keyed on the order', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ prorateOnChange: true }));
    revenue.findRunningSubscription.mockResolvedValue(subscription({ id: 'sub_pro', tier: 'PRO', pricePerMonth: D('4999'), startsAt: new Date('2026-08-31T06:00:00.000Z'), endsAt: new Date('2026-09-30T06:00:00.000Z') }));
    repository.findOrderBySubscription.mockResolvedValue(order({ id: 'ord_pro', tier: 'PRO', planName: 'Pro', status: 'PAID', paidMethod: 'WALLET', total: D('5898.82'), subscriptionId: 'sub_pro' }));
    const term = await resolveTerm('pub_1', 'PLUS', 1, NOW);
    expect(repository.findOrderBySubscription).toHaveBeenCalledWith('sub_pro');
    expect(term).toMatchObject({ rule: 'REPLACES_CURRENT', replaces: { id: 'sub_pro' }, credit: { subscriptionId: 'sub_pro', planName: 'Pro', amount: '3146.03', remainingDays: 16, termDays: 30, paidTotal: '5898.82' } });

    await markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW);
    expect(repository.activateOrder).toHaveBeenCalledWith(expect.objectContaining({ endRunningId: 'sub_pro' }));
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_1' }, 'Publisher wallet');
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal_pub',
        amount: '3146.03',
        entryType: 'ADJUSTMENT',
        ledgerKind: 'ADJUSTMENT',
        idempotencyKey: 'subscription-proration:ord_1',
        counterLegs: [{ accountCode: 'platform:revenue', amount: '-3146.03', note: 'Unused days of Pro' }],
        reference: 'sub_pro',
        note: 'Unused days of Pro',
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_ACTIVATED',
      'usr_pub',
      expect.anything(),
      expect.objectContaining({ inApp: expect.objectContaining({ message: expect.stringContaining('₹3146.03 for the unused days of Pro') }) }),
    );
  });

  it('a free term earns no credit: a TRIAL order behind the running row, or an admin grant with no order at all, replaces with credit null and no wallet movement', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ prorateOnChange: true }));
    const running = subscription({ id: 'sub_trial', tier: 'PRO', startsAt: new Date('2026-09-10T06:00:00.000Z'), endsAt: new Date('2026-09-24T06:00:00.000Z') });
    revenue.findRunningSubscription.mockResolvedValue(running);
    repository.findOrderBySubscription.mockResolvedValue(order({ id: 'ord_trial', tier: 'PRO', status: 'PAID', paidMethod: 'TRIAL', total: D('0'), subscriptionId: 'sub_trial' }));
    expect(await resolveTerm('pub_1', 'PLUS', 1, NOW)).toMatchObject({ rule: 'REPLACES_CURRENT', replaces: { id: 'sub_trial' }, credit: null });

    revenue.findRunningSubscription.mockResolvedValue(subscription({ id: 'sub_grant', tier: 'PRO', source: 'ADMIN_GRANT', startsAt: new Date('2026-08-31T06:00:00.000Z'), endsAt: new Date('2026-09-30T06:00:00.000Z') }));
    repository.findOrderBySubscription.mockResolvedValue(null);
    expect(await resolveTerm('pub_1', 'PLUS', 1, NOW)).toMatchObject({ rule: 'REPLACES_CURRENT', replaces: { id: 'sub_grant' }, credit: null });

    await markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW);
    expect(repository.activateOrder).toHaveBeenCalledWith(expect.objectContaining({ endRunningId: 'sub_grant' }));
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('a month from the 31st ends on the last day of a shorter month', async () => {
    const jan31 = new Date('2027-01-31T00:00:00.000Z');
    const term = await resolveTerm('pub_1', 'PLUS', 1, jan31);
    expect(term.endsAt.toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });

  it('assertSubscriptionOrderActivatable is the term rule\'s refusal alone — for the doors that debit before they activate', async () => {
    await expect(assertSubscriptionOrderActivatable(order(), NOW)).resolves.toMatchObject({ rule: 'STARTS_NOW' });
    revenue.findRunningSubscription.mockResolvedValue(subscription({ endsAt: null }));
    await expect(assertSubscriptionOrderActivatable(order(), NOW)).rejects.toMatchObject({ code: 'ALREADY_ON_PLAN' });
  });
});

/* ── the order ───────────────────────────────────────────────────── */

describe('the order', () => {
  it('snapshots the plan, mints a SUB-YYYY-NNNNNN reference and carries the quoted term', async () => {
    const { order: created, term } = await createSubscriptionOrder({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', cycle: 'ANNUAL', now: NOW });
    const data = repository.createOrder.mock.calls[0]![0] as Record<string, Decimal | string | number>;
    expect(String(data['reference'])).toMatch(/^SUB-2026-\d{6}$/);
    expect(data).toMatchObject({ publisherId: 'pub_1', createdByUserId: 'usr_pub', tier: 'PLUS', planName: 'Plus', months: 12 });
    expect((data['ratePct'] as Decimal).toString()).toBe('0.125');
    expect((data['total'] as Decimal).toFixed(2)).toBe('28308.67');
    expect(created).toMatchObject({ id: 'ord_new', total: '28308.67', status: 'PENDING_PAYMENT' });
    expect(term.rule).toBe('STARTS_NOW');
  });

  it('retries a taken reference', async () => {
    repository.referenceExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await createSubscriptionOrder({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', cycle: 'MONTHLY', now: NOW });
    expect(repository.referenceExists).toHaveBeenCalledTimes(2);
  });

  it('only the owning publisher pays; a cancelled or expired order is not payable', () => {
    expect(() => assertMayPaySubscriptionOrder({ publisherId: 'pub_1' }, OWNER)).not.toThrow();
    expect(() => assertMayPaySubscriptionOrder({ publisherId: 'pub_1' }, ADMIN)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => assertMayPaySubscriptionOrder({ publisherId: 'pub_2' }, OWNER)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => assertSubscriptionOrderPayable({ status: 'PENDING_PAYMENT' })).not.toThrow();
    expect(() => assertSubscriptionOrderPayable({ status: 'CANCELLED' })).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => assertSubscriptionOrderPayable({ status: 'EXPIRED' })).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => assertSubscriptionOrderPayable({ status: 'PAID' })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

/* ── the wallet pay ──────────────────────────────────────────────── */

describe('paying from the wallet', () => {
  it('refuses 402 INSUFFICIENT_FUNDS on a short withdrawable balance before any money moves', async () => {
    wallets.snapshot.mockResolvedValueOnce({ walletId: 'wal_pub', balance: '9000.00', withdrawable: '2000.00', spendable: '9000.00' });
    await expect(paySubscriptionOrderFromWallet('ord_1', OWNER, NOW)).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_FUNDS',
      details: { required: '2948.82', withdrawable: '2000.00' },
    });
    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.activateOrder).not.toHaveBeenCalled();
  });

  it('debits the publisher wallet against platform:revenue — the double entry — keyed on the order, then activates', async () => {
    const view = await paySubscriptionOrderFromWallet('ord_1', OWNER, NOW);
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_1' }, 'Publisher wallet');
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal_pub',
        amount: '-2948.82',
        entryType: 'PACKAGE_DEBIT',
        ledgerKind: 'PACKAGE_SPEND',
        idempotencyKey: 'subscription-debit:ord_1',
        requireFunds: true,
        counterLegs: [{ accountCode: 'platform:revenue', amount: '2948.82', note: 'Publisher subscription' }],
        reference: 'ord_1',
      }),
    );
    expect(repository.activateOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ord_1', method: 'WALLET', reference: 'SUB-2026-000001', startsAt: NOW }));
    expect(view).toMatchObject({ status: 'PAID', paidMethod: 'WALLET', subscriptionId: 'sub_new' });
  });

  it('checks the term before the wallet: an order that cannot activate is not charged', async () => {
    revenue.findRunningSubscription.mockResolvedValue(subscription({ endsAt: null }));
    await expect(paySubscriptionOrderFromWallet('ord_1', OWNER, NOW)).rejects.toMatchObject({ code: 'ALREADY_ON_PLAN' });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  /* Lot J2 (7): the rail the policy closed. */
  it('refuses 403 PAYMENT_METHOD_NOT_OFFERED when the policy has closed the wallet rail, before the wallet is read', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ payment: { walletAllowed: false, gatewaysAllowed: ['RAZORPAY'] } }));
    await expect(paySubscriptionOrderFromWallet('ord_1', OWNER, NOW)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PAYMENT_METHOD_NOT_OFFERED',
      details: { method: 'WALLET', gatewaysAllowed: ['RAZORPAY'] },
    });
    expect(wallets.snapshot).not.toHaveBeenCalled();
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('is the publisher\'s own door — not an admin\'s, not another publisher\'s', async () => {
    await expect(paySubscriptionOrderFromWallet('ord_1', ADMIN, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(paySubscriptionOrderFromWallet('ord_1', { ...OWNER, publisherId: 'pub_2' }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    expect(wallets.snapshot).not.toHaveBeenCalled();
  });

  it('a paid order paid again returns it unchanged without touching the wallet', async () => {
    repository.findOrder.mockResolvedValueOnce(order({ status: 'PAID', paidMethod: 'WALLET', subscriptionId: 'sub_1' }));
    const view = await paySubscriptionOrderFromWallet('ord_1', OWNER, NOW);
    expect(view.status).toBe('PAID');
    expect(wallets.move).not.toHaveBeenCalled();
  });
});

/* ── the activation ──────────────────────────────────────────────── */

describe('markSubscriptionOrderPaid', () => {
  it('activates in one repository transaction with the term, and tells the publisher', async () => {
    const paid = await markSubscriptionOrderPaid('ord_1', { method: 'GATEWAY', reference: 'PAY-2026-000009' }, NOW);
    expect(repository.activateOrder).toHaveBeenCalledWith({
      orderId: 'ord_1',
      now: NOW,
      method: 'GATEWAY',
      reference: 'PAY-2026-000009',
      startsAt: NOW,
      endsAt: new Date('2026-10-14T06:00:00.000Z'),
      endRunningId: null,
      autoRenew: false,
    });
    expect(paid.status).toBe('PAID');
    expect(notifications.notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_ACTIVATED',
      'usr_pub',
      expect.objectContaining({ planName: 'Plus', reference: 'SUB-2026-000001' }),
      expect.objectContaining({ inApp: expect.objectContaining({ title: ACTIVATED_TITLE, relatedId: 'sub_new' }) }),
    );
  });

  it('is idempotent: a second call on a PAID order returns it unchanged', async () => {
    const already = order({ status: 'PAID', paidAt: NOW, paidMethod: 'WALLET', subscriptionId: 'sub_1' });
    repository.findOrder.mockResolvedValueOnce(already);
    const again = await markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW);
    expect(again).toBe(already);
    expect(repository.activateOrder).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('a race inside the transaction — already PAID on re-read — sends nothing twice', async () => {
    repository.activateOrder.mockResolvedValueOnce({ order: order({ status: 'PAID', subscriptionId: 'sub_1' }), subscription: subscription(), activated: false });
    await markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('refuses a cancelled or expired order', async () => {
    repository.findOrder.mockResolvedValueOnce(order({ status: 'CANCELLED' }));
    await expect(markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    repository.findOrder.mockResolvedValueOnce(order({ status: 'EXPIRED' }));
    await expect(markSubscriptionOrderPaid('ord_1', { method: 'OFFLINE' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.activateOrder).not.toHaveBeenCalled();
  });

  it('the admin record-payment door audits SUBSCRIPTION_ORDER_RECORDED with the diff', async () => {
    const view = await recordSubscriptionOrderPayment('ord_1', { reference: 'UTR123', method: 'NEFT' }, { userId: 'usr_admin' }, NOW);
    expect(view).toMatchObject({ status: 'PAID', paidMethod: 'OFFLINE', paidReference: 'NEFT:UTR123' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'SUBSCRIPTION_ORDER_RECORDED',
      expect.objectContaining({
        module: 'revenue',
        targetType: 'PublisherSubscriptionOrder',
        targetId: 'ord_1',
        diff: expect.objectContaining({ status: { before: 'PENDING_PAYMENT', after: 'PAID' } }),
        metadata: expect.objectContaining({ method: 'NEFT', paymentReference: 'UTR123', total: '2948.82' }),
      }),
    );
  });
});

/* ── Lot J2 (5): trials ──────────────────────────────────────────── */

describe('a free trial', () => {
  const withTrial = () => settings.getSubscriptionPolicy.mockResolvedValue(policy({ trialDays: { STANDARD: 0, PLUS: 14, PRO: 0 } }));

  it('is refused 409 TRIAL_NOT_OFFERED when the tier\'s trialDays is 0', async () => {
    await expect(startSubscriptionTrial({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', now: NOW })).rejects.toMatchObject({ statusCode: 409, code: 'TRIAL_NOT_OFFERED' });
    withTrial();
    await expect(startSubscriptionTrial({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PRO', now: NOW })).rejects.toMatchObject({ code: 'TRIAL_NOT_OFFERED' });
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('is refused 409 TRIAL_ALREADY_USED once the publisher has ever held any subscription — a grant, a purchase, a trial, running or not', async () => {
    withTrial();
    repository.listSubscriptionsForPublisher.mockResolvedValue([subscription({ endsAt: new Date('2025-01-01T00:00:00.000Z'), source: 'ADMIN_GRANT' })]);
    await expect(startSubscriptionTrial({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', now: NOW })).rejects.toMatchObject({ statusCode: 409, code: 'TRIAL_ALREADY_USED' });
    repository.listSubscriptionsForPublisher.mockResolvedValue([subscription()]);
    await expect(startSubscriptionTrial({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', now: NOW })).rejects.toMatchObject({ code: 'TRIAL_ALREADY_USED' });
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('otherwise: through the repository\'s locked transaction — an order PAID at once with total 0 and method TRIAL, a subscription of trialDays — and the activation notice says it is a trial', async () => {
    withTrial();
    const { order: created, subscription: started } = await startSubscriptionTrial({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', now: NOW });

    expect(repository.startTrial).toHaveBeenCalledTimes(1);
    const input = repository.startTrial.mock.calls[0]![0] as { publisherId: string; now: Date; startsAt: Date; endsAt: Date; order: Record<string, Decimal | number | string> };
    expect(input).toMatchObject({ publisherId: 'pub_1', now: NOW, startsAt: NOW, endsAt: new Date('2026-09-28T06:00:00.000Z') });
    expect(input.order).toMatchObject({ tier: 'PLUS', planName: 'Plus', months: 0, cycle: 'MONTHLY', createdByUserId: 'usr_pub', reference: expect.stringMatching(/^SUB-2026-/) });
    expect((input.order['total'] as Decimal).toString()).toBe('0');
    expect((input.order['gstAmount'] as Decimal).toString()).toBe('0');
    // Nothing outside the lock writes: no plain order, no separate activation, no wallet.
    expect(repository.createOrder).not.toHaveBeenCalled();
    expect(repository.activateOrder).not.toHaveBeenCalled();
    expect(wallets.move).not.toHaveBeenCalled();
    expect(created).toMatchObject({ id: 'ord_new', status: 'PAID', paidMethod: 'TRIAL', total: '0.00' });
    expect(started).toMatchObject({ id: 'sub_new', tier: 'PLUS', source: 'SELF_SERVICE', autoRenew: false });
    expect(notifications.notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_ACTIVATED',
      'usr_pub',
      expect.objectContaining({ planName: 'Plus (free trial)' }),
      expect.objectContaining({ inApp: expect.objectContaining({ title: TRIAL_TITLE, relatedId: 'sub_new', message: expect.stringContaining('free trial of Plus runs until 28 Sept 2026') }) }),
    );
  });

  /* Lot K (B2): two concurrent starts — the lock's re-check. */
  it('cannot race: two trial starts arriving together are one 201 and one 409 TRIAL_ALREADY_USED — the second is refused by the re-check under the lock, and nothing is told twice', async () => {
    withTrial();
    // Both pass the plain history check (nothing held yet); the repository serialises them at the lock
    // and the second re-reads a history that now holds the first's row.
    let held = 0;
    let chain: Promise<unknown> = Promise.resolve();
    repository.startTrial.mockImplementation((input: { order: Record<string, unknown>; now: Date; startsAt: Date; endsAt: Date }) => {
      const run = chain.then(async () => {
        if (held > 0) return { started: false, order: null, subscription: null };
        held += 1;
        const sub = subscription({ id: 'sub_new', startsAt: input.startsAt, endsAt: input.endsAt });
        return { started: true, order: order({ ...input.order, id: 'ord_new', status: 'PAID', paidMethod: 'TRIAL', subscriptionId: sub.id, publisher: PUBLISHER }), subscription: sub };
      });
      chain = run.catch(() => undefined);
      return run;
    });

    const outcomes = await Promise.allSettled([
      startSubscriptionTrial({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', now: NOW }),
      startSubscriptionTrial({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS', now: NOW }),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409, code: 'TRIAL_ALREADY_USED' });
    expect(repository.startTrial).toHaveBeenCalledTimes(2);
    expect(held).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });
});

/* ── Lot J2 (6): the auto-renew switch ───────────────────────────── */

describe('the auto-renew switch', () => {
  it('is refused 409 "Auto-renew is not offered" while the policy does not allow it', async () => {
    revenue.findRunningSubscription.mockResolvedValue(subscription());
    await expect(setMySubscriptionAutoRenew('pub_1', true, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'AUTO_RENEW_NOT_OFFERED', message: 'Auto-renew is not offered' });
    expect(repository.setSubscriptionAutoRenew).not.toHaveBeenCalled();
  });

  /* Lot K (B2) */
  it('is refused 409 AUTO_RENEW_NOT_OFFERED "A trial does not renew - buy the plan" on a running trial, even with the policy allowing renewals; switching a trial off is still allowed', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ autoRenew: { allowed: true, chargeFromWallet: true } }));
    revenue.findRunningSubscription.mockResolvedValue(subscription({ id: 'sub_trial' }));
    repository.findOrderBySubscription.mockResolvedValue(order({ id: 'ord_trial', status: 'PAID', paidMethod: 'TRIAL', total: D('0'), subscriptionId: 'sub_trial' }));
    await expect(setMySubscriptionAutoRenew('pub_1', true, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'AUTO_RENEW_NOT_OFFERED', message: 'A trial does not renew - buy the plan' });
    expect(repository.findOrderBySubscription).toHaveBeenCalledWith('sub_trial');
    expect(repository.setSubscriptionAutoRenew).not.toHaveBeenCalled();

    revenue.findRunningSubscription.mockResolvedValue(subscription({ id: 'sub_trial', autoRenew: true }));
    expect(await setMySubscriptionAutoRenew('pub_1', false, NOW)).toMatchObject({ autoRenew: false });
    expect(repository.setSubscriptionAutoRenew).toHaveBeenCalledWith('sub_trial', false);
  });

  it('sets the flag on the running row when the policy allows it; switching off is always allowed; nothing running is 404', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ autoRenew: { allowed: true, chargeFromWallet: true } }));
    revenue.findRunningSubscription.mockResolvedValue(subscription());
    expect(await setMySubscriptionAutoRenew('pub_1', true, NOW)).toMatchObject({ id: 'sub_1', autoRenew: true, planName: 'Plus' });
    expect(repository.setSubscriptionAutoRenew).toHaveBeenCalledWith('sub_1', true);

    settings.getSubscriptionPolicy.mockResolvedValue(policy());
    revenue.findRunningSubscription.mockResolvedValue(subscription({ autoRenew: true }));
    expect(await setMySubscriptionAutoRenew('pub_1', false, NOW)).toMatchObject({ autoRenew: false });

    revenue.findRunningSubscription.mockResolvedValue(null);
    await expect(setMySubscriptionAutoRenew('pub_1', false, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ── Lot J2 (4): grace ───────────────────────────────────────────── */

describe('the entitled reads (grace)', () => {
  it('answer the running subscription, not in grace, with the day the grace would end', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 5 }));
    revenue.findRunningSubscription.mockResolvedValue(subscription());
    expect(await entitledSubscriptionForPublisher('pub_1', NOW)).toEqual({
      id: 'sub_1',
      tier: 'PLUS',
      startsAt: subscription().startsAt,
      endsAt: subscription().endsAt,
      inGrace: false,
      graceEndsAt: new Date('2026-10-05T06:00:00.000Z'),
    });
    expect(revenue.findLapsedSubscription).not.toHaveBeenCalled();
  });

  it('answer a subscription that ended within graceDays as inGrace, and nothing once the window has passed or with graceDays 0', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 5 }));
    const lapsed = subscription({ endsAt: new Date('2026-09-12T06:00:00.000Z') });
    revenue.findLapsedSubscription.mockResolvedValue(lapsed);
    expect(await entitledSubscriptionForPublisher('pub_1', NOW)).toMatchObject({ id: 'sub_1', inGrace: true, graceEndsAt: new Date('2026-09-17T06:00:00.000Z') });
    expect(revenue.findLapsedSubscription).toHaveBeenCalledWith('pub_1', new Date('2026-09-09T06:00:00.000Z'), NOW);

    revenue.findLapsedSubscription.mockResolvedValue(null);
    expect(await entitledSubscriptionForPublisher('pub_1', NOW)).toBeNull();

    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 0 }));
    revenue.findLapsedSubscription.mockClear();
    expect(await entitledSubscriptionForPublisher('pub_1', NOW)).toBeNull();
    expect(revenue.findLapsedSubscription).not.toHaveBeenCalled();
  });

  it('the batch form: running rows first, then the lapsed ones only for whoever has nothing running', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 3 }));
    revenue.findRunningSubscriptions.mockResolvedValue([subscription({ id: 'sub_a', publisherId: 'pub_a' })]);
    revenue.findLapsedSubscriptions.mockResolvedValue([subscription({ id: 'sub_b', publisherId: 'pub_b', endsAt: new Date('2026-09-13T06:00:00.000Z') })]);
    const map = await entitledSubscriptionsForPublishers(['pub_a', 'pub_b', 'pub_c'], NOW);
    expect(revenue.findLapsedSubscriptions).toHaveBeenCalledWith(['pub_b', 'pub_c'], new Date('2026-09-11T06:00:00.000Z'), NOW);
    expect(map.get('pub_a')).toMatchObject({ id: 'sub_a', inGrace: false });
    expect(map.get('pub_b')).toMatchObject({ id: 'sub_b', inGrace: true, graceEndsAt: new Date('2026-09-16T06:00:00.000Z') });
    expect(map.has('pub_c')).toBe(false);
  });
});

/* ── the phone's read ────────────────────────────────────────────── */

describe('GET /revenue/subscriptions/me', () => {
  it('with nothing running: no plan, every tier buyable now, the policy printed, no trials while none is offered', async () => {
    const me = await mySubscription('pub_1', NOW);
    expect(me.running).toBeNull();
    expect(me.plan).toBeNull();
    expect(me.upcoming).toEqual([]);
    expect(me.canBuy).toBe(true);
    expect(me.options.map((o) => [o.tier, o.allowed, o.rule])).toEqual([
      ['STANDARD', true, 'STARTS_NOW'],
      ['PLUS', true, 'STARTS_NOW'],
      ['PRO', true, 'STARTS_NOW'],
    ]);
    expect(me.trialAvailable).toEqual({});
    expect(me.policy).toMatchObject({ changePolicy: 'REPLACE_NOW', autoRenewAllowed: false });
    expect(me.grace).toBeNull();
  });

  /* Lot K (B2) */
  it('grace: with nothing running and a term ended inside graceDays, answers { tier, planName, endsAt, until }; null while one runs, past the window, or with graceDays 0', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 5 }));
    revenue.findLapsedSubscription.mockResolvedValue(subscription({ id: 'sub_old', tier: 'PRO', endsAt: new Date('2026-09-12T06:00:00.000Z') }));
    const me = await mySubscription('pub_1', NOW);
    expect(revenue.findLapsedSubscription).toHaveBeenCalledWith('pub_1', new Date('2026-09-09T06:00:00.000Z'), NOW);
    expect(me.running).toBeNull();
    expect(me.grace).toEqual({ tier: 'PRO', planName: 'Pro', endsAt: new Date('2026-09-12T06:00:00.000Z'), until: new Date('2026-09-17T06:00:00.000Z') });

    revenue.findLapsedSubscription.mockResolvedValue(null);
    expect((await mySubscription('pub_1', NOW)).grace).toBeNull();

    revenue.findLapsedSubscription.mockClear();
    revenue.findRunningSubscription.mockResolvedValue(subscription());
    expect((await mySubscription('pub_1', NOW)).grace).toBeNull();
    expect(revenue.findLapsedSubscription).not.toHaveBeenCalled();

    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 0 }));
    revenue.findRunningSubscription.mockResolvedValue(null);
    expect((await mySubscription('pub_1', NOW)).grace).toBeNull();
    expect(revenue.findLapsedSubscription).not.toHaveBeenCalled();
  });

  it('names the trials still open to a first-ever subscriber, per tier with the days, and none once they have held anything', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ trialDays: { STANDARD: 0, PLUS: 14, PRO: 7 } }));
    expect((await mySubscription('pub_1', NOW)).trialAvailable).toEqual({ PLUS: 14, PRO: 7 });
    repository.listSubscriptionsForPublisher.mockResolvedValue([subscription({ endsAt: new Date('2025-01-01T00:00:00.000Z') })]);
    expect((await mySubscription('pub_1', NOW)).trialAvailable).toEqual({});
  });

  it('running Plus with an end: the plan view, the queued renewal, the orders newest first, and per-tier rules', async () => {
    const running = subscription();
    const queued = subscription({ id: 'sub_2', startsAt: new Date('2026-09-30T06:00:00.000Z'), endsAt: new Date('2026-10-30T06:00:00.000Z') });
    revenue.findRunningSubscription.mockResolvedValue(running);
    repository.listSubscriptionsForPublisher.mockResolvedValue([queued, running]);
    repository.listOrdersForPublisher.mockResolvedValue([order({ id: 'ord_2', status: 'PAID' }), order()]);

    const me = await mySubscription('pub_1', NOW);
    expect(me.running).toMatchObject({ id: 'sub_1', tier: 'PLUS', planName: 'Plus', ratePct: '0.1250', pricePerMonth: '2499.00', source: 'SELF_SERVICE', autoRenew: false });
    expect(me.plan).toMatchObject({ tier: 'PLUS', name: 'Plus' });
    expect(me.upcoming.map((s) => s.id)).toEqual(['sub_2']);
    expect(me.orders.map((o) => o.id)).toEqual(['ord_2', 'ord_1']);
    expect(me.options.map((o) => [o.tier, o.rule, o.startsAt])).toEqual([
      ['STANDARD', 'REPLACES_CURRENT', NOW],
      ['PLUS', 'QUEUED_AFTER_CURRENT', running.endsAt],
      ['PRO', 'REPLACES_CURRENT', NOW],
    ]);
    expect(me.canBuy).toBe(true);
  });

  it('under QUEUE_AFTER_TERM every other tier queues at the running term\'s end', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ changePolicy: 'QUEUE_AFTER_TERM' }));
    const running = subscription();
    revenue.findRunningSubscription.mockResolvedValue(running);
    const me = await mySubscription('pub_1', NOW);
    expect(me.options.map((o) => [o.tier, o.rule, o.startsAt])).toEqual([
      ['STANDARD', 'QUEUED_AFTER_CURRENT', running.endsAt],
      ['PLUS', 'QUEUED_AFTER_CURRENT', running.endsAt],
      ['PRO', 'QUEUED_AFTER_CURRENT', running.endsAt],
    ]);
  });

  it('an open-ended grant blocks its own tier only, and says so', async () => {
    revenue.findRunningSubscription.mockResolvedValue(subscription({ endsAt: null, source: 'ADMIN_GRANT' }));
    const me = await mySubscription('pub_1', NOW);
    expect(me.options.find((o) => o.tier === 'PLUS')).toMatchObject({ allowed: false, reason: 'ALREADY_ON_PLAN' });
    expect(me.options.find((o) => o.tier === 'PRO')).toMatchObject({ allowed: true, rule: 'REPLACES_CURRENT' });
    expect(me.canBuy).toBe(true);
  });
});

/* ── Lot J2 (d): the console's list ──────────────────────────────── */

describe('GET /revenue/subscriptions (the list contract)', () => {
  it('answers a page with the publisher, the plan name, the state and a count per state', async () => {
    const withPublisher = (over: Record<string, unknown>) => ({ ...subscription(over), publisher: { id: 'pub_1', name: 'Asha Hoardings', displayId: 'PUB-1409-2601' } });
    repository.listSubscriptionsPage.mockResolvedValue({
      items: [
        withPublisher({ id: 'sub_up', startsAt: new Date('2026-09-30T06:00:00.000Z'), endsAt: new Date('2026-10-30T06:00:00.000Z') }),
        withPublisher({ id: 'sub_run' }),
        withPublisher({ id: 'sub_old', tier: 'STANDARD', endsAt: new Date('2026-09-01T00:00:00.000Z') }),
      ],
      total: 3,
      counts: { RUNNING: 1, UPCOMING: 1, ENDED: 1 },
    });
    const page = await listSubscriptionsPage({ state: undefined, q: 'asha', publisherId: undefined, page: 1, pageSize: 20 }, NOW);
    expect(repository.listSubscriptionsPage).toHaveBeenCalledWith(expect.objectContaining({ q: 'asha', page: 1, pageSize: 20 }), NOW);
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 20, counts: { RUNNING: 1, UPCOMING: 1, ENDED: 1 } });
    expect(page.items.map((row) => [row.id, row.state, row.planName, row.publisher.displayId])).toEqual([
      ['sub_up', 'UPCOMING', 'Plus', 'PUB-1409-2601'],
      ['sub_run', 'RUNNING', 'Plus', 'PUB-1409-2601'],
      ['sub_old', 'ENDED', 'Standard', 'PUB-1409-2601'],
    ]);
    // Lot K (B2): every row says when it was written; with graceDays 0 nothing is in grace and graceEndsAt is the end itself.
    expect(page.items.map((row) => [row.id, row.inGrace, row.graceEndsAt, row.createdAt])).toEqual([
      ['sub_up', false, new Date('2026-10-30T06:00:00.000Z'), NOW],
      ['sub_run', false, new Date('2026-09-30T06:00:00.000Z'), NOW],
      ['sub_old', false, new Date('2026-09-01T00:00:00.000Z'), NOW],
    ]);
  });

  /* Lot K (B2) */
  it('rows carry inGrace and graceEndsAt from the policy: an ENDED row inside graceDays is in grace, one past it is not, an open-ended grant has no grace end', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 5 }));
    const withPublisher = (over: Record<string, unknown>) => ({ ...subscription(over), publisher: { id: 'pub_1', name: 'Asha Hoardings', displayId: 'PUB-1409-2601' } });
    repository.listSubscriptionsPage.mockResolvedValue({
      items: [
        withPublisher({ id: 'sub_recent', endsAt: new Date('2026-09-12T06:00:00.000Z'), createdAt: new Date('2026-08-12T06:00:00.000Z') }),
        withPublisher({ id: 'sub_old', endsAt: new Date('2026-09-01T00:00:00.000Z') }),
        withPublisher({ id: 'sub_run' }),
        withPublisher({ id: 'sub_grant', endsAt: null, source: 'ADMIN_GRANT' }),
      ],
      total: 4,
      counts: { RUNNING: 2, UPCOMING: 0, ENDED: 2 },
    });
    const page = await listSubscriptionsPage({ state: undefined, q: undefined, publisherId: undefined, page: 1, pageSize: 20 }, NOW);
    expect(page.items.map((row) => [row.id, row.state, row.inGrace, row.graceEndsAt, row.createdAt])).toEqual([
      ['sub_recent', 'ENDED', true, new Date('2026-09-17T06:00:00.000Z'), new Date('2026-08-12T06:00:00.000Z')],
      ['sub_old', 'ENDED', false, new Date('2026-09-06T00:00:00.000Z'), NOW],
      ['sub_run', 'RUNNING', false, new Date('2026-10-05T06:00:00.000Z'), NOW],
      ['sub_grant', 'RUNNING', false, null, NOW],
    ]);
  });
});

/* ── the sweep ───────────────────────────────────────────────────── */

describe('the daily sweep', () => {
  const ending = (over: Record<string, unknown> = {}) => ({ ...subscription(over), publisher: { id: 'pub_1', name: 'Asha', userId: 'usr_pub' }, order: { id: 'ord_prev', cycle: 'MONTHLY' as const } });
  const allowRenewals = () => settings.getSubscriptionPolicy.mockResolvedValue(policy({ autoRenew: { allowed: true, chargeFromWallet: true } }));

  it('sends the expiring notice once per subscription inside the reminderLeadDays window, with the plain renew line', async () => {
    const soon = ending({ endsAt: new Date('2026-09-20T06:00:00.000Z') });
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [soon] : []));
    const first = await runPublisherSubscriptionSweep(NOW);
    expect(repository.findEndingBetween).toHaveBeenNthCalledWith(1, NOW, new Date('2026-09-21T06:00:00.000Z'));
    expect(first.expiringNotified).toBe(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_EXPIRING',
      'usr_pub',
      { planName: 'Plus', endsAt: '20 Sept 2026', days: '6', renewal: expect.stringContaining('Renew in the ADX app') },
      expect.objectContaining({ inApp: expect.objectContaining({ title: EXPIRING_TITLE, relatedId: 'sub_1', message: expect.stringContaining('ends on 20 Sept 2026') }) }),
      NOW,
    );

    // The marker: the in-app row already written for this subscription under this title.
    repository.noticeSent.mockImplementation(async (_u: string, relatedId: string, title: string) => relatedId === 'sub_1' && title === EXPIRING_TITLE);
    notifications.notify.mockClear();
    const second = await runPublisherSubscriptionSweep(NOW);
    expect(second.expiringNotified).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('reads the lead from the policy — three days is three days', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ reminderLeadDays: 3, unpaidOrderExpiryDays: 2 }));
    await runPublisherSubscriptionSweep(NOW);
    expect(repository.findEndingBetween).toHaveBeenNthCalledWith(1, NOW, new Date('2026-09-17T06:00:00.000Z'));
    expect(repository.findEndingBetween).toHaveBeenNthCalledWith(2, new Date('2026-09-11T06:00:00.000Z'), NOW);
    expect(repository.expireStaleOrders).toHaveBeenCalledWith(new Date('2026-09-12T06:00:00.000Z'));
  });

  it('with auto-renew on (theirs and the policy\'s) the reminder says what the wallet will be charged and when', async () => {
    allowRenewals();
    const soon = ending({ endsAt: new Date('2026-09-20T06:00:00.000Z'), autoRenew: true });
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [soon] : []));
    await runPublisherSubscriptionSweep(NOW);
    expect(notifications.notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_EXPIRING',
      'usr_pub',
      expect.objectContaining({ renewal: 'It renews from your wallet on 20 Sept 2026 for ₹2948.82.' }),
      expect.objectContaining({ inApp: expect.objectContaining({ message: 'Your Plus plan renews from your wallet on 20 Sept 2026 for ₹2948.82.' }) }),
      NOW,
    );
  });

  it('sends the ended notice the day a subscription lapses, unless another term of theirs is in force at that moment', async () => {
    const lapsed = ending({ id: 'sub_old', endsAt: new Date('2026-09-13T20:00:00.000Z') });
    const replaced = ending({ id: 'sub_rep', endsAt: new Date('2026-09-13T20:00:00.000Z'), publisherId: 'pub_2' });
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [] : [lapsed, replaced]));
    repository.hasSuccessor.mockImplementation(async (publisherId: string) => publisherId === 'pub_2');

    const summary = await runPublisherSubscriptionSweep(NOW);
    expect(repository.findEndingBetween).toHaveBeenNthCalledWith(2, new Date('2026-09-07T06:00:00.000Z'), NOW);
    expect(summary.endedNotified).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_ENDED',
      'usr_pub',
      { planName: 'Plus', endedAt: '14 Sept 2026' },
      expect.objectContaining({ inApp: expect.objectContaining({ title: ENDED_TITLE, relatedId: 'sub_old' }) }),
      NOW,
    );
    expect(repository.hasSuccessor).toHaveBeenCalledWith('pub_1', lapsed.endsAt, 'sub_old');
  });

  it('expires PENDING_PAYMENT orders older than unpaidOrderExpiryDays', async () => {
    repository.expireStaleOrders.mockResolvedValueOnce(3);
    const summary = await runPublisherSubscriptionSweep(NOW);
    expect(repository.expireStaleOrders).toHaveBeenCalledWith(new Date('2026-09-07T06:00:00.000Z'));
    expect(summary.ordersExpired).toBe(3);
  });

  it('skips a publisher with no login — there is nobody to tell', async () => {
    repository.findEndingBetween.mockResolvedValue([{ ...ending({ endsAt: new Date('2026-09-18T06:00:00.000Z') }), publisher: { id: 'pub_1', name: 'Asha', userId: null } }]);
    const summary = await runPublisherSubscriptionSweep(NOW);
    expect(summary.expiringNotified).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  /* Lot J2 (6): the renewal. */
  describe('auto-renew', () => {
    const ENDED_AT = new Date('2026-09-13T20:00:00.000Z');
    const lapsed = () => ending({ id: 'sub_old', endsAt: ENDED_AT, autoRenew: true });

    beforeEach(() => {
      allowRenewals();
      repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [] : [lapsed()]));
    });

    it('on the day endsAt passes: the next order on the same tier and cycle, starting when the old one ended, paid from the wallet through the same debit and activation, the flag carried forward, SUBSCRIPTION_RENEWED sent, and no ended notice', async () => {
      const summary = await runPublisherSubscriptionSweep(NOW);
      expect(summary).toMatchObject({ renewed: 1, renewalsFailed: 0, endedNotified: 0 });

      expect(repository.findOrderStartingAt).toHaveBeenCalledWith('pub_1', 'PLUS', ENDED_AT);
      const data = repository.createOrder.mock.calls[0]![0] as Record<string, unknown>;
      expect(data).toMatchObject({ publisherId: 'pub_1', tier: 'PLUS', cycle: 'MONTHLY', months: 1, startsAt: ENDED_AT, createdByUserId: 'usr_pub' });
      expect(String(data['total'])).toBe('2948.82');
      expect(wallets.move).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 'wal_pub', amount: '-2948.82', entryType: 'PACKAGE_DEBIT', idempotencyKey: 'subscription-debit:ord_new', requireFunds: true }),
      );
      expect(repository.activateOrder).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'ord_new', method: 'WALLET', startsAt: ENDED_AT, endsAt: new Date('2026-10-13T20:00:00.000Z'), endRunningId: null, autoRenew: true }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        'SUBSCRIPTION_RENEWED',
        'usr_pub',
        { planName: 'Plus', startsAt: '14 Sept 2026', endsAt: '14 Oct 2026', total: '2948.82', reference: expect.stringMatching(/^SUB-2026-/) },
        expect.objectContaining({ inApp: expect.objectContaining({ title: RENEWED_TITLE }) }),
        NOW,
      );
      expect(notifications.notify).not.toHaveBeenCalledWith('SUBSCRIPTION_ENDED', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    });

    it('never charges twice: a second run finds the paid order queued at that end and does nothing', async () => {
      await runPublisherSubscriptionSweep(NOW);
      repository.findOrderStartingAt.mockResolvedValue(order({ id: 'ord_new', status: 'PAID', startsAt: ENDED_AT }));
      repository.hasSuccessor.mockResolvedValue(true);
      wallets.move.mockClear();
      repository.createOrder.mockClear();
      notifications.notify.mockClear();
      const again = await runPublisherSubscriptionSweep(NOW);
      expect(again.renewed).toBe(0);
      expect(repository.createOrder).not.toHaveBeenCalled();
      expect(wallets.move).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('with the wallet short: SUBSCRIPTION_RENEWAL_FAILED once with the shortfall, no debit, the flag stays on, and the row lapses like any other', async () => {
      wallets.snapshot.mockResolvedValue({ walletId: 'wal_pub', balance: '1000.00', withdrawable: '1000.00', spendable: '1000.00' });
      const summary = await runPublisherSubscriptionSweep(NOW);
      expect(summary).toMatchObject({ renewed: 0, renewalsFailed: 1, endedNotified: 1 });
      expect(wallets.move).not.toHaveBeenCalled();
      expect(repository.activateOrder).not.toHaveBeenCalled();
      expect(repository.setSubscriptionAutoRenew).not.toHaveBeenCalled();
      expect(notifications.notify).toHaveBeenCalledWith(
        'SUBSCRIPTION_RENEWAL_FAILED',
        'usr_pub',
        expect.objectContaining({ planName: 'Plus', total: '2948.82', shortfall: '1948.82', endedAt: '14 Sept 2026' }),
        expect.objectContaining({ inApp: expect.objectContaining({ title: RENEWAL_FAILED_TITLE, relatedId: 'sub_old' }) }),
        NOW,
      );
      // Told once: the marker is the in-app row.
      repository.noticeSent.mockImplementation(async (_u: string, _id: string, title: string) => title === RENEWAL_FAILED_TITLE || title === ENDED_TITLE);
      notifications.notify.mockClear();
      await runPublisherSubscriptionSweep(NOW);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    /* Lot K (B2) */
    it('skips a TRIAL row: no order minted, no wallet read, no renewal — it lapses with the ended notice; and its reminder says a trial does not renew', async () => {
      const trialEnding = { ...ending({ id: 'sub_trial', endsAt: ENDED_AT, autoRenew: true }), order: { id: 'ord_trial', cycle: 'MONTHLY' as const, paidMethod: 'TRIAL' } };
      const trialSoon = { ...ending({ id: 'sub_trial_soon', endsAt: new Date('2026-09-20T06:00:00.000Z'), autoRenew: true }), order: { id: 'ord_trial2', cycle: 'MONTHLY' as const, paidMethod: 'TRIAL' } };
      repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [trialSoon] : [trialEnding]));
      const summary = await runPublisherSubscriptionSweep(NOW);
      expect(summary).toMatchObject({ renewed: 0, renewalsFailed: 0, endedNotified: 1, expiringNotified: 1 });
      expect(repository.findOrderStartingAt).not.toHaveBeenCalled();
      expect(repository.createOrder).not.toHaveBeenCalled();
      expect(wallets.snapshot).not.toHaveBeenCalled();
      expect(wallets.move).not.toHaveBeenCalled();
      expect(repository.activateOrder).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalledWith('SUBSCRIPTION_RENEWED', expect.anything(), expect.anything(), expect.anything(), expect.anything());
      expect(notifications.notify).not.toHaveBeenCalledWith('SUBSCRIPTION_RENEWAL_FAILED', expect.anything(), expect.anything(), expect.anything(), expect.anything());
      expect(notifications.notify).toHaveBeenCalledWith('SUBSCRIPTION_ENDED', 'usr_pub', expect.anything(), expect.objectContaining({ inApp: expect.objectContaining({ relatedId: 'sub_trial' }) }), NOW);
      expect(notifications.notify).toHaveBeenCalledWith(
        'SUBSCRIPTION_EXPIRING',
        'usr_pub',
        expect.objectContaining({ renewal: expect.stringContaining('a trial does not renew') }),
        expect.objectContaining({ inApp: expect.objectContaining({ relatedId: 'sub_trial_soon', message: expect.stringContaining('free trial of Plus ends on 20 Sept 2026') }) }),
        NOW,
      );
    });

    /* Lot K (B2) */
    it('retries a renewal whose debit posted on a run that then failed to activate: the keyed debit is found before the balance, the empty wallet is not asked, and the term activates — no RENEWAL_FAILED', async () => {
      // The previous run minted the order and debited the wallet, then died before activation: the order is still PENDING_PAYMENT.
      repository.findOrderStartingAt.mockResolvedValue(order({ id: 'ord_queued', status: 'PENDING_PAYMENT', startsAt: ENDED_AT }));
      repository.debitPosted.mockResolvedValue(true);
      wallets.snapshot.mockResolvedValue({ walletId: 'wal_pub', balance: '0.00', withdrawable: '0.00', spendable: '0.00' });

      const summary = await runPublisherSubscriptionSweep(NOW);
      expect(summary).toMatchObject({ renewed: 1, renewalsFailed: 0 });
      expect(repository.debitPosted).toHaveBeenCalledWith('subscription-debit:ord_queued');
      expect(wallets.snapshot).not.toHaveBeenCalled();
      expect(wallets.move).not.toHaveBeenCalled();
      expect(repository.createOrder).not.toHaveBeenCalled();
      expect(repository.activateOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ord_queued', method: 'WALLET', startsAt: ENDED_AT, autoRenew: true }));
      expect(notifications.notify).toHaveBeenCalledWith('SUBSCRIPTION_RENEWED', 'usr_pub', expect.anything(), expect.anything(), NOW);
      expect(notifications.notify).not.toHaveBeenCalledWith('SUBSCRIPTION_RENEWAL_FAILED', expect.anything(), expect.anything(), expect.anything(), expect.anything());

      // Without the debit on the books, the same empty wallet fails the renewal as before.
      repository.debitPosted.mockResolvedValue(false);
      notifications.notify.mockClear();
      repository.activateOrder.mockClear();
      const again = await runPublisherSubscriptionSweep(NOW);
      expect(again).toMatchObject({ renewed: 0, renewalsFailed: 1 });
      expect(wallets.snapshot).toHaveBeenCalled();
      expect(repository.activateOrder).not.toHaveBeenCalled();
      expect(notifications.notify).toHaveBeenCalledWith('SUBSCRIPTION_RENEWAL_FAILED', 'usr_pub', expect.objectContaining({ shortfall: '2948.82' }), expect.anything(), NOW);
    });

    it('with the policy\'s switch off: nobody is charged, whatever their flag says, and the reminder is the plain line', async () => {
      settings.getSubscriptionPolicy.mockResolvedValue(policy());
      const soon = ending({ id: 'sub_soon', endsAt: new Date('2026-09-20T06:00:00.000Z'), autoRenew: true });
      repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [soon] : [lapsed()]));
      const summary = await runPublisherSubscriptionSweep(NOW);
      expect(summary).toMatchObject({ renewed: 0, renewalsFailed: 0, expiringNotified: 1, endedNotified: 1 });
      expect(wallets.move).not.toHaveBeenCalled();
      expect(repository.createOrder).not.toHaveBeenCalled();
      expect(notifications.notify).toHaveBeenCalledWith(
        'SUBSCRIPTION_EXPIRING',
        'usr_pub',
        expect.objectContaining({ renewal: expect.stringContaining('Renew in the ADX app') }),
        expect.anything(),
        NOW,
      );
    });
  });
});
