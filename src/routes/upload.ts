import { Router } from 'express';
import { handleUploadMiddleware, uploadFileHandler } from '../controllers/upload';
import { asyncHandler } from '../shared/http';
import { authenticate } from '../shared/auth';

export const uploadRouter = Router();
uploadRouter.use(authenticate);

uploadRouter.post('/', handleUploadMiddleware, asyncHandler(uploadFileHandler));
