import crypto from 'crypto';
import { env } from '../../config/env';
import type { QrCode, QrType, Role } from '../../shared/database';
import { listArgs, toListPage, type ListPage } from '../../shared/pagination';
import { prismaQrRepository as repository } from './prisma-qr.repository';
import type { ScansByFilter } from './qr.repository';
import { QR_TYPES, type QrListQuery, type QrScansQuery } from './qr.schema';
import { sign, verify, type QrPayload } from './qr.token';
import {
  accessGrantPort,
  advertiserOnboardingPort,
  publisherOnboardingPort,
  qrRefLabelResolver,
  type ClaimedAdvertiser,
  type ClaimedGrant,
  type ClaimedPublisher,
} from './qr.ports';

export type QrAction =
  | 'ONBOARD_PUBLISHER'
  | 'ONBOARD_ADVERTISER'
  | 'ORDER_CHECKIN'
  /** The pickup code on the material package — an ORDER code minted at print-ready. */
  | 'PICKUP_MATERIAL'
  | 'AD_HEALTH_CHECK'
  | 'AGENT_REFERRAL'
  | 'CLAIM_ACCESS_GRANT'
  | 'VIEW_ONLY';

export type QrResolution = {
  qrId: string;
  type: QrType;
  refId: string;
  metadata: unknown;
  action: QrAction;
  /**
   * An onboarding code: the scan is logged and nothing is claimed until the
   * person whose code it is approves it from their own phone. `scanId` is
   * what the agent's app polls.
   */
  pendingApproval?: boolean;
  scanId?: string;
  /** Metres between where the code was made and where it was scanned, when both fixes exist. */
  distanceM?: number | null;
  /** Populated when action === 'ONBOARD_PUBLISHER' on a PUBLISHER-type code. */
  publisher?: ClaimedPublisher;
  /** Populated when action === 'ONBOARD_ADVERTISER' on an ADVERTISER-type code. */
  advertiser?: ClaimedAdvertiser;
  /** Populated when action === 'CLAIM_ACCESS_GRANT'. Says what was granted. */
  grant?: ClaimedGrant;
};

/** How long a door-to-door onboarding code lives. Settled at ninety seconds. */
export const ONBOARDING_QR_TTL_SECONDS = 90;
/** How long the owner has to approve a scan after it happens. */
export const APPROVAL_WINDOW_SECONDS = 5 * 60;

export type QrOptions = {
  /** Seconds until the code dies on its own. Omit for a code that does not expire. */
  expiresInSeconds?: number;
  /** Where the issuer is, so a scan can be measured against it. */
  position?: { latitude: number; longitude: number };
};

export async function generateQr(
  type: QrType,
  refId: string,
  allowedRoles: Role[] = [],
  metadata?: Record<string, unknown>,
  options: QrOptions = {},
): Promise<{ qrId: string; token: string; expiresAt: Date | null }> {
  const expiresAt =
    options.expiresInSeconds === undefined ? null : new Date(Date.now() + options.expiresInSeconds * 1000);
  // The signature covers the row id, so the row has to exist first. It is
  // created with a throwaway token and immediately updated with the real one.
  const qr = await repository.createPlaceholder({
    type,
    refId,
    allowedRoles,
    metadata,
    token: `pending_${crypto.randomUUID()}`,
    expiresAt: expiresAt ?? undefined,
    latitude: options.position?.latitude,
    longitude: options.position?.longitude,
  });

  const payload: QrPayload = { id: qr.id, type, refId, iat: Date.now() };
  const token = sign(payload);

  await repository.setToken(qr.id, token);

  return { qrId: qr.id, token, expiresAt };
}

/** Metres between two fixes, great-circle. */
export function distanceMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

/**
 * Both onboarding codes behave the same way; only the module behind them
 * differs. This is the one shape the scan and the decision speak to.
 */
type ClaimPort = {
  kind: 'publisher' | 'advertiser';
  prepare: (refId: string, scannedByUserId: string) => Promise<{ party: ClaimedPublisher | ClaimedAdvertiser; agentId: string }>;
  commit: (refId: string, agentId: string, context: { qrId: string; scanId: string }) => Promise<{ grantId: string | null }>;
};

