import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import * as h from './invoices.controller';

/**
 * Four routers, one per audience, each mounted by bootstrap where its paths
 * live.
 *
 * `invoiceFinanceRouter` is ADX's side and ADMIN at the router: the legal
 * entity, the invoice register, voids, the publishers' invoices and the
 * statement run. Voiding is `finance.approve` on top — it is the desk saying
 * a bill was wrong.
 *
 * The other three name a party and answer only to that party (or an admin):
 * an advertiser's invoices under /advertisers/:id, a publisher's own invoice
 * upload under /publishers/me, and the publisher's payment advices under
 * /payouts/wallet/statements.
 */

export const invoiceFinanceRouter = Router();
invoiceFinanceRouter.use(authenticate);
invoiceFinanceRouter.use(requireRole('ADMIN'));

/* Who ADX is on every invoice. */
invoiceFinanceRouter.get('/legal-entity', asyncHandler(h.getLegalEntityHandler));
invoiceFinanceRouter.put('/legal-entity', asyncHandler(h.putLegalEntityHandler));

/* The register. */
invoiceFinanceRouter.get('/invoices', asyncHandler(h.listInvoicesHandler));
invoiceFinanceRouter.post('/invoices/issue', asyncHandler(h.issueInvoiceHandler));
invoiceFinanceRouter.get('/invoices/:id', asyncHandler(h.getInvoiceHandler));
invoiceFinanceRouter.get('/invoices/:id/pdf', asyncHandler(h.invoicePdfHandler));
invoiceFinanceRouter.post('/invoices/:id/void', requirePermission('finance.approve'), asyncHandler(h.voidInvoiceHandler));

/* What publishers billed ADX. */
invoiceFinanceRouter.get('/publisher-invoices', asyncHandler(h.listPublisherInvoicesHandler));
invoiceFinanceRouter.patch('/publisher-invoices/:id', asyncHandler(h.reviewPublisherInvoiceHandler));

/* The monthly run, by hand. */
invoiceFinanceRouter.post('/statements/run', asyncHandler(h.runStatementsHandler));

/* ── /advertisers/:id/invoices — the advertiser's own paper ─────────── */

export const advertiserInvoiceRouter = Router();
advertiserInvoiceRouter.use(authenticate);
advertiserInvoiceRouter.get('/:id/invoices', asyncHandler(h.advertiserInvoicesHandler));
advertiserInvoiceRouter.get('/:id/invoices/:invoiceId/pdf', asyncHandler(h.advertiserInvoicePdfHandler));

/* ── /publishers/me/invoices — a publisher billing ADX ───────────────── */

export const publisherInvoiceRouter = Router();
publisherInvoiceRouter.use(authenticate);
publisherInvoiceRouter.use(requireRole('PUBLISHER'));
publisherInvoiceRouter.get('/', asyncHandler(h.myPublisherInvoicesHandler));
publisherInvoiceRouter.post('/', asyncHandler(h.uploadPublisherInvoiceHandler));

/* ── /payouts/wallet/statements — the monthly payment advices ────────── */

export const statementRouter = Router();
statementRouter.use(authenticate);
statementRouter.get('/', asyncHandler(h.myStatementsHandler));
statementRouter.get('/:id/pdf', asyncHandler(h.statementPdfHandler));
