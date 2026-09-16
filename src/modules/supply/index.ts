/**
 * Supply — how a publisher and their inventory get from "signed up" to
 * "rentable and earning", and what happens when a listing stops being
 * verifiable.
 *
 * The specification lives in docs/publisher-supply-lifecycle.md. This module
 * owns the agreements, the listing attempt, per-listing documents, verification
 * and its clock, claims on unowned inventory, and the compliance ladder.
 *
 * It deliberately does not own the listing itself — `listings` does. Supply
 * moves a listing through its status; it never creates one outside an attempt.
 */
export { supplyRouter } from './supply.routes';

/** Used by `listings` and the admin console to render the verification badge. */
export { verificationState, CADENCE_DAYS, RISK_WINDOW_DAYS } from './supply.service';
export type { VerificationState } from './supply.service';

/**
 * Exposed for the scheduler. Idempotent: every step guards itself, so running
 * it twice in a window changes nothing the first run did not already do.
 */
export { runEnforcementSweep } from './supply.service';

/**
 * Lot U: the listing importer (`party-imports`) opens one attempt per batch
 * and files each listing it created through `listings` under it, so the
 * publisher accepts one agreement for the whole file.
 */
export { createAttempt, attachListingToAttempt, getAttempt } from './supply.service';

/** O-B: the five supply gates counted, for `section-overviews` — the platform's state now, the same read `GET /supply/funnel` answers. */
export { getFunnel as supplyFunnel } from './supply.service';
export type { SupplyFunnel } from './supply.repository';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