function claimPortFor(type: QrType, action: QrAction): ClaimPort | null {
  if (type === 'PUBLISHER' && action === 'ONBOARD_PUBLISHER') {
    const port = publisherOnboardingPort();
    return {
      kind: 'publisher',
      prepare: async (refId, userId) => {
        const { publisher, agentId } = await port.prepareClaim(refId, userId);
        return { party: publisher, agentId };
      },
      commit: (refId, agentId, context) => port.commitClaim(refId, agentId, context),
    };
  }
  if (type === 'ADVERTISER' && action === 'ONBOARD_ADVERTISER') {
    const port = advertiserOnboardingPort();
    return {
      kind: 'advertiser',
      prepare: async (refId, userId) => {
        const { advertiser, agentId } = await port.prepareClaim(refId, userId);
        return { party: advertiser, agentId };
      },
      commit: (refId, agentId, context) => port.commitClaim(refId, agentId, context),
    };
  }
  return null;
}

const isExpired = (qr: { expiresAt: Date | null }, now = new Date()) =>
  qr.expiresAt !== null && qr.expiresAt.getTime() <= now.getTime();

/**
 * What a scan means, given the code's type and the scanner's role.
 *
 * Anything unrecognised degrades to VIEW_ONLY rather than failing, so an older
 * app scanning a newer code type still gets a sensible response.
 */
/** What an ORDER code is for. Print-ready mints one with `purpose: PICKUP`. */
export const PICKUP_PURPOSE = 'PICKUP';

function purposeOf(metadata: unknown): string | null {
  const purpose = (metadata as { purpose?: unknown } | null)?.purpose;
  return typeof purpose === 'string' ? purpose : null;
}

