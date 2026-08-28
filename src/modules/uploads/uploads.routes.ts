import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import { handleUploadMiddleware } from './uploads.middleware';
import { uploadFileHandler } from './uploads.controller';

export const uploadRouter = Router();
uploadRouter.use(authenticate);

uploadRouter.post('/', handleUploadMiddleware, asyncHandler(uploadFileHandler));
