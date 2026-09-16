import type { QrType } from '../../shared/database';

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

  /**
   * Writes the claim — attribution — and opens the authority the approval
   * grants. Only called after prepareClaim has passed, and only once the
   * owner has approved the scan. Returns the authority's id so the scan row
   * can carry it.
   */
  commitClaim(
    publisherId: string,
    agentId: string,
    context: { qrId: string; scanId: string },
  ): Promise<{ grantId: string | null }>;
}

/**
 * The second thing QR resolution needs from elsewhere.
 *
 * Scanning an ACCESS_GRANT code claims a delegated-access window — logic owned
 * by `access-grants`, which already imports `qr` to mint the code. Same cycle,
 * same answer: state the shape here and let the module register itself.
 */
export type ClaimedGrant = {
  grantId: string;
  publisherId: string;
  publisherName: string;
  /** What the publisher said they wanted changed. Shown to the agent. */
  reason: string;
  scope: string;
  listingIds: string[];
  durationMinutes: number;
  expiresAt: Date;
};

export interface AccessGrantPort {
  /**
   * Validates that this grant can be claimed by this scanner. No writes.
   *
   * Throws the same QR_* sentinels the controller already maps: QR_NOT_FOUND,
   * QR_ACCESS_DENIED for a scanner who is not the assigned agent,
   * QR_ALREADY_CLAIMED for a window that has already started.
   */
  prepareClaim(grantId: string, scannedByUserId: string): Promise<ClaimedGrant>;
  /** Starts the window. Only called after prepareClaim has passed. */
  commitClaim(grantId: string, expiresAt: Date, scannedByUserId: string): Promise<void>;
}

let registeredGrants: AccessGrantPort | null = null;

export function registerAccessGrantPort(port: AccessGrantPort): void {
  registeredGrants = port;
}

export function accessGrantPort(): AccessGrantPort {
  if (!registeredGrants) {
    throw new Error(
      'AccessGrantPort not registered. bootstrap/register-modules must wire the access-grants module.',
    );
  }
  return registeredGrants;
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

/**
 * The demand side of the same code. Scanning an ADVERTISER-type QR is
 * advertiser onboarding logic, owned by `advertisers`, which imports `qr`
 * to mint the code — the same cycle, the same answer.
 */
export type ClaimedAdvertiser = {
  id: string;
  name: string;
  mobile: string;
  type: string;
};

export interface AdvertiserOnboardingPort {
  prepareClaim(
    advertiserId: string,
    scannedByUserId: string,
  ): Promise<{ advertiser: ClaimedAdvertiser; agentId: string }>;
  commitClaim(
    advertiserId: string,
    agentId: string,
    context: { qrId: string; scanId: string },
  ): Promise<{ grantId: string | null }>;
}

let registeredAdvertisers: AdvertiserOnboardingPort | null = null;

export function registerAdvertiserOnboardingPort(port: AdvertiserOnboardingPort): void {
  registeredAdvertisers = port;
}

export function advertiserOnboardingPort(): AdvertiserOnboardingPort {
  if (!registeredAdvertisers) {
    throw new Error(
      'AdvertiserOnboardingPort not registered. bootstrap/register-modules must wire the advertisers module.',
    );
  }
  return registeredAdvertisers;
}

/* ------------------------------------------------------------------ */
/* K-B1: the ref-label port — the QR desk naming a code's subject      */
/* ------------------------------------------------------------------ */

/**
 * `GET /qr` prints, beside each code, what its `refId` names: the spot, the
 * agent, the order, the publisher, the advertiser, the access grant. Those
 * live in six modules that all import `qr` to mint codes, so — the same
 * cycle, the same answer — `qr` declares the shape and bootstrap registers
 * each module's own batch export (`findPublisherLabels`, `findOrderLabels`,
 * …). One batch per kind per page, never one query per row; a kind nobody
 * registered answers `label: null`, never an error.
 */
export type QrRefLabel = { id: string; label: string; displayId: string | null };
export type QrRefLabelResolver = (ids: string[]) => Promise<QrRefLabel[]>;
export type QrRefLabelPort = Partial<Record<QrType, QrRefLabelResolver>>;

let registeredRefLabels: QrRefLabelPort = {};

export function registerQrRefLabelPort(port: QrRefLabelPort): void {
  registeredRefLabels = { ...registeredRefLabels, ...port };
}

/** For tests. */
export function resetQrRefLabelPort(): void {
  registeredRefLabels = {};
}

export function qrRefLabelResolver(type: QrType): QrRefLabelResolver | null {
  return registeredRefLabels[type] ?? null;
}
