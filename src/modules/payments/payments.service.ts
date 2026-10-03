import { randomInt } from 'crypto';
import { env } from '../../config/env';
import { assertPartyAdultForOrders } from '../../shared/age-gate';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import type { PaymentGateway } from '../../shared/database';
import {
  bookingEligibility,
  failRefund,
  findRefundRequest,
  getAdvertiser,
  markRefundPaid,
  payForPackage,
  recordGatewayTopUp,
} from '../advertisers';
import { getSubscriptionPolicy, type SubscriptionAudience } from '../app-config';
import { authorizeCampaignById, campaignPaymentQuote, reservationFeePaymentQuote, settleReservationFeeById } from '../campaigns';
import { isFeatureEnabled } from '../feature-flags';
import { liveInvoiceFor, markInvoicePaid } from '../invoices';
import { platformAccount, post as postLedger } from '../ledger';
import { createNotification, type RelatedType } from '../notifications';
import { assertMayActOnSale, assertPayable, assertSaleTermsAccepted, findSale, markPaid as markSalePaid } from '../packages';
import { findPublisherContact } from '../publishers';
import {
  assertMayPaySubscriptionOrder,
  assertSubscriptionOrderActivatable,
  assertSubscriptionOrderPayable,
  findSubscriptionOrder,
  markSubscriptionOrderPaid,
  type SubscriptionOrderRow,
} from '../revenue';
import { listAdminUserIds } from '../users';
import { ensureWallet, findWallet, findWalletFor, move } from '../wallets';
import type { FetchedPayment, GatewayAdapter, WebhookEvent, WebhookRequest } from './gateways/gateway';
import { GATEWAY_NAMES, adapterFor } from './gateways/registry';
import { checkoutUrlFor, returnUrlFor } from './checkout-page.service';
import { consumeCheckoutToken, mintCheckoutToken } from './checkout-tokens';
import type { PaymentListFilter, PaymentRefundRow, PaymentRow, PaymentView } from './payments.repository';
import { prismaPaymentsRepository as repository } from './prisma-payments.repository';
import { getIntegrationsConfig } from '../../shared/integrations';
import { advertiserOf, payerOf, type Payer } from './payer';
import { promotionPayments } from './promotion-payments.port';

/**
 * Payments — the gateway (Lot C, Q110/Q118/Q12; Lot J-B2 for publishers).
 *
 * One Payment row per attempt to pay through a gateway, for a campaign, a
 * package sale or — Lot J (B2) — a publisher's plan order. The money never
 * goes straight to the target: on capture it is a gateway TOPUP into the
 * payer's wallet (wallet + / platform:cash −; `advertisers.recordGatewayTopUp`
 * for an advertiser, the same legs through `wallets.move` for a publisher)
 * and the target is then settled out of that balance by the same call the
 * wallet path makes — `campaigns.authorizeCampaignById`,
 * `advertisers.payForPackage` + `packages.markPaid`, or the publisher
 * wallet's own subscription debit + `revenue.markSubscriptionOrderPaid`.
 * Every rail therefore tells the ledger one story, and a capture whose
 * target can no longer be applied leaves the payer with spendable balance
 * rather than money in limbo (Q118).
 *
 * Idempotent at every step: the top-up is keyed on the gateway's payment
 * id, the authorise on the campaign's hold, the sale on its id, the order's
 * debit on the order, the webhook on (gateway, event id). A gateway may
 * retry as often as it likes.
 */

export type PaymentActor = {
  userId: string;
  isAdmin: boolean;
  advertiserId: string | null;
  /** Lot J (B2): the publisher behind the session, for a plan order's payment. */
  publisherId: string | null;
  agentId: string | null;
};

/** The publisher wallet's label, as `revenue`'s wallet path opens it. */
const PUBLISHER_WALLET_LABEL = 'Publisher wallet';
/** The flag `revenue` puts on the plan routes; an order cannot be paid by gateway while it is off. */
const PUBLISHER_PLANS_FEATURE = 'revenue.publisher-plans';

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

