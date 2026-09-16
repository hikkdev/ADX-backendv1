import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The payments service — Lot C (Q110/Q118).
 *
 * The rules worth holding onto: no gateway order is created for a campaign
 * that could not then be authorised; a capture credits the wallet first and
 * settles the target out of that balance, so every rail tells the ledger the
 * same story; a webhook is applied once however often the gateway retries,
 * and never on a bad signature; a refund leaves the wallet before it leaves
 * the gateway, and comes back to the wallet when the gateway refuses.
 */

const { repository, advertisers, campaigns, packages, invoices, notifications, users, wallets, ledger, audit, tokens, revenue, publishers, featureFlags, settings } = vi.hoisted(() => ({
  tokens: { mintCheckoutToken: vi.fn(async () => 'tok_1'), consumeCheckoutToken: vi.fn(async () => true) },
  // Lot J2 (7): which gateways each audience's policy offers.
  settings: { getSubscriptionPolicy: vi.fn() },
  repository: {
    createPayment: vi.fn(),
    findPayment: vi.fn(),
    findByGatewayOrder: vi.fn(),
    findByGatewayPayment: vi.fn(),
    updatePayment: vi.fn(),
    referenceExists: vi.fn(),
    listPaymentsPage: vi.fn(),
    refundableForAdvertiser: vi.fn(),
    createRefund: vi.fn(),
    findRefund: vi.fn(),
    findRefundByGatewayId: vi.fn(),
    findRefundByRequest: vi.fn(),
    updateRefund: vi.fn(),
    recordWebhookEvent: vi.fn(),
    markWebhookProcessed: vi.fn(),
  },
  advertisers: {
    bookingEligibility: vi.fn(),
    getAdvertiser: vi.fn(),
    recordGatewayTopUp: vi.fn(),
    payForPackage: vi.fn(),
    findRefundRequest: vi.fn(),
    markRefundPaid: vi.fn(),
    failRefund: vi.fn(),
  },
  campaigns: { campaignPaymentQuote: vi.fn(), authorizeCampaignById: vi.fn() },
  packages: { findSale: vi.fn(), assertMayActOnSale: vi.fn(), assertPayable: vi.fn(), assertSaleTermsAccepted: vi.fn(), markPaid: vi.fn() },
  invoices: { liveInvoiceFor: vi.fn(), markInvoicePaid: vi.fn() },
  notifications: { createNotification: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
  wallets: { findWallet: vi.fn(), findWalletFor: vi.fn(), ensureWallet: vi.fn(), move: vi.fn() },
  ledger: { platformAccount: vi.fn(), post: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn((before: unknown, after: unknown) => ({ before, after })) },
  // Lot J (B2): the publisher's plan order and the publisher behind it.
  revenue: {
    findSubscriptionOrder: vi.fn(),
    assertMayPaySubscriptionOrder: vi.fn(),
    assertSubscriptionOrderPayable: vi.fn(),
    assertSubscriptionOrderActivatable: vi.fn(async () => ({ rule: 'STARTS_NOW' })),
    markSubscriptionOrderPaid: vi.fn(),
  },
  publishers: { findPublisherContact: vi.fn() },
  featureFlags: { isFeatureEnabled: vi.fn(async () => true) },
}));

vi.mock('../prisma-payments.repository', () => ({ prismaPaymentsRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../campaigns', () => campaigns);
vi.mock('../../packages', () => packages);
vi.mock('../../invoices', () => invoices);
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ledger);
vi.mock('../../revenue', () => revenue);
vi.mock('../../publishers', () => publishers);
vi.mock('../../feature-flags', () => featureFlags);
vi.mock('../../app-config', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app-config')>()), ...settings }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../checkout-tokens', () => tokens);

import { DEFAULT_PLATFORM_SETTINGS } from '../../app-config';
import type { GatewayAdapter } from '../gateways/gateway';
import { setAdapter } from '../gateways/registry';
import { actorFromCheckoutToken, confirmPayment, createIntent, getPayment, handleWebhook, listGateways, refundPayment, refundableToOriginalMethod } from '../payments.service';

const owner = { userId: 'usr_owner', isAdmin: false, advertiserId: 'adv_1', publisherId: null, agentId: null };
const admin = { userId: 'usr_admin', isAdmin: true, advertiserId: null, publisherId: null, agentId: null };
/** Lot J (B2): a publisher paying for their own plan. */
const publisher = { userId: 'usr_pub', isAdmin: false, advertiserId: null, publisherId: 'pub_1', agentId: null };
const NOW = new Date('2026-09-12T10:00:00Z');

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay_1',
  reference: 'PAY-2026-000482',
  advertiserId: 'adv_1',
  publisherId: null,
  campaignId: 'cmp_1',
  packageSaleId: null,
  subscriptionOrderId: null,
  gateway: 'RAZORPAY',
  gatewayOrderId: 'order_ABC',
  gatewayPaymentId: null,
  amount: new Decimal('34810.00'),
  currency: 'INR',
  method: null,
  status: 'CREATED',
  failureReason: null,
  topUpId: null,
  walletEntryId: null,
  ledgerTransactionId: null,
  invoiceId: null,
  createdByUserId: 'usr_owner',
  createdAt: NOW,
  capturedAt: null,
  updatedAt: NOW,
  refunds: [] as unknown[],
  ...over,
});

function fakeAdapter(over: Partial<GatewayAdapter> = {}): GatewayAdapter {
  return {
    name: 'RAZORPAY',
    readiness: vi.fn(async () => ({ configured: true, testMode: true, missing: [] })),
    createOrder: vi.fn(async () => ({ gatewayOrderId: 'order_ABC', checkout: { orderId: 'order_ABC', keyId: 'rzp_test_abc' } })),
    verifySignature: vi.fn(async () => true),
    fetchPayment: vi.fn(async () => ({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', status: 'CAPTURED', amount: '34810.00', currency: 'INR', method: 'upi', failureReason: null, raw: {} })),
    refund: vi.fn(async () => ({ gatewayRefundId: 'rfnd_1', status: 'PROCESSED', raw: {} })),
    parseWebhook: vi.fn(async () => ({ ok: false, reason: 'MISMATCH' })),
    ...over,
  } as GatewayAdapter;
}

let adapter: GatewayAdapter;

/** The one payment the repository holds — stateful, so a re-read after a write sees the write. */
let stored: ReturnType<typeof payment>;
const hold = (row: ReturnType<typeof payment>) => {
  stored = row;
};

beforeEach(() => {
  vi.clearAllMocks();
  adapter = fakeAdapter();
  setAdapter('RAZORPAY', adapter);
  hold(payment());
  repository.referenceExists.mockResolvedValue(false);
  repository.createPayment.mockImplementation(async (data) => {
    hold({ ...payment(), ...data, id: 'pay_1', refunds: [] });
    const { refunds: _refunds, ...row } = stored;
    return row;
  });
  repository.updatePayment.mockImplementation(async (_id, patch) => {
    hold({ ...stored, ...patch });
    return stored;
  });
  repository.findPayment.mockImplementation(async () => ({ ...stored, refunds: [...stored.refunds] }));
  repository.createRefund.mockImplementation(async (data) => {
    const refund = { id: 'prf_1', ...data, status: 'PENDING', gatewayRefundId: null, createdAt: NOW, processedAt: null };
    (stored.refunds as unknown[]).push(refund);
    return refund;
  });
  repository.updateRefund.mockImplementation(async (id, patch) => {
    const refund = (stored.refunds as { id: string }[]).find((row) => row.id === id) ?? { id };
    Object.assign(refund, patch);
    return { ...refund };
  });
  repository.recordWebhookEvent.mockImplementation(async (data) => ({ event: { id: 'evt_row', ...data, processedAt: null }, created: true }));
  advertisers.bookingEligibility.mockResolvedValue({ eligible: false, blockedBy: ['FUNDS'], wallet: null });
  advertisers.getAdvertiser.mockResolvedValue({ id: 'adv_1', name: 'Anita', companyName: "Anita's Coffee", email: 'a@x.com', mobile: '+919999999999', userId: 'usr_owner' });
  advertisers.recordGatewayTopUp.mockResolvedValue({ topUp: { id: 'tu_1', walletEntryId: 'we_1', ledgerTransactionId: 'lt_1' }, wallet: {}, created: true });
  campaigns.campaignPaymentQuote.mockResolvedValue({ campaignId: 'cmp_1', reference: 'ADX-CMP-2026-482913', name: 'April', advertiserId: 'adv_1', status: 'PENDING_PAYMENT', total: '34810.00', agreements: [] });
  campaigns.authorizeCampaignById.mockResolvedValue({ campaign: { id: 'cmp_1', status: 'SCHEDULED', walletHoldId: 'hold_1' }, review: {}, failedSpots: [], incentive: null });
  invoices.liveInvoiceFor.mockResolvedValue({ id: 'inv_1', status: 'ISSUED' });
  invoices.markInvoicePaid.mockResolvedValue({ id: 'inv_1', status: 'PAID' });
  notifications.createNotification.mockResolvedValue({});
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
  wallets.findWalletFor.mockResolvedValue({ id: 'wal_1', advertiserId: 'adv_1' });
  wallets.findWallet.mockResolvedValue({ id: 'wal_1', advertiserId: 'adv_1' });
  wallets.move.mockResolvedValue({ created: true, entry: { id: 'we_9' }, ledgerTransactionId: 'lt_9' });
  ledger.platformAccount.mockImplementation(async (code: string) => ({ id: `acct:${code}` }));
  ledger.post.mockResolvedValue({ transaction: { id: 'lt_10' }, created: true });
  // Lot J (B2): revenue's guards, as the real ones behave, over a stateful order.
  holdOrder(order());
  revenue.findSubscriptionOrder.mockImplementation(async () => ({ ...storedOrder }));
  revenue.assertMayPaySubscriptionOrder.mockImplementation((row: { publisherId: string }, actor: { publisherId: string | null }) => {
    if (!actor.publisherId || actor.publisherId !== row.publisherId) {
      throw Object.assign(new Error('Only the publisher can pay for their own subscription.'), { statusCode: 403, code: 'FORBIDDEN' });
    }
  });
  revenue.assertSubscriptionOrderPayable.mockImplementation((row: { status: string }) => {
    if (row.status !== 'PENDING_PAYMENT') throw Object.assign(new Error('This order is not waiting for payment.'), { statusCode: 409, code: 'CONFLICT' });
  });
  revenue.markSubscriptionOrderPaid.mockImplementation(async (_id: string, input: { method: string; reference?: string | null }, at: Date) => {
    if (storedOrder.status !== 'PAID') holdOrder({ ...storedOrder, status: 'PAID', paidAt: at, paidMethod: input.method, paidReference: input.reference ?? null, subscriptionId: 'sub_new' });
    return { ...storedOrder };
  });
  publishers.findPublisherContact.mockResolvedValue({ id: 'pub_1', userId: 'usr_pub', name: 'Sharma Stores', email: 'p@x.com', mobile: '+918888888888' });
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_pub', publisherId: 'pub_1' });
  featureFlags.isFeatureEnabled.mockResolvedValue(true);
  revenue.assertSubscriptionOrderActivatable.mockResolvedValue({ rule: 'STARTS_NOW' });
  settings.getSubscriptionPolicy.mockImplementation(async (audience: 'publisher' | 'advertiser') => DEFAULT_PLATFORM_SETTINGS.subscriptions[audience]);
});

/** Lot J2 (7): one audience's policy with its gateway list narrowed. */
const gatewaysFor = (audience: 'publisher' | 'advertiser', gatewaysAllowed: string[], walletAllowed = true) =>
  settings.getSubscriptionPolicy.mockImplementation(async (asked: 'publisher' | 'advertiser') => {
    const base = DEFAULT_PLATFORM_SETTINGS.subscriptions[asked];
    return asked === audience ? { ...base, payment: { walletAllowed, gatewaysAllowed } } : base;
  });

/** Lot J (B2): the one subscription order revenue holds — stateful, so the second confirm sees it PAID. */
const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  reference: 'SUB-2026-000123',
  publisherId: 'pub_1',
  createdByUserId: 'usr_pub',
  tier: 'PLUS',
  planName: 'Plus',
  pricePerMonth: new Decimal('2499.00'),
  ratePct: new Decimal('0.1250'),
  cycle: 'MONTHLY',
  months: 1,
  subtotal: new Decimal('2499.00'),
  discountPct: new Decimal('0'),
  discountAmount: new Decimal('0'),
  gstPct: new Decimal('18'),
  gstAmount: new Decimal('449.82'),
  total: new Decimal('2948.82'),
  status: 'PENDING_PAYMENT' as string,
  startsAt: null as Date | null,
  paidAt: null as Date | null,
  paidMethod: null as string | null,
  paidReference: null as string | null,
  cancelledAt: null as Date | null,
  subscriptionId: null as string | null,
  createdAt: NOW,
  updatedAt: NOW,
  publisher: { id: 'pub_1', name: 'Sharma Stores', userId: 'usr_pub', displayId: 'PUB-1' },
  ...over,
});
let storedOrder: ReturnType<typeof order>;
const holdOrder = (row: ReturnType<typeof order>) => {
  storedOrder = row;
};
/** A publisher's payment for that order, as the intent records it. */
const subscriptionPayment = (over: Record<string, unknown> = {}) =>
  payment({ advertiserId: null, publisherId: 'pub_1', campaignId: null, subscriptionOrderId: 'ord_1', amount: new Decimal('2948.82'), createdByUserId: 'usr_pub', ...over });

describe('gateways', () => {
  it('says which gateways are configured, naming the empty fields only to an admin', async () => {
    setAdapter('CASHFREE', fakeAdapter({ name: 'CASHFREE', readiness: vi.fn(async () => ({ configured: false, testMode: true, missing: ['appId', 'secretKey'] })) }));
    const forAdvertiser = await listGateways(false);
    expect(forAdvertiser.find((g) => g.gateway === 'RAZORPAY')).toEqual({ gateway: 'RAZORPAY', configured: true, testMode: true });
    expect(forAdvertiser.find((g) => g.gateway === 'CASHFREE')).toEqual({ gateway: 'CASHFREE', configured: false, testMode: true });
    const forAdmin = await listGateways(true);
    expect(forAdmin.find((g) => g.gateway === 'CASHFREE')).toMatchObject({ missing: ['appId', 'secretKey'] });
    setAdapter('CASHFREE', null);
  });
});

describe('intents', () => {
  it('prices the campaign, checks the advertiser may pay, opens the gateway order and records a CREATED payment', async () => {
    const result = await createIntent({ campaignId: 'cmp_1', gateway: 'RAZORPAY' }, owner);

    expect(campaigns.campaignPaymentQuote).toHaveBeenCalledWith('cmp_1', owner);
    expect(repository.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ advertiserId: 'adv_1', campaignId: 'cmp_1', gateway: 'RAZORPAY', currency: 'INR', createdByUserId: 'usr_owner' }),
    );
    expect(String(repository.createPayment.mock.calls[0]![0].amount)).toBe('34810');
    expect(repository.createPayment.mock.calls[0]![0].reference).toMatch(/^PAY-2026-\d{6}$/);
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay_1', amount: '34810.00', currency: 'INR', customer: expect.objectContaining({ id: 'adv_1', name: "Anita's Coffee" }) }),
    );
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', { gatewayOrderId: 'order_ABC' });
    expect(result.checkout).toEqual({ orderId: 'order_ABC', keyId: 'rzp_test_abc', checkoutUrl: result.checkoutUrl });
    expect(result.payment.status).toBe('CREATED');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_owner', 'PAYMENT_INTENT_CREATED', expect.objectContaining({ targetType: 'Payment', targetId: 'pay_1' }));
  });

  it('answers 409 GATEWAY_NOT_CONFIGURED before anything is written when the keys are missing', async () => {
    (adapter.readiness as ReturnType<typeof vi.fn>).mockResolvedValue({ configured: false, testMode: true, missing: ['keySecret'] });
    await expect(createIntent({ campaignId: 'cmp_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 409, code: 'GATEWAY_NOT_CONFIGURED' });
    expect(repository.createPayment).not.toHaveBeenCalled();
  });

  it('refuses the advertiser the same gates a booking does, funds excepted — that is what the payment is for', async () => {
    advertisers.bookingEligibility.mockResolvedValue({ eligible: false, blockedBy: ['KYC', 'FUNDS'], wallet: null });
    await expect(createIntent({ campaignId: 'cmp_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 403, code: 'KYC_REQUIRED' });
    advertisers.bookingEligibility.mockResolvedValue({ eligible: false, blockedBy: ['SUSPENDED'], wallet: null });
    await expect(createIntent({ campaignId: 'cmp_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 409, code: 'ADVERTISER_SUSPENDED' });
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('marks the payment FAILED when the gateway refuses the order, and passes the refusal on', async () => {
    (adapter.createOrder as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('Razorpay: BAD_REQUEST_ERROR: nope'), { statusCode: 502, code: 'GATEWAY_FAILED' }));
    await expect(createIntent({ campaignId: 'cmp_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 502 });
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', expect.objectContaining({ status: 'FAILED', failureReason: 'Razorpay: BAD_REQUEST_ERROR: nope' }));
  });

  it('sells a package the same way: ownership, payability and the terms before the order', async () => {
    packages.findSale.mockResolvedValue({ id: 'sale_1', reference: 'PKG-1', advertiserId: 'adv_1', agentId: null, status: 'PENDING_PAYMENT', total: new Decimal('11800.00'), packageName: 'Growth' });
    const result = await createIntent({ packageSaleId: 'sale_1', gateway: 'RAZORPAY' }, owner);
    expect(packages.assertMayActOnSale).toHaveBeenCalled();
    expect(packages.assertPayable).toHaveBeenCalled();
    expect(packages.assertSaleTermsAccepted).toHaveBeenCalledWith('sale_1');
    expect(repository.createPayment).toHaveBeenCalledWith(expect.objectContaining({ packageSaleId: 'sale_1', campaignId: null }));
    expect(result.payment.packageSaleId).toBe('sale_1');
  });

  it('Lot J2 (7): refuses a gateway the advertiser policy does not list for a package sale; a campaign is untouched', async () => {
    gatewaysFor('advertiser', ['CCAVENUE']);
    packages.findSale.mockResolvedValue({ id: 'sale_1', reference: 'PKG-2026-482913', advertiserId: 'adv_1', agentId: null, packageName: 'Growth', status: 'PENDING_PAYMENT', total: new Decimal('33038.82') });
    await expect(createIntent({ packageSaleId: 'sale_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_METHOD_NOT_OFFERED',
      message: 'RAZORPAY is not offered for advertiser subscriptions. Choose CCAVENUE.',
    });
    expect(packages.assertSaleTermsAccepted).not.toHaveBeenCalled();
    expect(repository.createPayment).not.toHaveBeenCalled();
    await expect(createIntent({ campaignId: 'cmp_1', gateway: 'RAZORPAY' }, owner)).resolves.toBeTruthy();
  });

  it('E7-2: hands a Razorpay intent the checkout page URL under a one-time token, and every gateway the API return page', async () => {
    const result = await createIntent({ campaignId: 'cmp_1', gateway: 'RAZORPAY' }, owner);
    expect(tokens.mintCheckoutToken).toHaveBeenCalledWith('checkout', 'pay_1');
    expect(result.checkoutUrl).toMatch(/\/api\/v1\/payments\/pay_1\/checkout\?t=tok_1$/);
    // E9: the return URL carries the intent's one-time return token, so the page can print the reference and amount.
    expect(tokens.mintCheckoutToken).toHaveBeenCalledWith('return', 'pay_1');
    expect(adapter.createOrder).toHaveBeenCalledWith(expect.objectContaining({ returnUrl: expect.stringMatching(/\/api\/v1\/payments\/pay_1\/return\?t=tok_1$/) }));
    expect((adapter.createOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0].returnUrl).not.toContain('5173');

    tokens.mintCheckoutToken.mockClear();
    const cashfreeAdapter = fakeAdapter({ name: 'CASHFREE', createOrder: vi.fn(async () => ({ gatewayOrderId: 'pay_1', checkout: { paymentSessionId: 'sess' } })) });
    setAdapter('CASHFREE', cashfreeAdapter);
    const cashfree = await createIntent({ campaignId: 'cmp_1', gateway: 'CASHFREE' }, owner);
    expect(cashfree.checkoutUrl).toBeNull();
    expect(cashfree.checkout).toEqual({ paymentSessionId: 'sess' });
    // No checkout page for Cashfree — only the return token is minted.
    expect(tokens.mintCheckoutToken).not.toHaveBeenCalledWith('checkout', expect.anything());
    expect(tokens.mintCheckoutToken).toHaveBeenCalledWith('return', 'pay_1');
    expect(cashfreeAdapter.createOrder).toHaveBeenCalledWith(expect.objectContaining({ returnUrl: expect.stringMatching(/\/api\/v1\/payments\/pay_1\/return\?t=tok_1$/) }));
    setAdapter('CASHFREE', null);
  });

  it('wants exactly one target, and names all three when it says so', async () => {
    await expect(createIntent({ gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/campaignId.*packageSaleId.*subscriptionOrderId/) });
    await expect(createIntent({ campaignId: 'cmp_1', packageSaleId: 'sale_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createIntent({ campaignId: 'cmp_1', subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.createPayment).not.toHaveBeenCalled();
  });
});

/* Lot J (B2): a publisher pays for a plan order through the gateway. */
describe('intents for a subscription order (Lot J-B2)', () => {
  it('records a publisher payment for the order — publisherId and subscriptionOrderId set, advertiserId null — naming the plan and the SUB reference', async () => {
    const result = await createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, publisher);

    expect(revenue.findSubscriptionOrder).toHaveBeenCalledWith('ord_1');
    expect(revenue.assertMayPaySubscriptionOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'ord_1' }), expect.objectContaining({ userId: 'usr_pub', publisherId: 'pub_1', isAdmin: false }));
    expect(revenue.assertSubscriptionOrderPayable).toHaveBeenCalledWith(expect.objectContaining({ id: 'ord_1' }));
    // The advertiser's booking gates are not the publisher's.
    expect(advertisers.bookingEligibility).not.toHaveBeenCalled();
    expect(advertisers.getAdvertiser).not.toHaveBeenCalled();
    expect(repository.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ advertiserId: null, publisherId: 'pub_1', campaignId: null, packageSaleId: null, subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY', createdByUserId: 'usr_pub' }),
    );
    expect(String(repository.createPayment.mock.calls[0]![0].amount)).toBe('2948.82');
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: '2948.82',
        description: expect.stringMatching(/Plus plan.*SUB-2026-000123/),
        customer: expect.objectContaining({ id: 'pub_1', name: 'Sharma Stores', email: 'p@x.com', mobile: '+918888888888' }),
      }),
    );
    expect(result.payment).toMatchObject({ publisherId: 'pub_1', subscriptionOrderId: 'ord_1', advertiserId: null, status: 'CREATED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'PAYMENT_INTENT_CREATED', expect.objectContaining({ metadata: expect.objectContaining({ publisherId: 'pub_1', subscriptionOrderId: 'ord_1' }) }));
  });

  it("is the order's own publisher's to pay: another publisher, an advertiser and an admin are all 403", async () => {
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, { ...publisher, userId: 'usr_other', publisherId: 'pub_other' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, owner)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, admin)).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.createPayment).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('refuses a PAID order 409, and an unknown one 404, before any write', async () => {
    holdOrder(order({ status: 'PAID' }));
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, publisher)).rejects.toMatchObject({ statusCode: 409 });
    revenue.findSubscriptionOrder.mockResolvedValueOnce(null);
    await expect(createIntent({ subscriptionOrderId: 'ord_x', gateway: 'RAZORPAY' }, publisher)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.createPayment).not.toHaveBeenCalled();
  });

  /* Lot J2 (7): the audience's gateway list. */
  it('refuses 400 PAYMENT_METHOD_NOT_OFFERED a gateway the publisher policy does not list, before any write — and an empty list closes the path', async () => {
    gatewaysFor('publisher', ['CASHFREE']);
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, publisher)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_METHOD_NOT_OFFERED',
      message: 'RAZORPAY is not offered for publisher subscriptions. Choose CASHFREE.',
      details: { gateway: 'RAZORPAY', gatewaysAllowed: ['CASHFREE'], walletAllowed: true },
    });
    gatewaysFor('publisher', []);
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, publisher)).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_NOT_OFFERED',
      message: 'Paying through a gateway is not offered for publisher subscriptions. Pay from your ADX wallet instead.',
    });
    expect(repository.createPayment).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
    // The advertiser policy narrowed leaves the publisher's order alone.
    gatewaysFor('advertiser', []);
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, publisher)).resolves.toBeTruthy();
  });

  it('is behind the publisher-plans kill switch', async () => {
    featureFlags.isFeatureEnabled.mockResolvedValueOnce(false);
    await expect(createIntent({ subscriptionOrderId: 'ord_1', gateway: 'RAZORPAY' }, publisher)).rejects.toMatchObject({ statusCode: 503, code: 'FEATURE_OFF' });
    expect(featureFlags.isFeatureEnabled).toHaveBeenCalledWith('revenue.publisher-plans', 'usr_pub');
    expect(repository.createPayment).not.toHaveBeenCalled();
  });
});

