import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Selling a package.
 *
 * Three things carry the weight here. The total has to match what the frame
 * prints, because it is the number an advertiser is asked to pay. The sale has
 * to survive existing before the money does — the agent sends a link and waits,
 * so a record that is not yet paid for is the normal state rather than an edge
 * case. And activation has to be idempotent, because a link can be opened twice
 * and an admin can press a button twice.
 */

const { repository, createNotification, notify, recordIncentive, assertVisitOutcome, settings, revenue, wallets, advertisers } = vi.hoisted(() => ({
  assertVisitOutcome: vi.fn(),
  // Lot J2: the advertiser policy, revenue's tax row, the wallet the proration credit lands in, the advertiser's wallet door.
  settings: { getSubscriptionPolicy: vi.fn() },
  revenue: { taxSettings: vi.fn() },
  wallets: { ensureWallet: vi.fn(), move: vi.fn() },
  advertisers: { bookingEligibility: vi.fn(), payForPackage: vi.fn() },
  repository: {
    listPackages: vi.fn(),
    findPackage: vi.fn(),
    findPackageByTier: vi.fn(),
    upsertPackage: vi.fn(),
    listAddOns: vi.fn(),
    findAddOnsByCode: vi.fn(),
    upsertAddOn: vi.fn(),
    createSale: vi.fn(),
    findSale: vi.fn(),
    findSaleByToken: vi.fn(),
    findSaleByReference: vi.fn(),
    referenceExists: vi.fn(),
    tokenExists: vi.fn(),
    updateSale: vi.fn(),
    listSales: vi.fn(),
    advertiserContext: vi.fn(),
    findActiveSale: vi.fn(),
    findActiveSales: vi.fn(),
    findPackagesByIds: vi.fn(),
    findExpiredSales: vi.fn(),
    commissionAmounts: vi.fn(),
    agentTier: vi.fn(),
    findLapsedSale: vi.fn(),
    findLapsedSales: vi.fn(),
    hasEverHeldSale: vi.fn(),
    findEndingBetween: vi.fn(),
    hasSuccessorSale: vi.fn(),
    findSaleStartingAt: vi.fn(),
    noticeSent: vi.fn(),
    startTrial: vi.fn(),
  },
  createNotification: vi.fn(),
  notify: vi.fn(),
  recordIncentive: vi.fn(),
}));

