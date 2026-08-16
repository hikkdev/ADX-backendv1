import { Router } from 'express';
import {
  createAdvertisementHandler,
  getAllAdvertisementsHandler,
  getAdvertisementByIdHandler,
  updateAdvertisementHandler,
  deleteAdvertisementHandler,
} from '../controllers/advertisement';
import { asyncHandler } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';

export const advertisementRouter = Router();
advertisementRouter.use(authenticate);

advertisementRouter.post('/', asyncHandler(createAdvertisementHandler));
advertisementRouter.get('/', asyncHandler(getAllAdvertisementsHandler));
advertisementRouter.get('/:id', asyncHandler(getAdvertisementByIdHandler));
advertisementRouter.put('/:id', asyncHandler(updateAdvertisementHandler));
advertisementRouter.delete('/:id', asyncHandler(deleteAdvertisementHandler));
