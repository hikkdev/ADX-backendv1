import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/* AGE-1: the order gate, passing unless a test says otherwise (its own tests: shared/age-gate). */
const ageGate = vi.hoisted(() => ({ assertPartyAdultForOrders: vi.fn(), assertAdultForOrders: vi.fn() }));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), ...ageGate }));

/**
 * LM-1 — a display ad (`adBookingId`, the advertiser pays) and a sponsored
 * listing (`listingBoostId`, the publisher pays) are the fourth and fifth
 * things a payment settles.
 *
 * Pinned: the intent is priced and guarded by `promotions` and written to
 * its own column with the right payer; exactly one target is still the
 * rule; a capture credits the payer's wallet first and then settles the
 * placement out of it through `promotions` — once, however often the
 * gateway replays — stamping the ad's invoice on the payment; a placement
 * that can no longer be paid leaves the money spendable and tells ops.
 */

const { repository, advertisers, promotions, notifications, users, wallets, publishers, audit, tokens, invoices } = vi.hoisted(() => ({
  repository: {
    createPayment: vi.fn(),
    findPayment: vi.fn(),
    findByGatewayOrder: vi.fn(),
    findByGatewayPayment: vi.fn(),
    updatePayment: vi.fn(),
    referenceExists: vi.fn(async () => false),
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
    bookingEligibility: vi.fn(async () => ({ eligible: false, blockedBy: ['FUNDS'], wallet: null })),
    getAdvertiser: vi.fn(async () => ({ id: 'adv_1', name: 'Asha', companyName: 'Asha Foods', email: 'a@x.com', mobile: '+919999999999', userId: 'usr_adv' })),
    recordGatewayTopUp: vi.fn(async () => ({ topUp: { id: 'tu_1', walletEntryId: 'we_1', ledgerTransactionId: 'lt_1' }, created: true })),
    payForPackage: vi.fn(),
    findRefundRequest: vi.fn(),
    markRefundPaid: vi.fn(),
    failRefund: vi.fn(),
  },
  promotions: {
    adPaymentTarget: vi.fn(async () => ({ id: 'ad_1', reference: 'ADB-0110-2601', payer: { kind: 'ADVERTISER', id: 'adv_1' }, amount: '12390.00', description: 'Ad ADB-0110-2601 — Listing page sidebar, 5 Oct – 11 Oct 2026' })),
    boostPaymentTarget: vi.fn(async () => ({ id: 'bst_1', reference: 'BST-0110-2601', payer: { kind: 'PUBLISHER', id: 'pub_1' }, amount: '7080.00', description: 'Sponsored listing BST-0110-2601' })),
    settleAdPayment: vi.fn(async () => ({ invoiceId: 'inv_ad' })),
    settleBoostPayment: vi.fn(async () => ({ invoiceId: null })),
  },
  invoices: { liveInvoiceFor: vi.fn(async () => null), markInvoicePaid: vi.fn() },
  notifications: { createNotification: vi.fn(async () => ({})) },
  users: { listAdminUserIds: vi.fn(async () => ['usr_admin']) },
  wallets: { findWallet: vi.fn(), findWalletFor: vi.fn(), ensureWallet: vi.fn(async () => ({ id: 'wal_pub' })), move: vi.fn(async () => ({ created: true, entry: { id: 'we_9' }, ledgerTransactionId: 'lt_9' })) },
  publishers: { findPublisherContact: vi.fn(async () => ({ id: 'pub_1', userId: 'usr_pub', name: 'Sharma Media', email: 'p@x.com', mobile: '+918888888888' })) },
  audit: { logActivity: vi.fn(async () => undefined), auditDiff: vi.fn(() => ({})) },
  tokens: { mintCheckoutToken: vi.fn(async () => 'tok_1'), consumeCheckoutToken: vi.fn(async () => true) },
}));