function resolveAction(type: QrType, role: Role | null, purpose: string | null = null): QrAction {
  switch (type) {
    case 'PUBLISHER':
      // Publisher identity QR — only agent publishers can act on it
      if (role === 'AGENT_PUBLISHER') return 'ONBOARD_PUBLISHER';
      return 'VIEW_ONLY';

    case 'ADVERTISER':
      // The demand side's door-to-door code — only advertiser agents act on it.
      if (role === 'AGENT_ADVERTISER') return 'ONBOARD_ADVERTISER';
      return 'VIEW_ONLY';

    case 'ACCESS_GRANT':
      // Delegated access. The role gate is the coarse one; the grant itself
      // names a single agent, and the claim checks that.
      if (role === 'AGENT_PUBLISHER') return 'CLAIM_ACCESS_GRANT';
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
      // The pickup code is the third thing an agent scans (DR 01 · Scan QR
      // Material Verification): only the publisher-side agent acts on it.
      // Without the purpose an ORDER code is the site check-in it always was.
      if (purpose === PICKUP_PURPOSE) return role === 'AGENT_PUBLISHER' ? 'PICKUP_MATERIAL' : 'VIEW_ONLY';
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
  if (!qr) throw new Error('QR_NOT_FOUND');

  // Every attempt on a code that exists is a row, refusals included — this is
  // the log of exactly who scanned what and when, which the door-to-door
  // model depends on. A refusal is written, then thrown.
  const refuse = async (outcome: string, sentinel: string): Promise<never> => {
    await repository.logScan({
      qrId: qr.id,
      scannedById,
      role: role ?? undefined,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      action: 'REFUSED',
      outcome,
    });
    throw new Error(sentinel);
  };

  if (!qr.isActive) return refuse('ALREADY_USED', 'QR_ALREADY_USED');
  if (isExpired(qr)) return refuse('EXPIRED', 'QR_EXPIRED');

  // 3. Role-based access check
  if (qr.allowedRoles.length > 0 && role && !qr.allowedRoles.includes(role)) {
    return refuse('NOT_AN_AGENT', 'QR_ACCESS_DENIED');
  }

  // 4. Determine action based on type + scanning user's role
  const action = resolveAction(qr.type, role, purposeOf(qr.metadata));

  const result: QrResolution = {
    qrId: qr.id,
    type: qr.type,
    refId: qr.refId,
    metadata: qr.metadata,
    action,
  };

  const distanceM =
    coords && qr.latitude !== null && qr.longitude !== null
      ? distanceMetres({ latitude: qr.latitude, longitude: qr.longitude }, coords)
      : undefined;

  // 5. An onboarding code (from the user app) claims nothing on the scan. The
  // agent's identity and the publisher's state are checked now, so a refusal
  // is immediate; then the scan waits for the person whose code it is to
  // approve it from their own phone. SITE-type codes that resolve to
  // ONBOARD_PUBLISHER are a different flow (legacy site check-in) and are
  // deliberately not claimed.
  const claim = claimPortFor(qr.type, action);
  if (claim) {
    let prepared;
    try {
      prepared = await claim.prepare(qr.refId, scannedById);
    } catch (cause) {
      const sentinel = cause instanceof Error ? cause.message : 'QR_ACCESS_DENIED';
      return refuse(sentinel === 'QR_ACCESS_DENIED' ? 'NOT_AN_AGENT' : 'ALREADY_USED', sentinel);
    }
    const scan = await repository.logScan({
      qrId: qr.id,
      scannedById,
      role: role ?? undefined,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      action,
      outcome: 'PENDING_APPROVAL',
      distanceM,
    });
    if (claim.kind === 'publisher') result.publisher = prepared.party;
    else result.advertiser = prepared.party;
    result.pendingApproval = true;
    result.scanId = scan.id;
    result.distanceM = distanceM ?? null;
    return result;
  }

  // Same two-step shape, same reason: validate everything, then burn the code
  // and start the window together. A refused scan must not leave the publisher
  // holding a dead code they would have to regenerate.
  if (action === 'CLAIM_ACCESS_GRANT') {
    const port = accessGrantPort();
    const grant = await port.prepareClaim(qr.refId, scannedById);
    await Promise.all([
      repository.deactivate(qr.id),
      port.commitClaim(grant.grantId, grant.expiresAt, scannedById),
    ]);
    result.grant = grant;
  }

  // 6. Log the scan only after all validation passes
  await repository.logScan({
    qrId: qr.id,
    scannedById,
    role: role ?? undefined,
    latitude: coords?.latitude,
    longitude: coords?.longitude,
    action,
    outcome: 'GRANTED',
    distanceM,
  });

  return result;
}

/** The scan on an onboarding code that is waiting for its owner, if any. */
export async function findPendingScan(qrId: string) {
  return repository.findPendingScan(qrId);
}

/**
 * The owner's answer to a scan — the second party of the two-party grant.
 *
 * Approving is what a scan used to do by itself: the code is burnt and the
 * claim committed together, and the authority the port opens is recorded on
 * the scan. Declining burns the code too — it was one-time — and records
 * that the person said no. Either way the decision must land within the
 * approval window, or the scan has expired and so has the code.
 */
export async function decideOnboardingScan(
  scanId: string,
  refId: string,
  decision: 'approve' | 'decline',
): Promise<{ outcome: 'GRANTED' | 'USER_DECLINED'; grantId: string | null }> {
  const scan = await repository.findScanById(scanId);
  if (!scan) throw new Error('QR_NOT_FOUND');
  const qr = await repository.findById(scan.qrId);
  if (!qr || qr.refId !== refId) throw new Error('QR_NOT_FOUND');
  const claim = claimPortFor(qr.type, resolveAction(qr.type, qr.type === 'ADVERTISER' ? 'AGENT_ADVERTISER' : 'AGENT_PUBLISHER'));
  if (!claim) throw new Error('QR_NOT_FOUND');
  if (scan.outcome !== 'PENDING_APPROVAL') throw new Error('QR_NOT_PENDING');

  if (scan.createdAt.getTime() + APPROVAL_WINDOW_SECONDS * 1000 <= Date.now()) {
    await Promise.all([
      repository.updateScan(scan.id, { outcome: 'EXPIRED', decidedAt: new Date() }),
      repository.deactivate(qr.id),
    ]);
    throw new Error('QR_EXPIRED');
  }

  if (decision === 'decline') {
    await Promise.all([
      repository.updateScan(scan.id, { outcome: 'USER_DECLINED', decidedAt: new Date() }),
      repository.deactivate(qr.id),
    ]);
    return { outcome: 'USER_DECLINED', grantId: null };
  }

  // Validated again: the account's state may have moved since the scan.
  const { party, agentId } = await claim.prepare(qr.refId, scan.scannedById);
  await repository.deactivate(qr.id);
  const { grantId } = await claim.commit(party.id, agentId, { qrId: qr.id, scanId: scan.id });
  await repository.updateScan(scan.id, {
    outcome: 'GRANTED',
    decidedAt: new Date(),
    grantId: grantId ?? undefined,
  });
  return { outcome: 'GRANTED', grantId };
}

/** What became of a scan, for the agent who made it — and only for them. */
export async function getScanForScanner(scanId: string, userId: string) {
  const scan = await repository.findScanById(scanId);
  if (!scan || scan.scannedById !== userId) throw new Error('QR_NOT_FOUND');
  return {
    id: scan.id,
    qrId: scan.qrId,
    outcome: scan.outcome,
    decidedAt: scan.decidedAt,
    grantId: scan.grantId,
    distanceM: scan.distanceM,
    createdAt: scan.createdAt,
  };
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

/** D6: every scan one person made, newest first, each with its code. */
export async function listScansBy(userId: string) {
  return repository.findScansByScanner(userId);
}

/** U9: every scan of a subject's codes, newest first — refusals included. */
export async function listScansFor(type: QrType, refId: string) {
  return repository.findScansForSubject(type, refId);
}

/**
 * The one question the pickup step asks: is this the live code for THIS
 * subject. The scan itself was already verified and logged by `resolveQr`;
 * this is the check when the id comes back with the action it authorised.
 */
export async function assertQrForRef(qrId: string, type: QrType, refId: string): Promise<void> {
  const qr = await repository.findById(qrId);
  if (!qr || !qr.isActive || qr.type !== type || qr.refId !== refId) throw new Error('QR_MISMATCH');
}

/**
 * Whether a scanned string is a signed code for one of the given references —
 * a SITE code for the listing or an ORDER code for the order. The site
 * check-in compares the scan to `Listing.qrToken` first; this is the other
 * half, so a signed site code, if one is ever printed, is not refused as a
 * mismatch. Unsigned or foreign strings are simply false, never an error.
 */
/**
 * Lot H: the print partner's handover scan. The partner scans the pickup
 * code the agent holds — the ORDER code with `purpose: PICKUP` that
 * `print-ready` minted for this order — and the job goes COLLECTED on the
 * partner's side too. The scan is written down like every other (action
 * PICKUP_HANDOVER, role PARTNER), so the log shows who handed what over
 * and when. Throws `QR_INVALID` for a string that is not a signed code,
 * `QR_MISMATCH` for a code that is not this order's live pickup code.
 */
export async function confirmPickupHandover(
  token: string,
  orderId: string,
  scannedById: string,
): Promise<{ qrId: string }> {
  let payload: QrPayload;
  try {
    payload = verify(token);
  } catch {
    throw new Error('QR_INVALID');
  }
  const qr = await repository.findById(payload.id);
  if (!qr || !qr.isActive || qr.type !== 'ORDER' || qr.refId !== orderId || purposeOf(qr.metadata) !== PICKUP_PURPOSE) {
    throw new Error('QR_MISMATCH');
  }
  await repository.logScan({ qrId: qr.id, scannedById, role: 'PARTNER', action: 'PICKUP_HANDOVER', outcome: 'GRANTED' });
  return { qrId: qr.id };
}

export async function isSignedCodeFor(token: string, refs: { listingId?: string; orderId?: string }): Promise<boolean> {
  let payload: QrPayload;
  try {
    payload = verify(token);
  } catch {
    return false;
  }
  const qr = await repository.findById(payload.id);
  if (!qr || !qr.isActive) return false;
  if (qr.type === 'SITE' && refs.listingId && qr.refId === refs.listingId) return true;
  if (qr.type === 'ORDER' && refs.orderId && qr.refId === refs.orderId) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* K-B1: the QR desk                                                   */
/* ------------------------------------------------------------------ */

export type QrRef = { kind: string; id: string; label: string | null; displayId: string | null; href: string | null };

export type QrDeskItem = {
  id: string;
  type: QrType;
  refId: string;
  ref: QrRef;
  isActive: boolean;
  expiresAt: Date | null;
  scansCount: number;
  lastScanAt: Date | null;
  createdAt: Date;
  imagePngUrl: string;
  imageSvgUrl: string;
};

/** What each code type's `refId` names, and where the console goes for it. */
const REF_KIND: Record<QrType, { kind: string; href: (id: string) => string }> = {
  SITE: { kind: 'listing', href: (id) => `/listings/${id}` },
  AD: { kind: 'ad', href: (id) => `/ads/${id}` },
  AGENT: { kind: 'agent', href: (id) => `/agents/${id}` },
  ORDER: { kind: 'order', href: (id) => `/orders/${id}` },
  PUBLISHER: { kind: 'publisher', href: (id) => `/publishers/${id}` },
  ADVERTISER: { kind: 'advertiser', href: (id) => `/advertisers/${id}` },
  ACCESS_GRANT: { kind: 'access-grant', href: (id) => `/access-grants/${id}` },
};

export function imageUrls(qrId: string, base = env.BASE_URL ?? ''): { imagePngUrl: string; imageSvgUrl: string } {
  return { imagePngUrl: `${base}/api/v1/qr/${qrId}/image.png`, imageSvgUrl: `${base}/api/v1/qr/${qrId}/image.svg` };
}

/**
 * Names every code's subject on a page — one batch per kind, through the
 * resolver bootstrap registered for it. A kind with no resolver, or an id
 * the module no longer has, answers `label: null` rather than failing the
 * page: a code can outlive what it pointed at.
 */
export async function resolveRefs(codes: readonly { type: QrType; refId: string }[]): Promise<Map<string, QrRef>> {
  const byType = new Map<QrType, Set<string>>();
  for (const code of codes) {
    if (!byType.has(code.type)) byType.set(code.type, new Set());
    byType.get(code.type)!.add(code.refId);
  }
  const out = new Map<string, QrRef>();
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const resolver = qrRefLabelResolver(type);
      const spec = REF_KIND[type] ?? { kind: type.toLowerCase(), href: () => null };
      const labels = new Map<string, { label: string; displayId: string | null }>();
      if (resolver) {
        for (const row of await resolver([...ids])) labels.set(row.id, { label: row.label, displayId: row.displayId });
      }
      for (const id of ids) {
        const found = labels.get(id);
        out.set(`${type}:${id}`, {
          kind: spec.kind,
          id,
          label: found?.label ?? null,
          displayId: found?.displayId ?? null,
          href: found ? spec.href(id) : null,
        });
      }
    }),
  );
  return out;
}

