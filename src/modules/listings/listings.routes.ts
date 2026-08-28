import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  createListingHandler,
  getAllListingsHandler,
  updateListingHandler,
  publishListingHandler,
} from './listings.controller';

export const listingRouter = Router();
listingRouter.use(authenticate);

listingRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllListingsHandler));
listingRouter.post('/', requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(createListingHandler));
listingRouter.patch('/:listingId', requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(updateListingHandler));
listingRouter.post('/:listingId/publish', requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(publishListingHandler));