describe('capture of a subscription payment (Lot J-B2)', () => {
  beforeEach(() => {
    hold(subscriptionPayment());
    (adapter.fetchPayment as ReturnType<typeof vi.fn>).mockResolvedValue({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', status: 'CAPTURED', amount: '2948.82', currency: 'INR', method: 'upi', failureReason: null, raw: {} });
  });

  it('credits the PUBLISHER wallet with a gateway TOPUP keyed on the gateway payment, debits it for the order, and marks the order paid by GATEWAY', async () => {
    const result = await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);

    // Never the advertiser's door.
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
    expect(advertisers.payForPackage).not.toHaveBeenCalled();
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_1' }, expect.any(String));
    // The credit: TOPUP, wallet + / platform:cash −, reference = the gateway's payment, the key the advertiser path uses.
    expect(wallets.move).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        walletId: 'wal_pub',
        amount: '2948.82',
        entryType: 'TOPUP',
        ledgerKind: 'TOPUP',
        idempotencyKey: 'topup:gateway:pay_XYZ',
        reference: 'pay_XYZ',
        occurredAt: NOW,
        createdByUserId: 'usr_pub',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:cash', amount: '-2948.82' })],
      }),
    );
    expect(repository.updatePayment).toHaveBeenCalledWith(
      'pay_1',
      expect.objectContaining({ status: 'CAPTURED', gatewayPaymentId: 'pay_XYZ', method: 'upi', topUpId: null, walletEntryId: 'we_9', ledgerTransactionId: 'lt_9', capturedAt: NOW }),
    );
    // Then the order, out of that balance: the wallet path's own debit under its key, then revenue's activation.
    expect(wallets.move).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        walletId: 'wal_pub',
        amount: '-2948.82',
        entryType: 'PACKAGE_DEBIT',
        ledgerKind: 'PACKAGE_SPEND',
        idempotencyKey: 'subscription-debit:ord_1',
        requireFunds: true,
        reference: 'ord_1',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:revenue', amount: '2948.82' })],
      }),
    );
    expect(revenue.markSubscriptionOrderPaid).toHaveBeenCalledWith('ord_1', { method: 'GATEWAY', reference: 'PAY-2026-000482' }, NOW);
    // No invoice for a publisher's order (revenue: not here).
    expect(invoices.liveInvoiceFor).not.toHaveBeenCalled();
    expect(invoices.markInvoicePaid).not.toHaveBeenCalled();
    // The publisher hears, not an advertiser.
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', title: 'Payment received', relatedId: 'ord_1' }));
    expect(advertisers.getAdvertiser).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'PAYMENT_CAPTURED', expect.objectContaining({ targetType: 'Payment', targetId: 'pay_1' }));
    expect(result.status).toBe('CAPTURED');
  });

  it('marks the order paid once across two confirms and a webhook retry', async () => {
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      event: { eventId: 'evt_s', eventType: 'payment.captured', kind: 'PAYMENT', gatewayOrderId: 'order_ABC', gatewayPaymentId: 'pay_XYZ', gatewayRefundId: null, status: 'CAPTURED', refundStatus: null, amount: '2948.82', method: 'upi', failureReason: null },
      payload: {},
    });
    repository.findByGatewayOrder.mockImplementation(async () => ({ ...stored, refunds: [] }));
    await handleWebhook('RAZORPAY', { rawBody: Buffer.from('{}'), body: {}, headers: {} }, NOW);

    expect(revenue.markSubscriptionOrderPaid).toHaveBeenCalledTimes(1);
    // The debit once — the retries find the order PAID. The webhook re-issues the
    // credit, as the advertiser path re-calls recordGatewayTopUp, and every call
    // carries the one key the wallet makes a single movement of.
    expect(wallets.move.mock.calls.filter(([input]) => input.entryType === 'PACKAGE_DEBIT')).toHaveLength(1);
    const credits = wallets.move.mock.calls.filter(([input]) => input.entryType === 'TOPUP');
    expect(credits.length).toBeGreaterThanOrEqual(1);
    expect(new Set(credits.map(([input]) => input.idempotencyKey))).toEqual(new Set(['topup:gateway:pay_XYZ']));
    expect(adapter.fetchPayment).toHaveBeenCalledTimes(1);
  });

  /* Lot J2 (b): the term rule before the debit at capture. */
  it('asks revenue whether the order can activate before the wallet is debited: refused, the credit stays spendable and no PACKAGE_DEBIT moves', async () => {
    revenue.assertSubscriptionOrderActivatable.mockRejectedValueOnce(Object.assign(new Error('Already on this plan'), { statusCode: 409, code: 'ALREADY_ON_PLAN' }));
    const result = await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);
    expect(result.status).toBe('CAPTURED');
    expect(revenue.assertSubscriptionOrderActivatable).toHaveBeenCalledWith(expect.objectContaining({ id: 'ord_1' }), NOW);
    expect(wallets.move.mock.calls.filter(([input]) => input.entryType === 'PACKAGE_DEBIT')).toHaveLength(0);
    expect(wallets.move.mock.calls.filter(([input]) => input.entryType === 'TOPUP')).toHaveLength(1);
    expect(revenue.markSubscriptionOrderPaid).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', title: 'Payment captured but not applied' }));
  });

  /* Lot J2 (c): the payer hears once. */
  it('tells the payer once — on the transition to CAPTURED — never again on a second confirm or a replayed capture webhook', async () => {
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      event: { eventId: 'evt_replay', eventType: 'payment.captured', kind: 'PAYMENT', gatewayOrderId: 'order_ABC', gatewayPaymentId: 'pay_XYZ', gatewayRefundId: null, status: 'CAPTURED', refundStatus: null, amount: '2948.82', method: 'upi', failureReason: null },
      payload: {},
    });
    repository.findByGatewayOrder.mockImplementation(async () => ({ ...stored, refunds: [] }));
    await handleWebhook('RAZORPAY', { rawBody: Buffer.from('{}'), body: {}, headers: {} }, NOW);
    const received = notifications.createNotification.mock.calls.filter(([input]) => (input as { title: string }).title === 'Payment received');
    expect(received).toHaveLength(1);
    expect(received[0]![0]).toMatchObject({ userId: 'usr_pub', relatedId: 'ord_1' });
  });

  it('keeps the credit and tells ops when the order can no longer be activated', async () => {
    revenue.markSubscriptionOrderPaid.mockRejectedValueOnce(Object.assign(new Error('Already on this plan'), { statusCode: 409, code: 'ALREADY_ON_PLAN' }));
    const result = await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);
    expect(result.status).toBe('CAPTURED');
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_admin', title: 'Payment captured but not applied', message: expect.stringContaining('the order could not be activated') }),
    );
    expect(notifications.createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', title: 'Payment received' }));
  });

  it('tells the publisher, not an advertiser, when the gateway reports the payment failed', async () => {
    (adapter.fetchPayment as ReturnType<typeof vi.fn>).mockResolvedValue({ gatewayPaymentId: 'pay_F', gatewayOrderId: 'order_ABC', status: 'FAILED', amount: '2948.82', currency: 'INR', method: 'card', failureReason: 'Card declined', raw: {} });
    await expect(confirmPayment('pay_1', { gatewayPaymentId: 'pay_F', signature: 'sig' }, publisher, NOW)).rejects.toMatchObject({ statusCode: 402 });
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', expect.objectContaining({ status: 'FAILED', failureReason: 'Card declined' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', title: 'Payment failed', relatedId: 'ord_1', type: 'SYSTEM' }));
    expect(advertisers.getAdvertiser).not.toHaveBeenCalled();
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it("is the publisher's own to read and confirm; another publisher or an advertiser is 403", async () => {
    await expect(getPayment('pay_1', { ...publisher, userId: 'usr_other', publisherId: 'pub_other' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(getPayment('pay_1', owner)).rejects.toMatchObject({ statusCode: 403 });
    expect((await getPayment('pay_1', publisher)).id).toBe('pay_1');
    expect((await getPayment('pay_1', admin)).id).toBe('pay_1');
    await expect(confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, owner, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('confirms from the checkout page as the publisher who raised the intent', async () => {
    const actor = await actorFromCheckoutToken('pay_1', 'ct');
    expect(actor).toEqual({ userId: 'usr_pub', isAdmin: false, advertiserId: null, publisherId: 'pub_1', agentId: null });
  });

  it("is not refundable through the gateway refund — that path is the advertiser's", async () => {
    hold(subscriptionPayment({ status: 'CAPTURED', gatewayPaymentId: 'pay_XYZ', capturedAt: NOW }));
    await expect(refundPayment('pay_1', { amount: '100.00', reason: 'Goodwill' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not refundable/i) });
    expect(repository.createRefund).not.toHaveBeenCalled();
    expect(adapter.refund).not.toHaveBeenCalled();
  });
});

describe('confirm from the checkout page (E7-2)', () => {
  it('spends the confirm token once and confirms as the person who raised the intent', async () => {
    const actor = await actorFromCheckoutToken('pay_1', 'ct');
    expect(tokens.consumeCheckoutToken).toHaveBeenCalledWith('confirm', 'pay_1', 'ct');
    expect(actor).toEqual({ userId: 'usr_owner', isAdmin: false, advertiserId: 'adv_1', publisherId: null, agentId: null });

    const result = await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig', gatewayOrderId: 'order_ABC' }, actor, NOW);
    expect(result.status).toBe('CAPTURED');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_owner', 'PAYMENT_CAPTURED', expect.anything());
  });

  it('refuses a spent or foreign token with 401 before touching the payment', async () => {
    tokens.consumeCheckoutToken.mockResolvedValueOnce(false);
    await expect(actorFromCheckoutToken('pay_1', 'stale')).rejects.toMatchObject({ statusCode: 401, code: 'CHECKOUT_TOKEN_INVALID' });
    expect(repository.findPayment).not.toHaveBeenCalled();
  });

  it('refuses a confirmation naming another order, whatever it signs', async () => {
    await expect(confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig', gatewayOrderId: 'order_OTHER' }, owner, NOW)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_SIGNATURE_INVALID',
    });
    expect(adapter.verifySignature).not.toHaveBeenCalled();
  });
});

describe('confirm (Razorpay client-side)', () => {
  it('verifies the signature, reads the payment, credits the wallet as a gateway top-up and authorises the campaign', async () => {
    const result = await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, owner, NOW);

    expect(adapter.verifySignature).toHaveBeenCalledWith({ gatewayOrderId: 'order_ABC', gatewayPaymentId: 'pay_XYZ', signature: 'sig' });
    expect(adapter.fetchPayment).toHaveBeenCalledWith('pay_XYZ', 'order_ABC');
    // Money through the wallet: TOPUP legs (wallet + / platform:cash −), keyed on the gateway's payment id.
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalledWith(
      'adv_1',
      expect.objectContaining({ amount: '34810.00', paymentId: 'pay_XYZ', receivedAt: NOW }),
      'usr_owner',
    );
    expect(repository.updatePayment).toHaveBeenCalledWith(
      'pay_1',
      expect.objectContaining({ status: 'CAPTURED', gatewayPaymentId: 'pay_XYZ', method: 'upi', topUpId: 'tu_1', walletEntryId: 'we_1', ledgerTransactionId: 'lt_1', capturedAt: NOW }),
    );
    // Then the campaign, out of that balance — the same authorise the wallet path runs.
    expect(campaigns.authorizeCampaignById).toHaveBeenCalledWith('cmp_1', NOW);
    // And the invoice carries the payment.
    expect(invoices.markInvoicePaid).toHaveBeenCalledWith('inv_1', { paymentId: 'pay_1' });
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', { invoiceId: 'inv_1' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner', title: 'Payment received', relatedId: 'cmp_1' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_owner', 'PAYMENT_CAPTURED', expect.objectContaining({ targetType: 'Payment', targetId: 'pay_1' }));
    expect(result.status).toBe('CAPTURED');
  });

  it('captures an authorised payment first, where the gateway authorises before it captures', async () => {
    (adapter.fetchPayment as ReturnType<typeof vi.fn>).mockResolvedValue({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', status: 'AUTHORIZED', amount: '34810.00', currency: 'INR', method: 'card', failureReason: null, raw: {} });
    adapter.capture = vi.fn(async () => ({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', status: 'CAPTURED' as const, amount: '34810.00', currency: 'INR', method: 'card', failureReason: null, raw: {} }));

    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, owner, NOW);
    expect(adapter.capture).toHaveBeenCalledWith({ gatewayPaymentId: 'pay_XYZ', amount: '34810.00', currency: 'INR' });
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalled();
  });

  it('refuses a forged signature with 400 PAYMENT_SIGNATURE_INVALID and touches nothing', async () => {
    (adapter.verifySignature as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'bad' }, owner)).rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_SIGNATURE_INVALID' });
    expect(adapter.fetchPayment).not.toHaveBeenCalled();
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
  });

  it('marks a failed payment FAILED with the gateway\'s reason', async () => {
    (adapter.fetchPayment as ReturnType<typeof vi.fn>).mockResolvedValue({ gatewayPaymentId: 'pay_F', gatewayOrderId: 'order_ABC', status: 'FAILED', amount: '34810.00', currency: 'INR', method: 'card', failureReason: 'Card declined', raw: {} });
    await expect(confirmPayment('pay_1', { gatewayPaymentId: 'pay_F', signature: 'sig' }, owner)).rejects.toMatchObject({ statusCode: 402 });
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', expect.objectContaining({ status: 'FAILED', failureReason: 'Card declined', gatewayPaymentId: 'pay_F' }));
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
  });

  it('is the owner\'s, their agent\'s who raised it, or an admin\'s to confirm', async () => {
    await expect(confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, { ...owner, advertiserId: 'adv_other', userId: 'usr_other' })).rejects.toMatchObject({ statusCode: 403 });
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, admin);
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalledTimes(1);
  });

  it('credits the wallet even when the campaign can no longer be authorised, and tells ops', async () => {
    campaigns.authorizeCampaignById.mockRejectedValue(Object.assign(new Error('booked out'), { statusCode: 409, code: 'CONFLICT' }));
    const result = await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, owner, NOW);
    expect(result.status).toBe('CAPTURED');
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalled();
    // Ops hear about it; the advertiser keeps the money as spendable balance (Q118).
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', title: 'Payment captured but not applied' }));
  });

  it('is idempotent: a captured payment confirmed again only re-checks the target', async () => {
    hold(payment({ status: 'CAPTURED', gatewayPaymentId: 'pay_XYZ', capturedAt: NOW }));
    campaigns.authorizeCampaignById.mockRejectedValue(Object.assign(new Error('already'), { statusCode: 409, code: 'CONFLICT', message: 'Payment for this campaign is already authorized.' }));
    const result = await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, owner, NOW);
    expect(result.status).toBe('CAPTURED');
    expect(adapter.fetchPayment).not.toHaveBeenCalled();
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
  });

  it('settles a package sale by debiting the wallet it just credited and marking the sale paid by GATEWAY', async () => {
    hold(payment({ campaignId: null, packageSaleId: 'sale_1' }));
    packages.findSale.mockResolvedValue({ id: 'sale_1', reference: 'PKG-1', advertiserId: 'adv_1', agentId: null, status: 'PENDING_PAYMENT', total: new Decimal('34810.00'), packageName: 'Growth' });
    packages.markPaid.mockResolvedValue({ id: 'sale_1', status: 'ACTIVE' });

    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, owner, NOW);
    expect(advertisers.payForPackage).toHaveBeenCalledWith('adv_1', 'sale_1', '34810.00', expect.stringContaining('PAY-2026-000482'));
    expect(packages.markPaid).toHaveBeenCalledWith('sale_1', { method: 'GATEWAY', reference: 'PAY-2026-000482' }, NOW);
    expect(invoices.liveInvoiceFor).toHaveBeenCalledWith({ campaignId: null, packageSaleId: 'sale_1' });
  });
});