/** `GET /qr` — the desk's list, the list contract with counts per type. */
export async function listQrCodes(query: QrListQuery): Promise<ListPage<QrDeskItem>> {
  const filter = { type: query.type as QrType | undefined, active: query.active, refId: query.refId, q: query.q };
  const [{ rows, total }, groups] = await Promise.all([
    repository.findDeskPage(filter, listArgs(query)),
    repository.countDeskByType({ active: filter.active, refId: filter.refId, q: filter.q }),
  ]);
  const refs = await resolveRefs(rows);
  const items = rows.map((row) => ({
    id: row.id,
    type: row.type,
    refId: row.refId,
    ref: refs.get(`${row.type}:${row.refId}`)!,
    isActive: row.isActive,
    expiresAt: row.expiresAt,
    scansCount: row.scansCount,
    lastScanAt: row.lastScanAt,
    createdAt: row.createdAt,
    ...imageUrls(row.id),
  }));
  const counts: Record<string, number> = {};
  for (const type of QR_TYPES) counts[type] = 0;
  for (const group of groups) counts[group.type] = group.count;
  return toListPage(items, total, counts, query);
}

/** `GET /qr/:qrId/scans` — one code's scans, the list contract, each with the scanner's name. */
export async function listQrScans(qrId: string, query: QrScansQuery) {
  const qr = await repository.findById(qrId);
  if (!qr) throw new Error('QR_NOT_FOUND');
  const { rows, total, counts } = await repository.findScansPage(qrId, { outcome: query.outcome }, listArgs(query));
  const items = rows.map((scan) => ({
    id: scan.id,
    qrId: scan.qrId,
    scannedBy: { id: scan.scannedBy.id, name: scan.scannedBy.name ?? scan.scannedBy.mobile, mobile: scan.scannedBy.mobile },
    role: scan.role,
    action: scan.action,
    outcome: scan.outcome,
    latitude: scan.latitude,
    longitude: scan.longitude,
    distanceM: scan.distanceM,
    decidedAt: scan.decidedAt,
    grantId: scan.grantId,
    createdAt: scan.createdAt,
  }));
  return toListPage(items, total, counts, query);
}