vi.mock('../prisma-packages.repository', () => ({ prismaPackagesRepository: repository }));
vi.mock('../../notifications', () => ({ createNotification, notify }));
vi.mock('../../payouts', () => ({ recordIncentive }));
vi.mock('../../visits', () => ({ assertVisitOutcome }));
vi.mock('../../app-config', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app-config')>()), ...settings }));
vi.mock('../../revenue', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../revenue')>()), ...revenue }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../advertisers', () => advertisers);

import { DEFAULT_PLATFORM_SETTINGS, type SubscriptionPolicy } from '../../app-config';
import {
  ANNUAL_DISCOUNT_PCT,
  EXPIRING_TITLE,
  RENEWAL_FAILED_TITLE,
  RENEWED_TITLE,
  TRIAL_TITLE,
  activePackageWithOptions,
  assertPayable,
  assertWalletPaymentOffered,
  cancelSale,
  entitledPackageForAdvertiser,
  entitledPackagesForAdvertisers,
  markPaid,
  MAX_PAYMENT_LINK_SENDS,
  priceSale,
  quote,
  resolveSaleTerm,
  runPackageExpiry,
  runPackageRenewals,
  sellPackage,
  sendPaymentLink,
  setActivePackageAutoRenew,
  startPackageTrial,
} from '../packages.service';

const RATES = { gstPct: '18', annualDiscountPct: 20 };
const DEFAULT_POLICY = DEFAULT_PLATFORM_SETTINGS.subscriptions.advertiser;
const policy = (over: Partial<SubscriptionPolicy> = {}): SubscriptionPolicy => ({ ...DEFAULT_POLICY, ...over });

const GROWTH = {
  id: 'pkg_growth',
  tier: 'GROWTH' as const,
  name: 'Growth',
  pricePerMonth: new Decimal('24999'),
  description: null,
  isPopular: true,
  entitlements: {},
  isActive: true,
  sortOrder: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const REFRESH = {
  id: 'add_1',
  code: 'EXTRA_CREATIVE_REFRESH',
  name: 'Extra creative refresh',
  pricePerMonth: new Decimal('3000'),
  description: null,
  isActive: true,
  sortOrder: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const sale = (over: Record<string, unknown> = {}) => ({
  id: 'sale_1',
  reference: 'PKG-2026-482913',
  advertiserId: 'adv_1',
  agentId: 'agt_1',
  createdByUserId: 'usr_1',
  packageId: 'pkg_growth',
  tier: 'GROWTH' as const,
  packageName: 'Growth',
  pricePerMonth: new Decimal('24999'),
  cycle: 'MONTHLY' as const,
  months: 1,
  addOnsPerMonth: new Decimal('3000'),
  subtotal: new Decimal('27999'),
  discountPct: new Decimal('0'),
  discountAmount: new Decimal('0'),
  gstPct: new Decimal('18'),
  gstAmount: new Decimal('5039.82'),
  total: new Decimal('33038.82'),
  status: 'PENDING_PAYMENT',
  paymentToken: 'tok_abc',
  paymentLinkSentAt: null,
  paymentLinkSends: 0,
  paidAt: null,
  paidMethod: null,
  paidReference: null,
  startsAt: null,
  endsAt: null,
  nextBillingAt: null,
  autoRenew: false,
  lines: [],
  advertiser: {
    id: 'adv_1',
    name: 'Anita Kumar',
    companyName: "Anita's Coffee",
    email: 'anita@example.com',
    mobile: '9876543210',
    userId: 'usr_adv',
  },
  package: { id: 'pkg_growth', name: 'Growth', tier: 'GROWTH' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.listPackages.mockResolvedValue([GROWTH]);
  repository.listAddOns.mockResolvedValue([REFRESH]);
  repository.findPackageByTier.mockResolvedValue(GROWTH);
  repository.findPackage.mockResolvedValue(GROWTH);
  repository.findAddOnsByCode.mockImplementation(async (codes: string[]) =>
    codes.includes(REFRESH.code) ? [REFRESH] : []
  );
  repository.listSales.mockResolvedValue([]);
  repository.referenceExists.mockResolvedValue(false);
  repository.tokenExists.mockResolvedValue(false);
  repository.createSale.mockImplementation(async () => sale());
  repository.findSale.mockImplementation(async () => sale());
  repository.updateSale.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
    sale(patch)
  );
  notify.mockResolvedValue({ notificationId: null, templateKey: 'package-link', deliveries: [] });
  createNotification.mockResolvedValue(undefined);
  settings.getSubscriptionPolicy.mockResolvedValue(policy());
  revenue.taxSettings.mockResolvedValue({ mediaGstPct: '0.18' });
  repository.findActiveSale.mockResolvedValue(null);
  repository.findActiveSales.mockResolvedValue([]);
  repository.findPackagesByIds.mockResolvedValue([GROWTH]);
  repository.findLapsedSale.mockResolvedValue(null);
  repository.findLapsedSales.mockResolvedValue([]);
  repository.hasEverHeldSale.mockResolvedValue(false);
  repository.findEndingBetween.mockResolvedValue([]);
  repository.hasSuccessorSale.mockResolvedValue(false);
  repository.findSaleStartingAt.mockResolvedValue(null);
  repository.noticeSent.mockResolvedValue(false);
  repository.startTrial.mockImplementation(async (input: { sale: Record<string, unknown>; now: Date; startsAt: Date; endsAt: Date }) => ({
    started: true,
    sale: sale({ ...input.sale, id: 'sale_trial', status: 'ACTIVE', paidAt: input.now, paidMethod: 'TRIAL', paidReference: null, startsAt: input.startsAt, endsAt: input.endsAt, nextBillingAt: input.endsAt, incentiveId: null }),
  }));
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_adv' });
  wallets.move.mockResolvedValue({ created: true, entry: { id: 'we_1' } });
  advertisers.bookingEligibility.mockResolvedValue({ eligible: true, blockedBy: [], wallet: { spendable: '100000.00' } });
  advertisers.payForPackage.mockResolvedValue({ paid: true });
});

describe('pricing', () => {
  /** The exact figures on the frame: Growth + one add-on, billed monthly. */
  it('matches what the review screen prints', () => {
    const priced = priceSale({
      plan: { tier: 'GROWTH', name: 'Growth', pricePerMonth: '24999.00' },
      addOns: [{ code: 'EXTRA_CREATIVE_REFRESH', name: 'Extra creative refresh', pricePerMonth: '3000.00' }],
      cycle: 'MONTHLY',
      rates: RATES,
    });

    expect(priced.perMonth).toBe('27999.00');
    expect(priced.subtotal).toBe('27999.00');
    expect(priced.gstAmount).toBe('5039.82');
    // The receipt rounds this to ₹33,039 for display; the ledger keeps the paise.
    expect(priced.total).toBe('33038.82');
  });

  it('takes a fifth off twelve months at once', () => {
    const priced = priceSale({
      plan: { tier: 'GROWTH', name: 'Growth', pricePerMonth: '24999.00' },
      addOns: [],
      cycle: 'ANNUAL',
      rates: RATES,
    });

    expect(priced.months).toBe(12);
    expect(priced.subtotal).toBe('299988.00');
    expect(priced.discountPct).toBe(String(ANNUAL_DISCOUNT_PCT) + '.00');
    expect(priced.discountAmount).toBe('59997.60');
    // GST is charged on the discounted figure, not the list price.
    expect(priced.gstAmount).toBe('43198.27');
    expect(priced.total).toBe('283188.67');
  });

  it('lists the plan and every add-on as its own line', () => {
    const priced = priceSale({
      plan: { tier: 'GROWTH', name: 'Growth', pricePerMonth: '24999.00' },
      addOns: [
        { code: 'A', name: 'Premium analytics', pricePerMonth: '2500.00' },
        { code: 'B', name: 'Dedicated support manager', pricePerMonth: '5000.00' },
      ],
      cycle: 'ANNUAL',
      rates: RATES,
    });

    expect(priced.lines).toHaveLength(3);
    expect(priced.lines[0]).toMatchObject({ kind: 'PLAN', label: 'Growth plan', amount: '299988.00' });
    expect(priced.lines[1]).toMatchObject({ kind: 'ADDON', months: 12, amount: '30000.00' });
  });

  /* Lot J2 (2): GST is revenue's tax row, the discount the policy's number; the quote carries the policy. */
  it("reads GST from revenue's tax row and the annual discount from the advertiser policy — change either and the quote follows", async () => {
    const before = await quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'ANNUAL' });
    expect(before.priced).toMatchObject({ gstPct: '18.00', discountPct: '20.00', total: '283188.67' });
    expect(before.policy).toMatchObject({ cyclesOffered: ['MONTHLY', 'ANNUAL'], annualDiscountPct: 20, changePolicy: 'REPLACE_NOW', trialDays: 0, autoRenewAllowed: false });

    revenue.taxSettings.mockResolvedValue({ mediaGstPct: '0.05' });
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ annualDiscountPct: 10 }));
    const after = await quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'ANNUAL' });
    // 299988 less 10% = 269989.20, plus 5% GST = 283488.66
    expect(after.priced).toMatchObject({ gstPct: '5.00', discountPct: '10.00', discountAmount: '29998.80', gstAmount: '13499.46', total: '283488.66' });
    expect(after.policy.annualDiscountPct).toBe(10);
  });

  /* Lot K (B2): the term rides beside the money, so no phone predicts the rule. */
  it('answers the term the activation would apply for the advertiser named — starts now with nothing running, queues behind the same tier, replaces a different one with the capped credit — and null when nobody is named', async () => {
    const NOW = new Date('2026-09-14T06:00:00Z');
    const nobody = await quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY' });
    expect(nobody.term).toBeNull();
    expect(repository.findActiveSale).not.toHaveBeenCalled();

    const fresh = await quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY', advertiserId: 'adv_1', now: NOW });
    expect(repository.findActiveSale).toHaveBeenCalledWith('adv_1', NOW);
    expect(fresh.term).toEqual({ rule: 'STARTS_NOW', startsAt: NOW, endsAt: new Date('2026-10-14T06:00:00Z'), replaces: null, prorationAmount: null });

    const running = sale({ id: 'sale_run', tier: 'STARTER', packageName: 'Starter', status: 'ACTIVE', paidMethod: 'WALLET', total: new Decimal('11798.82'), startsAt: new Date('2026-08-30T06:00:00Z'), endsAt: new Date('2026-09-30T06:00:00Z') });
    repository.findActiveSale.mockResolvedValue(running);
    const replaced = await quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY', advertiserId: 'adv_1', now: NOW });
    expect(replaced.term).toMatchObject({ rule: 'REPLACES_CURRENT', startsAt: NOW, replaces: { id: 'sale_run', tier: 'STARTER' }, prorationAmount: null });

    settings.getSubscriptionPolicy.mockResolvedValue(policy({ prorateOnChange: true }));
    const credited = await quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY', advertiserId: 'adv_1', now: NOW });
    expect(credited.term).toMatchObject({ rule: 'REPLACES_CURRENT', prorationAmount: '6089.71' });

    repository.findActiveSale.mockResolvedValue({ ...running, tier: 'GROWTH', packageName: 'Growth' });
    const queued = await quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY', advertiserId: 'adv_1', now: NOW });
    expect(queued.term).toMatchObject({ rule: 'QUEUED_AFTER_CURRENT', startsAt: new Date('2026-09-30T06:00:00Z'), replaces: null, prorationAmount: null });
  });

  it('refuses a cycle the policy does not offer, 400, naming the offered ones — before the catalogue is read', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ cyclesOffered: ['MONTHLY'] }));
    await expect(quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'ANNUAL' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CYCLE_NOT_OFFERED',
      message: 'The ANNUAL cycle is not offered. Choose MONTHLY.',
    });
    expect(repository.findPackageByTier).not.toHaveBeenCalled();
  });

  it('refuses an add-on that is not in the catalogue', async () => {
    await expect(
      quote({ tier: 'GROWTH', addOnCodes: ['NOT_A_THING'], cycle: 'MONTHLY' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses a plan that is not on sale', async () => {
    repository.findPackageByTier.mockResolvedValue({ ...GROWTH, isActive: false });
    await expect(quote({ tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('the sale', () => {
  const actor = { userId: 'usr_1', isAdmin: false, agentId: 'agt_1', advertiserId: null };

  it('snapshots the price rather than pointing at the catalogue', async () => {
    await sellPackage(
      { advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: ['EXTRA_CREATIVE_REFRESH'], cycle: 'MONTHLY' },
      actor
    );

    expect(repository.createSale).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: 'Growth',
        pricePerMonth: new Decimal('24999.00'),
        total: new Decimal('33038.82'),
        agentId: 'agt_1',
      })
    );
  });

  it('records the agent who sold it', async () => {
    await sellPackage({ advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY' }, actor);
    const created = repository.createSale.mock.calls[0]![0];
    expect(created.agentId).toBe('agt_1');
    expect(created.createdByUserId).toBe('usr_1');
    expect(created.visitId).toBeNull();
  });

  /* Lot B (Q1): the visit the sale was made on, gated by the visits module. */
  it('records the visit it was made on, once the visits module has allowed it', async () => {
    assertVisitOutcome.mockResolvedValue(undefined);
    await sellPackage({ advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY', visitId: 'vst_1' }, actor);
    expect(assertVisitOutcome).toHaveBeenCalledWith('vst_1', 'agt_1', expect.any(Date));
    expect(repository.createSale).toHaveBeenCalledWith(expect.objectContaining({ visitId: 'vst_1' }));
  });

  it('refuses the sale when the visit is not the agent’s, before anything is written', async () => {
    assertVisitOutcome.mockRejectedValue(Object.assign(new Error('not yours'), { statusCode: 403 }));
    await expect(
      sellPackage({ advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY', visitId: 'vst_9' }, actor)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.createSale).not.toHaveBeenCalled();
  });

  it('sends the link and leaves the sale awaiting payment', async () => {
    await sellPackage({ advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY' }, actor);

    // Lot E (Q147): one dispatcher call carries both channels to the
    // advertiser's own contact details, with the variables the template renders.
    expect(notify).toHaveBeenCalledWith(
      'PACKAGE_LINK',
      null,
      expect.objectContaining({ packageName: expect.stringContaining('Growth'), reference: 'PKG-2026-482913', url: expect.stringContaining('/p/tok_abc') }),
      expect.objectContaining({ recipient: { email: 'anita@example.com', mobile: '9876543210' }, immediate: true })
    );
    expect(repository.updateSale).toHaveBeenCalledWith(
      'sale_1',
      expect.objectContaining({ status: 'PENDING_PAYMENT', paymentLinkSends: 1 })
    );
  });

  /* A link that did not send is a resend away; losing the sale because an SMTP
     host blinked would be worse. */
  it('does not fail the sale when the dispatcher is down', async () => {
    notify.mockRejectedValue(new Error('database down'));
    await expect(
      sellPackage({ advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY' }, actor)
    ).resolves.toBeTruthy();
  });

  it('counts every resend', async () => {
    repository.findSale.mockResolvedValue(sale({ paymentLinkSends: 2 }));
    await sendPaymentLink('sale_1');
    expect(repository.updateSale).toHaveBeenCalledWith(
      'sale_1',
      expect.objectContaining({ paymentLinkSends: 3 })
    );
  });

  it('will not resend for a package already paid for', async () => {
    repository.findSale.mockResolvedValue(sale({ status: 'ACTIVE' }));
    await expect(sendPaymentLink('sale_1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('activation', () => {
  const NOW = new Date('2026-06-26T10:00:00Z');

  beforeEach(() => {
    repository.agentTier.mockResolvedValue('SILVER');
    recordIncentive.mockResolvedValue({ id: 'inc_pkg' });
  });

  it('starts the term at payment and dates the next bill', async () => {
    await markPaid('sale_1', { method: 'WALLET', reference: 'sale_1' }, NOW);

    const patch = repository.updateSale.mock.calls[0]![1];
    expect(patch.status).toBe('ACTIVE');
    expect(patch.startsAt).toEqual(NOW);
    // One month on, as the receipt's "Next billing 26 Jul 2026" says.
    expect(patch.endsAt?.toISOString().slice(0, 10)).toBe('2026-07-26');
    expect(patch.nextBillingAt).toEqual(patch.endsAt);
  });

  /* DR 06 decision 16: "₹2,500 comm." is a recorded PACKAGE_SOLD, at the
     selling agent's tier, kept on the sale. */
  it('records the commission for the agent who sold it, and keeps it on the sale', async () => {
    await markPaid('sale_1', { method: 'WALLET' }, NOW);
    expect(recordIncentive).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'PACKAGE_SOLD', tier: 'SILVER', agentId: 'agt_1' }),
      NOW
    );
    expect(repository.updateSale.mock.calls[0]![1].incentiveId).toBe('inc_pkg');
  });

  it('records no commission on a sale nobody sold, or when no rate is priced', async () => {
    repository.findSale.mockResolvedValue(sale({ agentId: null }));
    await markPaid('sale_1', { method: 'OFFLINE' }, NOW);
    expect(recordIncentive).not.toHaveBeenCalled();
    expect(repository.updateSale.mock.calls[0]![1].incentiveId).toBeNull();

    repository.findSale.mockResolvedValue(sale());
    recordIncentive.mockRejectedValue(new Error('No incentive rate'));
    await markPaid('sale_1', { method: 'OFFLINE' }, NOW);
    expect(repository.updateSale.mock.calls[1]![1].status).toBe('ACTIVE');
    expect(repository.updateSale.mock.calls[1]![1].incentiveId).toBeNull();
  });

  it('gives an annual plan a twelve-month term', async () => {
    repository.findSale.mockResolvedValue(sale({ cycle: 'ANNUAL', months: 12 }));
    await markPaid('sale_1', { method: 'OFFLINE', reference: 'NEFT-2211' }, NOW);
    expect(repository.updateSale.mock.calls[0]![1].endsAt?.toISOString().slice(0, 10)).toBe(
      '2027-06-26'
    );
  });

  /** A 31st landing in a short month rolls back rather than into the next one. */
  it('does not slide a month-end date into the following month', async () => {
    await markPaid('sale_1', { method: 'WALLET' }, new Date('2026-01-31T10:00:00Z'));
    const endsAt = repository.updateSale.mock.calls[0]![1].endsAt as Date;
    expect(endsAt.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  /* A link can be opened twice and an admin can press a button twice. Neither
     may extend a term or take money again. */
  it('is idempotent', async () => {
    repository.findSale.mockResolvedValue(sale({ status: 'ACTIVE' }));
    const result = await markPaid('sale_1', { method: 'WALLET' }, NOW);
    expect(repository.updateSale).not.toHaveBeenCalled();
    expect(result.status).toBe('ACTIVE');
  });

  it('refuses to activate a cancelled sale', async () => {
    repository.findSale.mockResolvedValue(sale({ status: 'CANCELLED' }));
    await expect(markPaid('sale_1', { method: 'WALLET' }, NOW)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('tells the seller their sale landed', async () => {
    await markPaid('sale_1', { method: 'WALLET' }, NOW);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_1', title: 'Package activated' })
    );
  });
});

/*
 * What an adversarial pass on the money path turned up.
 *
 * Every case here is a way one sale could have taken money twice, taken money
 * it should not have, or been brought back from a term it had already served.
 */
describe('one sale, one charge', () => {
  const actor = { userId: 'usr_1', isAdmin: false, agentId: 'agt_1', advertiserId: null };

  /* The agent's natural move on a timeout is to press Sell again. That must
     not leave the advertiser holding two payable links. */
  it('resends the open link rather than selling the same plan twice', async () => {
    const open = sale({ id: 'sale_open', reference: 'PKG-2026-000111' });
    repository.listSales.mockResolvedValue([open]);
    repository.findSale.mockResolvedValue(open);

    const result = await sellPackage(
      { advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: [], cycle: 'MONTHLY' },
      actor
    );

    expect(repository.createSale).not.toHaveBeenCalled();
    // The open sale is the one that gets resent, not a new one.
    expect(repository.updateSale).toHaveBeenCalledWith(
      'sale_open',
      expect.objectContaining({ status: 'PENDING_PAYMENT' })
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('PACKAGE_LINK', null, expect.objectContaining({ reference: 'PKG-2026-000111' }), expect.anything());
    expect(result).toBeTruthy();
  });

  /* A different plan is a deliberate second sale, and cancelling the first is
     the agent's call rather than a retry's. */
  it('refuses a different plan while one is still unpaid', async () => {
    repository.listSales.mockResolvedValue([sale({ id: 'sale_open' })]);

    await expect(
      sellPackage(
        { advertiserId: 'adv_1', tier: 'GROWTH', addOnCodes: ['EXTRA_CREATIVE_REFRESH'], cycle: 'MONTHLY' },
        actor
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.createSale).not.toHaveBeenCalled();
  });

  /* The counter on the row was telemetry. Every send is an SMS somebody pays
     for and a message somebody receives. */
  it('stops sending the link once it has gone out enough times', async () => {
    repository.findSale.mockResolvedValue(sale({ paymentLinkSends: MAX_PAYMENT_LINK_SENDS }));
    await expect(sendPaymentLink('sale_1')).rejects.toMatchObject({ statusCode: 429 });
    expect(notify).not.toHaveBeenCalled();
  });

  /* payHandler asks this before it touches the wallet. markPaid asks it again
     afterwards, and by then the money has already moved. */
  it('says plainly which sales can still take money', () => {
    expect(() => assertPayable({ status: 'PENDING_PAYMENT' })).not.toThrow();
    expect(() => assertPayable({ status: 'CANCELLED' })).toThrowError(/cancelled/i);
    expect(() => assertPayable({ status: 'EXPIRED' })).toThrowError(/new sale/i);
    expect(() => assertPayable({ status: 'DRAFT' })).toThrowError(/waiting for payment/i);
  });
});

describe('a term that has run out stays run out', () => {
  const NOW = new Date('2026-06-26T10:00:00Z');

  /* Reviving it in place would overwrite startsAt, endsAt and paidAt, so the
     term the advertiser actually served would be gone. */
  it('refuses to pay for an expired plan', async () => {
    repository.findSale.mockResolvedValue(sale({ status: 'EXPIRED' }));
    await expect(markPaid('sale_1', { method: 'WALLET' }, NOW)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(repository.updateSale).not.toHaveBeenCalled();
  });

  it('refuses to send the link for an expired plan', async () => {
    repository.findSale.mockResolvedValue(sale({ status: 'EXPIRED' }));
    await expect(sendPaymentLink('sale_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('cancelling and expiry', () => {
  it('cancels a sale nobody paid for', async () => {
    await cancelSale('sale_1', 'Client went quiet');
    expect(repository.updateSale).toHaveBeenCalledWith(
      'sale_1',
      expect.objectContaining({ status: 'CANCELLED', cancellationReason: 'Client went quiet' })
    );
  });

  /* Money has changed hands. Cancelling it away would be a refund by another
     name, decided by nobody. */
  it('refuses to cancel a live package', async () => {
    repository.findSale.mockResolvedValue(sale({ status: 'ACTIVE' }));
    await expect(cancelSale('sale_1', 'changed my mind')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('expires terms that have run out, and says renewal is a new sale', async () => {
    repository.findExpiredSales.mockResolvedValue([sale({ status: 'ACTIVE' })]);
    const result = await runPackageExpiry(new Date('2026-08-01T00:00:00Z'));

    expect(result.expired).toBe(1);
    expect(repository.updateSale).toHaveBeenCalledWith('sale_1', { status: 'EXPIRED' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('new sale') })
    );
  });
});

/* ── Lot J2 (3): the change policy on activation ─────────────────── */

describe('activation under the change policy (Lot J2)', () => {
  const NOW = new Date('2026-09-14T06:00:00Z');
  // Starter, paid ₹11,798.82 (9999 + GST) for 30 Aug → 30 Sep: a 31-day term.
  const running = (over: Record<string, unknown> = {}) =>
    sale({ id: 'sale_run', reference: 'PKG-2026-000001', tier: 'STARTER', packageName: 'Starter', pricePerMonth: new Decimal('9999'), total: new Decimal('11798.82'), paidMethod: 'WALLET', status: 'ACTIVE', startsAt: new Date('2026-08-30T06:00:00Z'), endsAt: new Date('2026-09-30T06:00:00Z'), nextBillingAt: new Date('2026-09-30T06:00:00Z'), ...over });

  beforeEach(() => {
    repository.agentTier.mockResolvedValue(null);
  });

  it('nothing running: starts now (unchanged)', async () => {
    expect(await resolveSaleTerm(sale(), NOW)).toMatchObject({ rule: 'STARTS_NOW', startsAt: NOW, replaces: null, credit: null });
  });

  it('the same tier running: the new term queues at its end — a renewal, never a second overlapping term', async () => {
    repository.findActiveSale.mockResolvedValue(running({ tier: 'GROWTH', packageName: 'Growth' }));
    const term = await resolveSaleTerm(sale(), NOW);
    expect(term).toMatchObject({ rule: 'QUEUED_AFTER_CURRENT', startsAt: new Date('2026-09-30T06:00:00Z'), replaces: null, credit: null });
    expect(term.endsAt.toISOString().slice(0, 10)).toBe('2026-10-30');
  });

  it('REPLACE_NOW (the default): a different tier starts now and the running one ends now, EXPIRED at once, no proration', async () => {
    repository.findActiveSale.mockResolvedValue(running());
    await markPaid('sale_1', { method: 'WALLET' }, NOW);
    const [, patch] = repository.updateSale.mock.calls[0]!;
    expect(patch).toMatchObject({ status: 'ACTIVE', startsAt: NOW });
    expect(repository.updateSale).toHaveBeenCalledWith('sale_run', { status: 'EXPIRED', endsAt: NOW, nextBillingAt: null });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('REPLACE_NOW with prorateOnChange: the running term\'s unused days come back as a wallet credit — what it paid × 16 of its 31 days: 11798.82 × 16 / 31 = 6089.71 — double entry, keyed on the sale', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ prorateOnChange: true }));
    repository.findActiveSale.mockResolvedValue(running());
    const term = await resolveSaleTerm(sale(), NOW);
    expect(term.credit).toEqual({ saleId: 'sale_run', packageName: 'Starter', amount: '6089.71', remainingDays: 16, termDays: 31, paidTotal: '11798.82' });

    await markPaid('sale_1', { method: 'WALLET' }, NOW);
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, "Anita's Coffee · advertiser");
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal_adv',
        amount: '6089.71',
        entryType: 'ADJUSTMENT',
        ledgerKind: 'ADJUSTMENT',
        idempotencyKey: 'package-proration:sale_1',
        counterLegs: [{ accountCode: 'platform:revenue', amount: '-6089.71', note: 'Unused days of Starter' }],
        reference: 'sale_run',
        note: 'Unused days of Starter',
      }),
    );
  });

  /* Lot K (B2): the cap. */
  it('the credit never exceeds what the sale paid: a 12-month annual term replaced after one day credits at most its total less one day\'s share', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ prorateOnChange: true }));
    // Starter annual: 9999 × 12 less 20% plus GST = 113268.67 for 13 Sep 2026 → 13 Sep 2027, 365 days; replaced one day in.
    repository.findActiveSale.mockResolvedValue(running({ cycle: 'ANNUAL', months: 12, total: new Decimal('113268.67'), startsAt: new Date('2026-09-13T06:00:00Z'), endsAt: new Date('2027-09-13T06:00:00Z') }));
    const term = await resolveSaleTerm(sale(), NOW);
    expect(term.credit).toEqual({ saleId: 'sale_run', packageName: 'Starter', amount: '112958.34', remainingDays: 364, termDays: 365, paidTotal: '113268.67' });
    const ceiling = new Decimal('113268.67').minus(new Decimal('113268.67').dividedBy(365));
    expect(new Decimal(term.credit!.amount).lessThanOrEqualTo(ceiling)).toBe(true);
    // Never the old month-based figure: 9999 × 364 / 30 would have been more than the whole year cost.
    expect(new Decimal(term.credit!.amount).lessThan(new Decimal('9999').times(364).dividedBy(30))).toBe(true);
  });

  it('a free term earns no credit: a running TRIAL replaced under prorateOnChange ends now with credit null and no wallet movement', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ prorateOnChange: true }));
    repository.findActiveSale.mockResolvedValue(running({ id: 'sale_trial', paidMethod: 'TRIAL', total: new Decimal('0'), months: 0, startsAt: new Date('2026-09-10T06:00:00Z'), endsAt: new Date('2026-09-24T06:00:00Z') }));
    const term = await resolveSaleTerm(sale(), NOW);
    expect(term).toMatchObject({ rule: 'REPLACES_CURRENT', replaces: { id: 'sale_trial' }, credit: null });
    await markPaid('sale_1', { method: 'WALLET' }, NOW);
    expect(repository.updateSale).toHaveBeenCalledWith('sale_trial', { status: 'EXPIRED', endsAt: NOW, nextBillingAt: null });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('QUEUE_AFTER_TERM: a different tier starts when the running one ends, nothing ends early, nothing is credited', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ changePolicy: 'QUEUE_AFTER_TERM', prorateOnChange: true }));
    repository.findActiveSale.mockResolvedValue(running());
    await markPaid('sale_1', { method: 'WALLET' }, NOW);
    const [, patch] = repository.updateSale.mock.calls[0]!;
    expect(patch).toMatchObject({ status: 'ACTIVE', startsAt: new Date('2026-09-30T06:00:00Z') });
    expect(patch.endsAt?.toISOString().slice(0, 10)).toBe('2026-10-30');
    expect(repository.updateSale).toHaveBeenCalledTimes(1);
    expect(wallets.move).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Package activated', message: expect.stringContaining('starts on 30 Sept 2026') }));
  });

  it('a term handed in (the renewal sweep) is applied as given, and carries the auto-renew flag', async () => {
    const term = { rule: 'QUEUED_AFTER_CURRENT' as const, startsAt: new Date('2026-09-13T20:00:00Z'), endsAt: new Date('2026-10-13T20:00:00Z'), replaces: null, credit: null };
    await markPaid('sale_1', { method: 'WALLET', term, autoRenew: true }, NOW);
    expect(repository.findActiveSale).not.toHaveBeenCalled();
    expect(repository.updateSale.mock.calls[0]![1]).toMatchObject({ startsAt: term.startsAt, endsAt: term.endsAt, autoRenew: true });
  });
});

/* ── Lot J2 (4): grace ───────────────────────────────────────────── */

describe('the entitled reads (grace)', () => {
  const NOW = new Date('2026-09-14T06:00:00Z');
  const active = () => sale({ status: 'ACTIVE', startsAt: new Date('2026-08-14T06:00:00Z'), endsAt: new Date('2026-09-30T06:00:00Z') });

  it('answer the running package, not in grace, with the day the grace would end', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 5 }));
    repository.findActiveSale.mockResolvedValue(active());
    expect(await entitledPackageForAdvertiser('adv_1', NOW)).toMatchObject({ saleId: 'sale_1', tier: 'GROWTH', inGrace: false, graceEndsAt: new Date('2026-10-05T06:00:00Z'), enforcedKeys: ['liveChat'] });
    expect(repository.findLapsedSale).not.toHaveBeenCalled();
  });

  it('answer a term that ended within graceDays as inGrace; nothing past the window, nothing with graceDays 0', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 5 }));
    repository.findLapsedSale.mockResolvedValue(sale({ status: 'EXPIRED', startsAt: new Date('2026-08-12T06:00:00Z'), endsAt: new Date('2026-09-12T06:00:00Z') }));
    expect(await entitledPackageForAdvertiser('adv_1', NOW)).toMatchObject({ saleId: 'sale_1', inGrace: true, graceEndsAt: new Date('2026-09-17T06:00:00Z') });
    expect(repository.findLapsedSale).toHaveBeenCalledWith('adv_1', new Date('2026-09-09T06:00:00Z'), NOW);

    repository.findLapsedSale.mockResolvedValue(null);
    expect(await entitledPackageForAdvertiser('adv_1', NOW)).toBeNull();

    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 0 }));
    repository.findLapsedSale.mockClear();
    expect(await entitledPackageForAdvertiser('adv_1', NOW)).toBeNull();
    expect(repository.findLapsedSale).not.toHaveBeenCalled();
  });

  it('the batch form: running sales first, then the lapsed ones only for whoever has nothing running, plans read once', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 3 }));
    repository.findActiveSales.mockResolvedValue([{ ...active(), id: 'sale_a', advertiserId: 'adv_a' }]);
    repository.findLapsedSales.mockResolvedValue([sale({ id: 'sale_b', advertiserId: 'adv_b', status: 'EXPIRED', startsAt: new Date('2026-08-13T06:00:00Z'), endsAt: new Date('2026-09-13T06:00:00Z') })]);
    const map = await entitledPackagesForAdvertisers(['adv_a', 'adv_b', 'adv_c'], NOW);
    expect(repository.findLapsedSales).toHaveBeenCalledWith(['adv_b', 'adv_c'], new Date('2026-09-11T06:00:00Z'), NOW);
    expect(repository.findPackagesByIds).toHaveBeenCalledTimes(1);
    expect(map.get('adv_a')).toMatchObject({ saleId: 'sale_a', inGrace: false });
    expect(map.get('adv_b')).toMatchObject({ saleId: 'sale_b', inGrace: true, graceEndsAt: new Date('2026-09-16T06:00:00Z') });
    expect(map.has('adv_c')).toBe(false);
  });
});

