/**
 * Payments — the gateway (Lot C, Q110/Q118/Q12).
 *
 * One Payment per attempt to pay a campaign or a package sale through
 * Razorpay, Cashfree or CCAvenue. It owns no money: a capture is a gateway
 * TOPUP into the advertiser's wallet through `advertisers`, and the target
 * is settled out of that balance by the same calls the wallet path makes.
 * It owns the three adapters, the webhook door and the refund back to the
 * original method.
 */
import { registerOriginalMethodRefundPort } from '../advertisers';
import { refundableToOriginalMethod } from './payments.service';

export { paymentRouter, advertiserPaymentRouter, paymentWebhookRouter } from './payments.routes';

/**
 * Supplies `advertisers`' OriginalMethodRefundPort — whether a refund
 * request may name ORIGINAL_METHOD. Called by bootstrap/register-modules,
 * because `advertisers` cannot import this module (it is read here for
 * the wallet). Unregistered, ORIGINAL_METHOD keeps refusing.
 */
export function registerPaymentsModule(): void {
  registerOriginalMethodRefundPort({ refundable: (advertiserId, amount) => refundableToOriginalMethod(advertiserId, amount) });
}

/** For the console and tests: which gateways are on, and a payment's view. */
export { listGateways, getPayment, toPaymentView } from './payments.service';
export type { PaymentActor, PaymentSummary, PaymentIntent, GatewayStatus } from './payments.service';
export type { GatewayAdapter, GatewayName } from './gateways/gateway';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
