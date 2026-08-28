import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import {
  createAdvertisementHandler,
  getAllAdvertisementsHandler,
  getAdvertisementByIdHandler,
  updateAdvertisementHandler,
  deleteAdvertisementHandler,
} from './advertisements.controller';

export const advertisementRouter = Router();
advertisementRouter.use(authenticate);

// No requireRole: visibility is decided per row in advertisements.policy,
// because admins and advertisers share these endpoints.
advertisementRouter.post('/', asyncHandler(createAdvertisementHandler));
advertisementRouter.get('/', asyncHandler(getAllAdvertisementsHandler));
advertisementRouter.get('/:id', asyncHandler(getAdvertisementByIdHandler));
advertisementRouter.put('/:id', asyncHandler(updateAdvertisementHandler));
advertisementRouter.delete('/:id', asyncHandler(deleteAdvertisementHandler));