describe('webhooks', () => {
  const request = { rawBody: Buffer.from('{}'), body: {}, headers: {} };
  const captured = {
    eventId: 'evt_1',
    eventType: 'payment.captured',
    kind: 'PAYMENT' as const,
    gatewayOrderId: 'order_ABC',
    gatewayPaymentId: 'pay_XYZ',
    gatewayRefundId: null,
    status: 'CAPTURED' as const,
    refundStatus: null,
    amount: '34810.00',
    method: 'upi',
    failureReason: null,
  };

  it('refuses a bad signature with 401 and records nothing', async () => {
    await expect(handleWebhook('RAZORPAY', request)).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
  });

  it('records the event once, marks the payment captured through the wallet, and settles the campaign', async () => {
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, event: captured, payload: { event: 'payment.captured' } });
    repository.findByGatewayOrder.mockResolvedValue(payment());

    const result = await handleWebhook('RAZORPAY', request, NOW);

    expect(repository.recordWebhookEvent).toHaveBeenCalledWith({ gateway: 'RAZORPAY', eventId: 'evt_1', eventType: 'payment.captured', payload: { event: 'payment.captured' } });
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalledWith('adv_1', expect.objectContaining({ paymentId: 'pay_XYZ' }), 'usr_owner');
    expect(campaigns.authorizeCampaignById).toHaveBeenCalledWith('cmp_1', NOW);
    expect(repository.markWebhookProcessed).toHaveBeenCalledWith('evt_row', 'CAPTURED', NOW);
    expect(result).toEqual({ duplicate: false, outcome: 'CAPTURED' });
  });

  it('applies a retried event once', async () => {
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, event: captured, payload: {} });
    repository.recordWebhookEvent.mockResolvedValue({ event: { id: 'evt_row', processedAt: NOW, outcome: 'CAPTURED' }, created: false });
    const result = await handleWebhook('RAZORPAY', request, NOW);
    expect(result).toEqual({ duplicate: true, outcome: 'CAPTURED' });
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
  });

  it('marks a failure FAILED with the reason and tells the advertiser', async () => {
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, event: { ...captured, eventId: 'evt_2', status: 'FAILED', failureReason: 'Card declined' }, payload: {} });
    repository.findByGatewayOrder.mockResolvedValue(payment());
    const result = await handleWebhook('RAZORPAY', request, NOW);
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', expect.objectContaining({ status: 'FAILED', failureReason: 'Card declined' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner', title: 'Payment failed' }));
    expect(result.outcome).toBe('FAILED');
  });

  it('answers a verified event for an order it does not know without applying anything', async () => {
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, event: captured, payload: {} });
    repository.findByGatewayOrder.mockResolvedValue(null);
    repository.findByGatewayPayment.mockResolvedValue(null);
    const result = await handleWebhook('RAZORPAY', request, NOW);
    expect(result.outcome).toBe('NO_PAYMENT');
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
  });

  it('answers a verified but unreadable body 200 so the gateway stops retrying', async () => {
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: 'UNPARSEABLE' });
    expect(await handleWebhook('RAZORPAY', request, NOW)).toEqual({ duplicate: false, outcome: 'UNPARSEABLE' });
  });

  it('finalises a pending refund the gateway now says is processed', async () => {
    (adapter.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      event: { ...captured, eventId: 'evt_3', eventType: 'refund.processed', kind: 'REFUND', gatewayRefundId: 'rfnd_1', status: null, refundStatus: 'PROCESSED', amount: '5000.00' },
      payload: {},
    });
    repository.findRefundByGatewayId.mockResolvedValue({ id: 'prf_1', paymentId: 'pay_1', amount: new Decimal('5000.00'), status: 'PENDING', refundRequestId: 'req_1', payment: payment({ status: 'PARTIALLY_REFUNDED' }) });
    hold(payment({ status: 'PARTIALLY_REFUNDED', gatewayPaymentId: 'pay_XYZ', refunds: [{ id: 'prf_1', paymentId: 'pay_1', amount: new Decimal('5000.00'), status: 'PENDING', gatewayRefundId: 'rfnd_1', refundRequestId: 'req_1', createdAt: NOW, processedAt: null }] }));

    const result = await handleWebhook('RAZORPAY', request, NOW);
    expect(repository.updateRefund).toHaveBeenCalledWith('prf_1', { status: 'PROCESSED', processedAt: NOW });
    expect(advertisers.markRefundPaid).toHaveBeenCalledWith('req_1', { railReference: 'rfnd_1', byUserId: 'system' }, NOW);
    expect(result.outcome).toBe('REFUND_PROCESSED');
  });
});

