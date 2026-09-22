import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  generateQrHandler,
  resolveQrHandler,
  getScanForScannerHandler,
  getQrScansHandler,
  deactivateQrHandler,
  getQrHandler,
  qrImagePngHandler,
  qrImageSvgHandler,
  describeIdentityHandler,
  scansByHandler,
  listQrHandler,
  regenerateQrHandler,
} from './qr.controller';

export const qrRouter = Router();

// QR image serving — public, no auth. An <img> tag cannot send an
// Authorization header, so these must stay registered ABOVE the authenticate
// layer below. Moving them down turns every rendered QR into a broken image.
qrRouter.get('/:qrId/image.png', asyncHandler(qrImagePngHandler));
qrRouter.get('/:qrId/image.svg', asyncHandler(qrImageSvgHandler));
// QR-27: the web landing behind an identity code's link — public, like the images.
qrRouter.get('/public/:token', asyncHandler(describeIdentityHandler));

qrRouter.use(authenticate);

// Scan & resolve a QR token — any authenticated user
qrRouter.post('/resolve', asyncHandler(resolveQrHandler));
// The agent's poll after an onboarding scan: has the owner approved?
// D6: ops' view of one person's scans. Literal path, ahead of /scans/:scanId.
qrRouter.get('/scans', requireRole('ADMIN'), asyncHandler(scansByHandler));
qrRouter.get('/scans/:scanId', asyncHandler(getScanForScannerHandler));

// Admin: the desk (K-B1) — list, generate, view scans, regenerate, deactivate
qrRouter.get('/', requireRole('ADMIN'), asyncHandler(listQrHandler));
qrRouter.post('/', requireRole('ADMIN'), asyncHandler(generateQrHandler));
qrRouter.get('/:qrId/scans', requireRole('ADMIN'), asyncHandler(getQrScansHandler));
qrRouter.post('/:qrId/regenerate', requireRole('ADMIN'), asyncHandler(regenerateQrHandler));
qrRouter.delete('/:qrId', requireRole('ADMIN'), asyncHandler(deactivateQrHandler));

qrRouter.get('/:qrId', asyncHandler(getQrHandler));
