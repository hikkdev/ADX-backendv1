import { Router } from 'express';
import { getBalanceHandler, getTransactionsHandler } from '../controllers/earnings';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const earningsRouter = Router();
earningsRouter.use(authenticate);
earningsRouter.use(requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'ADMIN'));

earningsRouter.get('/balance', asyncHandler(getBalanceHandler));
earningsRouter.get('/transactions', asyncHandler(getTransactionsHandler));
