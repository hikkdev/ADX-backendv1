import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { env } from '../../config/env';
import type { QrType, Role } from '../../shared/database';
import { generateQrSchema, resolveQrSchema } from './qr.schema';
import { deactivateQr, generateQr, getQrById, getQrScans, resolveQr } from './qr.service';
import { IMAGE_CACHE_CONTROL, clampSize, toDataUrl, toPngBuffer, toSvg } from './qr.image';

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
};

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

  res.status(201).json({ success: true, data: result });
}

export async function resolveQrHandler(req: Request, res: Response): Promise<void> {
  const parsed = resolveQrSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { token, role, latitude, longitude } = parsed.data;

  let result;
  try {
    result = await resolveQr(
      token,
      req.user!.sub,
      (role as Role) ?? null,
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    );
  } catch (err: any) {
    const mapped = QR_ERROR_STATUS[err?.message];
    if (!mapped) throw err;
    const [status, code, message] = mapped;
    throw new ApiError(status, code, message);
  }

  res.json({ success: true, data: result });
}

export async function getQrScansHandler(req: Request, res: Response): Promise<void> {
  const scans = await getQrScans(req.params['qrId'] as string);
  res.json({ success: true, data: scans });
}

export async function deactivateQrHandler(req: Request, res: Response): Promise<void> {
  await deactivateQr(req.params['qrId'] as string);
  res.json({ success: true, data: { message: 'QR deactivated' } });
}

// GET /qr/:qrId/image.png — serves raw PNG
export async function qrImagePngHandler(req: Request, res: Response): Promise<void> {
  const qr = await requireActiveQr(req.params['qrId'] as string);
  const buffer = await toPngBuffer(qr.token, clampSize(req.query['size']));

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', IMAGE_CACHE_CONTROL);
  res.send(buffer);
}

// GET /qr/:qrId/image.svg — serves SVG string
export async function qrImageSvgHandler(req: Request, res: Response): Promise<void> {
  const qr = await requireActiveQr(req.params['qrId'] as string);
  const svg = await toSvg(qr.token);

  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', IMAGE_CACHE_CONTROL);
  res.send(svg);
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
