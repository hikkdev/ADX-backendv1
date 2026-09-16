import { createHash, randomBytes } from 'crypto';
import { redis } from '../../shared/cache';

/**
 * The one-time tokens the phones' Razorpay flow rides on (E7-2).
 *
 * `react-native-razorpay` is not installed, so the apps open
 * `GET /payments/:id/checkout?t=<token>` in the system browser. The browser
 * has no bearer, so the door is a token: minted with the intent, twenty
 * minutes, single use, bound to one payment. The page it opens mints a
 * second one of the same shape for the confirm it posts, so neither the
 * URL in the browser history nor the page source is worth stealing twice.
 *
 * Only the hash is stored: a Redis dump does not hand out live tokens. The
 * consume is one atomic DEL — the first caller gets `1`, everybody after
 * gets `0` — so two tabs racing on the same link open one checkout.
 */

export const CHECKOUT_TOKEN_TTL_SECONDS = 20 * 60;

/** E9 adds `return`: the token on the gateways' return URL that lets the return page print more than the status word. */
export type CheckoutTokenKind = 'checkout' | 'confirm' | 'return';

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

const key = (kind: CheckoutTokenKind, paymentId: string, token: string): string =>
  `payments:${kind}-token:${paymentId}:${hash(token)}`;

/** A fresh token for this payment, live for twenty minutes. */
export async function mintCheckoutToken(kind: CheckoutTokenKind, paymentId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(key(kind, paymentId, token), '1', 'EX', CHECKOUT_TOKEN_TTL_SECONDS);
  return token;
}

/**
 * Spends the token. True exactly once per token, for the payment it was
 * minted for; false for a token that is unknown, expired, already spent, or
 * minted for another payment.
 */
export async function consumeCheckoutToken(kind: CheckoutTokenKind, paymentId: string, token: string | undefined): Promise<boolean> {
  if (!token || token.length > 256) return false;
  const deleted = await redis.del(key(kind, paymentId, token));
  return deleted === 1;
}
