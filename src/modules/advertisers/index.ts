/**
 * Advertisers — how demand gets from "signed up" to "able to book", and how
 * money moves once it can.
 *
 * The specification lives in docs/advertiser-onboarding.md. This module owns
 * the advertiser account, its brands, the two demand-side agreements and the
 * wallet.
 *
 * It deliberately does not own campaigns or bookings — that is B2, unbuilt.
 * The seam is `campaignId`, which this module stores and never dereferences,
 * so the campaign model can land without reopening anything here.
 */
import { registerAdvertiserOnboardingPort } from '../qr';
import { commitClaim, prepareClaim } from './advertiser-onboarding.service';

export { advertiserRouter, refundDeskRouter, topUpDeskRouter } from './advertisers.routes';

/**
 * Supplies the QR module's AdvertiserOnboardingPort — the demand side of the
 * door-to-door code. Called by bootstrap/register-modules, for the same
 * reason `publishers` registers its port: `qr` must not import this module.
 */
export function registerAdvertiserModule(): void {
  registerAdvertiserOnboardingPort({ prepareClaim, commitClaim });
}

/**
 * Gate 1, for `users` — POST /users/me/party opens the advertiser side of an
 * account through this, so there is one place an advertiser comes into
 * being from the app and one place its identifier is minted.
 */
export { registerAdvertiser } from './advertisers.service';
export type { RegisterInput } from './advertisers.service';

/**
 * Lot S: `party-imports` creates and merges advertisers through the same two
 * doors the console's Create and PATCH use — `registerAdvertiser` above and
 * `updateProfile` (Gate 2, which never touches kycStatus or activatedAt) —
 * and validates the file's `type` / `industry` columns against the same
 * vocabularies the profile accepts.
 */
export { updateProfile } from './advertisers.service';
export { advertiserTypeSchema, ADVERTISER_INDUSTRIES } from './advertisers.schema';

/**
 * The booking gate. Campaigns will call `assertCanBook` before confirming and
 * `holdForCampaign` at confirmation, so the eligibility rules live in one place
 * rather than being restated by whoever builds the booking flow.
 */
export {
  assertCanBook,
  /** Lot A BLOCK_NEW alone, for a path that must not also demand KYC or funds. */
  assertNotSuspended,
  bookingEligibility,
  holdForCampaign,
  payForPackage,
  captureCampaignHold,
  releaseCampaignHold,
} from './advertisers.service';
export type { BookingEligibility } from './advertisers.service';

/** Resolves the advertiser behind a session, for modules that must not trust a
 *  client-supplied advertiser id. */
export { getAdvertiserForUser } from './advertisers.service';
/** N3-B: the profile by id, or null — the KYC desk resolves `:id` as row id → profile id → user id through it. */
export { findAdvertiser } from './advertisers.service';
/** E7-3: the label per login, for the desks' requester / against-party reads (composed in bootstrap). */
export { findAdvertiserLabelsForUsers } from './advertisers.service';
/** K-B1: by advertiser id, for the QR desk (registered on qr's ref-label port by bootstrap). */
export { findAdvertiserLabels } from './advertisers.service';
export type { AdvertiserLabelRow } from './advertisers.repository';

/**
 * Called by the supply enforcement ladder when a publisher forfeits a day's
 * earning. Supply decides who is owed and how much; this credits it.
 */
export { creditGoodwill } from './advertisers.service';

/**
 * Called by `suspension` when STOP_OPEN_WORK cancels running work an advertiser
 * has paid for: one refund request per affected campaign, raised through the
 * same two-person path support uses — never a direct wallet write.
 */
export { requestRefund } from './advertisers.service';

/**
 * Lot B (Q41): the refund desk. `campaigns` releases a cancelled campaign's
 * unused value back to the wallet through this — the REFUND legs and the
 * statement line come from `wallets.move`, never from a direct write.
 */
export { creditCampaignRefund } from './advertisers.service';

/**
 * Lot C's door (Q118): the payment gateway confirms a settlement and the
 * wallet is credited against cash. Not a route — the route requires a method
 * and a person; a webhook has a payment id and retries.
 */
export { recordGatewayTopUp } from './advertisers.service';
export type { TopUpInput, TopUpOutcome, RefundRequestInput } from './advertisers.service';

/**
 * Lot C (Q110): a refund back to the original payment method. `payments`
 * answers whether one is possible through the port bootstrap registers,
 * reads the approved request, and marks it PAID (or FAILED) with the
 * gateway's refund id once the gateway has answered.
 */
export { registerOriginalMethodRefundPort, findRefundRequest, markRefundPaid, failRefund } from './advertisers.service';
export type { OriginalMethodRefundPort } from './advertisers.service';

/**
 * Lot B (Q85): `reconciliation` explains a bank credit with a top-up — by
 * UTR, by payment id or by hand — and stamps `reconciledAt` when it does.
 * Reads and one stamp; the money itself moved when the top-up was recorded.
 */
export { findTopUp, findTopUpByUtr, findTopUpByPaymentId, markTopUpReconciled } from './advertisers.service';

/**
 * Called by the KYC module on every status write over an advertiser's
 * record — N3-B: the record is keyed by the profile, so `applyKycDecision`
 * (by profile id) is the door; the by-user-id form stays for a legacy row
 * that knows the advertiser only as a User. Every status is mirrored onto
 * `Advertiser.kycStatus`; only VERIFIED can activate.
 */
export { applyKycDecision, applyKycDecisionByUserId } from './advertisers.service';

/**
 * Lot B (Q13): `invoices` prints the advertiser as the recipient — name,
 * GSTIN, state, billing address — and its party-facing routes under
 * /advertisers/:id/invoices answer to the same owner/admin/agent policy every
 * other /advertisers/:id route does.
 */
export { getAdvertiser } from './advertisers.service';

/** O-B: the five demand gates counted, for `section-overviews` — the same read `GET /advertisers/funnel` answers. */
export { advertiserFunnel } from './advertisers.service';
export type { AdvertiserFunnel } from './advertisers.repository';
export { assertMayActFor } from './advertisers.policy';
export type { ActingAs } from './advertisers.policy';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
