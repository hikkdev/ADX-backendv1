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
invoiceFinanceRouter.get('/legal-entity', requirePermission('finance.view'), asyncHandler(h.getLegalEntityHandler));
invoiceFinanceRouter.put('/legal-entity', requirePermission('finance.edit'), asyncHandler(h.putLegalEntityHandler));

/* The register. */
invoiceFinanceRouter.get('/invoices', requirePermission('finance.view'), asyncHandler(h.listInvoicesHandler));
invoiceFinanceRouter.post('/invoices/issue', requirePermission('finance.edit'), asyncHandler(h.issueInvoiceHandler));
invoiceFinanceRouter.get('/invoices/:id', requirePermission('finance.view'), asyncHandler(h.getInvoiceHandler));
invoiceFinanceRouter.get('/invoices/:id/pdf', requirePermission('finance.view'), asyncHandler(h.invoicePdfHandler));
invoiceFinanceRouter.post('/invoices/:id/void', requirePermission('finance.approve'), asyncHandler(h.voidInvoiceHandler));

/* What publishers billed ADX. */
invoiceFinanceRouter.get('/publisher-invoices', requirePermission('finance.view'), asyncHandler(h.listPublisherInvoicesHandler));
invoiceFinanceRouter.patch('/publisher-invoices/:id', requirePermission('finance.edit'), asyncHandler(h.reviewPublisherInvoiceHandler));

/* The monthly run, by hand. */
invoiceFinanceRouter.post('/statements/run', requirePermission('system.jobs'), asyncHandler(h.runStatementsHandler));

/* ── /advertisers/:id/invoices — the advertiser's own paper ─────────── */

export const advertiserInvoiceRouter = Router();
advertiserInvoiceRouter.use(authenticate);
advertiserInvoiceRouter.get('/:id/invoices', asyncHandler(h.advertiserInvoicesHandler));
/* WG-1 (DR 12 board 07): the invoice itself, lines and all — the same shape the desk reads. */
advertiserInvoiceRouter.get('/:id/invoices/:invoiceId', asyncHandler(h.advertiserInvoiceHandler));
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