describe('refunds', () => {
  const captured = (over: Record<string, unknown> = {}) => payment({ status: 'CAPTURED', gatewayPaymentId: 'pay_XYZ', capturedAt: NOW, ...over });

  beforeEach(() => {
    hold(captured());
    repository.findRefundByRequest.mockResolvedValue(null);
  });

  it('pays an approved ORIGINAL_METHOD request through the gateway and marks it PAID with the gateway refund id', async () => {
    advertisers.findRefundRequest.mockResolvedValue({ id: 'req_1', walletId: 'wal_1', amount: new Decimal('5000.00'), status: 'APPROVED', destination: 'ORIGINAL_METHOD' });
    advertisers.markRefundPaid.mockResolvedValue({ id: 'req_1', status: 'PAID' });

    const result = await refundPayment('pay_1', { amount: '5000.00', reason: 'Unused days', refundRequestId: 'req_1' }, 'usr_admin', NOW);

    expect(repository.createRefund).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'pay_1', reason: 'Unused days', refundRequestId: 'req_1' }));
    expect(adapter.refund).toHaveBeenCalledWith({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', amount: '5000.00', refundId: 'prf_1', note: 'Unused days' });
    expect(repository.updateRefund).toHaveBeenCalledWith('prf_1', { gatewayRefundId: 'rfnd_1', status: 'PROCESSED', processedAt: NOW });
    // The request's own wallet debit was taken at approval; paying it posts payables − / cash + through advertisers.
    expect(advertisers.markRefundPaid).toHaveBeenCalledWith('req_1', { railReference: 'rfnd_1', byUserId: 'usr_admin' }, NOW);
    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', { status: 'PARTIALLY_REFUNDED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PAYMENT_REFUNDED', expect.objectContaining({ targetType: 'Payment', targetId: 'pay_1' }));
    expect(result.refund.status).toBe('PROCESSED');
    // T-B: the envelope carries the same views the reads do — the refund as the
    // Payment view lists one, the payment as GET /payments/:id answers it.
    expect(result.refund).toEqual({
      id: 'prf_1',
      amount: '5000.00',
      status: 'PROCESSED',
      gatewayRefundId: 'rfnd_1',
      reason: 'Unused days',
      refundRequestId: 'req_1',
      createdAt: NOW,
      processedAt: NOW,
    });
    expect(result.payment).toMatchObject({ id: 'pay_1', refundable: expect.any(String), refunds: [expect.objectContaining({ id: 'prf_1', amount: '5000.00' })] });
    expect(result.payment.refunds[0]).toEqual(result.refund);
  });

  it('refuses a request that is not an approved ORIGINAL_METHOD one, or on another advertiser\'s wallet, or for a different amount', async () => {
    advertisers.findRefundRequest.mockResolvedValue({ id: 'req_1', walletId: 'wal_1', amount: new Decimal('5000.00'), status: 'PENDING', destination: 'ORIGINAL_METHOD' });
    await expect(refundPayment('pay_1', { amount: '5000.00', reason: 'x', refundRequestId: 'req_1' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    advertisers.findRefundRequest.mockResolvedValue({ id: 'req_1', walletId: 'wal_1', amount: new Decimal('5000.00'), status: 'APPROVED', destination: 'BANK_TRANSFER' });
    await expect(refundPayment('pay_1', { amount: '5000.00', reason: 'x', refundRequestId: 'req_1' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    advertisers.findRefundRequest.mockResolvedValue({ id: 'req_1', walletId: 'wal_1', amount: new Decimal('5000.00'), status: 'APPROVED', destination: 'ORIGINAL_METHOD' });
    wallets.findWallet.mockResolvedValue({ id: 'wal_1', advertiserId: 'adv_other' });
    await expect(refundPayment('pay_1', { amount: '5000.00', reason: 'x', refundRequestId: 'req_1' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    wallets.findWallet.mockResolvedValue({ id: 'wal_1', advertiserId: 'adv_1' });
    await expect(refundPayment('pay_1', { amount: '4000.00', reason: 'x', refundRequestId: 'req_1' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(adapter.refund).not.toHaveBeenCalled();
  });

  it('a direct refund debits the wallet first (REFUND: wallet − / payables +) and, once processed, discharges payables against cash', async () => {
    const result = await refundPayment('pay_1', { amount: '5000.00', reason: 'Goodwill' }, 'usr_admin', NOW);

    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal_1',
        amount: '-5000.00',
        entryType: 'REFUND',
        ledgerKind: 'REFUND',
        idempotencyKey: 'payment-refund:prf_1',
        requireFunds: true,
        counterLegs: [expect.objectContaining({ accountCode: 'platform:payables', amount: '5000.00' })],
      }),
    );
    expect(ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'REFUND',
        idempotencyKey: 'payment-refund-paid:prf_1',
        legs: [
          expect.objectContaining({ accountId: 'acct:platform:payables', amount: '-5000.00' }),
          expect.objectContaining({ accountId: 'acct:platform:cash', amount: '5000.00' }),
        ],
      }),
      NOW,
    );
    expect(result.payment.status).toBe('PARTIALLY_REFUNDED');
  });

  it('puts the money back in the wallet and marks the refund FAILED when the gateway refuses', async () => {
    (adapter.refund as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('Razorpay: refund refused'), { statusCode: 502, code: 'GATEWAY_FAILED' }));
    await expect(refundPayment('pay_1', { amount: '5000.00', reason: 'Goodwill' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 502 });
    expect(repository.updateRefund).toHaveBeenCalledWith('prf_1', { status: 'FAILED' });
    expect(wallets.move).toHaveBeenLastCalledWith(expect.objectContaining({ amount: '5000.00', idempotencyKey: 'payment-refund-failed:prf_1' }));
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('never refunds more than is left on the payment, and a full refund marks it REFUNDED', async () => {
    hold(captured({ status: 'PARTIALLY_REFUNDED', refunds: [{ id: 'prf_0', amount: new Decimal('30000.00'), status: 'PROCESSED' }] }));
    await expect(refundPayment('pay_1', { amount: '5000.00', reason: 'x' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 400 });

    await refundPayment('pay_1', { amount: '4810.00', reason: 'x' }, 'usr_admin', NOW);
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', { status: 'REFUNDED' });
  });

  it('answers whether an advertiser has a captured gateway payment with enough left to return to', async () => {
    repository.refundableForAdvertiser.mockResolvedValue([captured({ refunds: [{ id: 'prf_0', amount: new Decimal('30000.00'), status: 'PROCESSED' }] })]);
    expect(await refundableToOriginalMethod('adv_1', '4810.00')).toBe(true);
    expect(await refundableToOriginalMethod('adv_1', '5000.00')).toBe(false);
    (adapter.readiness as ReturnType<typeof vi.fn>).mockResolvedValue({ configured: false, testMode: true, missing: ['keyId'] });
    expect(await refundableToOriginalMethod('adv_1', '100.00')).toBe(false);
  });
});