/* ── Lot J2 (5): trials ──────────────────────────────────────────── */

describe('a free trial', () => {
  const NOW = new Date('2026-09-14T06:00:00Z');
  const withTrial = () => settings.getSubscriptionPolicy.mockResolvedValue(policy({ trialDays: { STARTER: 0, GROWTH: 14, PRO: 0 } }));

  it('is refused 409 TRIAL_NOT_OFFERED when the tier\'s trialDays is 0', async () => {
    await expect(startPackageTrial({ advertiserId: 'adv_1', userId: 'usr_adv', tier: 'GROWTH', now: NOW })).rejects.toMatchObject({ statusCode: 409, code: 'TRIAL_NOT_OFFERED' });
    withTrial();
    await expect(startPackageTrial({ advertiserId: 'adv_1', userId: 'usr_adv', tier: 'PRO', now: NOW })).rejects.toMatchObject({ code: 'TRIAL_NOT_OFFERED' });
    expect(repository.createSale).not.toHaveBeenCalled();
  });

  it('is refused 409 TRIAL_ALREADY_USED once the advertiser has ever held a term — running or expired, sold or trialled', async () => {
    withTrial();
    repository.hasEverHeldSale.mockResolvedValue(true);
    await expect(startPackageTrial({ advertiserId: 'adv_1', userId: 'usr_adv', tier: 'GROWTH', now: NOW })).rejects.toMatchObject({ statusCode: 409, code: 'TRIAL_ALREADY_USED' });
    expect(repository.createSale).not.toHaveBeenCalled();
  });

  it('otherwise: through the repository\'s locked transaction — a sale ACTIVE with total 0, method TRIAL, endsAt = now + trialDays, no agent, no incentive, no invoice, no wallet', async () => {
    withTrial();
    const started = await startPackageTrial({ advertiserId: 'adv_1', userId: 'usr_adv', tier: 'GROWTH', now: NOW });

    expect(repository.startTrial).toHaveBeenCalledTimes(1);
    const input = repository.startTrial.mock.calls[0]![0];
    expect(input).toMatchObject({ advertiserId: 'adv_1', now: NOW, startsAt: NOW, endsAt: new Date('2026-09-28T06:00:00Z') });
    const created = input.sale;
    expect(created).toMatchObject({ advertiserId: 'adv_1', agentId: null, visitId: null, createdByUserId: 'usr_adv', tier: 'GROWTH', packageName: 'Growth', months: 0 });
    expect(String(created.total)).toBe('0');
    expect(created.lines[0]).toMatchObject({ kind: 'PLAN', label: 'Growth plan (free trial)' });
    // Nothing outside the lock writes: no plain sale, no second update.
    expect(repository.createSale).not.toHaveBeenCalled();
    expect(repository.updateSale).not.toHaveBeenCalled();
    expect(recordIncentive).not.toHaveBeenCalled();
    expect(advertisers.payForPackage).not.toHaveBeenCalled();
    expect(wallets.move).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(started).toMatchObject({ id: 'sale_trial', status: 'ACTIVE', paidMethod: 'TRIAL', startsAt: NOW, endsAt: new Date('2026-09-28T06:00:00Z') });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', title: TRIAL_TITLE, relatedId: 'sale_trial', message: expect.stringContaining('free trial of Growth runs until 28 Sept 2026') }));
  });

  /* Lot K (B2): two concurrent starts — the lock's re-check. */
  it('cannot race: two trial starts arriving together are one 201 and one 409 TRIAL_ALREADY_USED — the second is refused by the re-check under the lock, and told nothing', async () => {
    withTrial();
    let held = 0;
    let chain: Promise<unknown> = Promise.resolve();
    repository.startTrial.mockImplementation((input: { sale: Record<string, unknown>; now: Date; startsAt: Date; endsAt: Date }) => {
      const run = chain.then(async () => {
        if (held > 0) return { started: false, sale: null };
        held += 1;
        return { started: true, sale: sale({ ...input.sale, id: 'sale_trial', status: 'ACTIVE', paidMethod: 'TRIAL', startsAt: input.startsAt, endsAt: input.endsAt }) };
      });
      chain = run.catch(() => undefined);
      return run;
    });

    const outcomes = await Promise.allSettled([
      startPackageTrial({ advertiserId: 'adv_1', userId: 'usr_adv', tier: 'GROWTH', now: NOW }),
      startPackageTrial({ advertiserId: 'adv_1', userId: 'usr_adv', tier: 'GROWTH', now: NOW }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ statusCode: 409, code: 'TRIAL_ALREADY_USED' });
    expect(repository.startTrial).toHaveBeenCalledTimes(2);
    expect(held).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('GET /packages/active names the trials still open, per tier with the days — none once a term was ever held', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ trialDays: { STARTER: 7, GROWTH: 14, PRO: 0 } }));
    repository.listPackages.mockResolvedValue([{ ...GROWTH, tier: 'STARTER', id: 'pkg_starter' }, GROWTH, { ...GROWTH, tier: 'PRO', id: 'pkg_pro', isActive: false }]);
    const none = await activePackageWithOptions('adv_1', NOW);
    expect(none).toMatchObject({ saleId: null, trialAvailable: { STARTER: 7, GROWTH: 14 } });
    expect(none.policy).toMatchObject({ changePolicy: 'REPLACE_NOW', autoRenewAllowed: false });

    repository.hasEverHeldSale.mockResolvedValue(true);
    repository.findActiveSale.mockResolvedValue(sale({ status: 'ACTIVE', startsAt: NOW, endsAt: new Date('2026-10-14T06:00:00Z'), paidMethod: 'WALLET' }));
    const live = await activePackageWithOptions('adv_1', NOW);
    expect(live).toMatchObject({ saleId: 'sale_1', tier: 'GROWTH', autoRenew: false, paidMethod: 'WALLET', trialAvailable: {}, grace: null });
  });

  /* Lot K (B2) */
  it('GET /packages/active answers grace: { tier, packageName, endsAt, until } for a term ended inside graceDays with nothing running — null while one runs, past the window, or with graceDays 0', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 5 }));
    repository.findLapsedSale.mockResolvedValue(sale({ id: 'sale_old', status: 'EXPIRED', tier: 'STARTER', packageName: 'Starter', startsAt: new Date('2026-08-12T06:00:00Z'), endsAt: new Date('2026-09-12T06:00:00Z') }));
    const graced = await activePackageWithOptions('adv_1', NOW);
    expect(repository.findLapsedSale).toHaveBeenCalledWith('adv_1', new Date('2026-09-09T06:00:00Z'), NOW);
    expect(graced).toMatchObject({ saleId: null, grace: { tier: 'STARTER', packageName: 'Starter', endsAt: new Date('2026-09-12T06:00:00Z'), until: new Date('2026-09-17T06:00:00Z') } });

    repository.findLapsedSale.mockResolvedValue(null);
    expect((await activePackageWithOptions('adv_1', NOW)).grace).toBeNull();

    repository.findLapsedSale.mockClear();
    repository.findActiveSale.mockResolvedValue(sale({ status: 'ACTIVE', startsAt: NOW, endsAt: new Date('2026-10-14T06:00:00Z') }));
    expect((await activePackageWithOptions('adv_1', NOW)).grace).toBeNull();
    expect(repository.findLapsedSale).not.toHaveBeenCalled();

    settings.getSubscriptionPolicy.mockResolvedValue(policy({ graceDays: 0 }));
    repository.findActiveSale.mockResolvedValue(null);
    expect((await activePackageWithOptions('adv_1', NOW)).grace).toBeNull();
    expect(repository.findLapsedSale).not.toHaveBeenCalled();
  });
});