export type PaymentRefundView = {
  id: string;
  amount: Money;
  status: PaymentRefundRow['status'];
  gatewayRefundId: string | null;
  reason: string;
  refundRequestId: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

/** BT-1: what the payer told us about their transfer, on a BANK_TRANSFER payment. */
export type BankTransferClaim = { utr: string | null; paidOn: string | null; claimedAmount: Money | null; proofFileId: string | null; claimedAt: string | null };

export type PaymentSummary = Omit<PaymentView, 'amount' | 'refunds' | 'bankClaimedAmount' | 'bankPaidOn'> & {
  amount: Money;
  /** What is still on the payment after the refunds that stand. */
  refundable: Money;
  refunds: PaymentRefundView[];
  /** BT-1: null on a gateway payment. */
  bankTransfer: BankTransferClaim | null;
};

const refundedSoFar = (refunds: Pick<PaymentRefundRow, 'amount' | 'status'>[]): Decimal =>
  refunds.filter((refund) => refund.status !== 'FAILED').reduce((sum, refund) => sum.plus(new Decimal(refund.amount)), new Decimal(0));

/** One refund as the Payment view lists it — money as a string; T-B: the refund route's `refund` is the same view. */
export function toRefundView(refund: PaymentRefundRow): PaymentRefundView {
  return {
    id: refund.id,
    amount: money(refund.amount),
    status: refund.status,
    gatewayRefundId: refund.gatewayRefundId,
    reason: refund.reason,
    refundRequestId: refund.refundRequestId,
    createdAt: refund.createdAt,
    processedAt: refund.processedAt,
  };
}

export function toPaymentView(payment: PaymentView): PaymentSummary {
  const { amount, refunds, bankClaimedAmount, bankPaidOn, ...rest } = payment;
  return {
    ...rest,
    amount: money(amount),
    refundable: money(new Decimal(amount).minus(refundedSoFar(refunds))),
    refunds: refunds.map(toRefundView),
    bankTransfer:
      payment.gateway === 'BANK_TRANSFER'
        ? {
            utr: payment.bankUtr ?? null,
            paidOn: bankPaidOn ? bankPaidOn.toISOString().slice(0, 10) : null,
            claimedAmount: bankClaimedAmount ? money(bankClaimedAmount) : null,
            proofFileId: payment.bankProofFileId ?? null,
            claimedAt: payment.bankClaimedAt ? payment.bankClaimedAt.toISOString() : null,
          }
        : null,
  };
}

/* ------------------------------------------------------------------ */
/* BT-1: bank transfer                                                 */
/* ------------------------------------------------------------------ */

export type BankTransferDetails = { beneficiary: string; accountNumber: string; ifsc: string; bank: string | null; branch: string | null; instructions: string | null };

const BANK_TRANSFER_FIELDS = ['beneficiary', 'accountNumber', 'ifsc'] as const;

/** ADX's receiving account as Settings › Integrations holds it, or the fields still empty. */
export async function bankTransferDetails(): Promise<{ configured: true; details: BankTransferDetails } | { configured: false; missing: string[] }> {
  const cfg = (await getIntegrationsConfig()).bankTransfer ?? {};
  const missing = BANK_TRANSFER_FIELDS.filter((field) => !cfg[field]);
  if (missing.length > 0) return { configured: false, missing };
  return {
    configured: true,
    details: {
      beneficiary: cfg.beneficiary!,
      accountNumber: cfg.accountNumber!,
      ifsc: cfg.ifsc!,
      bank: cfg.bank ?? null,
      branch: cfg.branch ?? null,
      instructions: cfg.instructions ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Gateways                                                            */
/* ------------------------------------------------------------------ */

export type GatewayStatus = { gateway: PaymentGateway; configured: boolean; testMode: boolean; missing?: string[] };

/** Which gateways the app may offer. The empty field names are for the console only. */
export async function listGateways(forAdmin: boolean): Promise<GatewayStatus[]> {
  const gateways = await Promise.all(
    GATEWAY_NAMES.map(async (gateway): Promise<GatewayStatus> => {
      const readiness = await adapterFor(gateway).readiness();
      return {
        gateway,
        configured: readiness.configured,
        testMode: readiness.testMode,
        ...(forAdmin ? { missing: readiness.missing } : {}),
      };
    }),
  );
  // BT-1: bank transfer is offered once the receiving account is on file.
  const bank = await bankTransferDetails();
  gateways.push({ gateway: 'BANK_TRANSFER', configured: bank.configured, testMode: false, ...(forAdmin && !bank.configured ? { missing: bank.missing } : {}) });
  return gateways;
}

async function configuredAdapter(gateway: PaymentGateway): Promise<GatewayAdapter> {
  const adapter = adapterFor(gateway);
  const readiness = await adapter.readiness();
  if (!readiness.configured) {
    throw new ApiError(409, 'GATEWAY_NOT_CONFIGURED', `${gateway} is not configured yet. Ask ADX to set it up under Settings › Integrations.`, {
      gateway,
      missing: readiness.missing,
    });
  }
  return adapter;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** The owner (advertiser or publisher), the person who raised it (their agent), or an admin. */
function assertMayRead(payment: Pick<PaymentRow, 'advertiserId' | 'publisherId' | 'createdByUserId'>, actor: PaymentActor): void {
  if (actor.isAdmin) return;
  if (actor.advertiserId && payment.advertiserId === actor.advertiserId) return;
  if (actor.publisherId && payment.publisherId === actor.publisherId) return;
  if (payment.createdByUserId && payment.createdByUserId === actor.userId) return;
  throw new ApiError(403, 'FORBIDDEN', 'This payment belongs to someone else.');
}

export async function getPayment(paymentId: string, actor: PaymentActor): Promise<PaymentView> {
  const payment = await repository.findPayment(paymentId);
  if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
  assertMayRead(payment, actor);
  return payment;
}

export async function listPaymentsPage(filter: PaymentListFilter): Promise<ListPage<PaymentSummary>> {
  const { items, total, counts } = await repository.listPaymentsPage(filter);
  return toListPage(items.map(toPaymentView), total, counts, filter);
}

/* ------------------------------------------------------------------ */
/* Intents                                                             */
/* ------------------------------------------------------------------ */

/** PAY-2026-000482 — the schema's own example, minted with a retry on collision. */
async function nextReference(now: Date): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const reference = `PAY-${now.getFullYear()}-${String(randomInt(1, 999_999)).padStart(6, '0')}`;
    if (!(await repository.referenceExists(reference))) return reference;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a payment reference');
}

/**
 * The gates a booking passes, funds excepted — the payment is how the funds
 * arrive. Asked before the gateway order exists, so nobody pays for a
 * campaign that could not then be authorised.
 */
async function assertMayPayByGateway(advertiserId: string): Promise<void> {
  const { blockedBy } = await bookingEligibility(advertiserId);
  if (blockedBy.includes('SUSPENDED')) throw new ApiError(409, 'ADVERTISER_SUSPENDED', 'This advertiser account is suspended and cannot pay');
  if (blockedBy.includes('PROFILE')) throw new ApiError(409, 'CONFLICT', 'Complete the advertiser profile before paying');
  if (blockedBy.includes('KYC')) throw new ApiError(403, 'KYC_REQUIRED', 'KYC must be verified before paying');
  if (blockedBy.includes('AGREEMENT')) {
    throw new ApiError(403, 'PLATFORM_AGREEMENT_REQUIRED', 'Accept the current advertiser platform agreement before paying');
  }
}

/** What an intent is for. RF-1: `purpose` picks the reservation fee on a campaign over its full amount. */
type IntentInput = {
  campaignId?: string | null;
  packageSaleId?: string | null;
  subscriptionOrderId?: string | null;
  /** LM-1: a display ad or a sponsored listing. */
  adBookingId?: string | null;
  listingBoostId?: string | null;
  gateway: PaymentGateway;
  purpose?: 'SETTLEMENT' | 'RESERVATION_FEE' | undefined;
  /** UP-1: the payer's UPI id, handed to the gateway. */
  upiId?: string | undefined;
};

type PaymentTarget = {
  kind: 'CAMPAIGN' | 'PACKAGE_SALE' | 'SUBSCRIPTION_ORDER' | 'AD_BOOKING' | 'LISTING_BOOST';
  id: string;
  reference: string;
  /** Who pays — the advertiser for a campaign or a sale, the publisher for a plan order. */
  payer: Payer;
  amount: Money;
  description: string;
};

/** LM-1: the Payment column each target is written to — and the key the audit row names it by. */
const TARGET_COLUMN = {
  CAMPAIGN: 'campaignId',
  PACKAGE_SALE: 'packageSaleId',
  SUBSCRIPTION_ORDER: 'subscriptionOrderId',
  AD_BOOKING: 'adBookingId',
  LISTING_BOOST: 'listingBoostId',
} as const satisfies Record<PaymentTarget['kind'], string>;

/** The five target columns of a new Payment, exactly one of them set. */
const targetColumns = (target: Pick<PaymentTarget, 'kind' | 'id'>) => ({
  campaignId: target.kind === 'CAMPAIGN' ? target.id : null,
  packageSaleId: target.kind === 'PACKAGE_SALE' ? target.id : null,
  subscriptionOrderId: target.kind === 'SUBSCRIPTION_ORDER' ? target.id : null,
  adBookingId: target.kind === 'AD_BOOKING' ? target.id : null,
  listingBoostId: target.kind === 'LISTING_BOOST' ? target.id : null,
});

/** Lot J (B2): the line a plan order is paid under — on the gateway order, the checkout page and the wallet note. */
export const subscriptionOrderLine = (order: Pick<SubscriptionOrderRow, 'planName' | 'reference'>): string => `${order.planName} plan — ${order.reference}`;

/**
 * Lot J2 (7): a subscription is paid on the gateways its audience's policy
 * lists (`settings.subscriptions.<audience>.payment.gatewaysAllowed`); an
 * empty list closes the gateway path. Campaign payments are untouched.
 */
async function assertGatewayOffered(audience: SubscriptionAudience, gateway: PaymentGateway): Promise<void> {
  const policy = await getSubscriptionPolicy(audience);
  if ((policy.payment.gatewaysAllowed as readonly string[]).includes(gateway)) return;
  throw new ApiError(
    400,
    'PAYMENT_METHOD_NOT_OFFERED',
    policy.payment.gatewaysAllowed.length === 0
      ? `Paying through a gateway is not offered for ${audience} subscriptions.${policy.payment.walletAllowed ? ' Pay from your ADX wallet instead.' : ''}`
      : `${gateway} is not offered for ${audience} subscriptions. Choose ${policy.payment.gatewaysAllowed.join(' or ')}.`,
    { gateway, gatewaysAllowed: policy.payment.gatewaysAllowed, walletAllowed: policy.payment.walletAllowed },
  );
}

async function resolveTarget(
  input: IntentInput,
  actor: PaymentActor,
): Promise<PaymentTarget> {
  if (input.campaignId && input.purpose === 'RESERVATION_FEE') {
    // RF-1: the fee that holds the spots, not the booking.
    const quote = await reservationFeePaymentQuote(input.campaignId, actor);
    return {
      kind: 'CAMPAIGN',
      id: quote.campaignId,
      reference: quote.reference,
      payer: { kind: 'ADVERTISER', id: quote.advertiserId },
      amount: quote.amount,
      description: `Reservation fee — campaign ${quote.reference}, ${quote.name}`,
    };
  }
  if (input.campaignId) {
    const quote = await campaignPaymentQuote(input.campaignId, actor);
    return {
      kind: 'CAMPAIGN',
      id: quote.campaignId,
      reference: quote.reference,
      payer: { kind: 'ADVERTISER', id: quote.advertiserId },
      amount: quote.total,
      description: `Campaign ${quote.reference} — ${quote.name}`,
    };
  }
  if (input.adBookingId || input.listingBoostId) {
    // LM-1: a paid placement — `promotions` guards it (whose it is, that it
    // waits for payment, the switch) and prices it.
    const placement = input.adBookingId ? await promotionPayments().adTarget(input.adBookingId, actor) : await promotionPayments().boostTarget(input.listingBoostId!, actor);
    return {
      kind: input.adBookingId ? 'AD_BOOKING' : 'LISTING_BOOST',
      id: placement.id,
      reference: placement.reference,
      payer: placement.payer,
      amount: placement.amount,
      description: placement.description,
    };
  }
  if (input.subscriptionOrderId) {
    // Lot J (B2): the publisher's plan order. Its own guards from `revenue`:
    // only the order's publisher pays it (an admin records an offline payment
    // there instead), and only while it is waiting for payment.
    if (!(await isFeatureEnabled(PUBLISHER_PLANS_FEATURE, actor.userId))) {
      throw new ApiError(503, 'FEATURE_OFF', 'This feature is switched off', { key: PUBLISHER_PLANS_FEATURE });
    }
    const order = await findSubscriptionOrder(input.subscriptionOrderId);
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'Subscription order not found');
    assertMayPaySubscriptionOrder(order, { userId: actor.userId, isAdmin: actor.isAdmin, publisherId: actor.publisherId });
    assertSubscriptionOrderPayable(order);
    await assertGatewayOffered('publisher', input.gateway);
    return {
      kind: 'SUBSCRIPTION_ORDER',
      id: order.id,
      reference: order.reference,
      payer: { kind: 'PUBLISHER', id: order.publisherId },
      amount: money(order.total),
      description: subscriptionOrderLine(order),
    };
  }
  const sale = await findSale(input.packageSaleId!);
  if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Sale not found');
  assertMayActOnSale(sale, actor);
  assertPayable(sale);
  await assertGatewayOffered('advertiser', input.gateway);
  // Lot D (Q123): the terms, on the version live now, before any money.
  await assertSaleTermsAccepted(sale.id);
  return {
    kind: 'PACKAGE_SALE',
    id: sale.id,
    reference: sale.reference,
    payer: { kind: 'ADVERTISER', id: sale.advertiserId },
    amount: money(sale.total),
    description: `${sale.packageName} plan — ${sale.reference}`,
  };
}

/** The customer the gateway order names: the advertiser's company, or the publisher. */
async function customerFor(payer: Payer): Promise<{ id: string; name: string; email: string | null; mobile: string | null }> {
  if (payer.kind === 'ADVERTISER') {
    const advertiser = await getAdvertiser(payer.id);
    return { id: advertiser.id, name: advertiser.companyName ?? advertiser.name, email: advertiser.email ?? null, mobile: advertiser.mobile ?? null };
  }
  const publisher = await findPublisherContact(payer.id);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  return { id: publisher.id, name: publisher.name, email: publisher.email, mobile: publisher.mobile };
}

const apiBase = (): string => env.BASE_URL ?? `http://localhost:${env.PORT}`;

export type PaymentIntent = {
  payment: PaymentSummary;
  checkout: Record<string, unknown>;
  /** BT-1: on a bank-transfer intent, the account to pay into and the reference to quote. */
  bankTransfer?: BankTransferDetails & { reference: string; amount: Money };
  /**
   * E7-2, Razorpay only: the page the app opens in the system browser —
   * `GET /payments/:id/checkout?t=` under a one-time, twenty-minute token.
   * Null for the redirect-flow gateways, whose `checkout` says where to go.
   */
  checkoutUrl: string | null;
};

/**
 * Opens the gateway order and records the Payment CREATED.
 *
 * The full total is collected, even when the wallet already holds some
 * balance: the capture is a top-up, and whatever the target does not need
 * stays spendable. Simpler for the advertiser to read than a shortfall,
 * and impossible to double-charge on a retry, since the target is settled
 * by the idempotent calls the wallet path makes.
 */
export async function createIntent(
  input: IntentInput,
  actor: PaymentActor,
  now = new Date(),
): Promise<PaymentIntent> {
  const targets = [input.campaignId, input.packageSaleId, input.subscriptionOrderId, input.adBookingId, input.listingBoostId].filter(Boolean).length;
  if (targets !== 1) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Say what is being paid for: a campaignId, a packageSaleId, a subscriptionOrderId, an adBookingId or a listingBoostId — exactly one of them.',
    );
  }
  if (input.gateway === 'BANK_TRANSFER') return createBankTransferIntent(input, actor, now);
  const adapter = await configuredAdapter(input.gateway);
  const target = await resolveTarget(input, actor);
  // AGE-1: every intent is an order — the payer's account holder, 18 or over.
  await assertPartyAdultForOrders(target.payer, { actorUserId: actor.userId });
  // The advertiser's booking gates are the advertiser's; a publisher's order
  // carries its own (Lot J-B2: the order's publisher, PENDING_PAYMENT).
  if (target.payer.kind === 'ADVERTISER') await assertMayPayByGateway(target.payer.id);
  const customer = await customerFor(target.payer);

  const created = await repository.createPayment({
    reference: await nextReference(now),
    advertiserId: target.payer.kind === 'ADVERTISER' ? target.payer.id : null,
    publisherId: target.payer.kind === 'PUBLISHER' ? target.payer.id : null,
    ...targetColumns(target),
    gateway: input.gateway,
    purpose: input.purpose ?? 'SETTLEMENT',
    payerUpiId: input.upiId ?? null,
    amount: new Decimal(target.amount),
    currency: 'INR',
    createdByUserId: actor.userId,
  });

  let order;
  try {
    order = await adapter.createOrder({
      paymentId: created.id,
      reference: created.reference,
      amount: target.amount,
      currency: 'INR',
      customer,
      description: target.description,
      // E7-2: the API's own status page — the old FRONTEND_URL page was never
      // served. E9: under the intent's one-time return token, so the page may
      // print the reference and the amount to the browser that paid.
      returnUrl: returnUrlFor(created.id, await mintCheckoutToken('return', created.id)),
      notifyUrl: `${apiBase()}/api/v1/webhooks/${input.gateway.toLowerCase()}`,
      // UP-1: the UPI id, when the payer typed one.
      ...(input.upiId ? { upiId: input.upiId } : {}),
    });
  } catch (err) {
    await repository.updatePayment(created.id, {
      status: 'FAILED',
      failureReason: err instanceof Error ? err.message : 'The gateway refused the order',
    });
    throw err;
  }

  await repository.updatePayment(created.id, { gatewayOrderId: order.gatewayOrderId });
  await logActivity(actor.userId, 'PAYMENT_INTENT_CREATED', {
    module: 'payments',
    targetType: 'Payment',
    targetId: created.id,
    metadata: {
      reference: created.reference,
      gateway: input.gateway,
      amount: target.amount,
      [target.payer.kind === 'ADVERTISER' ? 'advertiserId' : 'publisherId']: target.payer.id,
      [TARGET_COLUMN[target.kind]]: target.id,
      gatewayOrderId: order.gatewayOrderId,
    },
  });

  const payment = (await repository.findPayment(created.id)) ?? { ...created, gatewayOrderId: order.gatewayOrderId, refunds: [] };
  // E7-2: the phones open Razorpay in the system browser, so the intent
  // carries the page's URL with its one-time door in it.
  const checkoutUrl = input.gateway === 'RAZORPAY' ? checkoutUrlFor(created.id, await mintCheckoutToken('checkout', created.id)) : null;
  return { payment: toPaymentView(payment), checkout: checkoutUrl ? { ...order.checkout, checkoutUrl } : order.checkout, checkoutUrl };
}

/**
 * E7-2: the checkout page has no bearer — it confirms under the one-time
 * token the page was served with. Spent here, once; the actor is then the
 * payment's own advertiser, so `assertMayRead` and the audit row read as
 * the person who raised the intent. 401 for a token that is spent, expired
 * or minted for another payment.
 */
export async function actorFromCheckoutToken(paymentId: string, token: string): Promise<PaymentActor> {
  if (!(await consumeCheckoutToken('confirm', paymentId, token))) {
    throw new ApiError(401, 'CHECKOUT_TOKEN_INVALID', 'This payment page has expired. Return to the ADX app and tap Pay again.');
  }
  const payment = await repository.findPayment(paymentId);
  if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
  // The intent's author, failing that the first admin — the arrangement
  // `auditActor` makes for a webhook, and for the same reason: the row
  // needs a real user behind it.
  const userId = payment.createdByUserId ?? (await listAdminUserIds())[0];
  if (!userId) throw new ApiError(500, 'INTERNAL_ERROR', 'No user to confirm this payment as');
  return { userId, isAdmin: false, advertiserId: payment.advertiserId, publisherId: payment.publisherId, agentId: null };
}

/* ------------------------------------------------------------------ */
/* Capture and settlement                                              */
/* ------------------------------------------------------------------ */

/** E9: `relatedType` CAMPAIGN when the payment is a campaign's; a package sale or the payment itself has no type a push can open. */
async function notifyAdvertiser(
  advertiserId: string,
  notification: { title: string; message: string; relatedId: string; relatedType?: RelatedType; suggestedAction?: string },
): Promise<void> {
  try {
    const advertiser = await getAdvertiser(advertiserId);
    if (!advertiser.userId) return;
    await createNotification({ userId: advertiser.userId, type: 'BOOKING', ...notification });
  } catch (err) {
    logger.warn('Could not notify the advertiser about a payment', { advertiserId, err });
  }
}

/**
 * Lot J (B2): the payer hears — the advertiser through their record, the
 * publisher through the login on theirs. A publisher's notice is SYSTEM:
 * BOOKING is the advertiser's vocabulary, and a plan order is no order a
 * push can open.
 */
async function notifyPayer(
  payment: Pick<PaymentRow, 'advertiserId' | 'publisherId' | 'reference'>,
  notification: { title: string; message: string; relatedId: string; relatedType?: RelatedType; suggestedAction?: string },
): Promise<void> {
  const payer = payerOf(payment);
  if (payer.kind === 'ADVERTISER') {
    await notifyAdvertiser(payer.id, notification);
    return;
  }
  try {
    const publisher = await findPublisherContact(payer.id);
    if (!publisher?.userId) return;
    await createNotification({ userId: publisher.userId, type: 'SYSTEM', ...notification });
  } catch (err) {
    logger.warn('Could not notify the publisher about a payment', { publisherId: payer.id, err });
  }
}

async function notifyOps(title: string, message: string, relatedId: string): Promise<void> {
  try {
    const adminIds = await listAdminUserIds();
    await Promise.all(adminIds.map((userId) => createNotification({ userId, type: 'SYSTEM', title, message, relatedId })));
  } catch (err) {
    logger.warn('Could not notify ops about a payment', { relatedId, err });
  }
}

/**
 * Whose row an audit entry goes under when a webhook, not a person, did it.
 * `ActivityLog.userId` is a real user: the person who raised the intent,
 * failing that the first admin — the arrangement the KYC probe job uses —
 * with `metadata.by` saying it was the gateway.
 */
async function auditActor(payment: Pick<PaymentRow, 'createdByUserId'>, byUserId: string | null): Promise<{ userId: string; by: 'user' | 'webhook' } | null> {
  if (byUserId) return { userId: byUserId, by: 'user' };
  if (payment.createdByUserId) return { userId: payment.createdByUserId, by: 'webhook' };
  const [admin] = await listAdminUserIds();
  return admin ? { userId: admin, by: 'webhook' } : null;
}

const isAlreadySettled = (err: unknown): boolean =>
  err instanceof ApiError && err.statusCode === 409 && /already (been )?authori[sz]ed|already paid|not waiting for payment/i.test(err.message);

/**
 * Lot J (B2): the plan order, paid out of the publisher wallet the capture
 * just credited — the wallet path's own debit (wallet − / platform:revenue
 * +, PACKAGE_DEBIT under PACKAGE_SPEND, keyed on the order so this and
 * `POST /revenue/subscription-orders/:id/pay` can never both charge it,
 * `requireFunds` inside the movement) and then `revenue`'s activation, by
 * GATEWAY under the payment's reference. An order already PAID — the
 * publisher paid from the wallet while the gateway page was open, or this
 * is a retry — is settled.
 */
async function settleSubscriptionOrder(payment: PaymentView, byUserId: string | null, now: Date): Promise<void> {
  const order = await findSubscriptionOrder(payment.subscriptionOrderId!);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Subscription order not found');
  if (order.status === 'PAID') return;
  assertSubscriptionOrderPayable(order);
  // Lot J2 (b): the term rule before the debit — an order that cannot
  // activate (409 ALREADY_ON_PLAN) leaves the credit spendable in the wallet
  // rather than moved to platform:revenue for a plan that never started.
  await assertSubscriptionOrderActivatable(order, now);
  const wallet = await ensureWallet({ kind: 'PUBLISHER', id: order.publisherId }, PUBLISHER_WALLET_LABEL);
  const total = new Decimal(order.total);
  await move({
    walletId: wallet.id,
    walletLabel: PUBLISHER_WALLET_LABEL,
    amount: money(total.negated()),
    entryType: 'PACKAGE_DEBIT',
    ledgerKind: 'PACKAGE_SPEND',
    idempotencyKey: `subscription-debit:${order.id}`,
    requireFunds: true,
    counterLegs: [{ accountCode: 'platform:revenue', amount: money(total), note: 'Publisher subscription' }],
    reference: order.id,
    note: `${order.planName} plan, ${order.reference} (${payment.reference})`,
    createdByUserId: byUserId ?? payment.createdByUserId ?? null,
    occurredAt: now,
  });
  await markSubscriptionOrderPaid(order.id, { method: 'GATEWAY', reference: payment.reference }, now);
}

const targetFailure = (payment: Pick<PaymentView, 'campaignId' | 'subscriptionOrderId' | 'adBookingId' | 'listingBoostId'>): string =>
  payment.campaignId
    ? 'the campaign could not be authorised'
    : payment.subscriptionOrderId
      ? 'the order could not be activated'
      : payment.adBookingId
        ? 'the ad booking could not be paid'
        : payment.listingBoostId
          ? 'the sponsored listing could not be paid'
          : 'the sale could not be activated';

/**
 * Applies a captured payment to what it was for, out of the wallet balance
 * the capture just credited. Idempotent: a campaign already authorised, a
 * sale already active or an order already paid reads as settled. Any other
 * refusal is reported to ops and left — the payer keeps the balance (Q118).
 */
async function settleTarget(payment: PaymentView, byUserId: string | null, now: Date): Promise<'SETTLED' | 'NOT_APPLIED'> {
  try {
    if (payment.campaignId && payment.purpose === 'RESERVATION_FEE') {
      // RF-1: the fee, out of the balance the capture just credited.
      await settleReservationFeeById(payment.campaignId, payment.id, now);
    } else if (payment.campaignId) {
      await authorizeCampaignById(payment.campaignId, now);
    } else if (payment.subscriptionOrderId) {
      await settleSubscriptionOrder(payment, byUserId, now);
    } else if (payment.adBookingId || payment.listingBoostId) {
      // LM-1: the placement's own debit out of the balance the capture
      // credited (keyed on the booking, so the wallet route and this are one
      // charge), and — for an ad — its invoice, stamped with this payment.
      const settled = payment.adBookingId
        ? await promotionPayments().settleAd(payment.adBookingId, { id: payment.id, reference: payment.reference }, byUserId, now)
        : await promotionPayments().settleBoost(payment.listingBoostId!, { id: payment.id, reference: payment.reference }, byUserId, now);
      if (settled.invoiceId && payment.invoiceId !== settled.invoiceId) await repository.updatePayment(payment.id, { invoiceId: settled.invoiceId });
      return 'SETTLED';
    } else if (payment.packageSaleId) {
      const sale = await findSale(payment.packageSaleId);
      if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Sale not found');
      if (sale.status !== 'ACTIVE') {
        assertPayable(sale);
        await assertSaleTermsAccepted(sale.id);
        await payForPackage(sale.advertiserId, sale.id, money(sale.total), `${sale.packageName} plan — ${sale.reference} (${payment.reference})`);
        await markSalePaid(sale.id, { method: 'GATEWAY', reference: payment.reference }, now);
      }
    }
  } catch (err) {
    if (isAlreadySettled(err)) return 'SETTLED';
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('Payment captured but the target could not be settled', { paymentId: payment.id, reason });
    await notifyOps(
      'Payment captured but not applied',
      `${payment.reference} (${money(payment.amount)}) was captured and credited to the ${payment.publisherId ? "publisher's" : "advertiser's"} wallet, but ${targetFailure(payment)}: ${reason}. The balance is spendable; apply it by hand.`,
      payment.id,
    );
    return 'NOT_APPLIED';
  }

  // Lot J (B2): no paper for a plan order — `invoices` issues for campaigns
  // and package sales and its Invoice names an advertiser; a publisher's
  // receipt is a later lot (revenue README, "Not here").
  if (payment.subscriptionOrderId) return 'SETTLED';
  // RF-1: no paper for a reservation fee — the invoice comes with the booking it is folded into.
  if (payment.purpose === 'RESERVATION_FEE') return 'SETTLED';

  // Lot B (Q13): the paper. The invoice the authorise or the sale issued
  // carries the payment that settled it.
  try {
    const invoice = await liveInvoiceFor({ campaignId: payment.campaignId, packageSaleId: payment.packageSaleId });
    if (invoice) {
      await markInvoicePaid(invoice.id, { paymentId: payment.id });
      if (payment.invoiceId !== invoice.id) await repository.updatePayment(payment.id, { invoiceId: invoice.id });
    }
  } catch (err) {
    logger.warn('Payment settled but the invoice could not be stamped', { paymentId: payment.id, err });
  }
  return 'SETTLED';
}

/**
 * The capture, as one act: the wallet credited by a gateway TOPUP keyed on
 * the gateway's payment id, the Payment marked CAPTURED with the top-up
 * behind it, then the target settled out of the balance. Re-run on a retry,
 * every step answers what it already did.
 */
async function settleCapture(
  payment: PaymentView,
  capture: Pick<FetchedPayment, 'gatewayPaymentId' | 'amount' | 'method'>,
  byUserId: string | null,
  now: Date,
): Promise<PaymentView> {
  const expected = money(payment.amount);
  const mismatch = money(capture.amount) !== expected;
  // Lot J2 (c): the payer hears once — on the CREATED/AUTHORISED → CAPTURED
  // transition. A replayed webhook after settlement re-checks the target and
  // says nothing.
  const transition = payment.status !== 'CAPTURED';

  const credit = await creditPayerWallet(payment, capture, byUserId, now);

  if (transition) {
    await repository.updatePayment(payment.id, {
      status: 'CAPTURED',
      capturedAt: now,
      gatewayPaymentId: capture.gatewayPaymentId,
      method: capture.method,
      topUpId: credit.topUpId,
      walletEntryId: credit.walletEntryId,
      ledgerTransactionId: credit.ledgerTransactionId,
      failureReason: mismatch ? `Gateway captured ${money(capture.amount)} against ${expected}; credited to the wallet, not applied` : null,
    });
    const actor = await auditActor(payment, byUserId);
    if (actor) {
      await logActivity(actor.userId, 'PAYMENT_CAPTURED', {
        module: 'payments',
        targetType: 'Payment',
        targetId: payment.id,
        diff: auditDiff({ status: payment.status, gatewayPaymentId: payment.gatewayPaymentId }, { status: 'CAPTURED', gatewayPaymentId: capture.gatewayPaymentId }),
        metadata: { by: actor.by, reference: payment.reference, gateway: payment.gateway, amount: money(capture.amount), method: capture.method, topUpId: credit.topUpId, mismatch },
      });
    }
  }

  const refreshed = (await repository.findPayment(payment.id)) ?? { ...payment, status: 'CAPTURED' as const, gatewayPaymentId: capture.gatewayPaymentId };

  if (mismatch) {
    await notifyOps(
      'Payment amount differs from the intent',
      `${payment.reference}: the gateway captured ${money(capture.amount)} against ${expected}. The wallet was credited with what arrived; nothing was applied.`,
      payment.id,
    );
    return refreshed;
  }

  const outcome = await settleTarget(refreshed, byUserId, now);
  if (outcome === 'SETTLED' && transition) {
    await notifyPayer(payment, {
      title: 'Payment received',
      message: `${money(capture.amount)} received against ${payment.reference}. ${
        payment.campaignId
          ? payment.purpose === 'RESERVATION_FEE'
            ? 'Your spots are reserved.'
            : 'Your campaign is booked.'
          : payment.subscriptionOrderId
            ? 'Your subscription is paid for.'
            : payment.adBookingId
              ? 'Your ad is paid for and waits for ADX to review it.'
              : payment.listingBoostId
                ? 'Your sponsored listing is booked.'
                : 'Your plan is active.'
      }`,
      relatedId: payment.campaignId ?? payment.packageSaleId ?? payment.subscriptionOrderId ?? payment.adBookingId ?? payment.listingBoostId ?? payment.id,
      relatedType: payment.campaignId ? 'CAMPAIGN' : undefined,
    });
  }
  return (await repository.findPayment(payment.id)) ?? refreshed;
}

type WalletCredit = { topUpId: string | null; walletEntryId: string | null; ledgerTransactionId: string | null };

/**
 * The capture's credit, into whichever wallet the payer owns. An advertiser's
 * goes through `advertisers.recordGatewayTopUp`, which also writes their
 * TopUp row for the reconciliation desk. A publisher's (Lot J-B2) is the same
 * movement through the `wallets` port — TOPUP, wallet + / platform:cash −,
 * keyed `topup:gateway:<gateway payment id>` with the gateway's payment as
 * the reference, so a replayed webhook is one credit; publishers have no
 * TopUp table, so `topUpId` stays null and the entry and transaction ids
 * carry the trail.
 */
async function creditPayerWallet(
  payment: PaymentView,
  capture: Pick<FetchedPayment, 'gatewayPaymentId' | 'amount'>,
  byUserId: string | null,
  now: Date,
): Promise<WalletCredit> {
  const payer = payerOf(payment);
  const recordedBy = byUserId ?? payment.createdByUserId ?? null;
  if (payer.kind === 'ADVERTISER') {
    const { topUp } = await recordGatewayTopUp(
      payer.id,
      { amount: money(capture.amount), paymentId: capture.gatewayPaymentId, receivedAt: now, note: `${payment.gateway} ${payment.reference}` },
      recordedBy ?? 'system',
    );
    return { topUpId: topUp.id, walletEntryId: topUp.walletEntryId ?? null, ledgerTransactionId: topUp.ledgerTransactionId ?? null };
  }
  const wallet = await ensureWallet({ kind: 'PUBLISHER', id: payer.id }, PUBLISHER_WALLET_LABEL);
  const result = await move({
    walletId: wallet.id,
    walletLabel: PUBLISHER_WALLET_LABEL,
    amount: money(capture.amount),
    entryType: 'TOPUP',
    ledgerKind: 'TOPUP',
    idempotencyKey: `topup:gateway:${capture.gatewayPaymentId}`,
    counterLegs: [{ accountCode: 'platform:cash', amount: money(new Decimal(capture.amount).negated()), note: 'Gateway settlement' }],
    reference: capture.gatewayPaymentId,
    note: `${payment.gateway} ${payment.reference}`,
    createdByUserId: recordedBy,
    occurredAt: now,
  });
  return { topUpId: null, walletEntryId: result.entry?.id ?? null, ledgerTransactionId: result.ledgerTransactionId ?? null };
}

async function markFailed(payment: PaymentView, failure: { gatewayPaymentId: string | null; failureReason: string | null; method: string | null }, byUserId: string | null): Promise<PaymentView> {
  if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED' || payment.status === 'PARTIALLY_REFUNDED') return payment;
  const reason = failure.failureReason ?? 'The gateway reported the payment failed';
  await repository.updatePayment(payment.id, {
    status: 'FAILED',
    failureReason: reason,
    ...(failure.gatewayPaymentId ? { gatewayPaymentId: failure.gatewayPaymentId } : {}),
    ...(failure.method ? { method: failure.method } : {}),
  });
  const actor = await auditActor(payment, byUserId);
  if (actor) {
    await logActivity(actor.userId, 'PAYMENT_FAILED', {
      module: 'payments',
      targetType: 'Payment',
      targetId: payment.id,
      diff: auditDiff({ status: payment.status }, { status: 'FAILED' }),
      metadata: { by: actor.by, reference: payment.reference, gateway: payment.gateway, reason },
    });
  }
  await notifyPayer(payment, {
    title: 'Payment failed',
    message: `${payment.reference}: ${reason}. Nothing was charged; try again or choose another way to pay.`,
    relatedId: payment.campaignId ?? payment.packageSaleId ?? payment.subscriptionOrderId ?? payment.adBookingId ?? payment.listingBoostId ?? payment.id,
    relatedType: payment.campaignId ? 'CAMPAIGN' : undefined,
    suggestedAction: 'Try again',
  });
  return (await repository.findPayment(payment.id)) ?? { ...payment, status: 'FAILED', failureReason: reason };
}

/**
 * The client-side confirmation: Razorpay's checkout hands the app a payment
 * id and a signature, the app posts them here. The signature is checked,
 * the payment read back from the gateway — never trusted from the client —
 * captured where the account authorises first, and settled.
 */
export async function confirmPayment(
  paymentId: string,
  input: { gatewayPaymentId: string; signature: string; gatewayOrderId?: string | null },
  actor: PaymentActor,
  now = new Date(),
): Promise<PaymentView> {
  const payment = await getPayment(paymentId, actor);
  // The checkout page posts the order id Razorpay handed back; one naming
  // another order is a confirmation for some other payment, whatever it signs.
  if (input.gatewayOrderId && payment.gatewayOrderId && input.gatewayOrderId !== payment.gatewayOrderId) {
    throw new ApiError(400, 'PAYMENT_SIGNATURE_INVALID', 'The payment confirmation names a different order.');
  }
  if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED' || payment.status === 'PARTIALLY_REFUNDED') {
    // Already captured: only make sure what it paid for was applied.
    if (payment.status === 'CAPTURED') await settleTarget(payment, actor.userId, now);
    return (await repository.findPayment(payment.id)) ?? payment;
  }
  if (payment.status === 'FAILED') throw new ApiError(409, 'CONFLICT', 'This payment failed. Start a new one.');
  if (!payment.gatewayOrderId) throw new ApiError(409, 'CONFLICT', 'This payment has no gateway order to confirm against.');

  const adapter = await configuredAdapter(payment.gateway);
  const ok = await adapter.verifySignature({ gatewayOrderId: payment.gatewayOrderId, gatewayPaymentId: input.gatewayPaymentId, signature: input.signature });
  if (!ok) {
    logger.warn('Payment confirmation carried a bad signature', { paymentId: payment.id, gateway: payment.gateway });
    throw new ApiError(400, 'PAYMENT_SIGNATURE_INVALID', 'The payment confirmation could not be verified.');
  }

  let fetched = await adapter.fetchPayment(input.gatewayPaymentId, payment.gatewayOrderId);
  if (fetched.status === 'AUTHORIZED' && adapter.capture) {
    fetched = await adapter.capture({ gatewayPaymentId: fetched.gatewayPaymentId, amount: money(payment.amount), currency: payment.currency });
  }

  if (fetched.status === 'CAPTURED') return settleCapture(payment, fetched, actor.userId, now);
  if (fetched.status === 'FAILED') {
    await markFailed(payment, fetched, actor.userId);
    throw new ApiError(402, 'INSUFFICIENT_FUNDS', fetched.failureReason ?? 'The gateway reported the payment failed', { paymentId: payment.id });
  }
  await repository.updatePayment(payment.id, { gatewayPaymentId: fetched.gatewayPaymentId, status: fetched.status === 'AUTHORIZED' ? 'AUTHORIZED' : payment.status });
  throw new ApiError(409, 'CONFLICT', `The gateway has not captured this payment yet (${fetched.status.toLowerCase()}). It will settle when the gateway confirms.`, {
    paymentId: payment.id,
    gatewayStatus: fetched.status,
  });
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export type WebhookOutcome = { duplicate: boolean; outcome: string };

/**
 * One gateway event, applied once.
 *
 * The signature is checked first and fails loudly — 401 — because an
 * unauthenticated write here moves money. A verified body the adapter
 * cannot read is answered 200: the gateway retries on errors, and a body
 * that will never parse must not become an indefinite retry. An event the
 * platform has already applied is answered with what it did. One that was
 * recorded but not applied — the process died mid-way — is applied now.
 */
export async function handleWebhook(gateway: PaymentGateway, request: WebhookRequest, now = new Date()): Promise<WebhookOutcome> {
  const adapter = adapterFor(gateway);
  const parsed = await adapter.parseWebhook(request);
  if (!parsed.ok) {
    if (parsed.reason === 'UNPARSEABLE') {
      logger.warn('Gateway webhook verified but unreadable', { gateway });
      return { duplicate: false, outcome: 'UNPARSEABLE' };
    }
    logger.error('Gateway webhook rejected', { gateway, reason: parsed.reason });
    throw new ApiError(401, 'UNAUTHORIZED', `Webhook could not be verified (${parsed.reason})`);
  }

  const { event: row, created } = await repository.recordWebhookEvent({
    gateway,
    eventId: parsed.event.eventId,
    eventType: parsed.event.eventType,
    payload: parsed.payload as never,
  });
  if (!created && row.processedAt) return { duplicate: true, outcome: row.outcome ?? 'PROCESSED' };

  const outcome = await applyEvent(gateway, parsed.event, now);
  await repository.markWebhookProcessed(row.id, outcome, now);
  return { duplicate: false, outcome };
}

async function applyEvent(gateway: PaymentGateway, event: WebhookEvent, now: Date): Promise<string> {
  if (event.kind === 'PAYMENT') {
    const payment =
      (event.gatewayOrderId ? await repository.findByGatewayOrder(gateway, event.gatewayOrderId) : null) ??
      (event.gatewayPaymentId ? await repository.findByGatewayPayment(gateway, event.gatewayPaymentId) : null);
    if (!payment) {
      logger.warn('Gateway webhook names an order the platform does not know', { gateway, gatewayOrderId: event.gatewayOrderId });
      return 'NO_PAYMENT';
    }
    if (event.status === 'CAPTURED' && event.gatewayPaymentId) {
      await settleCapture(payment, { gatewayPaymentId: event.gatewayPaymentId, amount: event.amount ?? money(payment.amount), method: event.method }, null, now);
      return 'CAPTURED';
    }
    if (event.status === 'AUTHORIZED' && event.gatewayPaymentId) {
      const adapter = adapterFor(gateway);
      if (!adapter.capture) return 'AUTHORIZED';
      if (event.amount && money(event.amount) !== money(payment.amount)) return 'AUTHORIZED_AMOUNT_MISMATCH';
      const captured = await adapter.capture({ gatewayPaymentId: event.gatewayPaymentId, amount: money(payment.amount), currency: payment.currency });
      if (captured.status !== 'CAPTURED') return `CAPTURE_${captured.status}`;
      await settleCapture(payment, captured, null, now);
      return 'CAPTURED';
    }
    if (event.status === 'FAILED') {
      await markFailed(payment, { gatewayPaymentId: event.gatewayPaymentId, failureReason: event.failureReason, method: event.method }, null);
      return 'FAILED';
    }
    return `IGNORED_${event.status ?? 'UNKNOWN'}`;
  }

  if (event.kind === 'REFUND' && event.gatewayRefundId) {
    const refund = await repository.findRefundByGatewayId(gateway, event.gatewayRefundId);
    if (!refund) return 'NO_REFUND';
    if (event.refundStatus === 'PROCESSED' && refund.status !== 'PROCESSED') {
      await finaliseRefund({ ...refund, gatewayRefundId: event.gatewayRefundId }, refund.payment, 'system', now);
      return 'REFUND_PROCESSED';
    }
    if (event.refundStatus === 'FAILED' && refund.status !== 'FAILED') {
      await undoRefund(refund, refund.payment, 'The gateway could not process the refund', 'system', now);
      return 'REFUND_FAILED';
    }
    return `REFUND_${event.refundStatus ?? 'UNKNOWN'}`;
  }

  return 'IGNORED';
}

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

const walletLabel = (advertiser: { name: string; companyName: string | null }) => `${advertiser.companyName ?? advertiser.name} · advertiser`;

/*
 * Lot J (B2): refunds are the advertiser's path and stay so. A refund
 * request (`WalletRefundRequest`) is an advertiser wallet's, the direct
 * return debits the advertiser's wallet against payables, and nothing in
 * DR 04 gives a publisher money back off a plan. So `refundPayment`
 * refuses a subscription payment up front, and `undoRefund` below keeps
 * `advertiserOf` — a refund on a publisher's payment cannot exist to undo.
 */

/**
 * Whether the advertiser has a captured gateway payment with enough left to
 * return `amount` to — `advertisers` asks through its port when a refund
 * request names ORIGINAL_METHOD.
 */
export async function refundableToOriginalMethod(advertiserId: string, amount: Money): Promise<boolean> {
  const wanted = new Decimal(amount);
  const candidates = await repository.refundableForAdvertiser(advertiserId);
  for (const payment of candidates) {
    if (new Decimal(payment.amount).minus(refundedSoFar(payment.refunds)).lessThan(wanted)) continue;
    if ((await adapterFor(payment.gateway).readiness()).configured) return true;
  }
  return false;
}

/** After the gateway says processed: the request goes PAID, or the direct refund's cash leg is posted. */
async function finaliseRefund(refund: PaymentRefundRow, payment: PaymentRow, byUserId: string, now: Date): Promise<void> {
  if (refund.status !== 'PROCESSED') await repository.updateRefund(refund.id, { status: 'PROCESSED', processedAt: now });
  if (refund.refundRequestId) {
    await markRefundPaid(refund.refundRequestId, { railReference: refund.gatewayRefundId ?? refund.id, byUserId }, now);
  } else {
    const amount = money(refund.amount);
    const [payables, cash] = await Promise.all([platformAccount('platform:payables'), platformAccount('platform:cash')]);
    await postLedger(
      {
        kind: 'REFUND',
        idempotencyKey: `payment-refund-paid:${refund.id}`,
        legs: [
          { accountId: payables.id, amount: money(new Decimal(amount).negated()), reference: refund.id, note: 'Refund paid through the gateway' },
          { accountId: cash.id, amount, reference: refund.id, note: `Gateway refund ${refund.gatewayRefundId ?? refund.id}` },
        ],
        occurredAt: now,
        createdByUserId: byUserId,
        note: `Payment ${payment.reference} refund ${refund.id} paid`,
      },
      now,
    );
  }
  await syncPaymentRefundStatus(payment.id);
}

/** The gateway refused or failed: the refund is FAILED and the money is back in the wallet. */
async function undoRefund(refund: PaymentRefundRow, payment: PaymentRow, reason: string, byUserId: string, now: Date): Promise<void> {
  await repository.updateRefund(refund.id, { status: 'FAILED' });
  if (refund.refundRequestId) {
    await failRefund(refund.refundRequestId, { reason, byUserId }, now);
  } else {
    const wallet = await findWalletFor({ kind: 'ADVERTISER', id: advertiserOf(payment) });
    const advertiser = await getAdvertiser(advertiserOf(payment));
    if (wallet) {
      await move({
        walletId: wallet.id,
        walletLabel: walletLabel(advertiser),
        amount: money(refund.amount),
        entryType: 'REFUND',
        ledgerKind: 'ADJUSTMENT',
        idempotencyKey: `payment-refund-failed:${refund.id}`,
        counterLegs: [{ accountCode: 'platform:payables', amount: money(new Decimal(refund.amount).negated()), note: 'Gateway refund returned' }],
        reference: refund.id,
        note: `Refund ${refund.id} on ${payment.reference} failed: ${reason}`,
        createdByUserId: byUserId,
        occurredAt: now,
      });
    }
  }
  await syncPaymentRefundStatus(payment.id);
}

/** REFUNDED when nothing is left, PARTIALLY_REFUNDED when something stands, CAPTURED when every refund failed. */
async function syncPaymentRefundStatus(paymentId: string): Promise<PaymentView | null> {
  const payment = await repository.findPayment(paymentId);
  if (!payment) return null;
  const refunded = refundedSoFar(payment.refunds);
  const next = refunded.isZero() ? 'CAPTURED' : refunded.greaterThanOrEqualTo(new Decimal(payment.amount)) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (next !== payment.status) {
    await repository.updatePayment(paymentId, { status: next });
    return { ...payment, status: next };
  }
  return payment;
}

/** T-B: the envelope's two halves are the views the reads answer — the refund as the Payment view lists one, the payment as GET /payments/:id answers it. */
export type RefundOutcome = { refund: PaymentRefundView; payment: PaymentSummary };

/**
 * A refund through the gateway — ADMIN with `finance.approve`.
 *
 * Two doors. With `refundRequestId`, this pays an APPROVED ORIGINAL_METHOD
 * `WalletRefundRequest` (Lot B's desk): the wallet was debited at approval,
 * so only the gateway leg and the PAID stamp happen here. Without one it is
 * a direct return, and the wallet is debited first — REFUND, wallet − /
 * payables +, refused 402 when the balance is not there — so the books
 * never show money leaving ADX that the advertiser still holds. Either way
 * the cash leg (payables − / cash +) posts when the gateway says processed,
 * now or on its webhook, and a refusal puts the money back.
 */
export async function refundPayment(
  paymentId: string,
  input: { amount: Money; reason: string; refundRequestId?: string | null },
  byUserId: string,
  now = new Date(),
): Promise<RefundOutcome> {
  const payment = await repository.findPayment(paymentId);
  if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
  if (payment.subscriptionOrderId || !payment.advertiserId) {
    throw new ApiError(409, 'CONFLICT', `${payment.reference} is a publisher's subscription payment and is not refundable through the gateway refund.`);
  }
  if (payment.status !== 'CAPTURED' && payment.status !== 'PARTIALLY_REFUNDED') {
    throw new ApiError(409, 'CONFLICT', `Only a captured payment can be refunded; this one is ${payment.status.toLowerCase().replace('_', ' ')}.`);
  }
  if (!payment.gatewayPaymentId) throw new ApiError(409, 'CONFLICT', 'This payment has no gateway payment id to refund against.');
  const amount = new Decimal(input.amount);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) throw new ApiError(400, 'VALIDATION_ERROR', 'Amount must be greater than zero');
  const remaining = new Decimal(payment.amount).minus(refundedSoFar(payment.refunds));
  if (amount.greaterThan(remaining)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Only ${money(remaining)} is left on this payment to refund.`, { refundable: money(remaining) });
  }
  const reason = input.reason.trim();
  if (!reason) throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the payment is being refunded.');

  const requestId = input.refundRequestId?.trim() || null;
  if (requestId) {
    const request = await findRefundRequest(requestId);
    if (!request) throw new ApiError(404, 'NOT_FOUND', 'Refund request not found');
    if (request.status !== 'APPROVED' || request.destination !== 'ORIGINAL_METHOD') {
      throw new ApiError(409, 'CONFLICT', 'Only an approved refund request to the original payment method is paid here.');
    }
    const wallet = await findWallet(request.walletId);
    if (!wallet || wallet.advertiserId !== payment.advertiserId) {
      throw new ApiError(409, 'CONFLICT', 'That refund request is on another advertiser\'s wallet.');
    }
    if (!new Decimal(request.amount).equals(amount)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `The request is for ${money(request.amount)}; a refund to the original method returns exactly that.`);
    }
    const standing = await repository.findRefundByRequest(requestId);
    if (standing && standing.status !== 'FAILED') {
      throw new ApiError(409, 'CONFLICT', `That request is already being returned (refund ${standing.id}, ${standing.status.toLowerCase()}).`);
    }
  }

  const adapter = await configuredAdapter(payment.gateway);
  const refund = await repository.createRefund({ paymentId: payment.id, amount, reason, refundRequestId: requestId });

  // A direct return leaves the wallet before it leaves the gateway.
  if (!requestId) {
    const wallet = await findWalletFor({ kind: 'ADVERTISER', id: advertiserOf(payment) });
    if (!wallet) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
    const advertiser = await getAdvertiser(advertiserOf(payment));
    try {
      await move({
        walletId: wallet.id,
        walletLabel: walletLabel(advertiser),
        amount: money(amount.negated()),
        entryType: 'REFUND',
        ledgerKind: 'REFUND',
        idempotencyKey: `payment-refund:${refund.id}`,
        requireFunds: true,
        counterLegs: [{ accountCode: 'platform:payables', amount: money(amount), note: 'Refund owed to the advertiser' }],
        reference: refund.id,
        note: `Refund on ${payment.reference}: ${reason}`,
        createdByUserId: byUserId,
        occurredAt: now,
      });
    } catch (err) {
      await repository.updateRefund(refund.id, { status: 'FAILED' });
      throw err;
    }
  }

  let result;
  try {
    result = await adapter.refund({
      gatewayPaymentId: payment.gatewayPaymentId,
      gatewayOrderId: payment.gatewayOrderId,
      amount: money(amount),
      refundId: refund.id,
      note: reason,
    });
  } catch (err) {
    await undoRefund(refund, payment, err instanceof Error ? err.message : 'The gateway refused the refund', byUserId, now);
    throw err;
  }

  let updated: PaymentRefundRow;
  if (result.status === 'FAILED') {
    await undoRefund({ ...refund, gatewayRefundId: result.gatewayRefundId }, payment, 'The gateway refused the refund', byUserId, now);
    updated = { ...refund, gatewayRefundId: result.gatewayRefundId, status: 'FAILED' };
  } else {
    updated = await repository.updateRefund(refund.id, {
      gatewayRefundId: result.gatewayRefundId,
      status: result.status,
      ...(result.status === 'PROCESSED' ? { processedAt: now } : {}),
    });
    if (result.status === 'PROCESSED') await finaliseRefund({ ...updated, status: 'PROCESSED' }, payment, byUserId, now);
    else await syncPaymentRefundStatus(payment.id);
  }

  const after = (await repository.findPayment(payment.id)) ?? payment;
  await logActivity(byUserId, 'PAYMENT_REFUNDED', {
    module: 'payments',
    targetType: 'Payment',
    targetId: payment.id,
    diff: auditDiff({ status: payment.status }, { status: after.status }),
    metadata: {
      reference: payment.reference,
      gateway: payment.gateway,
      amount: money(amount),
      reason,
      refundId: refund.id,
      gatewayRefundId: result.gatewayRefundId,
      refundStatus: updated.status,
      refundRequestId: requestId,
    },
  });
  if (updated.status !== 'FAILED') {
    await notifyAdvertiser(advertiserOf(payment), {
      title: 'Refund on its way',
      message: `${money(amount)} is being returned to the ${payment.method ?? 'payment method'} you paid ${payment.reference} with. Banks take 5–7 working days to show it.`,
      relatedId: payment.id,
    });
  }
  // T-B: the envelope stays — `refund` as the Payment view lists a refund, `payment` as GET /payments/:id answers it.
  return { refund: toRefundView(updated), payment: toPaymentView(after) };
}

/* ------------------------------------------------------------------ */
/* BT-1: bank transfer — an intent with no gateway behind it           */
/* ------------------------------------------------------------------ */

/**
 * The advertiser (or, Lot J-B2, a publisher) chooses to pay by NEFT/IMPS/RTGS.
 * The intent is the same row a gateway would open — the same target, the
 * same amount, the same reference — with no gateway order; the answer
 * carries ADX's receiving account and the reference to quote. The row
 * stays CREATED until ops confirm the money on the statement
 * (`confirmBankTransfer`), which captures and settles it exactly as a
 * gateway capture would.
 */
async function createBankTransferIntent(
  input: IntentInput,
  actor: PaymentActor,
  now: Date,
): Promise<PaymentIntent> {
  const bank = await bankTransferDetails();
  if (!bank.configured) {
    throw new ApiError(409, 'GATEWAY_NOT_CONFIGURED', 'Paying by bank transfer is not set up yet. Ask ADX to add the receiving account under Settings › Integrations.', {
      gateway: 'BANK_TRANSFER',
      missing: bank.missing,
    });
  }
  const target = await resolveTarget(input, actor);
  // AGE-1: a bank transfer is an order too — the payer's account holder, 18 or over.
  await assertPartyAdultForOrders(target.payer, { actorUserId: actor.userId });
  if (target.payer.kind === 'ADVERTISER') await assertMayPayByGateway(target.payer.id);

  const created = await repository.createPayment({
    reference: await nextReference(now),
    advertiserId: target.payer.kind === 'ADVERTISER' ? target.payer.id : null,
    publisherId: target.payer.kind === 'PUBLISHER' ? target.payer.id : null,
    ...targetColumns(target),
    gateway: 'BANK_TRANSFER',
    purpose: input.purpose ?? 'SETTLEMENT',
    payerUpiId: input.upiId ?? null,
    amount: new Decimal(target.amount),
    currency: 'INR',
    createdByUserId: actor.userId,
  });
  await logActivity(actor.userId, 'PAYMENT_INTENT_CREATED', {
    module: 'payments',
    targetType: 'Payment',
    targetId: created.id,
    metadata: {
      reference: created.reference,
      gateway: 'BANK_TRANSFER',
      amount: target.amount,
      [target.payer.kind === 'ADVERTISER' ? 'advertiserId' : 'publisherId']: target.payer.id,
      [TARGET_COLUMN[target.kind]]: target.id,
    },
  });
  const payment = (await repository.findPayment(created.id)) ?? { ...created, refunds: [] };
  return {
    payment: toPaymentView(payment),
    checkout: {},
    checkoutUrl: null,
    bankTransfer: { ...bank.details, reference: created.reference, amount: target.amount },
  };
}

export type BankTransferClaimInput = { utr: string; paidOn: string; amount: Money; proofFileId?: string | null | undefined };

/**
 * "I have paid" — the payer records the UTR, the day, the amount and, if
 * they like, a proof upload. Nothing moves: the claim is what ops check the
 * statement against. Re-submitting replaces the claim while the row is
 * still CREATED.
 */
export async function submitBankTransfer(paymentId: string, input: BankTransferClaimInput, actor: PaymentActor, now = new Date()): Promise<PaymentSummary> {
  const payment = await getPayment(paymentId, actor);
  if (payment.gateway !== 'BANK_TRANSFER') throw new ApiError(409, 'CONFLICT', 'This payment goes through a gateway, not a bank transfer.');
  if (payment.status !== 'CREATED') throw new ApiError(409, 'CONFLICT', `This payment is already ${payment.status.toLowerCase()}.`);
  const paidOn = new Date(`${input.paidOn}T00:00:00.000Z`);
  if (Number.isNaN(paidOn.getTime()) || paidOn.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say the day the transfer was made (not a day in the future).', { paidOn: input.paidOn });
  }
  await repository.updatePayment(payment.id, {
    bankUtr: input.utr.trim().toUpperCase(),
    bankPaidOn: paidOn,
    bankClaimedAmount: new Decimal(input.amount),
    bankProofFileId: input.proofFileId ?? null,
    bankClaimedAt: now,
  });
  await logActivity(actor.userId, 'PAYMENT_BANK_TRANSFER_CLAIMED', {
    module: 'payments',
    targetType: 'Payment',
    targetId: payment.id,
    metadata: { reference: payment.reference, utr: input.utr.trim().toUpperCase(), paidOn: input.paidOn, amount: input.amount, expected: money(payment.amount) },
  });
  await notifyOps(
    'Bank transfer claimed',
    `${payment.reference}: ${money(input.amount)} said to be sent on ${input.paidOn} (UTR ${input.utr.trim().toUpperCase()}) against ${money(payment.amount)}. Confirm it under Finance › Payments once it shows on the statement.`,
    payment.id,
  );
  return toPaymentView((await repository.findPayment(payment.id)) ?? payment);
}

/**
 * Ops saw the money on the statement: the payment is captured for what
 * arrived and settled exactly as a gateway capture is — the wallet topped
 * up (keyed on the UTR, so a second confirm is one credit), the campaign
 * authorised or the sale paid. `amount` defaults to the intent's; a
 * different figure is credited as it came and flagged, as a gateway's
 * mismatch would be. ADMIN + finance.approve.
 */
export async function confirmBankTransfer(paymentId: string, input: { amount?: Money | undefined; utr?: string | undefined; note?: string | undefined }, actor: PaymentActor, now = new Date()): Promise<PaymentSummary> {
  const payment = await getPayment(paymentId, actor);
  if (payment.gateway !== 'BANK_TRANSFER') throw new ApiError(409, 'CONFLICT', 'This payment goes through a gateway; it captures itself.');
  if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED' || payment.status === 'PARTIALLY_REFUNDED') {
    await settleTarget(payment, actor.userId, now);
    return toPaymentView((await repository.findPayment(payment.id)) ?? payment);
  }
  if (payment.status === 'FAILED') throw new ApiError(409, 'CONFLICT', 'This payment was rejected. The payer has to start a new one.');
  const utr = (input.utr ?? payment.bankUtr ?? '').trim().toUpperCase();
  if (!utr) throw new ApiError(400, 'VALIDATION_ERROR', 'Give the UTR from the statement — the payer left none.');
  if (input.utr && input.utr.trim().toUpperCase() !== (payment.bankUtr ?? '').toUpperCase()) {
    await repository.updatePayment(payment.id, { bankUtr: utr });
  }
  const amount = money(input.amount ?? payment.amount);
  const settled = await settleCapture(payment, { gatewayPaymentId: `UTR:${utr}`, amount, method: 'bank_transfer' }, actor.userId, now);
  await logActivity(actor.userId, 'PAYMENT_BANK_TRANSFER_CONFIRMED', {
    module: 'payments',
    targetType: 'Payment',
    targetId: payment.id,
    metadata: { reference: payment.reference, utr, amount, expected: money(payment.amount), note: input.note ?? null },
  });
  return toPaymentView(settled);
}

/** Nothing arrived, or the wrong thing did: the payment fails with the reason, and the payer is told. ADMIN + finance.approve. */
export async function rejectBankTransfer(paymentId: string, input: { reason: string }, actor: PaymentActor): Promise<PaymentSummary> {
  const payment = await getPayment(paymentId, actor);
  if (payment.gateway !== 'BANK_TRANSFER') throw new ApiError(409, 'CONFLICT', 'This payment goes through a gateway.');
  if (payment.status !== 'CREATED') throw new ApiError(409, 'CONFLICT', `This payment is already ${payment.status.toLowerCase()}.`);
  const failed = await markFailed(payment, { gatewayPaymentId: null, failureReason: input.reason, method: 'bank_transfer' }, actor.userId);
  return toPaymentView(failed);
}
