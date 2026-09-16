import { ApiError } from '../../shared/errors';

/**
 * Lot J: a payment names either an advertiser or a publisher (exactly one
 * of `advertiserId` / `publisherId`). The advertiser-only paths — wallet,
 * receipt, notice — ask through this so a publisher's payment can never
 * fall into them by accident. A leaf on purpose: both services import it.
 */
export function advertiserOf(payment: { advertiserId: string | null; reference: string }): string {
  if (!payment.advertiserId) {
    throw new ApiError(409, 'CONFLICT', `Payment ${payment.reference} is not an advertiser payment`);
  }
  return payment.advertiserId;
}

/** Who is paying — the party the wallet, the checkout prefill and the notices belong to. */
export type Payer = { kind: 'ADVERTISER' | 'PUBLISHER'; id: string };

/**
 * Lot J (B2): the branch the two-party paths take. A row naming neither is
 * a broken row and says so, rather than being treated as anyone's.
 */
export function payerOf(payment: { advertiserId: string | null; publisherId: string | null; reference: string }): Payer {
  if (payment.publisherId) return { kind: 'PUBLISHER', id: payment.publisherId };
  return { kind: 'ADVERTISER', id: advertiserOf(payment) };
}
