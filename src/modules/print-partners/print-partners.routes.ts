import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import { requireFeature } from '../feature-flags';
import * as h from './print-partners.controller';
import * as kyc from './kyc/print-partner-kyc.controller';

/**
 * Two routers, two prefixes — Lot B (B4b), Lot H (Q147).
 *
 * `printPartnerRouter` is mounted at `/print-partners`. Its `/me/*` half is
 * the partner's own floor — PARTNER at the route, behind the
 * `partners.print-floor` and `partners.quotes` switches — registered
 * **ahead of** the ADMIN layer and its `/:id` routes, so `/me` is never
 * read as an id. Everything after the ADMIN layer is the desk's.
 *
 * `printJobRouter` hangs off the order, mounted at `/orders` after the
 * orders router (whose authenticate it therefore passes through first, like
 * `/orders/:orderId/milestones`). A job — and, Lot H, the quote request
 * behind it — is the order's, so the path says so; the rows are this
 * module's, so the routes live here.
 */

export const printPartnerRouter = Router();
printPartnerRouter.use(authenticate);

/* ── Lot H: the partner's own floor, ahead of the ADMIN layer ───────── */

const floor = [requireRole('PARTNER'), requireFeature('partners.print-floor')] as const;
const quotes = [requireRole('PARTNER'), requireFeature('partners.quotes')] as const;
/* Lot N: the partner's own KYC — the documents from the phone, or Digio. */
const partnerKyc = [requireRole('PARTNER'), requireFeature('print.partner-kyc')] as const;

printPartnerRouter.get('/me', ...floor, asyncHandler(h.myProfileHandler));
printPartnerRouter.patch('/me', ...floor, asyncHandler(h.updateMyProfileHandler));
/* PP-1: the shop's own application details, while the desk has not activated it. */
printPartnerRouter.post('/me/application', ...floor, asyncHandler(h.completeMyApplicationHandler));
printPartnerRouter.put('/me/rate-card', ...floor, asyncHandler(h.setMyRateCardHandler));

/* Lot N: the partner's KYC on their own phone — literal paths, ahead of /:id. */
printPartnerRouter.get('/me/kyc', ...partnerKyc, asyncHandler(kyc.myKycHandler));
printPartnerRouter.post('/me/kyc', ...partnerKyc, asyncHandler(kyc.submitMyKycHandler));
printPartnerRouter.post('/me/kyc/digio/initiate', ...partnerKyc, asyncHandler(kyc.initiateMyDigioHandler));
printPartnerRouter.get('/me/kyc/digio/status', ...partnerKyc, asyncHandler(kyc.myDigioStatusHandler));

printPartnerRouter.get('/me/quote-requests', ...quotes, asyncHandler(h.myQuoteRequestsHandler));
/* G13-B: the one request, sealed. */
printPartnerRouter.get('/me/quote-requests/:requestId', ...quotes, asyncHandler(h.myQuoteRequestHandler));
printPartnerRouter.post('/me/quote-requests/:requestId/quotes', ...quotes, asyncHandler(h.submitQuoteHandler));
printPartnerRouter.delete('/me/quote-requests/:requestId/quotes', ...quotes, asyncHandler(h.withdrawQuoteHandler));

printPartnerRouter.get('/me/jobs', ...floor, asyncHandler(h.myJobsHandler));
printPartnerRouter.get('/me/jobs/:jobId', ...floor, asyncHandler(h.myJobHandler));
printPartnerRouter.post('/me/jobs/:jobId/accept', ...floor, asyncHandler(h.acceptJobHandler));
printPartnerRouter.post('/me/jobs/:jobId/decline', ...floor, asyncHandler(h.declineJobHandler));
printPartnerRouter.post('/me/jobs/:jobId/printing', ...floor, asyncHandler(h.printingJobHandler));
printPartnerRouter.post('/me/jobs/:jobId/ready', ...floor, asyncHandler(h.readyJobHandler));
/* The partner scans the agent's pickup code; the job goes COLLECTED with the scan on it. */
printPartnerRouter.post('/me/jobs/:jobId/handover', ...floor, asyncHandler(h.handoverJobHandler));

