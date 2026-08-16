import { Router } from 'express';
import { handleUploadMiddleware, uploadFileHandler } from '../controllers/upload';
import { asyncHandler } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';

export const uploadRouter = Router();
uploadRouter.use(authenticate);

uploadRouter.post('/', handleUploadMiddleware, asyncHandler(uploadFileHandler));
