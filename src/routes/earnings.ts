import { Router } from 'express';
import { getBalanceHandler, getTransactionsHandler } from '../controllers/earnings';
import { asyncHandler } from '../lib/errors';
import { authenticate, requireRole } from '../middleware/authenticate';

export const earningsRouter = Router();
earningsRouter.use(authenticate);
earningsRouter.use(requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'ADMIN'));

earningsRouter.get('/balance', asyncHandler(getBalanceHandler));
earningsRouter.get('/transactions', asyncHandler(getTransactionsHandler));
