import { registerPublisherOnboardingPort } from '../qr';
import { commitClaim, prepareClaim } from './onboarding/publisher-onboarding.service';

/**
 * Publishers — the people and organisations who own advertising inventory,
 * their KYC, and the agent-mediated onboarding flow.
 *
 * `PublisherKyc` lives here rather than in the `kyc` module: it is part of the
 * publisher onboarding aggregate, its routes hang off
 * /publishers/:publisherId/kyc, and it is driven by the Digio integration.
 * `kyc` owns the two standalone record types, AdvertiserKyc and UserKyc.
 *
 * The inventory itself is `listings`.
 */
export { publisherRouter } from './publishers.routes';
export { digioWebhookHandler } from './kyc/digio.controller';

/**
 * Supplies the QR module's PublisherOnboardingPort.
 *
 * Called by bootstrap/register-modules. This is what lets `qr` trigger a
 * publisher claim without importing `publishers` — which would close a cycle,
 * since `publishers` imports `qr` to mint onboarding codes.
 */
export function registerPublisherModule(): void {
  registerPublisherOnboardingPort({ prepareClaim, commitClaim });
}
