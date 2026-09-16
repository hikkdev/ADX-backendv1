import { registerAccessGrantPort } from '../qr';
import {
  commitGrantClaim,
  prepareGrantClaim,
} from './access-grants.service';

/**
 * Delegated access — a publisher lending an agent a limited hand.
 *
 * The platform's default is that an agent acts for the publishers they
 * onboarded and nobody else, and that default is load-bearing: listings feed the
 * comparable pools, so an agent who can edit any listing can move the market a
 * rival is measured against. This module is the sanctioned exception, granted by
 * the publisher, scoped, and self-closing.
 *
 * The claim behaviour a scan triggers is registered as a QR port rather than
 * imported, because `qr` would otherwise have to import this module while this
 * module imports `qr` to mint the code.
 */
export { accessGrantRouter } from './access-grants.routes';

/** The question every guarded write asks. Used by `listings`. */
export { holdsLiveGrant, liveGrantFor } from './access-grants.service';

/**
 * The door-to-door onboarding authority — opened by `publishers` when the
 * owner approves a scan, closed by it when the onboarding completes.
 */
export { openOnboardingGrant, closeOnboardingGrants, hasLiveOnboardingGrant } from './access-grants.service';
/** U9: the owner's log of scans, authorities and writes on their account. */
export { accessLogFor } from './access-grants.service';
/** K-B1: by grant id, for the QR desk (registered on qr's ref-label port by bootstrap). */
export { findAccessGrantLabels } from './access-grants.service';
export type { AccessLogView } from './access-grants.service';
export type { GrantSubject } from './access-grants.repository';

export function registerAccessGrantsModule(): void {
  registerAccessGrantPort({
    prepareClaim: prepareGrantClaim,
    commitClaim: commitGrantClaim,
  });
}

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
