import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  generateQrHandler, resolveQrHandler, getQrScansHandler,
  deactivateQrHandler, getQrHandler, qrImagePngHandler, qrImageSvgHandler,
} from './qr.controller';

export const qrRouter = Router();

// QR image serving — public, no auth. An <img> tag cannot send an
// Authorization header, so these must stay registered ABOVE the authenticate
// layer below. Moving them down turns every rendered QR into a broken image.
qrRouter.get('/:qrId/image.png', asyncHandler(qrImagePngHandler));
qrRouter.get('/:qrId/image.svg', asyncHandler(qrImageSvgHandler));

qrRouter.use(authenticate);

// Scan & resolve a QR token — any authenticated user
qrRouter.post('/resolve', asyncHandler(resolveQrHandler));

// Admin: generate, view scans, deactivate
qrRouter.post('/', requireRole('ADMIN'), asyncHandler(generateQrHandler));
qrRouter.get('/:qrId/scans', requireRole('ADMIN'), asyncHandler(getQrScansHandler));
qrRouter.delete('/:qrId', requireRole('ADMIN'), asyncHandler(deactivateQrHandler));

qrRouter.get('/:qrId', asyncHandler(getQrHandler));
