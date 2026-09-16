import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import { handleUploadMiddleware } from './uploads.middleware';
import { deleteFileHandler, getFileHandler, uploadFileHandler } from './uploads.controller';

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

filesRouter.get('/:id', asyncHandler(getFileHandler));
filesRouter.delete('/:id', asyncHandler(deleteFileHandler));
