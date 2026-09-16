/**
 * Agreements — the text each party accepts, versioned, and the record of who
 * accepted which version and when.
 *
 * Owns the lifecycle of `AgreementTemplate`: draft, live, superseded. Does not
 * own the click — `supply` records a publisher's acceptance and `advertisers`
 * an advertiser's, because activation hangs off it in each of those modules.
 * Both read the live version the same way this module writes it.
 */
export { agreementRouter } from './agreements.routes';

/** Which party a kind binds and which kind gates each party's activation. */
export { KIND_META, PLATFORM_KIND_FOR, templateState } from './agreements.service';

/**
 * E6: version 1 of each unseeded kind as a clearly marked placeholder DRAFT,
 * so ops have a row to edit at /agreements/templates. Never satisfies a
 * gate; never overwrites. Called at boot by bootstrap/register-modules.
 */
export { ensureAgreementDrafts, PLACEHOLDER_MARKER, SEEDED_KINDS } from './agreements.service';

/** Used by `account-lifecycle`: what a closing party has already signed (Lot A, Q21). */
export { countAcceptancesFor } from './agreements.service';
export type { TemplateState, TemplateView, PartyAgreements } from './agreements.service';
export type { PartyType } from './agreements.repository';

/**
 * Lot D (Q123): the click for the transaction kinds, recorded by the module
 * that owns the transaction — `campaigns` (INSERTION_ORDER, through
 * `advertisers`' route), `packages` (PACKAGE_SALE), `orders` (JOB_TERMS) —
 * and the questions their gates ask. `isCurrentAcceptance` is the one rule
 * behind Q55's re-acceptance: `advertisers` and `supply` apply it to their
 * platform clicks rather than restating it.
 */
export {
  ANCHOR_FOR,
  acceptInsertionOrder,
  currentTemplate,
  isCurrentAcceptance,
  platformStanding,
  recordAcceptance,
  renderInsertionOrder,
  staleParties,
  transactionAcceptance,
} from './agreements.service';
export type { AcceptanceContext, AgreementStanding, PlatformStanding } from './agreements.service';
export type { AcceptanceAnchor, AcceptanceParty, InsertionOrderSnapshot, StaleParty } from './agreements.repository';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
