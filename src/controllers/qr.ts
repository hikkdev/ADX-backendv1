import type { Request, Response } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { upperEnum } from '../shared/validation';
import { env } from '../config/env';
import { generateQr, resolveQr, deactivateQr, getQrScans, getQrById } from '../services/qr.service';
import type { QrType, Role } from '../shared/database';

const generateSchema = z.object({
  type: upperEnum(['SITE', 'AD', 'AGENT', 'ORDER', 'PUBLISHER'] as const),
  refId: z.string().min(1),
  allowedRoles: z.array(upperEnum(['AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'PUBLISHER', 'ADVERTISER', 'ADMIN'] as const)).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const resolveSchema = z.object({
  token: z.string().min(1),
  role: upperEnum(['AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'PUBLISHER', 'ADVERTISER', 'ADMIN'] as const).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

export async function generateQrHandler(req: Request, res: Response): Promise<void> {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { type, refId, allowedRoles, metadata } = parsed.data;
  const result = await generateQr(type as QrType, refId, allowedRoles as Role[], metadata);

  res.status(201).json({ success: true, data: result });
}

export async function resolveQrHandler(req: Request, res: Response): Promise<void> {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { token, role, latitude, longitude } = parsed.data;
  const userId = req.user!.sub;

  let result;
  try {
    result = await resolveQr(
      token,
      userId,
      (role as Role) ?? null,
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    );
  } catch (err: any) {
    if (err.message === 'QR_INVALID') throw new ApiError(400, 'BAD_REQUEST', 'Invalid or tampered QR code');
    if (err.message === 'QR_NOT_FOUND') throw new ApiError(404, 'NOT_FOUND', 'QR code not found or inactive');
    if (err.message === 'QR_ACCESS_DENIED') throw new ApiError(403, 'FORBIDDEN', 'Your role cannot act on this QR code');
    if (err.message === 'QR_ALREADY_CLAIMED') throw new ApiError(409, 'CONFLICT', 'This publisher is already being onboarded by another agent.');
    if (err.message === 'QR_ALREADY_COMPLETE') throw new ApiError(409, 'CONFLICT', 'This publisher has already been onboarded.');
    throw err;
  }

  res.json({ success: true, data: result });
}

export async function getQrScansHandler(req: Request, res: Response): Promise<void> {
  const qrId = req.params['qrId'] as string;
  const scans = await getQrScans(qrId);
  res.json({ success: true, data: scans });
}

export async function deactivateQrHandler(req: Request, res: Response): Promise<void> {
  const qrId = req.params['qrId'] as string;
  await deactivateQr(qrId);
  res.json({ success: true, data: { message: 'QR deactivated' } });
}

// GET /qr/:qrId/image.png  — serves raw PNG
export async function qrImagePngHandler(req: Request, res: Response): Promise<void> {
  const qrId = req.params['qrId'] as string;
  const qr = await getQrById(qrId);
  if (!qr || !qr.isActive) throw new ApiError(404, 'NOT_FOUND', 'QR code not found');

  const size = Math.min(Math.max(parseInt(req.query['size'] as string ?? '300', 10), 100), 1000);

  const buffer = await QRCode.toBuffer(qr.token, {
    type: 'png',
    width: size,
    margin: 2,
    color: { dark: '#213333', light: '#FFFFFF' },
  });

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
}

// GET /qr/:qrId/image.svg  — serves SVG string
export async function qrImageSvgHandler(req: Request, res: Response): Promise<void> {
  const qrId = req.params['qrId'] as string;
  const qr = await getQrById(qrId);
  if (!qr || !qr.isActive) throw new ApiError(404, 'NOT_FOUND', 'QR code not found');

  const svg = await QRCode.toString(qr.token, {
    type: 'svg',
    margin: 2,
    color: { dark: '#213333', light: '#FFFFFF' },
  });

  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
}

// GET /qr/:qrId  — returns token + metadata + data URL for embedding
export async function getQrHandler(req: Request, res: Response): Promise<void> {
  const qrId = req.params['qrId'] as string;
  const qr = await getQrById(qrId);
  if (!qr || !qr.isActive) throw new ApiError(404, 'NOT_FOUND', 'QR code not found');

  const dataUrl = await QRCode.toDataURL(qr.token, {
    type: 'image/png',
    width: 300,
    margin: 2,
    color: { dark: '#213333', light: '#FFFFFF' },
  });

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
