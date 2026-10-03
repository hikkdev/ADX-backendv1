import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { getBalanceHandler, getTransactionsHandler } from './earnings.controller';

export const earningsRouter = Router();
earningsRouter.use(authenticate);

// ADMIN is in the guard even though both handlers resolve the *caller's* own
// agent profile — an admin without one gets 404, not 403. Inherited; the guard
// is router-wide rather than per route.
earningsRouter.use(requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'ADMIN'));

earningsRouter.get('/balance', requirePermission('finance.view'), asyncHandler(getBalanceHandler));
earningsRouter.get('/transactions', requirePermission('finance.view'), asyncHandler(getTransactionsHandler));
