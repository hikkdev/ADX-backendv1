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

/**
 * DS-1 (Digio eSign, 22 Sep 2026): e-signatures on the five documents. The
 * owning modules open a request (`openSigningRequest`) and read where a
 * party stands (`signingStanding` / `assertSigned`); bootstrap fills the
 * three ports (the policy, the messages, the completion hooks) and mounts
 * the webhook; `expireSigningRequests` is the sweep.
 */
export {
  DOCUMENT_OF,
  SIGNABLE_KINDS,
  SIGNING_PARTY_OF,
  assertSigned,
  expireSigningRequests,
  findSigningRequest,
  handleEsignWebhook,
  mySigningRequests,
  openSigningRequest,
  signingRequired,
  signingStanding,
  signingView,
} from './esign/esign.service';
export type { OpenSigningInput, SigningContext, SigningStanding, SigningView } from './esign/esign.service';
export { onSigningCompleted, registerEsignNotifyPort, registerEsignPolicyPort, resetSigningHooks } from './esign/esign.ports';
export type { EsignMessage, EsignNotifyPort, EsignPolicyPort, SigningCompletionHook } from './esign/esign.ports';
export { esignWebhookHandler } from './esign/esign.controller';
/** DS-3: the apps' two mid-flow documents and the slice every party read carries. */
export {
  assertPublisherLicenceSigned,
  insertionOrderSigning,
  insertionOrderSigningContext,
  openInsertionOrderSigning,
  publisherLicenceFor,
  publisherLicenceStanding,
  requestPublisherLicence,
  signingSlice,
} from './esign/esign.doors';
export type { InsertionOrderSigning, SigningSlice } from './esign/esign.doors';
export type { SigningRow, SignerState } from './esign/esign.repository';
