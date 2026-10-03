import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/* AGE-1: the order gate, passing unless a test says otherwise (its own tests: shared/age-gate). */
const ageGate = vi.hoisted(() => ({ assertPartyAdultForOrders: vi.fn(), assertAdultForOrders: vi.fn() }));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), ...ageGate }));

/**
 * BT-1 (DR 12) — paying by bank transfer.
 *
 * What is pinned: an intent with `gateway: BANK_TRANSFER` opens no gateway
 * order and answers ADX's receiving account with the reference to quote,
 * or 409 GATEWAY_NOT_CONFIGURED until ops fill the account; the payer's
 * claim (UTR, day, amount, proof) is recorded on the row and ops are told,
 * nothing moving; ops' confirm captures and settles exactly as a gateway
 * capture — the wallet topped up keyed on the UTR, the campaign
 * authorised, the payer told; a reject fails the row with the reason; and
 * `GET /payments/gateways` lists BANK_TRANSFER as configured once the
 * account is on file.
 */
const { repository, advertisers, campaigns, packages, invoices, notifications, users, wallets, ledger, audit, tokens, revenue, publishers, featureFlags, settings, integrations } = vi.hoisted(() => ({
  tokens: { mintCheckoutToken: vi.fn(async () => 'tok_1'), consumeCheckoutToken: vi.fn(async () => true) },
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
  advertisers: { bookingEligibility: vi.fn(), getAdvertiser: vi.fn(), recordGatewayTopUp: vi.fn(), payForPackage: vi.fn(), findRefundRequest: vi.fn(), markRefundPaid: vi.fn(), failRefund: vi.fn() },
  campaigns: { campaignPaymentQuote: vi.fn(), authorizeCampaignById: vi.fn() },
  packages: { findSale: vi.fn(), assertMayActOnSale: vi.fn(), assertPayable: vi.fn(), assertSaleTermsAccepted: vi.fn(), markPaid: vi.fn() },
  invoices: { liveInvoiceFor: vi.fn(), markInvoicePaid: vi.fn() },
  notifications: { createNotification: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
  wallets: { findWallet: vi.fn(), findWalletFor: vi.fn(), ensureWallet: vi.fn(), move: vi.fn() },
  ledger: { platformAccount: vi.fn(), post: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn((before: unknown, after: unknown) => ({ before, after })) },
  revenue: { findSubscriptionOrder: vi.fn(), assertMayPaySubscriptionOrder: vi.fn(), assertSubscriptionOrderPayable: vi.fn(), assertSubscriptionOrderActivatable: vi.fn(), markSubscriptionOrderPaid: vi.fn() },
  publishers: { findPublisherContact: vi.fn() },
  featureFlags: { isFeatureEnabled: vi.fn(async () => true) },
  integrations: { getIntegrationsConfig: vi.fn() },
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
vi.mock('../../../shared/integrations', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/integrations')>()), ...integrations }));

import { ageRequiredError } from '../../../shared/age-gate';
import { confirmBankTransfer, createIntent, listGateways, rejectBankTransfer, submitBankTransfer } from '../payments.service';

const owner = { userId: 'usr_owner', isAdmin: false, advertiserId: 'adv_1', publisherId: null, agentId: null };
const admin = { userId: 'usr_admin', isAdmin: true, advertiserId: null, publisherId: null, agentId: null };
const NOW = new Date('2026-10-12T10:00:00Z');
const ACCOUNT = { beneficiary: 'Keysquare Technologies Pvt Ltd', accountNumber: '50100123456789', ifsc: 'HDFC0001234', bank: 'HDFC Bank', branch: 'Koramangala', instructions: 'Quote the reference in the remarks.' };

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay_1',
  reference: 'PAY-2026-000482',
  advertiserId: 'adv_1',
  publisherId: null,
  campaignId: 'cmp_1',
  packageSaleId: null,
  subscriptionOrderId: null,
  gateway: 'BANK_TRANSFER',
  gatewayOrderId: null,
  gatewayPaymentId: null,
  amount: new Decimal('25960.00'),
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
  bankUtr: null,
  bankPaidOn: null,
  bankClaimedAmount: null,
  bankProofFileId: null,
  bankClaimedAt: null,
  refunds: [] as unknown[],
  ...over,
});

let stored: ReturnType<typeof payment>;
const hold = (row: ReturnType<typeof payment>) => {
  stored = row;
};

beforeEach(() => {
  vi.clearAllMocks();
  hold(payment());
  integrations.getIntegrationsConfig.mockResolvedValue({ bankTransfer: ACCOUNT });
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
  advertisers.bookingEligibility.mockResolvedValue({ eligible: false, blockedBy: ['FUNDS'], wallet: null });
  advertisers.getAdvertiser.mockResolvedValue({ id: 'adv_1', name: 'Riya', companyName: 'Aster Home', email: 'riya@asterhome.example', mobile: '+919999999999', userId: 'usr_owner' });
  advertisers.recordGatewayTopUp.mockResolvedValue({ topUp: { id: 'tu_1', walletEntryId: 'we_1', ledgerTransactionId: 'lt_1' }, wallet: {}, created: true });
  campaigns.campaignPaymentQuote.mockResolvedValue({ campaignId: 'cmp_1', reference: 'ADX-CMP-2026-482913', name: 'Festive launch', advertiserId: 'adv_1', status: 'PENDING_PAYMENT', total: '25960.00', agreements: [] });
  campaigns.authorizeCampaignById.mockResolvedValue({ campaign: { id: 'cmp_1', status: 'SCHEDULED', walletHoldId: 'hold_1' }, review: {}, failedSpots: [], incentive: null });
  invoices.liveInvoiceFor.mockResolvedValue({ id: 'inv_1', status: 'ISSUED' });
  invoices.markInvoicePaid.mockResolvedValue({ id: 'inv_1', status: 'PAID' });
  notifications.createNotification.mockResolvedValue({});
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
  audit.logActivity.mockResolvedValue(undefined);
});

describe('the intent', () => {
  it('opens no gateway order and answers the receiving account with the reference to quote', async () => {
    const result = await createIntent({ campaignId: 'cmp_1', gateway: 'BANK_TRANSFER' }, owner);
    expect(campaigns.campaignPaymentQuote).toHaveBeenCalledWith('cmp_1', owner);
    expect(repository.createPayment).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1', campaignId: 'cmp_1', gateway: 'BANK_TRANSFER', currency: 'INR', createdByUserId: 'usr_owner' }));
    expect(String(repository.createPayment.mock.calls[0]![0].amount)).toBe('25960');
    expect(result.checkout).toEqual({});
    expect(result.checkoutUrl).toBeNull();
    expect(result.bankTransfer).toMatchObject({ ...ACCOUNT, amount: '25960.00' });
    expect(result.bankTransfer!.reference).toMatch(/^PAY-2026-\d{6}$/);
    expect(result.payment).toMatchObject({ status: 'CREATED', gateway: 'BANK_TRANSFER', bankTransfer: { utr: null, claimedAt: null } });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_owner', 'PAYMENT_INTENT_CREATED', expect.objectContaining({ metadata: expect.objectContaining({ gateway: 'BANK_TRANSFER' }) }));
  });

  it('is refused before anything is written until ops fill the account, and the gateway list says so', async () => {
    integrations.getIntegrationsConfig.mockResolvedValue({ bankTransfer: { beneficiary: 'ADX' } });
    await expect(createIntent({ campaignId: 'cmp_1', gateway: 'BANK_TRANSFER' }, owner)).rejects.toMatchObject({ statusCode: 409, code: 'GATEWAY_NOT_CONFIGURED', details: { missing: ['accountNumber', 'ifsc'] } });
    expect(repository.createPayment).not.toHaveBeenCalled();
    const gateways = await listGateways(true);
    expect(gateways.find((g) => g.gateway === 'BANK_TRANSFER')).toEqual({ gateway: 'BANK_TRANSFER', configured: false, testMode: false, missing: ['accountNumber', 'ifsc'] });
  });

  it('is listed as configured once the account is on file', async () => {
    const gateways = await listGateways(false);
    expect(gateways.find((g) => g.gateway === 'BANK_TRANSFER')).toEqual({ gateway: 'BANK_TRANSFER', configured: true, testMode: false });
  });
});

describe('the claim', () => {
  it('records the UTR, the day, the amount and the proof on the row, tells ops, and moves no money', async () => {
    const view = await submitBankTransfer('pay_1', { utr: 'hdfcn52026101212345', paidOn: '2026-10-12', amount: '25960.00', proofFileId: 'file_1' }, owner, NOW);
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', expect.objectContaining({ bankUtr: 'HDFCN52026101212345', bankProofFileId: 'file_1', bankClaimedAt: NOW }));
    expect(String(repository.updatePayment.mock.calls[0]![1].bankClaimedAmount)).toBe('25960');
    expect(view.status).toBe('CREATED');
    expect(view.bankTransfer).toMatchObject({ utr: 'HDFCN52026101212345', paidOn: '2026-10-12', claimedAmount: '25960.00', proofFileId: 'file_1' });
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', title: 'Bank transfer claimed' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_owner', 'PAYMENT_BANK_TRANSFER_CLAIMED', expect.anything());
  });

  it('refuses a day in the future, a gateway payment, and a row already settled', async () => {
    await expect(submitBankTransfer('pay_1', { utr: 'UTR123456', paidOn: '2027-01-01', amount: '1' }, owner, NOW)).rejects.toMatchObject({ statusCode: 400 });
    hold(payment({ gateway: 'RAZORPAY' }));
    await expect(submitBankTransfer('pay_1', { utr: 'UTR123456', paidOn: '2026-10-12', amount: '1' }, owner, NOW)).rejects.toMatchObject({ statusCode: 409 });
    hold(payment({ status: 'CAPTURED' }));
    await expect(submitBankTransfer('pay_1', { utr: 'UTR123456', paidOn: '2026-10-12', amount: '1' }, owner, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("ops' answer", () => {
  it('confirm captures for what arrived, keyed on the UTR, settles the campaign and tells the payer', async () => {
    hold(payment({ bankUtr: 'HDFCN52026101212345', bankClaimedAt: NOW }));
    const view = await confirmBankTransfer('pay_1', { note: 'Statement line 14' }, admin, NOW);
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalledWith('adv_1', expect.objectContaining({ amount: '25960.00', paymentId: 'UTR:HDFCN52026101212345' }), 'usr_admin');
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', expect.objectContaining({ status: 'CAPTURED', gatewayPaymentId: 'UTR:HDFCN52026101212345', method: 'bank_transfer', topUpId: 'tu_1' }));
    expect(campaigns.authorizeCampaignById).toHaveBeenCalledWith('cmp_1', NOW);
    expect(view.status).toBe('CAPTURED');
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner', title: 'Payment received' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PAYMENT_BANK_TRANSFER_CONFIRMED', expect.objectContaining({ metadata: expect.objectContaining({ utr: 'HDFCN52026101212345', amount: '25960.00', note: 'Statement line 14' }) }));
  });

  it('confirm takes the UTR from the statement when the payer left none, and refuses without one', async () => {
    await expect(confirmBankTransfer('pay_1', {}, admin, NOW)).rejects.toMatchObject({ statusCode: 400 });
    await confirmBankTransfer('pay_1', { utr: 'sbin52026101299999', amount: '25960.00' }, admin, NOW);
    expect(repository.updatePayment).toHaveBeenCalledWith('pay_1', { bankUtr: 'SBIN52026101299999' });
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalledWith('adv_1', expect.objectContaining({ paymentId: 'UTR:SBIN52026101299999' }), 'usr_admin');
  });

  it('a different amount is credited as it came and flagged, not applied', async () => {
    hold(payment({ bankUtr: 'UTR777777' }));
    const view = await confirmBankTransfer('pay_1', { amount: '25000.00' }, admin, NOW);
    expect(advertisers.recordGatewayTopUp).toHaveBeenCalledWith('adv_1', expect.objectContaining({ amount: '25000.00' }), 'usr_admin');
    expect(view.failureReason).toMatch(/captured 25000\.00 against 25960\.00/);
    expect(campaigns.authorizeCampaignById).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', title: 'Payment amount differs from the intent' }));
  });

  it('confirm on a captured row only re-checks the target; reject fails a CREATED row with the reason and tells the payer', async () => {
    hold(payment({ status: 'CAPTURED', gatewayPaymentId: 'UTR:X' }));
    await confirmBankTransfer('pay_1', {}, admin, NOW);
    expect(advertisers.recordGatewayTopUp).not.toHaveBeenCalled();
    expect(campaigns.authorizeCampaignById).toHaveBeenCalledWith('cmp_1', NOW);

    hold(payment({ bankUtr: 'UTR1' }));
    const view = await rejectBankTransfer('pay_1', { reason: 'Nothing on the statement in 7 days' }, admin);
    expect(view.status).toBe('FAILED');
    expect(view.failureReason).toBe('Nothing on the statement in 7 days');
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner', title: 'Payment failed' }));
    await expect(rejectBankTransfer('pay_1', { reason: 'again' }, admin)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('AGE-1 — a bank transfer is an order too', () => {
  it("asks the payer's account holder before the payment row is written", async () => {
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('MISSING'));
    await expect(createIntent({ campaignId: 'cmp_1', gateway: 'BANK_TRANSFER' }, owner)).rejects.toMatchObject({ statusCode: 403, code: 'AGE_REQUIRED' });
    expect(ageGate.assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_owner' });
    expect(repository.createPayment).not.toHaveBeenCalled();
  });
});
