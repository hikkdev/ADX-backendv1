import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { handleUploadMiddleware } from './uploads.middleware';
import {
  deleteFileHandler,
  getDocumentReadingAtHandler,
  getDocumentReadingHandler,
  getFileHandler,
  readDocumentAtHandler,
  readDocumentHandler,
  uploadFileHandler,
} from './uploads.controller';

export const uploadRouter = Router();
uploadRouter.use(authenticate);

uploadRouter.post('/', handleUploadMiddleware, asyncHandler(uploadFileHandler));

/**
 * Lot D (Q61): a file by id. Mounted at /files, apart from /upload, because
 * the read is the one door to every private document and the write is the
 * one door in — two routers so each stays one route deep.
 */
export const filesRouter = Router();
filesRouter.use(authenticate);

// DR-1: the desk reads a document through the model. ADMIN only — the reviewer's tool, never the uploader's.
// The by-URL pair sits ahead of `/:id` so "reading" and "read" are never taken for a file id.
filesRouter.get('/reading', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(getDocumentReadingAtHandler));
filesRouter.post('/read', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(readDocumentAtHandler));
filesRouter.get('/:id', asyncHandler(getFileHandler));
filesRouter.delete('/:id', asyncHandler(deleteFileHandler));
filesRouter.get('/:id/reading', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(getDocumentReadingHandler));
filesRouter.post('/:id/read', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(readDocumentHandler));
