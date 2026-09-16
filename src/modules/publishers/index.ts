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
/** Lot U: the legacy-book importer's row schema and header, read by `party-imports`' format guide. */
export { importRowSchema as publisherImportRowSchema, IMPORT_COLUMNS as PUBLISHER_IMPORT_COLUMNS } from './import/publisher-import.schema';
export { PUBLISHER_TYPES } from './publishers.schema';

/**
 * Self-registration, for `users` — POST /users/me/party opens the publisher
 * side of an account through this, so there is one place a publisher comes
 * into being from the app and one place its identifier is minted.
 */
export { registerProfile as registerPublisher } from './onboarding/publisher-onboarding.service';
export { digioWebhookHandler } from './kyc/digio.controller';

/**
 * Lot B (Q13): read by `invoices` — the publisher behind a session for the
 * upload of their own invoice, and the billing facts a payment advice prints.
 */
export { findPublisherForUser, findPublisherBilling } from './publishers.service';
/** Lot J (B2): read by `payments` — the name, email, mobile and login of the publisher behind a plan payment. */
export { findPublisherContact } from './publishers.service';
/** E7-3: the label per login, for the desks' requester / against-party reads (composed in bootstrap). */
export { findPublisherLabelsForUsers } from './publishers.service';
/** K-B1: by publisher id, for the QR desk (registered on qr's ref-label port by bootstrap). */
export { findPublisherLabels } from './publishers.service';
export type { PartyLabelRow as PublisherLabelRow } from './publishers.repository';
/** Used by bootstrap: other parties that verify through Digio register here for the one webhook. */
export { onUnmatchedDigioWebhook } from './kyc/digio.service';

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

/**
 * Lot D: the desk's reach into this module — the publisher's own review state
 * for `users`' onboarding manifest (flagged tiles, the reviewer's note), and
 * the Digio-path image purge the daily job runs (Q127).
 */
export { publisherKycReviewStateFor, purgeVerifiedPublisherImages } from './kyc/kyc-desk.service';

/**
 * P-B: the detail card's port — the running subscription (`revenue`) and the
 * visits made to the publisher (`visits`), both modules that already reach
 * this one. Bootstrap fills it; unregistered, the card answers no
 * subscription and no visits.
 */
export { registerPublisherSummaryPort } from './book/summary.port';
export type { PublisherSummaryPort } from './book/summary.port';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
