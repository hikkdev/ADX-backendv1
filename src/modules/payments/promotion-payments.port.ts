import { ApiError } from '../../shared/errors';
import type { Money } from '../../shared/money';

/**
 * LM-1: the fourth and fifth things a payment settles — a display ad
 * (`adBookingId`, the advertiser pays) and a sponsored listing
 * (`listingBoostId`, the publisher pays).
 *
 * `promotions` owns both: whose a booking is, whether it waits for payment,
 * what it costs, and the charge out of the wallet the capture credited. This
 * module declares what it needs and `bootstrap/register-modules` connects
 * `promotions` to it, so neither imports the other (and a payment's tests do
 * not load the whole placement stack). Unregistered, a placement cannot be
 * paid through a gateway — 503, never a half-made order.
 */

export type PromotionPayer = { userId: string; isAdmin: boolean; advertiserId: string | null; publisherId: string | null; agentId: string | null };

export type PromotionPaymentTarget = { id: string; reference: string; payer: { kind: 'ADVERTISER' | 'PUBLISHER'; id: string }; amount: Money; description: string };

export interface PromotionPaymentsPort {
  /** Guards and prices an ad's intent (the advertiser, its agent, or ADX; PENDING_PAYMENT only). */
  adTarget(adBookingId: string, actor: PromotionPayer): Promise<PromotionPaymentTarget>;
  /** Guards and prices a boost's intent (the listing's publisher only; PENDING_PAYMENT only). */
  boostTarget(boostId: string, actor: PromotionPayer): Promise<PromotionPaymentTarget>;
  /** Settles a captured payment out of the credited wallet, idempotently; the ad's invoice, when one was issued. */
  settleAd(adBookingId: string, payment: { id: string; reference: string }, byUserId: string | null, now: Date): Promise<{ invoiceId: string | null }>;
  settleBoost(boostId: string, payment: { id: string; reference: string }, byUserId: string | null, now: Date): Promise<{ invoiceId: string | null }>;
}

let registered: PromotionPaymentsPort | null = null;

export function registerPromotionPaymentsPort(port: PromotionPaymentsPort): void {
  registered = port;
}

export function promotionPayments(): PromotionPaymentsPort {
  if (!registered) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Paid placements cannot be paid for here yet');
  return registered;
}