vi.mock('../prisma-payments.repository', () => ({ prismaPaymentsRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../campaigns', () => ({ campaignPaymentQuote: vi.fn(), authorizeCampaignById: vi.fn(), reservationFeePaymentQuote: vi.fn(), settleReservationFeeById: vi.fn() }));
vi.mock('../../packages', () => ({ findSale: vi.fn(), assertMayActOnSale: vi.fn(), assertPayable: vi.fn(), assertSaleTermsAccepted: vi.fn(), markPaid: vi.fn() }));
vi.mock('../../invoices', () => invoices);
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../revenue', () => ({
  findSubscriptionOrder: vi.fn(),
  assertMayPaySubscriptionOrder: vi.fn(),
  assertSubscriptionOrderPayable: vi.fn(),
  assertSubscriptionOrderActivatable: vi.fn(),
  markSubscriptionOrderPaid: vi.fn(),
}));
vi.mock('../../publishers', () => publishers);
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../checkout-tokens', () => tokens);
vi.mock('../../../shared/integrations', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/integrations')>()), getIntegrationsConfig: vi.fn(async () => ({})) }));

import type { GatewayAdapter } from '../gateways/gateway';
import { setAdapter } from '../gateways/registry';
import { confirmPayment, createIntent } from '../payments.service';
import { registerPromotionPaymentsPort } from '../promotion-payments.port';

const NOW = new Date('2026-10-01T10:00:00Z');
const advertiser = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', publisherId: null, agentId: null };
const publisher = { userId: 'usr_pub', isAdmin: false, advertiserId: null, publisherId: 'pub_1', agentId: null };

let stored: Record<string, any>;

function fakeAdapter(amount: string): GatewayAdapter {
  return {
    name: 'RAZORPAY',
    readiness: vi.fn(async () => ({ configured: true, testMode: true, missing: [] })),
    createOrder: vi.fn(async () => ({ gatewayOrderId: 'order_ABC', checkout: { orderId: 'order_ABC' } })),
    verifySignature: vi.fn(async () => true),
    fetchPayment: vi.fn(async () => ({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', status: 'CAPTURED', amount, currency: 'INR', method: 'upi', failureReason: null, raw: {} })),
    refund: vi.fn(),
    parseWebhook: vi.fn(),
  } as unknown as GatewayAdapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  registerPromotionPaymentsPort({ adTarget: promotions.adPaymentTarget, boostTarget: promotions.boostPaymentTarget, settleAd: promotions.settleAdPayment, settleBoost: promotions.settleBoostPayment } as never);
  stored = {};
  repository.createPayment.mockImplementation(async (data: Record<string, unknown>) => {
    stored = {
      id: 'pay_1',
      status: 'CREATED',
      campaignId: null,
      packageSaleId: null,
      subscriptionOrderId: null,
      adBookingId: null,
      listingBoostId: null,
      gatewayOrderId: null,
      gatewayPaymentId: null,
      invoiceId: null,
      topUpId: null,
      walletEntryId: null,
      ledgerTransactionId: null,
      failureReason: null,
      method: null,
      createdAt: NOW,
      capturedAt: null,
      updatedAt: NOW,
      ...data,
      amount: new Decimal(String(data['amount'])),
    };
    return stored;
  });
  repository.updatePayment.mockImplementation(async (_id: string, patch: Record<string, unknown>) => (stored = { ...stored, ...patch }));
  repository.findPayment.mockImplementation(async () => ({ ...stored, refunds: [] }));
});

describe('an ad', () => {
  it('opens a gateway order for the advertiser, on the adBookingId column, priced by promotions', async () => {
    setAdapter('RAZORPAY', fakeAdapter('12390.00'));
    const intent = await createIntent({ adBookingId: 'ad_1', gateway: 'RAZORPAY' }, advertiser, NOW);
    expect(promotions.adPaymentTarget).toHaveBeenCalledWith('ad_1', advertiser);
    expect(repository.createPayment).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1', publisherId: null, adBookingId: 'ad_1', listingBoostId: null, campaignId: null }));
    expect(intent.payment).toMatchObject({ adBookingId: 'ad_1', amount: '12390.00' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_adv', 'PAYMENT_INTENT_CREATED', expect.objectContaining({ metadata: expect.objectContaining({ adBookingId: 'ad_1' }) }));
  });

  it('a capture credits the advertiser wallet, then promotions settles the ad and its invoice rides on the payment — once', async () => {
    setAdapter('RAZORPAY', fakeAdapter('12390.00'));
    await createIntent({ adBookingId: 'ad_1', gateway: 'RAZORPAY' }, advertiser, NOW);
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, advertiser, NOW);
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalledWith('adv_1', expect.objectContaining({ amount: '12390.00', paymentId: 'pay_XYZ' }), expect.anything());
    expect(promotions.settleAdPayment).toHaveBeenCalledWith('ad_1', { id: 'pay_1', reference: stored['reference'] }, 'usr_adv', NOW);
    expect(stored).toMatchObject({ status: 'CAPTURED', invoiceId: 'inv_ad' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', title: 'Payment received', relatedId: 'ad_1' }));
  });

  it('a placement that can no longer be paid leaves the money spendable and tells ops', async () => {
    setAdapter('RAZORPAY', fakeAdapter('12390.00'));
    await createIntent({ adBookingId: 'ad_1', gateway: 'RAZORPAY' }, advertiser, NOW);
    promotions.settleAdPayment.mockRejectedValueOnce(Object.assign(new Error('The ad booking was cancelled before the payment arrived'), { statusCode: 409 }));
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, advertiser, NOW);
    expect(stored['status']).toBe('CAPTURED');
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', title: 'Payment captured but not applied' }));
  });
});

describe('a sponsored listing', () => {
  it('the publisher pays: the listingBoostId column, the publisher wallet credited, promotions settles it', async () => {
    setAdapter('RAZORPAY', fakeAdapter('7080.00'));
    await createIntent({ listingBoostId: 'bst_1', gateway: 'RAZORPAY' }, publisher, NOW);
    expect(repository.createPayment).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: null, publisherId: 'pub_1', listingBoostId: 'bst_1', adBookingId: null }));
    await confirmPayment('pay_1', { gatewayPaymentId: 'pay_XYZ', signature: 'sig' }, publisher, NOW);
    expect(wallets.move).toHaveBeenCalledWith(expect.objectContaining({ entryType: 'TOPUP', idempotencyKey: 'topup:gateway:pay_XYZ', amount: '7080.00' }));
    expect(promotions.settleBoostPayment).toHaveBeenCalledWith('bst_1', expect.objectContaining({ id: 'pay_1' }), 'usr_pub', NOW);
    expect(stored).toMatchObject({ status: 'CAPTURED', invoiceId: null });
  });
});

describe('exactly one target', () => {
  it('two targets, or none, is 400 naming all five', async () => {
    setAdapter('RAZORPAY', fakeAdapter('1.00'));
    await expect(createIntent({ adBookingId: 'ad_1', listingBoostId: 'bst_1', gateway: 'RAZORPAY' }, advertiser, NOW)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('listingBoostId') });
    await expect(createIntent({ gateway: 'RAZORPAY' }, advertiser, NOW)).rejects.toMatchObject({ statusCode: 400 });
  });
});
