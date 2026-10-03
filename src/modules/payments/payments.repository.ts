import type { Prisma } from '../../shared/database';
import type {
  Payment,
  PaymentGateway,
  PaymentPurpose,
  PaymentRefund,
  PaymentRefundStatus,
  PaymentStatus,
  WebhookEvent,
} from '../../shared/database';

/**
 * What the payments module needs from storage, stated as a port.
 *
 * Three tables: the Payment (one attempt to pay through a gateway), its
 * refunds, and the webhook events the gateways send — each written once
 * per (gateway, event id) whatever the gateway retries.
 */

export type PaymentRow = Payment;
export type PaymentRefundRow = PaymentRefund;
export type WebhookEventRow = WebhookEvent;

/** A payment with its refunds — what every read returns. */
export type PaymentView = Payment & { refunds: PaymentRefund[] };

export const PAYMENT_STATUSES = ['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
export const PAYMENT_GATEWAYS = ['RAZORPAY', 'CASHFREE', 'CCAVENUE', 'BANK_TRANSFER'] as const;

export type NewPayment = {
  reference: string;
  /** Lot J: exactly one of the two — who is paying. */
  advertiserId: string | null;
  publisherId: string | null;
  campaignId: string | null;
  packageSaleId: string | null;
  /** Lot J (B2): a publisher's plan order, the third target. */
  subscriptionOrderId: string | null;
  /** LM-1: a display ad (the advertiser pays) or a sponsored listing (the publisher pays) — the fourth and fifth. */
  adBookingId?: string | null;
  listingBoostId?: string | null;
  gateway: PaymentGateway;
  /** RF-1: SETTLEMENT (the target's full amount) or RESERVATION_FEE on a campaign. */
  purpose: PaymentPurpose;
  /** UP-1: the UPI id the payer typed, when they did. */
  payerUpiId: string | null;
  amount: Prisma.Decimal;
  currency: string;
  createdByUserId: string | null;
};

export type PaymentPatch = Partial<{
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  method: string | null;
  status: PaymentStatus;
  failureReason: string | null;
  topUpId: string | null;
  walletEntryId: string | null;
  ledgerTransactionId: string | null;
  invoiceId: string | null;
  capturedAt: Date | null;
  /** BT-1: what the payer claimed about their transfer. */
  bankUtr: string | null;
  bankPaidOn: Date | null;
  bankClaimedAmount: Prisma.Decimal | null;
  bankProofFileId: string | null;
  bankClaimedAt: Date | null;
}>;

export type NewRefund = {
  paymentId: string;
  amount: Prisma.Decimal;
  reason: string;
  refundRequestId: string | null;
};

export type RefundPatch = Partial<{
  gatewayRefundId: string | null;
  status: PaymentRefundStatus;
  processedAt: Date | null;
}>;

export type PaymentListFilter = {
  advertiserId?: string | undefined;
  publisherId?: string | undefined;
  campaignId?: string | undefined;
  packageSaleId?: string | undefined;
  subscriptionOrderId?: string | undefined;
  gateway?: PaymentGateway | undefined;
  status?: readonly string[] | undefined;
  q?: string | undefined;
  sort: string;
  page: number;
  pageSize: number;
};

export interface PaymentsRepository {
  createPayment(data: NewPayment): Promise<PaymentRow>;
  findPayment(id: string): Promise<PaymentView | null>;
  findByGatewayOrder(gateway: PaymentGateway, gatewayOrderId: string): Promise<PaymentView | null>;
  findByGatewayPayment(gateway: PaymentGateway, gatewayPaymentId: string): Promise<PaymentView | null>;
  updatePayment(id: string, patch: PaymentPatch): Promise<PaymentRow>;
  referenceExists(reference: string): Promise<boolean>;
  /** The list contract: one page with the total and a count per status chip. */
  listPaymentsPage(filter: PaymentListFilter): Promise<{ items: PaymentView[]; total: number; counts: Record<string, number> }>;
  /** Captured (or partly refunded) payments of one advertiser, newest first — what a refund to the original method can go back to. */
  refundableForAdvertiser(advertiserId: string): Promise<PaymentView[]>;

  createRefund(data: NewRefund): Promise<PaymentRefundRow>;
  findRefund(id: string): Promise<(PaymentRefundRow & { payment: PaymentRow }) | null>;
  findRefundByGatewayId(gateway: PaymentGateway, gatewayRefundId: string): Promise<(PaymentRefundRow & { payment: PaymentRow }) | null>;
  findRefundByRequest(refundRequestId: string): Promise<(PaymentRefundRow & { payment: PaymentRow }) | null>;
  updateRefund(id: string, patch: RefundPatch): Promise<PaymentRefundRow>;

  /** Once per (gateway, eventId): `created` is false when the gateway retried. */
  recordWebhookEvent(data: { gateway: PaymentGateway; eventId: string; eventType: string | null; payload: Prisma.InputJsonValue }): Promise<{
    event: WebhookEventRow;
    created: boolean;
  }>;
  markWebhookProcessed(id: string, outcome: string, at: Date): Promise<void>;
}
