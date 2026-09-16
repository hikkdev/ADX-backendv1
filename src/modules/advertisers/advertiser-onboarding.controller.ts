import type { Request, Response, Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { env } from '../../config/env';
import { qrErrorToApi } from '../qr';
import {
  decideMyOnboardingScan,
  getOnboardingQrStatus,
  getOrCreateOnboardingQr,
  getMyAccessLog,
} from './advertiser-onboarding.service';

/**
 * The advertiser's own door-to-door routes, mirroring the publisher's:
 *
 *   GET  /advertisers/me/qr?latitude&longitude
 *   GET  /advertisers/me/qr/status
 *   POST /advertisers/me/qr/scans/:scanId/approve
 *   POST /advertisers/me/qr/scans/:scanId/decline
 *
 * Registered onto the advertisers router by `registerOnboardingRoutes`, so
 * they sit with the other `/me` routes and ahead of `/:id`.
 */

async function myQrHandler(req: Request, res: Response): Promise<void> {
  const latitude = Number(req.query['latitude']);
  const longitude = Number(req.query['longitude']);
  const position =
    Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : undefined;
  const { qrId, token, expiresAt, created } = await getOrCreateOnboardingQr(req.user!.sub, position);
  const base = env.BASE_URL ?? '';
  res.status(created ? 201 : 200).json({
    success: true,
    data: { qrId, token, expiresAt, pngUrl: `${base}/api/v1/qr/${qrId}/image.png` },
  });
}

async function myQrStatusHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getOnboardingQrStatus(req.user!.sub) });
}

async function decideHandler(req: Request, res: Response): Promise<void> {
  const decision = req.path.endsWith('/approve') ? 'approve' : 'decline';
  try {
    res.json({
      success: true,
      data: await decideMyOnboardingScan(req.user!.sub, req.params['scanId'] as string, decision),
    });
  } catch (err) {
    qrErrorToApi(err);
  }
}

async function myAccessLogHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyAccessLog(req.user!.sub) });
}

export function registerOnboardingRoutes(router: Router): void {
  router.get('/me/qr', asyncHandler(myQrHandler));
  router.get('/me/qr/status', asyncHandler(myQrStatusHandler));
  router.post('/me/qr/scans/:scanId/approve', asyncHandler(decideHandler));
  router.post('/me/qr/scans/:scanId/decline', asyncHandler(decideHandler));
  // U9: who has had access to this account.
  router.get('/me/access-log', asyncHandler(myAccessLogHandler));
}
