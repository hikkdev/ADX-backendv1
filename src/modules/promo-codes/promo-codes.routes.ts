import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { createHandler, getHandler, listHandler, updateHandler } from './promo-codes.controller';

/**
 * /promo-codes — the desk (PC-1). ADMIN at the router; Growth's tiers on
 * top: reading is `growth.view`, making and changing a code `growth.edit`.
 * A code is never deleted — it is switched off, and its redemptions stay
 * on the books. The advertiser's side (typing a code onto a booking) is
 * `POST /campaigns/:id/promo` in `campaigns`.
 */
export const promoCodeRouter = Router();
promoCodeRouter.use(authenticate, requireRole('ADMIN'));

promoCodeRouter.get('/', requirePermission('growth.view'), asyncHandler(listHandler));
promoCodeRouter.post('/', requirePermission('growth.edit'), asyncHandler(createHandler));
promoCodeRouter.get('/:id', requirePermission('growth.view'), asyncHandler(getHandler));
promoCodeRouter.patch('/:id', requirePermission('growth.edit'), asyncHandler(updateHandler));
