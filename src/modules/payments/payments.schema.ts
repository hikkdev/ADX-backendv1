import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { PAYMENT_GATEWAYS, PAYMENT_STATUSES } from './payments.repository';

const moneyString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal string with up to two places');

export const gatewaySchema = z.enum(PAYMENT_GATEWAYS);

/** POST /payments/intents — exactly one target of the three; the service says so in words when two or none arrive. */
export const createIntentSchema = z.object({
  campaignId: z.string().trim().min(1).max(64).optional(),
  packageSaleId: z.string().trim().min(1).max(64).optional(),
  /** Lot J (B2): a publisher's plan order. */
  subscriptionOrderId: z.string().trim().min(1).max(64).optional(),
  /** LM-1: a display ad the advertiser bought, or a sponsored listing the publisher bought. */
  adBookingId: z.string().trim().min(1).max(64).optional(),
  listingBoostId: z.string().trim().min(1).max(64).optional(),
  gateway: gatewaySchema,
  /** RF-1: on a campaign, the reservation fee rather than the full amount. */
  purpose: z.enum(['SETTLEMENT', 'RESERVATION_FEE']).optional(),
  /** UP-1: the payer's UPI id — a collect request on Cashfree, the prefilled VPA on Razorpay. */
  upiId: z.string().trim().regex(/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/, 'A UPI id looks like name@bank').optional(),
});

/**
 * POST /payments/:id/confirm — Razorpay's checkout handler; CCAvenue's
 * encResp rides in `signature`. Two spellings of the same thing: the app's
 * (`gatewayPaymentId` / `signature`) and, E7-2, Razorpay's own as the
 * checkout page posts them (`razorpay_payment_id` / `razorpay_order_id` /
 * `razorpay_signature`), plus the page's one-time `checkoutToken` in place
 * of a bearer. Normalised to one shape on the way through.
 */
const confirmBodySchema = z.object({
  gatewayPaymentId: z.string().trim().min(1).max(128).optional(),
  signature: z.string().trim().min(1).max(8192).optional(),
  gatewayOrderId: z.string().trim().min(1).max(128).optional(),
  razorpay_payment_id: z.string().trim().min(1).max(128).optional(),
  razorpay_order_id: z.string().trim().min(1).max(128).optional(),
  razorpay_signature: z.string().trim().min(1).max(8192).optional(),
  checkoutToken: z.string().trim().min(1).max(256).optional(),
});
export const confirmSchema = confirmBodySchema
  .transform((body) => ({
    gatewayPaymentId: body.gatewayPaymentId ?? body.razorpay_payment_id,
    signature: body.signature ?? body.razorpay_signature,
    gatewayOrderId: body.gatewayOrderId ?? body.razorpay_order_id ?? null,
    checkoutToken: body.checkoutToken ?? null,
  }))
  .pipe(
    z.object({
      gatewayPaymentId: z.string().min(1, 'gatewayPaymentId is required'),
      signature: z.string().min(1, 'signature is required'),
      gatewayOrderId: z.string().nullable(),
      checkoutToken: z.string().nullable(),
    }),
  );
export type ConfirmInput = z.infer<typeof confirmSchema>;

/** GET /payments/:id/checkout?t= — the one-time token in the link the app opened. */
export const checkoutQuerySchema = z.object({ t: z.string().trim().min(1).max(256).optional() });

/** POST /payments/:id/refund — ADMIN + finance.approve. */
export const refundSchema = z.object({
  amount: moneyString,
  reason: z.string().trim().min(3).max(500),
  refundRequestId: z.string().trim().min(1).max(64).optional(),
});

/** GET /payments — the list contract, scoped by payer (advertiser or publisher), gateway and target. */
export const listPaymentsQuerySchema = listQuerySchema(PAYMENT_STATUSES, ['NEWEST', 'OLDEST', 'AMOUNT_DESC']).extend({
  advertiserId: z.string().trim().min(1).max(64).optional(),
  publisherId: z.string().trim().min(1).max(64).optional(),
  campaignId: z.string().trim().min(1).max(64).optional(),
  packageSaleId: z.string().trim().min(1).max(64).optional(),
  subscriptionOrderId: z.string().trim().min(1).max(64).optional(),
  gateway: gatewaySchema.optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

/** GET /advertisers/:id/payments — the same page, the advertiser fixed by the path. */
export const advertiserPaymentsQuerySchema = listQuerySchema(PAYMENT_STATUSES, ['NEWEST', 'OLDEST', 'AMOUNT_DESC']).extend({
  gateway: gatewaySchema.optional(),
});

/* BT-1: bank transfer. */
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** POST /payments/:id/bank-transfer/submit — the payer's claim. */
export const bankTransferSubmitSchema = z.object({
  utr: z.string().trim().min(6).max(40),
  paidOn: calendarDay,
  amount: moneyString,
  proofFileId: z.string().trim().min(1).max(64).nullable().optional(),
});

/** POST /payments/:id/bank-transfer/confirm — ops saw it on the statement. */
export const bankTransferConfirmSchema = z.object({
  amount: moneyString.optional(),
  utr: z.string().trim().min(6).max(40).optional(),
  note: z.string().trim().max(300).optional(),
});

/** POST /payments/:id/bank-transfer/reject */
export const bankTransferRejectSchema = z.object({ reason: z.string().trim().min(3).max(300) });
