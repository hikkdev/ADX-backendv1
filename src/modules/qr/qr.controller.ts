import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { env } from '../../config/env';
import type { QrType, Role } from '../../shared/database';
import {
  deactivateQrSchema,
  generateQrSchema,
  qrListQuerySchema,
  qrScansQuerySchema,
  resolveQrSchema,
  scansByQuerySchema,
} from './qr.schema';
import {
  deactivateQr,
  generateQr,
  getQrById,
  getScanForScanner,
  resolveQr,
  describeIdentityByToken,
  listQrCodes,
  listQrScans,
  listScansByFiltered,
  regenerateQr,
  imageUrls,
} from './qr.service';
import { IMAGE_CACHE_CONTROL, clampSize, renderQrImage, toDataUrl } from './qr.image';

/**
 * The service throws opaque QR_* sentinels so it stays free of HTTP concerns;
 * this is the single place they become status codes.
 */
const QR_ERROR_STATUS: Record<string, [number, 'BAD_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT', string]> = {
  QR_INVALID: [400, 'BAD_REQUEST', 'Invalid or tampered QR code'],
  QR_NOT_FOUND: [404, 'NOT_FOUND', 'QR code not found or inactive'],
  QR_ACCESS_DENIED: [403, 'FORBIDDEN', 'Your role cannot act on this QR code'],
  QR_ALREADY_CLAIMED: [409, 'CONFLICT', 'This publisher is already being onboarded by another agent.'],
  QR_ALREADY_COMPLETE: [409, 'CONFLICT', 'This publisher has already been onboarded.'],
  QR_EXPIRED: [409, 'CONFLICT', 'This code has expired. Ask them to show a fresh one.'],
  QR_ALREADY_USED: [409, 'CONFLICT', 'This code has already been used.'],
  QR_NOT_PENDING: [409, 'CONFLICT', 'Nothing is waiting for a decision on this code.'],
};

/** The sentinels, mapped, for handlers other than resolve. */
export function qrErrorToApi(err: unknown): never {
  const mapped = err instanceof Error ? QR_ERROR_STATUS[err.message] : undefined;
  if (!mapped) throw err;
  const [status, code, message] = mapped;
  throw new ApiError(status, code, message);
}

/** Loads an active QR code or 404s. Every image route starts here. */
async function requireActiveQr(qrId: string) {
  const qr = await getQrById(qrId);
  if (!qr || !qr.isActive) throw new ApiError(404, 'NOT_FOUND', 'QR code not found');
  return qr;
}

export async function generateQrHandler(req: Request, res: Response): Promise<void> {
  const parsed = generateQrSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { type, refId, allowedRoles, metadata } = parsed.data;
  const result = await generateQr(type as QrType, refId, allowedRoles as Role[], metadata);

  // K-B1: the desk's mint is audited against the admin who pressed it.
  await logActivity(req.user!.sub, 'QR_GENERATED', {
    req,
    module: 'qr',
    targetType: 'QrCode',
    targetId: result.qrId,
    diff: auditDiff(null, { type, refId, allowedRoles, expiresAt: result.expiresAt }),
    metadata: { type, refId, allowedRoles, generatedBy: req.user!.sub },
  });

  res.status(201).json({ success: true, data: result });
}

export async function resolveQrHandler(req: Request, res: Response): Promise<void> {
  const parsed = resolveQrSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { token, role, latitude, longitude, ask } = parsed.data;

  let result;
  try {
    result = await resolveQr(
      token,
      req.user!.sub,
      (role as Role) ?? null,
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
      ask,
    );
  } catch (err: any) {
    const mapped = QR_ERROR_STATUS[err?.message];
    if (!mapped) throw err;
    const [status, code, message] = mapped;
    throw new ApiError(status, code, message);
  }

  res.json({ success: true, data: result });
}

/** QR-27: `GET /qr/public/:token` — who an identity code belongs to, for the web landing; no session. */
export async function describeIdentityHandler(req: Request, res: Response): Promise<void> {
  const found = await describeIdentityByToken(String(req.params['token'] ?? ''));
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'That code is not one of ours, or it has been retired.');
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: found });
}

/** K-B1: `GET /qr/:qrId/scans` — the list contract, each row with the scanner's name. */
export async function getQrScansHandler(req: Request, res: Response): Promise<void> {
  const parsed = qrScansQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  try {
    res.json({ success: true, data: await listQrScans(req.params['qrId'] as string, parsed.data) });
  } catch (err) {
    qrErrorToApi(err);
  }
}

/** `DELETE /qr/:qrId { reason }` — K-B1: audited `QR_DEACTIVATED` with the desk's reason. */
export async function deactivateQrHandler(req: Request, res: Response): Promise<void> {
  const parsed = deactivateQrSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const qrId = req.params['qrId'] as string;
  const qr = await getQrById(qrId);
  if (!qr) throw new ApiError(404, 'NOT_FOUND', 'QR code not found');
  await deactivateQr(qrId);
  await logActivity(req.user!.sub, 'QR_DEACTIVATED', {
    req,
    module: 'qr',
    targetType: 'QrCode',
    targetId: qrId,
    diff: auditDiff({ isActive: qr.isActive }, { isActive: false }, ['isActive']),
    metadata: { type: qr.type, refId: qr.refId, reason: parsed.data.reason, deactivatedBy: req.user!.sub },
  });
  res.json({ success: true, data: { message: 'QR deactivated' } });
}

