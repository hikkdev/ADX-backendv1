/**
 * The one thing QR resolution needs from another domain.
 *
 * Scanning a PUBLISHER-type QR claims that publisher for the scanning agent —
 * publisher onboarding logic, owned by the `publishers` module. But
 * `publishers` already imports `qr` to mint onboarding codes, so importing
 * `publishers` from here would close a cycle.
 *
 * Instead QR states what it needs as an interface and `publishers` registers an
 * implementation during bootstrap. `qr` depends on the shape, never the module.
 *
 * The two-step shape is not decoration: it preserves the original ordering,
 * where all validation happens first and only then are the QR deactivation and
 * the publisher claim issued together. Folding them into one call would burn
 * the QR code even when the claim turns out to be invalid.
 */

export type ClaimedPublisher = {
  id: string;
  name: string;
  mobile: string;
  type: string;
};

export interface PublisherOnboardingPort {
  /**
   * Validates that `publisherId` can be claimed and that `scannedByUserId` is
   * an agent. Performs no writes.
   *
   * Throws the QR_* sentinels the controller maps to status codes:
   * QR_NOT_FOUND, QR_ALREADY_CLAIMED, QR_ALREADY_COMPLETE, QR_ACCESS_DENIED.
   */
  prepareClaim(
    publisherId: string,
    scannedByUserId: string,
  ): Promise<{ publisher: ClaimedPublisher; agentId: string }>;

  /** Writes the claim. Only called after prepareClaim has passed. */
  commitClaim(publisherId: string, agentId: string): Promise<void>;
}

let registered: PublisherOnboardingPort | null = null;

export function registerPublisherOnboardingPort(port: PublisherOnboardingPort): void {
  registered = port;
}

export function publisherOnboardingPort(): PublisherOnboardingPort {
  if (!registered) {
    // Only reachable if bootstrap forgot to wire the module — fail loudly
    // rather than silently skipping the claim and logging a successful scan.
    throw new Error(
      'PublisherOnboardingPort not registered. bootstrap/register-modules must wire the publishers module.',
    );
  }
  return registered;
}
