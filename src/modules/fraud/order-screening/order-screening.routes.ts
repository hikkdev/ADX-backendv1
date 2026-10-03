import { Router } from 'express';
import { authenticate, requireRole, requirePermission } from '../../../shared/auth';
import { asyncHandler } from '../../../shared/http';
import {
  bulkHandler,
  cancelImpactHandler,
  clearHandler,
  confirmFraudHandler,
  fraudCaseHandler,
  holdHandler,
  listHandler,
  releaseHandler,
  rescoreHandler,
} from './order-screening.controller';

/**
 * Order fraud screening — the review desk's routes (2 Oct 2026), mounted by
 * bootstrap at `/orders` AHEAD of the orders router, so `/orders/fraud-review`
 * is not read as an order id. The guards sit on each route, never on the
 * router: a `router.use` here would run for every `/orders` request and turn
 * the advertisers' and agents' order routes away.
 *
 * Reading is the fraud desk's read permission (`kyc.view`, as the case
 * routes); acting is its edit (`kyc.edit`); cancelling as fraud also needs
 * the orders cancel permission (`marketplace.edit`) — the bulk route asks
 * for it inside, when the action is CONFIRM_FRAUD.
 */
export const orderScreeningRouter = Router();

const admin = [authenticate, requireRole('ADMIN')] as const;

orderScreeningRouter.get('/fraud-review', ...admin, requirePermission('kyc.view'), asyncHandler(listHandler));
orderScreeningRouter.post('/fraud-review/bulk', ...admin, requirePermission('kyc.edit'), asyncHandler(bulkHandler));
orderScreeningRouter.get('/:id/cancel-impact', ...admin, requirePermission('kyc.view'), asyncHandler(cancelImpactHandler));
orderScreeningRouter.post('/:id/hold', ...admin, requirePermission('kyc.edit'), asyncHandler(holdHandler));
orderScreeningRouter.post('/:id/release', ...admin, requirePermission('kyc.edit'), asyncHandler(releaseHandler));
orderScreeningRouter.post('/:id/clear', ...admin, requirePermission('kyc.edit'), asyncHandler(clearHandler));
orderScreeningRouter.post('/:id/confirm-fraud', ...admin, requirePermission('kyc.edit', 'marketplace.edit'), asyncHandler(confirmFraudHandler));
orderScreeningRouter.post('/:id/fraud-case', ...admin, requirePermission('kyc.edit'), asyncHandler(fraudCaseHandler));
orderScreeningRouter.post('/:id/rescore', ...admin, requirePermission('kyc.edit'), asyncHandler(rescoreHandler));
