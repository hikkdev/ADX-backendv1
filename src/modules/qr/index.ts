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
} from './qr.service';

export { registerPublisherOnboardingPort } from './qr.ports';
export type { PublisherOnboardingPort, ClaimedPublisher } from './qr.ports';
