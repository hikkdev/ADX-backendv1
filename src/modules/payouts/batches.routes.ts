import { Router } from 'express';
import { requirePermission } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import * as h from './batches.controller';

/**
 * Mounted under `financeRouter` — `/finance/payout-batches` and
 * `/finance/bank-accounts` — so they inherit its authenticate + ADMIN guard.
 * The decisions that move or commit money carry `finance.approve` on top:
 * signing a batch off, releasing it, and confirming or failing a line.
 */

export const batchesRouter = Router();

batchesRouter.get('/', asyncHandler(h.listBatchesHandler));
batchesRouter.post('/', asyncHandler(h.createBatchHandler));
/* Lot G (Q124): registered ahead of `/:id` so "schedule" is never read as a batch id. Do not reorder. */
batchesRouter.get('/schedule', asyncHandler(h.batchScheduleHandler));
/* G13-B: likewise ahead of `/:id` — the batches under the filters, one CSV line each. */
batchesRouter.get('/export.csv', asyncHandler(h.exportBatchesHandler));
batchesRouter.get('/:id', asyncHandler(h.getBatchHandler));
batchesRouter.put('/:id/lines', asyncHandler(h.setLinesHandler));
batchesRouter.post('/:id/submit', asyncHandler(h.submitBatchHandler));
batchesRouter.post('/:id/approve', requirePermission('finance.approve'), asyncHandler(h.approveBatchHandler));
batchesRouter.post('/:id/release', requirePermission('finance.approve'), asyncHandler(h.releaseBatchHandler));
batchesRouter.post('/:id/cancel', asyncHandler(h.cancelBatchHandler));
batchesRouter.get('/:id/preflight', asyncHandler(h.preflightBatchHandler));
batchesRouter.get('/:id/export', asyncHandler(h.exportBatchHandler));
batchesRouter.post('/:id/lines/:withdrawalId/mark-paid', requirePermission('finance.approve'), asyncHandler(h.markLinePaidHandler));
batchesRouter.post('/:id/lines/:withdrawalId/fail', requirePermission('finance.approve'), asyncHandler(h.failLineHandler));

export const bankAccountsRouter = Router();

bankAccountsRouter.get('/', asyncHandler(h.listBankAccountsHandler));
bankAccountsRouter.put('/', asyncHandler(h.saveBankAccountHandler));
