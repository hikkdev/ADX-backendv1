import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import {
  getBankAccountsHandler,
  createBankAccountHandler,
  updateBankAccountHandler,
  deleteBankAccountHandler,
  setDefaultBankAccountHandler,
} from './banking.controller';

export const bankingRouter = Router();
bankingRouter.use(authenticate);

bankingRouter.get('/', asyncHandler(getBankAccountsHandler));
bankingRouter.post('/', asyncHandler(createBankAccountHandler));
bankingRouter.patch('/:accountId', asyncHandler(updateBankAccountHandler));
bankingRouter.delete('/:accountId', asyncHandler(deleteBankAccountHandler));
bankingRouter.post('/:accountId/set-default', asyncHandler(setDefaultBankAccountHandler));
