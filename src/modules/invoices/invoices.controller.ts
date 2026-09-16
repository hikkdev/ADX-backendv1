import type { Request, Response } from 'express';
import type { z } from 'zod';
import { env } from '../../config/env';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { money } from '../../shared/money';
import { assertMayActFor, getAdvertiser } from '../advertisers';
import { openStoredFile, storeGeneratedFile, type OpenedFile } from '../uploads';
import * as schema from './invoices.schema';
import {
  getInvoice,
  getInvoiceForAdvertiser,
  getLegalEntity,
  issueInvoiceForCampaign,
  issueInvoiceForPackage,
  listInvoices,
  listInvoicesForAdvertiser,
  listMyPublisherInvoices,
  listPublisherInvoices,
  reviewPublisherInvoice,
  shapeInvoice,
  updateLegalEntity,
  uploadPublisherInvoice,
  voidInvoice,
} from './invoices.service';
import { renderInvoicePdf } from './pdf';
import { prismaInvoicesRepository as repository } from './prisma-invoices.repository';
import {
  listStatementsForUser,
  monthWindowFor,
  previousMonth,
  runMonthlyStatements,
  statementPdf,
} from './statements.service';
import type { InvoiceWithLines } from './invoices.repository';

function parse<T>(s: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = s.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

const userId = (req: Request) => req.user!.sub;
const isAdmin = (req: Request) => (req.user?.roles ?? []).includes('ADMIN');

/** Where a stored file's URL points when the storage is local. */
function baseUrlFor(req: Request): string {
  const host = req.get('host') ?? `localhost:${env.PORT}`;
  return env.BASE_URL ?? (env.NODE_ENV !== 'production' ? `${req.protocol}://${host}` : '');
}

/* ── The legal entity ───────────────────────────────────────────────── */

const LEGAL_ENTITY_FIELDS = [
  'legalName', 'tradeName', 'gstin', 'pan', 'tan', 'cin', 'registeredAddress',
  'city', 'stateCode', 'stateName', 'invoicePrefix', 'financialYearStartMonth',
] as const;

export async function getLegalEntityHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await getLegalEntity() });
}

export async function putLegalEntityHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.LegalEntityPatch>(schema.legalEntityPatchSchema, req.body ?? {});
  const { before, after } = await updateLegalEntity(body, userId(req));
  await logActivity(userId(req), 'LEGAL_ENTITY_UPDATED', {
    req,
    module: 'invoices',
    targetType: 'LegalEntitySettings',
    targetId: after.id,
    diff: auditDiff(before, after, LEGAL_ENTITY_FIELDS),
  });
  res.json({ success: true, data: after });
}

/* ── Invoices, the desk ─────────────────────────────────────────────── */

export async function listInvoicesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.ListInvoicesQuery>(schema.listInvoicesQuerySchema, req.query);
  res.json({ success: true, data: await listInvoices(query) });
}

export async function getInvoiceHandler(req: Request, res: Response): Promise<void> {
  const invoice = await getInvoice(req.params['id'] as string);
  res.json({ success: true, data: shapeInvoice(invoice) });
}

/** The desk's repair path: the same idempotent issue the checkout ran. */
export async function issueInvoiceHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof schema.issueInvoiceSchema>>(schema.issueInvoiceSchema, req.body ?? {});
  const invoice = body.campaignId
    ? await issueInvoiceForCampaign(body.campaignId, { byUserId: userId(req) })
    : await issueInvoiceForPackage(body.packageSaleId as string, { byUserId: userId(req) });
  await logActivity(userId(req), 'INVOICE_ISSUED', {
    req,
    module: 'invoices',
    targetType: 'Invoice',
    targetId: invoice.id,
    metadata: {
      number: invoice.number,
      kind: invoice.kind,
      status: invoice.status,
      campaignId: invoice.campaignId,
      packageSaleId: invoice.packageSaleId,
      total: money(invoice.total),
    },
  });
  res.status(201).json({ success: true, data: shapeInvoice(invoice) });
}

export async function voidInvoiceHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof schema.voidInvoiceSchema>>(schema.voidInvoiceSchema, req.body ?? {});
  const id = req.params['id'] as string;
  const before = await getInvoice(id);
  const { creditNote, original } = await voidInvoice(id, { reason: body.reason, byUserId: userId(req) });
  await logActivity(userId(req), 'INVOICE_VOIDED', {
    req,
    module: 'invoices',
    targetType: 'Invoice',
    targetId: original.id,
    diff: auditDiff({ status: before.status }, { status: original.status }),
    metadata: {
      number: original.number,
      creditNoteId: creditNote.id,
      creditNoteNumber: creditNote.number,
      amount: money(creditNote.total),
      reason: body.reason,
    },
  });
  res.json({ success: true, data: { creditNote: shapeInvoice(creditNote), original: shapeInvoice(original) } });
}

/* ── The PDF ────────────────────────────────────────────────────────── */

/**
 * Rendered on first request and kept: the row is immutable once issued, so
 * the file is too. E6: the stored file is PRIVATE and owned by the
 * advertiser's user (`ownerUserId`), and this route — which has already
 * checked who may read the invoice — serves the bytes itself rather than
 * bouncing to `/files/:id`, whose door refused the advertiser's agent and
 * anyone the invoice was not stored under. A local object streams; an R2
 * object is fetched through its presigned read and sent, so the caller
 * never sees a redirect either way.
 */