/* ── Lot J2 (6): the auto-renew switch ───────────────────────────── */

describe('the auto-renew switch', () => {
  const NOW = new Date('2026-09-14T06:00:00Z');

  it('is refused 409 "Auto-renew is not offered" while the policy does not allow it', async () => {
    repository.findActiveSale.mockResolvedValue(sale({ status: 'ACTIVE' }));
    await expect(setActivePackageAutoRenew('adv_1', true, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'AUTO_RENEW_NOT_OFFERED', message: 'Auto-renew is not offered' });
    expect(repository.updateSale).not.toHaveBeenCalled();
  });

  /* Lot K (B2) */
  it('is refused 409 AUTO_RENEW_NOT_OFFERED "A trial does not renew - buy the plan" on a running trial, even with the policy allowing renewals; switching a trial off is still allowed', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ autoRenew: { allowed: true, chargeFromWallet: true } }));
    repository.findActiveSale.mockResolvedValue(sale({ id: 'sale_trial', status: 'ACTIVE', paidMethod: 'TRIAL' }));
    await expect(setActivePackageAutoRenew('adv_1', true, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'AUTO_RENEW_NOT_OFFERED', message: 'A trial does not renew - buy the plan' });
    expect(repository.updateSale).not.toHaveBeenCalled();

    repository.findActiveSale.mockResolvedValue(sale({ id: 'sale_trial', status: 'ACTIVE', paidMethod: 'TRIAL', autoRenew: true }));
    await setActivePackageAutoRenew('adv_1', false, NOW);
    expect(repository.updateSale).toHaveBeenCalledWith('sale_trial', { autoRenew: false });
  });

  it('sets the flag on the running sale when the policy allows it; off is always allowed; nothing running is 404', async () => {
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ autoRenew: { allowed: true, chargeFromWallet: true } }));
    repository.findActiveSale.mockResolvedValue(sale({ status: 'ACTIVE' }));
    await setActivePackageAutoRenew('adv_1', true, NOW);
    expect(repository.updateSale).toHaveBeenCalledWith('sale_1', { autoRenew: true });

    settings.getSubscriptionPolicy.mockResolvedValue(policy());
    repository.findActiveSale.mockResolvedValue(sale({ status: 'ACTIVE', autoRenew: true }));
    await setActivePackageAutoRenew('adv_1', false, NOW);
    expect(repository.updateSale).toHaveBeenLastCalledWith('sale_1', { autoRenew: false });

    repository.findActiveSale.mockResolvedValue(null);
    await expect(setActivePackageAutoRenew('adv_1', false, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ── Lot J2 (7): the wallet rail ─────────────────────────────────── */

describe('the wallet rail', () => {
  it('is refused 403 PAYMENT_METHOD_NOT_OFFERED when the policy has closed it, naming the gateways left', async () => {
    await expect(assertWalletPaymentOffered()).resolves.toBeUndefined();
    settings.getSubscriptionPolicy.mockResolvedValue(policy({ payment: { walletAllowed: false, gatewaysAllowed: ['CASHFREE'] } }));
    await expect(assertWalletPaymentOffered()).rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_METHOD_NOT_OFFERED', details: { method: 'WALLET', gatewaysAllowed: ['CASHFREE'] } });
  });
});

/* ── Lot J2 (6): the renewal sweep ───────────────────────────────── */

describe('the daily renewal sweep', () => {
  const NOW = new Date('2026-09-14T06:00:00Z');
  const ENDED_AT = new Date('2026-09-13T20:00:00Z');
  const allowRenewals = () => settings.getSubscriptionPolicy.mockResolvedValue(policy({ autoRenew: { allowed: true, chargeFromWallet: true } }));
  const lapsed = (over: Record<string, unknown> = {}) =>
    sale({ id: 'sale_old', status: 'EXPIRED', autoRenew: true, startsAt: new Date('2026-08-13T20:00:00Z'), endsAt: ENDED_AT, lines: [{ kind: 'ADDON', code: 'EXTRA_CREATIVE_REFRESH', label: 'Extra creative refresh' }], ...over });
  const soon = (over: Record<string, unknown> = {}) => sale({ id: 'sale_soon', status: 'ACTIVE', startsAt: new Date('2026-08-20T06:00:00Z'), endsAt: new Date('2026-09-20T06:00:00Z'), ...over });

  beforeEach(() => {
    repository.agentTier.mockResolvedValue(null);
    let n = 0;
    repository.createSale.mockImplementation(async (data: Record<string, unknown>) => sale({ ...data, id: `sale_new_${(n += 1)}` }));
    repository.updateSale.mockImplementation(async (id: string, patch: Record<string, unknown>) => sale({ id, ...patch }));
    repository.findSale.mockImplementation(async (id: string) => sale({ id, status: 'PENDING_PAYMENT', startsAt: ENDED_AT }));
  });

  it('reminds once inside reminderLeadDays — the plain line, or the wallet line when auto-renew is on for them and the policy', async () => {
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [soon()] : []));
    const plain = await runPackageRenewals(NOW);
    expect(repository.findEndingBetween).toHaveBeenNthCalledWith(1, NOW, new Date('2026-09-21T06:00:00Z'));
    expect(plain.expiringNotified).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', title: EXPIRING_TITLE, relatedId: 'sale_soon', message: expect.stringContaining('ends on 20 Sept 2026') }));

    repository.noticeSent.mockResolvedValue(true);
    createNotification.mockClear();
    expect((await runPackageRenewals(NOW)).expiringNotified).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();

    repository.noticeSent.mockResolvedValue(false);
    allowRenewals();
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [soon({ autoRenew: true })] : []));
    await runPackageRenewals(NOW);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ message: 'Your Growth plan renews from your wallet on 20 Sept 2026 for ₹29498.82.' }));
  });

  it('on the day endsAt passes with auto-renew on: the next sale on the same tier, add-ons and cycle, starting when the old one ended, paid through payForPackage and markPaid, the flag carried forward, SUBSCRIPTION_RENEWED sent', async () => {
    allowRenewals();
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [] : [lapsed()]));
    const summary = await runPackageRenewals(NOW);
    expect(summary).toMatchObject({ renewed: 1, renewalsFailed: 0 });

    expect(repository.findSaleStartingAt).toHaveBeenCalledWith('adv_1', 'GROWTH', ENDED_AT);
    const created = repository.createSale.mock.calls[0]![0];
    expect(created).toMatchObject({ advertiserId: 'adv_1', agentId: null, createdByUserId: 'usr_adv', tier: 'GROWTH', cycle: 'MONTHLY', months: 1 });
    expect(String(created.total)).toBe('33038.82');
    expect(created.lines.map((line: { code: string }) => line.code)).toEqual(['GROWTH', 'EXTRA_CREATIVE_REFRESH']);
    expect(repository.updateSale).toHaveBeenCalledWith('sale_new_1', { status: 'PENDING_PAYMENT', startsAt: ENDED_AT });
    expect(advertisers.bookingEligibility).toHaveBeenCalledWith('adv_1', '33038.82');
    expect(advertisers.payForPackage).toHaveBeenCalledWith('adv_1', 'sale_new_1', '33038.82', expect.stringContaining('(renewal)'));
    expect(repository.updateSale).toHaveBeenCalledWith('sale_new_1', expect.objectContaining({ status: 'ACTIVE', paidMethod: 'WALLET', startsAt: ENDED_AT, endsAt: new Date('2026-10-13T20:00:00Z'), autoRenew: true }));
    expect(notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_RENEWED',
      'usr_adv',
      expect.objectContaining({ planName: 'Growth', total: '33038.82', startsAt: '14 Sept 2026', endsAt: '14 Oct 2026' }),
      expect.objectContaining({ inApp: expect.objectContaining({ title: RENEWED_TITLE }) }),
      NOW,
    );
  });

  it('never charges twice: a second run finds the sale queued at that end already ACTIVE, or a successor in force, and does nothing', async () => {
    allowRenewals();
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [] : [lapsed()]));
    repository.findSaleStartingAt.mockResolvedValue(sale({ id: 'sale_new_1', status: 'ACTIVE', startsAt: ENDED_AT }));
    expect((await runPackageRenewals(NOW)).renewed).toBe(0);
    expect(advertisers.payForPackage).not.toHaveBeenCalled();
    expect(repository.createSale).not.toHaveBeenCalled();

    repository.hasSuccessorSale.mockResolvedValue(true);
    expect((await runPackageRenewals(NOW)).renewed).toBe(0);
    expect(repository.findSaleStartingAt).toHaveBeenCalledTimes(1);
  });

  it('with the wallet short: SUBSCRIPTION_RENEWAL_FAILED once with the shortfall, no debit, the flag stays on', async () => {
    allowRenewals();
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [] : [lapsed()]));
    advertisers.bookingEligibility.mockResolvedValue({ eligible: false, blockedBy: ['FUNDS'], wallet: { spendable: '3038.82' } });
    const summary = await runPackageRenewals(NOW);
    expect(summary).toMatchObject({ renewed: 0, renewalsFailed: 1 });
    expect(advertisers.payForPackage).not.toHaveBeenCalled();
    expect(repository.updateSale).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ autoRenew: false }));
    expect(notify).toHaveBeenCalledWith(
      'SUBSCRIPTION_RENEWAL_FAILED',
      'usr_adv',
      expect.objectContaining({ planName: 'Growth', total: '33038.82', shortfall: '30000.00', endedAt: '14 Sept 2026' }),
      expect.objectContaining({ inApp: expect.objectContaining({ title: RENEWAL_FAILED_TITLE, relatedId: 'sale_old' }) }),
      NOW,
    );
    // Told once: the marker is the in-app row.
    repository.noticeSent.mockResolvedValue(true);
    notify.mockClear();
    await runPackageRenewals(NOW);
    expect(notify).not.toHaveBeenCalled();
  });

  /* Lot K (B2) */
  it('skips a TRIAL sale: no sale minted, no wallet asked, no renewal, no RENEWAL_FAILED — and its reminder says a trial does not renew', async () => {
    allowRenewals();
    repository.findEndingBetween.mockImplementation(async (from: Date) =>
      from.getTime() === NOW.getTime() ? [soon({ id: 'sale_trial_soon', autoRenew: true, paidMethod: 'TRIAL' })] : [lapsed({ id: 'sale_trial', paidMethod: 'TRIAL', total: new Decimal('0') })],
    );
    const summary = await runPackageRenewals(NOW);
    expect(summary).toMatchObject({ expiringNotified: 1, renewed: 0, renewalsFailed: 0 });
    expect(repository.findSaleStartingAt).not.toHaveBeenCalled();
    expect(repository.createSale).not.toHaveBeenCalled();
    expect(advertisers.bookingEligibility).not.toHaveBeenCalled();
    expect(advertisers.payForPackage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: EXPIRING_TITLE, relatedId: 'sale_trial_soon', message: expect.stringContaining('free trial of Growth ends on 20 Sept 2026. A trial does not renew') }),
    );
  });

  it('with the policy\'s switch off: nobody is charged, whatever their flag says', async () => {
    repository.findEndingBetween.mockImplementation(async (from: Date) => (from.getTime() === NOW.getTime() ? [] : [lapsed()]));
    const summary = await runPackageRenewals(NOW);
    expect(summary).toMatchObject({ renewed: 0, renewalsFailed: 0 });
    expect(repository.findEndingBetween).toHaveBeenCalledTimes(1);
    expect(advertisers.payForPackage).not.toHaveBeenCalled();
    expect(repository.createSale).not.toHaveBeenCalled();
  });

  it('the five-minute expiry leaves a lapsed auto-renew sale to the sweep — EXPIRED, but no "renewing is a new sale" notice', async () => {
    allowRenewals();
    repository.findExpiredSales.mockResolvedValue([sale({ status: 'ACTIVE', autoRenew: true })]);
    await runPackageExpiry(NOW);
    expect(repository.updateSale).toHaveBeenCalledWith('sale_1', { status: 'EXPIRED' });
    expect(createNotification).not.toHaveBeenCalled();
  });
});
