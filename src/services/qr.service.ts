import crypto from 'crypto';
import { prisma } from '../shared/database';
import { env } from '../config/env';
import type { QrType, Role } from '../shared/database';

// QR tokens are HMAC-SHA256 signed payloads encoded as base64url
// Format: base64url(JSON payload) + '.' + base64url(HMAC signature)
// This makes them opaque, tamper-proof, and only resolvable by our backend

const QR_SECRET = env.QR_SECRET;

type QrPayload = {
  id: string;    // QrCode.id
  type: QrType;
  refId: string;
  iat: number;   // issued at (unix ms)
};

function sign(payload: QrPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', QR_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token: string): QrPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid QR token format');
  const [data, sig] = parts as [string, string];
  const expected = crypto.createHmac('sha256', QR_SECRET).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'base64url'), Buffer.from(expected, 'base64url'))) {
    throw new Error('Invalid QR token signature');
  }
  return JSON.parse(Buffer.from(data, 'base64url').toString()) as QrPayload;
}

export async function generateQr(
  type: QrType,
  refId: string,
  allowedRoles: Role[] = [],
  metadata?: Record<string, unknown>,
): Promise<{ qrId: string; token: string }> {
  // Create a placeholder record to get the id, then sign with it
  const qr = await prisma.qrCode.create({
    data: { type, refId, allowedRoles, ...(metadata ? { metadata: metadata as any } : {}), token: `pending_${crypto.randomUUID()}` },
  });

  const payload: QrPayload = { id: qr.id, type, refId, iat: Date.now() };
  const token = sign(payload);

  await prisma.qrCode.update({ where: { id: qr.id }, data: { token } });

  return { qrId: qr.id, token };
}

export type QrResolution = {
  qrId: string;
  type: QrType;
  refId: string;
  metadata: unknown;
  action: 'ONBOARD_PUBLISHER' | 'ORDER_CHECKIN' | 'AD_HEALTH_CHECK' | 'AGENT_REFERRAL' | 'VIEW_ONLY';
  // Populated when action === 'ONBOARD_PUBLISHER'
  publisher?: {
    id: string;
    name: string;
    mobile: string;
    type: string;
  };
};

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
  const qr = await prisma.qrCode.findUnique({ where: { id: payload.id } });
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

  // 5. For PUBLISHER-type QRs (from the user app), validate + claim before logging the scan.
  // SITE-type QRs that resolve to ONBOARD_PUBLISHER are a different flow (legacy site check-in).
  if (action === 'ONBOARD_PUBLISHER' && qr.type === 'PUBLISHER') {
    const publisher = await prisma.publisher.findUnique({
      where: { id: qr.refId },
      select: { id: true, name: true, mobile: true, type: true, onboardingStatus: true },
    });

    if (!publisher) throw new Error('QR_NOT_FOUND');

    if (publisher.onboardingStatus === 'IN_ONBOARDING') {
      throw new Error('QR_ALREADY_CLAIMED');
    }
    if (publisher.onboardingStatus === 'ONBOARDING_COMPLETE') {
      throw new Error('QR_ALREADY_COMPLETE');
    }

    // Find the agent profile for the scanning user
    const agent = await prisma.agentProfile.findUnique({ where: { userId: scannedById } });
    if (!agent) throw new Error('QR_ACCESS_DENIED');

    // Claim: expire QR, set agentId, mark IN_ONBOARDING
    await Promise.all([
      prisma.qrCode.update({ where: { id: qr.id }, data: { isActive: false } }),
      prisma.publisher.update({
        where: { id: publisher.id },
        data: {
          agentId: agent.id,
          claimedAt: new Date(),
          onboardingStatus: 'IN_ONBOARDING',
        },
      }),
    ]);

    result.publisher = {
      id: publisher.id,
      name: publisher.name,
      mobile: publisher.mobile,
      type: publisher.type,
    };
  }

  // 6. Log the scan only after all validation passes
  await prisma.qrScan.create({
    data: {
      qrId: qr.id,
      scannedById,
      role: role ?? undefined,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      action,
    },
  });

  return result;
}

function resolveAction(type: QrType, role: Role | null): QrResolution['action'] {
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

export async function deactivateQr(qrId: string): Promise<void> {
  await prisma.qrCode.update({ where: { id: qrId }, data: { isActive: false } });
}

export async function getQrScans(qrId: string) {
  return prisma.qrScan.findMany({
    where: { qrId },
    include: { scannedBy: { select: { id: true, name: true, mobile: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getQrById(qrId: string) {
  return prisma.qrCode.findUnique({ where: { id: qrId } });
}