async function sendInvoicePdf(req: Request, res: Response, invoice: InvoiceWithLines): Promise<void> {
  const filename = `${invoice.number.replace(/\//g, '-')}.pdf`;
  if (invoice.pdfFileId) {
    const opened = await openStoredFile(invoice.pdfFileId).catch((err: unknown) => {
      logger.warn('Could not open the stored invoice PDF; re-rendering', { invoiceId: invoice.id, err });
      return null;
    });
    if (opened && (await sendStoredPdf(res, opened, filename))) return;
  }

  const [entity, against] = await Promise.all([
    getLegalEntity(),
    invoice.voidsInvoiceId ? repository.findInvoice(invoice.voidsInvoiceId) : Promise.resolve(null),
  ]);
  const buffer = await renderInvoicePdf(invoice, {
    againstNumber: against?.number ?? null,
    supplierPan: entity.pan,
    supplierCin: entity.cin,
    supplierLegalName: entity.legalName,
    supplierAddress: [entity.registeredAddress, entity.city, entity.stateName].filter(Boolean).join(', ') || null,
  });
  // A stored file needs an uploader — the issuer, or the requester — and,
  // E6, an owner: the advertiser's user, so the private door opens for them
  // and their agent too. Storing is best-effort — the bytes go out either way.
  try {
    const ownerUserId = await getAdvertiser(invoice.advertiserId)
      .then((advertiser) => advertiser.userId)
      .catch(() => null);
    const stored = await storeGeneratedFile(invoice.createdById ?? userId(req), {
      content: buffer,
      filename,
      mimeType: 'application/pdf',
      purpose: 'INVOICE',
      baseUrl: baseUrlFor(req),
      ownerUserId,
    });
    await repository.updateInvoice(invoice.id, { pdfFileId: stored.id });
  } catch (err) {
    logger.warn('Could not store the invoice PDF; served unstored', { invoiceId: invoice.id, err });
  }

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}

/** The stored bytes, streamed. False when they could not be read, so the caller re-renders. */
async function sendStoredPdf(res: Response, opened: OpenedFile, filename: string): Promise<boolean> {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${filename}"`);
  res.set('Cache-Control', 'private, no-store');
  if (opened.kind === 'stream') {
    await new Promise<void>((resolve, reject) => res.sendFile(opened.path, (err) => (err ? reject(err) : resolve()))).catch(
      (err: unknown) => {
        logger.warn('Could not stream the stored invoice PDF', { path: opened.path, err });
      },
    );
    return res.headersSent;
  }
  // A presigned read: fetched here and sent, never handed to the client as a redirect.
  const upstream = await fetch(opened.url).catch(() => null);
  if (!upstream || !upstream.ok) return false;
  res.send(Buffer.from(await upstream.arrayBuffer()));
  return true;
}

export async function invoicePdfHandler(req: Request, res: Response): Promise<void> {
  const invoice = await getInvoice(req.params['id'] as string);
  await sendInvoicePdf(req, res, invoice);
}

/* ── The advertiser's own ───────────────────────────────────────────── */

export async function advertiserInvoicesHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = req.params['id'] as string;
  await assertMayActFor(req, advertiserId, 'READ');
  res.json({ success: true, data: await listInvoicesForAdvertiser(advertiserId) });
}

export async function advertiserInvoicePdfHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = req.params['id'] as string;
  await assertMayActFor(req, advertiserId, 'READ');
  const invoice = await getInvoiceForAdvertiser(advertiserId, req.params['invoiceId'] as string);
  await sendInvoicePdf(req, res, invoice);
}

/* ── Publisher invoices ─────────────────────────────────────────────── */

export async function uploadPublisherInvoiceHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.UploadPublisherInvoiceInput>(schema.uploadPublisherInvoiceSchema, req.body ?? {});
  const row = await uploadPublisherInvoice(userId(req), body);
  res.status(201).json({ success: true, data: { ...row, amount: money(row.amount) } });
}

export async function myPublisherInvoicesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listMyPublisherInvoices(userId(req)) });
}

export async function listPublisherInvoicesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.ListPublisherInvoicesQuery>(schema.listPublisherInvoicesQuerySchema, req.query);
  res.json({ success: true, data: await listPublisherInvoices(query) });
}

export async function reviewPublisherInvoiceHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.ReviewPublisherInvoiceInput>(schema.reviewPublisherInvoiceSchema, req.body ?? {});
  const { before, after } = await reviewPublisherInvoice(req.params['id'] as string, body, userId(req));
  await logActivity(userId(req), 'PUBLISHER_INVOICE_REVIEWED', {
    req,
    module: 'invoices',
    targetType: 'PublisherInvoice',
    targetId: after.id,
    diff: auditDiff(before, after, ['status', 'note']),
    metadata: { publisherId: after.publisherId, period: after.period, amount: money(after.amount) },
  });
  res.json({ success: true, data: { ...after, amount: money(after.amount) } });
}

/* ── Statements (payment advices) ───────────────────────────────────── */

export async function myStatementsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listStatementsForUser(userId(req)) });
}

export async function statementPdfHandler(req: Request, res: Response): Promise<void> {
  const result = await statementPdf(req.params['id'] as string, { userId: userId(req), isAdmin: isAdmin(req) });
  if ('url' in result) {
    res.redirect(302, result.url);
    return;
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${result.filename}"`);
  res.send(result.buffer);
}

/** The desk's manual run — the month just ended by default, or `?period=YYYY-MM`. */
export async function runStatementsHandler(req: Request, res: Response): Promise<void> {
  const period = typeof req.body?.period === 'string' ? req.body.period : undefined;
  const window = period ? monthWindowFor(period) : previousMonth(new Date());
  const result = await runMonthlyStatements(window);
  await logActivity(userId(req), 'MONTHLY_STATEMENTS_RUN', {
    req,
    module: 'invoices',
    targetType: 'Statement',
    targetId: window.period,
    metadata: result,
  });
  res.json({ success: true, data: result });
}