/** D6 + K-B1: one person's scans, narrowed by outcome and window. */
export async function listScansByFiltered(filter: ScansByFilter) {
  return repository.findScansByScannerFiltered(filter);
}

/**
 * `POST /qr/:qrId/regenerate` — the old code is deactivated and a fresh
 * token issued for the same type, ref, roles, metadata and expiry, in that
 * order: the printed code stops working the moment the new one exists, and
 * a scan of the old one is refused (`ALREADY_USED`) rather than resolved.
 * A code that is already inactive can still be regenerated — that is the
 * point of the button after a deactivation.
 */
export async function regenerateQr(qrId: string): Promise<{ previous: QrCode; next: QrCode }> {
  const previous = await repository.findById(qrId);
  if (!previous) throw new Error('QR_NOT_FOUND');
  if (previous.isActive) await repository.deactivate(previous.id);
  const expiresInSeconds =
    previous.expiresAt === null ? undefined : Math.max(1, Math.round((previous.expiresAt.getTime() - Date.now()) / 1000));
  const position =
    previous.latitude !== null && previous.longitude !== null ? { latitude: previous.latitude, longitude: previous.longitude } : undefined;
  const { qrId: nextId } = await generateQr(
    previous.type,
    previous.refId,
    previous.allowedRoles,
    (previous.metadata as Record<string, unknown> | null) ?? undefined,
    { expiresInSeconds, position },
  );
  const next = await repository.findById(nextId);
  if (!next) throw new Error('QR_NOT_FOUND');
  return { previous, next };
}
