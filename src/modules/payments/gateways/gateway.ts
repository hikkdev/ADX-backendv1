import type { PaymentGateway } from '../../../shared/database';
import type { Money } from '../../../shared/money';

/**
 * The port every payment gateway is driven through (Lot C, Q110).
 *
 * Five verbs, one per thing the platform does with a gateway: open an order,
 * check the client-side confirmation, read a payment back, refund it, and
 * read a webhook. Everything the gateways disagree on — paise or rupees,
 * hex or base64, a signed body or an encrypted one — stays inside the
 * adapter; the service only ever sees these shapes.
 *
 * Adapters are built over `fetch`, not a vendor SDK, so the three of them
 * are testable with recorded fixtures and signature vectors and carry no
 * dependency the platform did not choose.
 */

export type GatewayName = PaymentGateway;

/** Who is paying, as the gateway wants to know them. */
export type GatewayCustomer = {
  id: string;
  name: string;
  email: string | null;
  mobile: string | null;
};

export type CreateOrderInput = {
  /** Our Payment id — the gateway echoes it as the receipt / merchant order id. */
  paymentId: string;
  /** PAY-2026-000482, printed on the gateway's own record. */
  reference: string;
  amount: Money;
  currency: string;
  customer: GatewayCustomer;
  description: string;
  /** Where a redirect-flow gateway sends the browser back afterwards. */
  returnUrl: string;
  /** Where the gateway posts its server-to-server notification. */
  notifyUrl: string;
};

export type CreateOrderResult = {
  gatewayOrderId: string;
  /**
   * What the app needs to open the gateway's checkout. Razorpay: the order
   * id and key id; Cashfree: the payment session id; CCAvenue: the encrypted
   * request, the access code and the redirect URL.
   */
  checkout: Record<string, unknown>;
};

export type GatewayPaymentStatus = 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED';
export type GatewayRefundStatus = 'PENDING' | 'PROCESSED' | 'FAILED';

/** A payment as the gateway reports it. */
export type FetchedPayment = {
  gatewayPaymentId: string;
  gatewayOrderId: string | null;
  status: GatewayPaymentStatus;
  amount: Money;
  currency: string;
  /** card | upi | netbanking | wallet, in the gateway's own vocabulary. */
  method: string | null;
  failureReason: string | null;
  raw: unknown;
};

export type RefundInput = {
  gatewayPaymentId: string;
  gatewayOrderId: string | null;
  amount: Money;
  /** Our PaymentRefund id — sent as the gateway's refund reference, so a retry is one refund. */
  refundId: string;
  note: string;
};

export type RefundResult = {
  gatewayRefundId: string;
  status: GatewayRefundStatus;
  raw: unknown;
};

/** The inbound request, as the webhook handler hands it over. */
export type WebhookRequest = {
  rawBody: Buffer | undefined;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * One gateway event, normalised. `kind` says which row it is about: a
 * PAYMENT event carries `status`, a REFUND event carries `refundStatus`;
 * IGNORED is an event type the platform does not act on but still records.
 */
export type WebhookEvent = {
  /** Unique per gateway — the idempotency key for `WebhookEvent`. */
  eventId: string;
  eventType: string;
  kind: 'PAYMENT' | 'REFUND' | 'IGNORED';
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  gatewayRefundId: string | null;
  status: GatewayPaymentStatus | null;
  refundStatus: GatewayRefundStatus | null;
  amount: Money | null;
  method: string | null;
  failureReason: string | null;
};

export type WebhookRejection = 'NO_SECRET' | 'NO_SIGNATURE' | 'NO_BODY' | 'MISMATCH' | 'UNPARSEABLE';

export type ParsedWebhook =
  | { ok: true; event: WebhookEvent; payload: unknown }
  | { ok: false; reason: WebhookRejection };

export type GatewayReadiness = {
  configured: boolean;
  testMode: boolean;
  /** The config fields still empty — names only, never values. */
  missing: string[];
};

export interface GatewayAdapter {
  readonly name: GatewayName;
  /** Answers cleanly when keys are missing; the service turns it into 409 GATEWAY_NOT_CONFIGURED. */
  readiness(): Promise<GatewayReadiness>;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /** The client-side confirmation — Razorpay's checkout handler signs order|payment. */
  verifySignature(input: { gatewayOrderId: string; gatewayPaymentId: string; signature: string }): Promise<boolean>;
  fetchPayment(gatewayPaymentId: string, gatewayOrderId: string | null): Promise<FetchedPayment>;
  /** Only where the gateway authorises first and captures second (Razorpay). */
  capture?(input: { gatewayPaymentId: string; amount: Money; currency: string }): Promise<FetchedPayment>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Signature checked (fail closed) and the body normalised; never throws on a bad body. */
  parseWebhook(request: WebhookRequest): Promise<ParsedWebhook>;
}

/** Rupees to the integer minor unit the gateways that want paise expect. */
export const toPaise = (amount: Money): number => Math.round(Number(amount) * 100);
/** Paise back to a money string. */
export const fromPaise = (paise: number): Money => (paise / 100).toFixed(2);

/** The one header value, whatever Express parsed it into. */
export const headerValue = (headers: WebhookRequest['headers'], name: string): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};
