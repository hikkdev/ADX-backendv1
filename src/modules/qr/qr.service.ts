import crypto from 'crypto';
import type { QrType, Role } from '../../shared/database';
import { prismaQrRepository as repository } from './prisma-qr.repository';
import { sign, verify, type QrPayload } from './qr.token';
import { publisherOnboardingPort, type ClaimedPublisher } from './qr.ports';

export type QrAction =
  | 'ONBOARD_PUBLISHER'
  | 'ORDER_CHECKIN'
  | 'AD_HEALTH_CHECK'
  | 'AGENT_REFERRAL'
  | 'VIEW_ONLY';

export type QrResolution = {
  qrId: string;
  type: QrType;
  refId: string;
  metadata: unknown;
  action: QrAction;
  /** Populated when action === 'ONBOARD_PUBLISHER' on a PUBLISHER-type code. */
  publisher?: ClaimedPublisher;
};

export async function generateQr(
  type: QrType,
  refId: string,
  allowedRoles: Role[] = [],
  metadata?: Record<string, unknown>,
): Promise<{ qrId: string; token: string }> {
  // The signature covers the row id, so the row has to exist first. It is
  // created with a throwaway token and immediately updated with the real one.
  const qr = await repository.createPlaceholder({
    type,
    refId,
    allowedRoles,
    metadata,
    token: `pending_${crypto.randomUUID()}`,
  });

  const payload: QrPayload = { id: qr.id, type, refId, iat: Date.now() };
  const token = sign(payload);

  await repository.setToken(qr.id, token);

  return { qrId: qr.id, token };
}

/**
 * What a scan means, given the code's type and the scanner's role.
 *
 * Anything unrecognised degrades to VIEW_ONLY rather than failing, so an older
 * app scanning a newer code type still gets a sensible response.
 */
function resolveAction(type: QrType, role: Role | null): QrAction {
  switch (type) {
    case 'PUBLISHER':
      // Publisher identity QR — only agent publishers can act on it
      if (role === 'AGENT_PUBLISHER') return 'ONBOARD_PUBLISHER';
      return 'VIEW_ONLY';

    case 'SITE':
      if (role === 'AGENT_PUBLISHER') return 'ONBOARD_PUBLISHER';
      if (role === 'AGENT_ADVERTISER') return 'ORDER_CHECKIN';
      return 'VIEW_ONLY';

    case 'AD':
      return 'AD_HEALTH_CHECK';

    case 'AGENT':
      return 'AGENT_REFERRAL';

    case 'ORDER':
      return 'ORDER_CHECKIN';

    default:
      return 'VIEW_ONLY';
  }
}

export async function resolveQr(
  token: string,
  scannedById: string,
  role: Role | null,
  coords?: { latitude: number; longitude: number },
): Promise<QrResolution> {
  // 1. Verify signature
  let payload: QrPayload;
  try {
    payload = verify(token);
  } catch {
    throw new Error('QR_INVALID');
  }

  // 2. Load from DB
  const qr = await repository.findById(payload.id);
  if (!qr || !qr.isActive) throw new Error('QR_NOT_FOUND');

  // 3. Role-based access check
  if (qr.allowedRoles.length > 0 && role && !qr.allowedRoles.includes(role)) {
    throw new Error('QR_ACCESS_DENIED');
  }

  // 4. Determine action based on type + scanning user's role
  const action = resolveAction(qr.type, role);

  const result: QrResolution = {
    qrId: qr.id,
    type: qr.type,
    refId: qr.refId,
    metadata: qr.metadata,
    action,
  };

  // 5. For PUBLISHER-type QRs (from the user app), validate + claim before
  // logging the scan. SITE-type QRs that resolve to ONBOARD_PUBLISHER are a
  // different flow (legacy site check-in) and are deliberately not claimed.
  if (action === 'ONBOARD_PUBLISHER' && qr.type === 'PUBLISHER') {
    const port = publisherOnboardingPort();

    // Validate everything first, then burn the code and write the claim
    // together — so a rejected claim never leaves the QR deactivated.
    const { publisher, agentId } = await port.prepareClaim(qr.refId, scannedById);
    await Promise.all([repository.deactivate(qr.id), port.commitClaim(publisher.id, agentId)]);

    result.publisher = publisher;
  }

  // 6. Log the scan only after all validation passes
  await repository.logScan({
    qrId: qr.id,
    scannedById,
    role: role ?? undefined,
    latitude: coords?.latitude,
    longitude: coords?.longitude,
    action,
  });

  return result;
}

export async function deactivateQr(qrId: string): Promise<void> {
  await repository.deactivate(qrId);
}

export async function getQrScans(qrId: string) {
  return repository.findScans(qrId);
}

export async function getQrById(qrId: string) {
  return repository.findById(qrId);
}

/**
 * The live code issued for a subject, e.g. the onboarding QR a publisher is
 * currently showing. Exposed so other modules never query QrCode themselves.
 */
export async function findActiveQrFor(type: QrType, refId: string) {
  return repository.findActiveForSubject(type, refId);
}

/** Expires every live code for a subject. */
export async function deactivateQrsFor(type: QrType, refId: string): Promise<void> {
  await repository.deactivateForSubject(type, refId);
}
