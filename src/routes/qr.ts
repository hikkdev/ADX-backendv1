import { Router } from 'express';
import { generateQrHandler, resolveQrHandler, getQrScansHandler, deactivateQrHandler, getQrHandler, qrImagePngHandler, qrImageSvgHandler } from '../controllers/qr';
import { asyncHandler } from '../lib/errors';
import { authenticate, requireRole } from '../middleware/authenticate';

export const qrRouter = Router();

// QR image serving — public, no auth (loaded by Image component without auth headers)
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