printPartnerRouter.get('/me/earnings', ...floor, asyncHandler(h.myEarningsHandler));
/* G13-B: the four figures over the ledger, Indian months. */
printPartnerRouter.get('/me/earnings/summary', ...floor, asyncHandler(h.myEarningsSummaryHandler));
printPartnerRouter.post('/me/withdrawals', ...floor, asyncHandler(h.myWithdrawalHandler));
printPartnerRouter.get('/me/payout-methods', ...floor, asyncHandler(h.myPayoutMethodsHandler));
printPartnerRouter.post('/me/payout-methods', ...floor, asyncHandler(h.addMyPayoutMethodHandler));
printPartnerRouter.post('/me/invoices', ...floor, asyncHandler(h.myInvoiceHandler));
/* G13-B: the partner's invoices with their months. */
printPartnerRouter.get('/me/invoices', ...floor, asyncHandler(h.myInvoicesHandler));

/* ── The desk ───────────────────────────────────────────────────────── */

printPartnerRouter.use(requireRole('ADMIN'));

printPartnerRouter.get('/', asyncHandler(h.listPartnersHandler));
printPartnerRouter.post('/', asyncHandler(h.createPartnerHandler));
printPartnerRouter.get('/:id', asyncHandler(h.getPartnerHandler));
printPartnerRouter.patch('/:id', asyncHandler(h.updatePartnerHandler));
printPartnerRouter.post('/:id/deactivate', asyncHandler(h.deactivatePartnerHandler));
printPartnerRouter.post('/:id/reactivate', asyncHandler(h.reactivatePartnerHandler));
/* Lot H: the account switched on, so the partner signs in by OTP. */
printPartnerRouter.post('/:id/activate', asyncHandler(h.activatePartnerHandler));
/* The partner's money and work: wallet, statement lines, withdrawals, jobs, invoices. */
printPartnerRouter.get('/:id/ledger', asyncHandler(h.partnerLedgerHandler));
/* Lot H: the console's reads of the rate card and the quote history. */
printPartnerRouter.get('/:id/rate-card', asyncHandler(h.partnerRateCardHandler));
printPartnerRouter.get('/:id/quotes', asyncHandler(h.partnerQuotesHandler));
/* G13-B: the desk on the partner's behalf — for a partner who never activates. */
printPartnerRouter.put('/:id/rate-card', asyncHandler(h.setPartnerRateCardHandler));
printPartnerRouter.post('/:id/invoices', asyncHandler(h.recordPartnerInvoiceHandler));
printPartnerRouter.get('/:id/invoices', asyncHandler(h.partnerInvoicesHandler));

/**
 * G13-B: `/print-quote-requests` — the desk's list across orders, so the
 * console stops fanning out `GET /orders/:id/print-quote-request` per order.
 * ADMIN behind the quotes switch; mounted by bootstrap beside the partners.
 */
export const printQuoteRequestsRouter = Router();
printQuoteRequestsRouter.use(authenticate, requireRole('ADMIN'), requireFeature('partners.quotes'));
printQuoteRequestsRouter.get('/', asyncHandler(h.listQuoteRequestsHandler));

export const printJobRouter = Router();
printJobRouter.use(authenticate);
printJobRouter.use(requireRole('ADMIN'));

printJobRouter.get('/:id/print-job', asyncHandler(h.getJobHandler));
printJobRouter.post('/:id/print-job', asyncHandler(h.openJobHandler));
printJobRouter.patch('/:id/print-job', asyncHandler(h.updateJobHandler));
/* The money moves here, so it carries the finance approver's permission. */
printJobRouter.post('/:id/print-job/approve-cost', requirePermission('finance.approve'), asyncHandler(h.approveCostHandler));

/* Lot H: the quote request behind a job — raised, read with the lowest highlighted, awarded. */
const desk = requireFeature('partners.quotes');
printJobRouter.post('/:id/print-quote-request', desk, asyncHandler(h.createQuoteRequestHandler));
printJobRouter.get('/:id/print-quote-request', desk, asyncHandler(h.getQuoteRequestHandler));
printJobRouter.post('/:id/print-quote-request/award', desk, asyncHandler(h.awardQuoteRequestHandler));
/* G13-B: ops close an OPEN request with a reason. */
printJobRouter.post('/:id/print-quote-request/cancel', desk, asyncHandler(h.cancelQuoteRequestHandler));