/** K-B1: `GET /qr?type=&active=&refId=&q=&page&pageSize` — the desk's list. */
export async function listQrHandler(req: Request, res: Response): Promise<void> {
  const parsed = qrListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await listQrCodes(parsed.data) });
}

/** K-B1: `POST /qr/:qrId/regenerate` — the old code dies, a new one for the same subject answers. */
export async function regenerateQrHandler(req: Request, res: Response): Promise<void> {
  let result;
  try {
    result = await regenerateQr(req.params['qrId'] as string);
  } catch (err) {
    qrErrorToApi(err);
  }
  const { previous, next } = result!;
  await logActivity(req.user!.sub, 'QR_REGENERATED', {
    req,
    module: 'qr',
    targetType: 'QrCode',
    targetId: next.id,
    diff: auditDiff({ qrId: previous.id, isActive: previous.isActive }, { qrId: next.id, isActive: next.isActive }, ['qrId', 'isActive']),
    metadata: { previousQrId: previous.id, type: next.type, refId: next.refId, regeneratedBy: req.user!.sub },
  });
  res.status(201).json({
    success: true,
    data: {
      id: next.id,
      type: next.type,
      refId: next.refId,
      token: next.token,
      isActive: next.isActive,
      expiresAt: next.expiresAt,
      createdAt: next.createdAt,
      previousQrId: previous.id,
      ...imageUrls(next.id),
    },
  });
}

/** QR-1: what a printed code's frame says — the code's purpose, never its ref. */
const PRINT_CAPTIONS: Partial<Record<QrType, string>> = {
  SITE: 'Scan to check in',
  AGENT: 'Scan to refer',
  ORDER: 'Scan to collect',
  AD: 'Scan to report',
};

// GET /qr/:qrId/image.png — QR-1: the engine's artwork for a printed type,
// the house style otherwise. `X-QR-Engine` / `X-QR-Styled` say which.
export async function qrImagePngHandler(req: Request, res: Response): Promise<void> {
  const qr = await requireActiveQr(req.params['qrId'] as string);
  const image = await renderQrImage(qr, 'png', clampSize(req.query['size']), PRINT_CAPTIONS[qr.type]);

  res.set('Content-Type', image.contentType);
  res.set('Cache-Control', IMAGE_CACHE_CONTROL);
  res.set('X-QR-Engine', image.engine);
  res.set('X-QR-Styled', image.styled ? 'true' : 'false');
  res.send(image.body);
}

// GET /qr/:qrId/image.svg — the same, as the vector a print designer wants.
export async function qrImageSvgHandler(req: Request, res: Response): Promise<void> {
  const qr = await requireActiveQr(req.params['qrId'] as string);
  const image = await renderQrImage(qr, 'svg', clampSize(req.query['size']), PRINT_CAPTIONS[qr.type]);

  res.set('Content-Type', image.contentType);
  res.set('Cache-Control', IMAGE_CACHE_CONTROL);
  res.set('X-QR-Engine', image.engine);
  res.set('X-QR-Styled', image.styled ? 'true' : 'false');
  res.send(image.body);
}

// GET /qr/:qrId — token + metadata + a data URL for embedding
export async function getQrHandler(req: Request, res: Response): Promise<void> {
  const qr = await requireActiveQr(req.params['qrId'] as string);
  const dataUrl = await toDataUrl(qr.token);

  // Absolute when BASE_URL is set, otherwise root-relative.
  const base = env.BASE_URL ?? '';
  res.json({
    success: true,
    data: {
      qrId: qr.id,
      type: qr.type,
      refId: qr.refId,
      token: qr.token,
      metadata: qr.metadata,
      isActive: qr.isActive,
      dataUrl,
      pngUrl: `${base}/api/v1/qr/${qr.id}/image.png`,
      svgUrl: `${base}/api/v1/qr/${qr.id}/image.svg`,
    },
  });
}

// GET /qr/scans/:scanId — what became of a scan, for the agent who made it
export async function getScanForScannerHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await getScanForScanner(req.params['scanId'] as string, req.user!.sub) });
  } catch (err) {
    qrErrorToApi(err);
  }
}

/**
 * D6 — `GET /qr/scans?scannedById=<userId>` (ADMIN): what one person has
 * scanned. K-B1: `&outcome=` and `&from=&to=` narrow it; `scannedBy` is the
 * spelling the console still sends and means the same. The array shape stays.
 */
export async function scansByHandler(req: Request, res: Response): Promise<void> {
  const parsed = scansByQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const { scannedById, outcome, from, to } = parsed.data;
  if (!scannedById) throw new ApiError(400, 'VALIDATION_ERROR', 'scannedById is required');
  res.json({ success: true, data: await listScansByFiltered({ scannedById, outcome, from, to }) });
}
