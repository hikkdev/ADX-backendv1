/**
 * QR — signed, tamper-proof codes and the scan log.
 *
 * Generic infrastructure for the platform's physical touchpoints: publisher
 * onboarding codes, site check-ins, ad health checks, agent referrals.
 *
 * The publisher-claim behaviour a scan triggers is NOT here. It is declared as
 * a port (`qr.ports.ts`) that the `publishers` module implements and bootstrap
 * registers, so `qr` never imports `publishers` — which would close a cycle,
 * since `publishers` imports `qr` to mint onboarding codes.
 */
export { qrRouter } from './qr.routes';

/** Used by `publishers` to mint and revoke onboarding codes. */
export {
  generateQr,
  deactivateQr,
  getQrById,
  findActiveQrFor,
  deactivateQrsFor,
  findPendingScan,
  decideOnboardingScan,
  ONBOARDING_QR_TTL_SECONDS,
  assertQrForRef,
  isSignedCodeFor,
  PICKUP_PURPOSE,
  confirmPickupHandover,
  listScansFor,
  listScansBy,
  getOrCreateIdentityQr,
  describeIdentity,
  askOf,
  tokenOf,
  isIdentityType,
  REQUESTED_GRANT_MINUTES,
} from './qr.service';
export type { ScanWithScanner } from './qr.repository';
export type { QrOptions } from './qr.service';
export { qrErrorToApi } from './qr.controller';

/**
 * Lot D (Q139): the renderer alone, for `campaigns` — a tracking code's QR
 * (`/t/:code`) is drawn in the house style so the artwork can embed it.
 * Rendering is stateless; the QrCode row and its scan log stay here.
 */
export { toPngBuffer, clampSize, IMAGE_CACHE_CONTROL } from './qr.image';

export {
  registerPublisherOnboardingPort,
  registerAdvertiserOnboardingPort,
  registerAccessGrantPort,
  registerQrRefLabelPort,
} from './qr.ports';
export type { QrRefLabelPort, QrRefLabel, IdentitySummary, AccessAsk } from './qr.ports';
export type {
  PublisherOnboardingPort,
  ClaimedPublisher,
  AdvertiserOnboardingPort,
  ClaimedAdvertiser,
  AccessGrantPort,
  ClaimedGrant,
} from './qr.ports';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
