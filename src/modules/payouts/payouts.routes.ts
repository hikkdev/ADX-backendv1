import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import * as h from './payouts.controller';
import { bankAccountsRouter, batchesRouter } from './batches.routes';

/**
 * Two routers, because there are two audiences with opposite defaults.
 *
 * `payoutRouter` is the party's own money: whoever is signed in sees their own
 * wallet and nobody else's, and every handler resolves the caller's wallet
 * rather than taking an id. There is no route here that names another party.
 *
 * `financeRouter` is ADX's side and is admin-only at the router. Approving a
 * payout, verifying a bank account and crediting an incentive all live here,
 * because the rule settled in the walkthrough is that a person vets every one —
 * there is no amount below which any of this is automatic.
 */

export const payoutRouter = Router();
payoutRouter.use(authenticate);

/* Lot B (Q11): the branch behind an IFSC, before a method is added. */
payoutRouter.get('/ifsc/:code', asyncHandler(h.ifscLookupHandler));

/* Where my money would go. */
payoutRouter.get('/methods', asyncHandler(h.listMethodsHandler));
payoutRouter.post('/methods', asyncHandler(h.addMethodHandler));
payoutRouter.delete('/methods/:id', asyncHandler(h.removeMethodHandler));
payoutRouter.post('/methods/:id/set-default', asyncHandler(h.setDefaultMethodHandler));

/* What I have. */
payoutRouter.get('/wallet', asyncHandler(h.myWalletHandler));
payoutRouter.get('/wallet/entries', asyncHandler(h.myEntriesHandler));
payoutRouter.get('/wallet/earnings', asyncHandler(h.myEarningsHandler));
payoutRouter.get('/wallet/incentives', asyncHandler(h.myIncentivesHandler));

/* Getting it out. */
payoutRouter.get('/withdrawals', asyncHandler(h.myWithdrawalsHandler));
payoutRouter.post('/withdrawals', asyncHandler(h.requestWithdrawalHandler));
payoutRouter.post('/withdrawals/:id/cancel', asyncHandler(h.cancelWithdrawalHandler));

export const financeRouter = Router();
financeRouter.use(authenticate);
financeRouter.use(requireRole('ADMIN'));

/* Wallets, for the console's wallet management section. */
financeRouter.get('/wallets', requirePermission('finance.view'), asyncHandler(h.adminWalletsHandler));
financeRouter.get('/wallets/:id', requirePermission('finance.view'), asyncHandler(h.adminWalletHandler));
financeRouter.get('/wallets/:id/entries', requirePermission('finance.view'), asyncHandler(h.adminWalletEntriesHandler));

/* The withdrawal queue. Nothing reaches a rail without passing through here. */
financeRouter.get('/withdrawals', requirePermission('finance.view'), asyncHandler(h.adminWithdrawalsHandler));
financeRouter.get('/withdrawals/summary', requirePermission('finance.view'), asyncHandler(h.withdrawalSummaryHandler));
/* Lot B (B4b): raised at the desk for a party who cannot sign in — a print partner. Literal path, ahead of /:id. */
financeRouter.post('/withdrawals/on-behalf', requirePermission('finance.edit'), asyncHandler(h.onBehalfWithdrawalHandler));
financeRouter.post('/withdrawals/:id/approve', requirePermission('finance.approve'), asyncHandler(h.approveHandler));
financeRouter.post('/withdrawals/:id/reject', requirePermission('finance.approve'), asyncHandler(h.rejectWithdrawalHandler));
financeRouter.post('/withdrawals/:id/mark-paid', requirePermission('finance.approve'), asyncHandler(h.markPaidHandler));
financeRouter.post('/withdrawals/:id/fail', requirePermission('finance.approve'), asyncHandler(h.failHandler));

/* Lot B (Q85/Q140): approved lines paid together, and the ADX accounts they are drawn on. */
financeRouter.use('/payout-batches', batchesRouter);
financeRouter.use('/bank-accounts', bankAccountsRouter);

/* Payout methods waiting to be proved — or one party's, with ?userId=. */
financeRouter.get('/payout-methods', requirePermission('finance.view'), asyncHandler(h.pendingMethodsHandler));
/* D5: one recorded at the desk on a party's behalf. */
financeRouter.post('/payout-methods', requirePermission('finance.edit'), asyncHandler(h.adminAddMethodHandler));
financeRouter.post('/payout-methods/:id/verify', requirePermission('finance.approve'), asyncHandler(h.verifyMethodHandler));
financeRouter.post('/payout-methods/:id/reject', requirePermission('finance.approve'), asyncHandler(h.rejectMethodHandler));

/* Agent incentives, which ops verifies before the money moves. */
financeRouter.get('/incentives', requirePermission('finance.view'), asyncHandler(h.adminIncentivesHandler));
financeRouter.post('/incentives', requirePermission('finance.edit'), asyncHandler(h.recordIncentiveHandler));
financeRouter.post('/incentives/:id/credit', requirePermission('finance.approve'), asyncHandler(h.creditIncentiveHandler));
financeRouter.post('/incentives/:id/reject', requirePermission('finance.approve'), asyncHandler(h.rejectIncentiveHandler));

/* The numbers behind the rules. */
financeRouter.get('/limits', requirePermission('finance.view'), asyncHandler(h.limitsHandler));
financeRouter.put('/limits', requirePermission('finance.edit'), asyncHandler(h.setLimitHandler));
financeRouter.get('/tax-rates', requirePermission('finance.view'), asyncHandler(h.taxRatesHandler));
financeRouter.post('/tax-rates', requirePermission('finance.edit'), asyncHandler(h.setTaxRateHandler));
financeRouter.get('/incentive-rates', requirePermission('finance.view'), asyncHandler(h.incentiveRatesHandler));
financeRouter.post('/incentive-rates', requirePermission('finance.edit'), asyncHandler(h.setIncentiveRateHandler));

/* The books. */
financeRouter.get('/ledger', requirePermission('finance.view'), asyncHandler(h.ledgerHandler));
/* The same filters as a file, one line per leg — same permission as the read, audited LEDGER_EXPORTED. */
financeRouter.get('/ledger/export.csv', requirePermission('finance.view'), asyncHandler(h.ledgerExportHandler));
financeRouter.post('/ledger/:id/reverse', requirePermission('finance.approve'), asyncHandler(h.reverseLedgerHandler));
financeRouter.get('/ledger/verify', requirePermission('finance.view'), asyncHandler(h.verifyLedgerHandler));

/* Operations. */
financeRouter.post('/accrual/run', requirePermission('system.jobs'), asyncHandler(h.runAccrualHandler));
/* Lot B (B1, Q135): the days the run paid at the unit rate. Dry run by default;
 * the execute moves money, so it needs the finance approver's permission. */
financeRouter.post(
  '/accruals/quantity-backfill',
  requirePermission('finance.approve'),
  asyncHandler(h.quantityBackfillHandler)
);
financeRouter.get('/rails', requirePermission('finance.view'), asyncHandler(h.railsHandler));
