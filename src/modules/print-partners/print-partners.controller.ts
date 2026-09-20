import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { isVerifiedParty } from '../../shared/kyc-state';
import { money } from '../../shared/money';
import { addMethodSchema, shapeMethod, shapeWithdrawal, type AddMethodInput } from '../payouts';
import * as schema from './print-partners.schema';
import {
  activatePartner,
  addPartnerPayoutMethod,
  createPartner,
  deactivatePartner,
  getPartner,
  getPartnerForUser,
  hasRateCard,
  listPartnerInvoicesWithMonths,
  listPartnerPayoutMethods,
  listPartners,
  partnerEarnings,
  partnerEarningsSummary,
  partnerLedger,
  partnerProfile,
  rateCardStateOf,
  reactivatePartner,
  recordPartnerInvoice,
  recordPartnerInvoiceOnBehalf,
  requestPartnerWithdrawal,
  setRateCard,
  setRateCardOnBehalf,
  updateMe,
  updatePartner,
  withLastLogin,
} from './print-partners.service';
import { withKycSummary, type PartnerKycSummary } from './kyc/print-partner-kyc.service';
import { approvePrintCost, getJobForOrder, openPrintJob, updatePrintJob } from './print-jobs.service';
import {
  awardQuoteRequest,
  cancelQuoteRequest,
  createQuoteRequest,
  envelopeOf,
  getQuoteRequestForOrder,
  getQuoteRequestForPartner,
  listQuoteRequests,
  listQuoteRequestsForPartner,
  rankQuotes,
  submitQuote,
  withdrawQuote,
} from './print-quotes.service';
import {
  acceptJob,
  declineJob,
  handoverJob,
  listPartnerJobs,
  markPrinting,
  markReady,
  partnerJobDetail,
} from './print-floor.service';
import { tellJobAssigned } from './print-partners.notify';
import { prismaPrintPartnersRepository as repository } from './prisma-print-partners.repository';
import type {
  JobRow,
  JobWithPartner,
  OrderForPrint,
  PartnerFileRow,
  PartnerRow,
  QuoteRequestWithQuotes,
  QuoteWithPartner,
} from './print-partners.repository';

/**
 * `/print-partners`, `/print-partners/me/*`, `/orders/:id/print-job*` and
 * `/orders/:id/print-quote-request*` — Lot B (B4b) and Lot H (Q147).
 *
 * The desk's routes are ADMIN and audited under the admin; the floor's are
 * PARTNER and audited under the partner's own user. Every write is audited
 * by hand against the partner, the job, the request or the quote, with a
 * diff on the status and money columns.
 */

function parse<T>(s: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = s.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

const userId = (req: Request) => req.user!.sub;
const partnerId = (req: Request) => req.params['id'] as string;
const orderId = (req: Request) => req.params['id'] as string;
const jobId = (req: Request) => req.params['jobId'] as string;
const requestId = (req: Request) => req.params['requestId'] as string;
/** Lot H: the partner behind the signed-in user — the floor's every handler starts here. */
const me = (req: Request) => getPartnerForUser(userId(req));

export const shapePartner = (row: PartnerRow & { lastLoginAt?: Date | null; kyc?: PartnerKycSummary }) => ({
  id: row.id,
  displayId: row.displayId,
  userId: row.userId,
  name: row.name,
  // QR-3: the verified mark every external party earns the same way.
  verified: isVerifiedParty(row.kycStatus),
  legalName: row.legalName,
  gstin: row.gstin,
  panNumber: row.panNumber,
  contactName: row.contactName,
  mobile: row.mobile,
  email: row.email,
  address: row.address,
  city: row.city,
  latitude: row.latitude,
  longitude: row.longitude,
  capabilities: row.capabilities,
  maxWidthFt: row.maxWidthFt === null ? null : money(row.maxWidthFt),
  turnaroundDays: row.turnaroundDays,
  isActive: row.isActive,
  notes: row.notes,
  /* Lot H: the account, the rate card, the quote switch. */
  activatedAt: row.activatedAt,
  activatedById: row.activatedById,
  acceptsQuoteRequests: row.acceptsQuoteRequests,
  rateCard: rateCardStateOf(row),
  invoiceUploadFileId: row.invoiceUploadFileId,
  /** G13-B: when the account behind the partner last signed in; null until they do (or when the row was not looked up). */
  lastLoginAt: row.lastLoginAt ?? null,
  /** Lot N: the mirror on the row, and the record's four facts (null before any record, or when the row was not looked up). */
  kycStatus: row.kycStatus,
  kyc: row.kyc ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const shapeJob = (row: JobRow | JobWithPartner) => ({
  id: row.id,
  orderId: row.orderId,
  printPartnerId: row.printPartnerId,
  status: row.status,
  quotedCost: row.quotedCost === null ? null : money(row.quotedCost),
  actualCost: row.actualCost === null ? null : money(row.actualCost),
  specs: row.specs,
  requestedAt: row.requestedAt,
  readyAt: row.readyAt,
  collectedAt: row.collectedAt,
  costApprovedByUserId: row.costApprovedByUserId,
  costApprovedAt: row.costApprovedAt,
  ledgerTransactionId: row.ledgerTransactionId,
  notes: row.notes,
  /* Lot H: the partner's own moves. */
  partnerAcceptedAt: row.partnerAcceptedAt,
  partnerDeclinedAt: row.partnerDeclinedAt,
  declineReason: row.declineReason,
  awardedQuoteId: row.awardedQuoteId,
  handoverConfirmedAt: row.handoverConfirmedAt,
  handoverQrId: row.handoverQrId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...('printPartner' in row && row.printPartner
    ? {
        partner: {
          id: row.printPartner.id,
          name: row.printPartner.name,
          contactName: row.printPartner.contactName,
          mobile: row.printPartner.mobile,
          address: row.printPartner.address,
          city: row.printPartner.city,
          latitude: row.printPartner.latitude,
          longitude: row.printPartner.longitude,
        },
      }
    : {}),
});

export const shapeQuote = (quote: QuoteWithPartner) => ({
  id: quote.id,
  requestId: quote.requestId,
  printPartnerId: quote.printPartnerId,
  amount: money(quote.amount),
  turnaroundDays: quote.turnaroundDays,
  note: quote.note,
  status: quote.status,
  submittedAt: quote.submittedAt,
  partner: {
    id: quote.printPartner.id,
    displayId: quote.printPartner.displayId,
    name: quote.printPartner.name,
    city: quote.printPartner.city,
    hasRateCard: hasRateCard(quote.printPartner),
    isActive: quote.printPartner.isActive,
  },
});

const shapeFile = (file: PartnerFileRow) => ({
  id: file.id,
  filename: file.filename,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
  url: file.url,
  createdAt: file.createdAt,
});

/** G13-B: an invoice file with the month it covers and who recorded it. */
const shapeInvoice = (file: PartnerFileRow & { month: string | null; recordedBy: 'PARTNER' | 'ADMIN' | null }) => ({
  ...shapeFile(file),
  month: file.month,
  recordedBy: file.recordedBy,
});

/** Lot H: the order as the partner sees it — the artwork, the site, the agent who collects. */
const shapeOrderForPrint = (order: OrderForPrint | null) =>
  order
    ? {
        id: order.id,
        status: order.status,
        campaignName: order.campaignName,
        startDate: order.startDate,
        endDate: order.endDate,
        artwork: order.creative
          ? {
              url: order.creative.fileUrl,
              fileName: order.creative.fileName,
              mimeType: order.creative.mimeType,
              widthPx: order.creative.widthPx,
              heightPx: order.creative.heightPx,
            }
          : order.designUrl
            ? { url: order.designUrl, fileName: null, mimeType: null, widthPx: null, heightPx: null }
            : null,
        site: order.listing,
        agent: order.agent ? { id: order.agent.id, name: order.agent.name, mobile: order.agent.mobile } : null,
      }
    : null;

/** Lot H: what a partner sees of a request — the specs, the deadline, and only their own quote (sealed bids). */
const shapeRequestForPartner = (request: QuoteRequestWithQuotes, partner: PartnerRow) => {
  const envelope = envelopeOf(request);
  const mine = request.quotes.find((quote) => quote.printPartnerId === partner.id) ?? null;
  return {
    id: request.id,
    orderId: request.orderId,
    specs: envelope.specs,
    city: request.city,
    deadlineAt: request.deadlineAt,
    status: request.status,
    awarded: mine !== null && request.awardedQuoteId === mine.id,
    reinvitedAt: envelope.reinvitedAt,
    myQuote: mine ? shapeQuote(mine) : null,
    createdAt: request.createdAt,
  };
};

/** The desk's view: the request, every quote ranked, the lowest highlighted. */
const shapeRequestForDesk = (request: QuoteRequestWithQuotes) => {
  const envelope = envelopeOf(request);
  const ranked = rankQuotes(request.quotes);
  const lowestId = ranked[0]?.id ?? null;
  return {
    id: request.id,
    orderId: request.orderId,
    specs: envelope.specs,
    city: request.city,
    deadlineAt: request.deadlineAt,
    status: request.status,
    inviteMode: envelope.inviteMode,
    invitedPartnerIds: envelope.invitedPartnerIds,
    reinvitedAt: envelope.reinvitedAt,
    awardedQuoteId: request.awardedQuoteId,
    awardNote: request.awardNote,
    cancelReason: envelope.cancelReason,
    cancelledAt: envelope.cancelledAt,
    lowestQuoteId: lowestId,
    quotes: [...ranked, ...request.quotes.filter((quote) => quote.status !== 'SUBMITTED')].map((quote) => ({
      ...shapeQuote(quote),
      lowest: quote.id === lowestId,
    })),
    createdById: request.createdById,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
};

/* ── Partners ────────────────────────────────────────────────────── */

export async function listPartnersHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.ListPartnersQuery>(schema.listPartnersQuerySchema, req.query);
  const page = await listPartners({
    page: query.page,
    pageSize: query.pageSize,
    ...(query.q ? { q: query.q } : {}),
    ...(query.city ? { city: query.city } : {}),
    ...(query.active === undefined ? {} : { active: query.active }),
  });
  // G13-B: when each account last signed in, one lookup for the page; Lot N: the KYC summary the same way.
  res.json({ success: true, data: { ...page, items: (await withKycSummary(await withLastLogin(page.items))).map(shapePartner) } });
}

export async function createPartnerHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.CreatePartnerInput>(schema.createPartnerSchema, req.body);
  const partner = await createPartner(body);
  await logActivity(userId(req), 'PRINT_PARTNER_CREATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: partner.id,
    metadata: { displayId: partner.displayId, name: partner.name, city: partner.city, userId: partner.userId },
  });
  res.status(201).json({ success: true, data: shapePartner(partner) });
}

export async function getPartnerHandler(req: Request, res: Response): Promise<void> {
  const [row] = await withKycSummary(await withLastLogin([await getPartner(partnerId(req))]));
  res.json({ success: true, data: shapePartner(row!) });
}

/* ── G13-B: the desk on the partner's behalf — for a partner who never activates ── */

export async function setPartnerRateCardHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.RateCardInput>(schema.rateCardSchema, req.body);
  const { before, after } = await setRateCardOnBehalf(partnerId(req), body, userId(req));
  await logActivity(userId(req), 'PARTNER_RATE_CARD_UPDATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff(
      { rateCardFileId: before.rateCardFileId, rows: Array.isArray(before.rateCardRows) ? before.rateCardRows.length : 0 },
      { rateCardFileId: after.rateCardFileId, rows: body.rows.length },
    ),
    metadata: { onBehalf: true, printPartnerId: after.id },
  });
  res.json({ success: true, data: { partnerId: after.id, ...rateCardStateOf(after) } });
}

export async function recordPartnerInvoiceHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.PartnerInvoiceInput>(schema.partnerInvoiceSchema, req.body);
  const { before, after } = await recordPartnerInvoiceOnBehalf(partnerId(req), body, userId(req));
  await logActivity(userId(req), 'PARTNER_INVOICE_UPLOADED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff({ invoiceUploadFileId: before.invoiceUploadFileId }, { invoiceUploadFileId: after.invoiceUploadFileId }),
    metadata: { month: body.month, fileId: body.fileId, onBehalf: true, printPartnerId: after.id },
  });
  res.status(201).json({ success: true, data: { fileId: after.invoiceUploadFileId, month: body.month, url: `/api/v1/files/${body.fileId}` } });
}

/** G13-B: the partner's invoices with their months — the desk's read. */
export async function partnerInvoicesHandler(req: Request, res: Response): Promise<void> {
  const partner = await getPartner(partnerId(req));
  res.json({ success: true, data: (await listPartnerInvoicesWithMonths(partner)).map(shapeInvoice) });
}

export async function updatePartnerHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.UpdatePartnerInput>(schema.updatePartnerSchema, req.body);
  const { before, after } = await updatePartner(partnerId(req), body);
  await logActivity(userId(req), 'PRINT_PARTNER_UPDATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff(before, after),
  });
  res.json({ success: true, data: shapePartner(after) });
}

export async function deactivatePartnerHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason?: string }>(schema.deactivateSchema, req.body ?? {});
  const { before, after } = await deactivatePartner(partnerId(req), body.reason ?? null);
  await logActivity(userId(req), 'PRINT_PARTNER_DEACTIVATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff({ isActive: before.isActive }, { isActive: after.isActive }),
    ...(body.reason ? { metadata: { reason: body.reason } } : {}),
  });
  res.json({ success: true, data: shapePartner(after) });
}

export async function reactivatePartnerHandler(req: Request, res: Response): Promise<void> {
  const before = await getPartner(partnerId(req));
  const after = before.isActive ? before : await reactivatePartner(before.id);
  await logActivity(userId(req), 'PRINT_PARTNER_REACTIVATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff({ isActive: before.isActive }, { isActive: after.isActive }),
  });
  res.json({ success: true, data: shapePartner(after) });
}

/** Lot H: the account switched on — the partner signs in by OTP from here on. */
export async function activatePartnerHandler(req: Request, res: Response): Promise<void> {
  const { before, after, activated } = await activatePartner(partnerId(req), userId(req));
  await logActivity(userId(req), 'PRINT_PARTNER_ACTIVATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff({ activatedAt: before.activatedAt }, { activatedAt: after.activatedAt }),
    metadata: { userId: after.userId, mobile: after.mobile, activated },
  });
  res.json({ success: true, data: { ...shapePartner(after), activated } });
}

export async function partnerLedgerHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ limit?: number; cursor?: string }>(schema.ledgerQuerySchema, req.query);
  const view = await partnerLedger(partnerId(req), query);
  res.json({
    success: true,
    data: {
      partner: shapePartner(view.partner),
      walletId: view.walletId,
      balances: view.balances,
      entries: view.entries,
      withdrawals: view.withdrawals.map((row) => ({
        id: row.id,
        reference: row.reference,
        amount: money(row.amount),
        netAmount: money(row.netAmount),
        status: row.status,
        rail: row.rail,
        railReference: row.railReference,
        requestedAt: row.requestedAt,
        paidAt: row.paidAt,
      })),
      jobs: view.jobs.map(shapeJob),
      jobCounts: view.jobCounts,
      invoices: view.invoices.map(shapeFile),
    },
  });
}

/** Lot H: the console reads the partner's rate card. */
export async function partnerRateCardHandler(req: Request, res: Response): Promise<void> {
  const partner = await getPartner(partnerId(req));
  res.json({ success: true, data: { partnerId: partner.id, ...rateCardStateOf(partner) } });
}

/** Lot H: the partner's quote history. */
export async function partnerQuotesHandler(req: Request, res: Response): Promise<void> {
  const partner = await getPartner(partnerId(req));
  const rows = await repository.listQuotesForPartner(partner.id, 100);
  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      orderId: row.request.orderId,
      amount: money(row.amount),
      turnaroundDays: row.turnaroundDays,
      note: row.note,
      status: row.status,
      submittedAt: row.submittedAt,
      request: { status: row.request.status, deadlineAt: row.request.deadlineAt, awarded: row.request.awardedQuoteId === row.id },
    })),
  });
}

/* ── Lot H: the partner's own floor (`/print-partners/me/*`) ─────── */

export async function myProfileHandler(req: Request, res: Response): Promise<void> {
  const view = await partnerProfile(await me(req));
  // N2-B: the partner's own read carries the KYC summary the desk's read and the roster do.
  const [partner] = await withKycSummary([view.partner]);
  res.json({ success: true, data: { ...shapePartner(partner!), walletId: view.walletId, balances: view.balances, rateCard: view.rateCard } });
}

export async function updateMyProfileHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.UpdateMeInput>(schema.updateMeSchema, req.body);
  const { before, after } = await updateMe(await me(req), body);
  await logActivity(userId(req), 'PRINT_PARTNER_PROFILE_UPDATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff(before, after),
  });
  res.json({ success: true, data: shapePartner(after) });
}

export async function setMyRateCardHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.RateCardInput>(schema.rateCardSchema, req.body);
  const { before, after } = await setRateCard(await me(req), body);
  await logActivity(userId(req), 'PARTNER_RATE_CARD_UPDATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff(
      { rateCardFileId: before.rateCardFileId, rows: Array.isArray(before.rateCardRows) ? before.rateCardRows.length : 0 },
      { rateCardFileId: after.rateCardFileId, rows: body.rows.length },
    ),
  });
  res.json({ success: true, data: rateCardStateOf(after) });
}

/** G13-B: one request as the partner sees it — sealed, so only their own quote. */
export async function myQuoteRequestHandler(req: Request, res: Response): Promise<void> {
  const partner = await me(req);
  const request = await getQuoteRequestForPartner(partner, requestId(req));
  res.json({ success: true, data: shapeRequestForPartner(request, partner) });
}

export async function myQuoteRequestsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.MyQuoteRequestsQuery>(schema.myQuoteRequestsQuerySchema, req.query);
  const partner = await me(req);
  const page = await listQuoteRequestsForPartner(partner, {
    page: query.page,
    pageSize: query.pageSize,
    ...(query.status ? { status: query.status } : {}),
  });
  res.json({ success: true, data: { ...page, items: page.items.map((request) => shapeRequestForPartner(request, partner)) } });
}

export async function submitQuoteHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.QuoteInput>(schema.quoteSchema, req.body);
  const partner = await me(req);
  const quote = await submitQuote(partner, requestId(req), body);
  await logActivity(userId(req), 'PRINT_QUOTE_SUBMITTED', {
    req,
    module: 'print-partners',
    targetType: 'PrintQuote',
    targetId: quote.id,
    metadata: { requestId: quote.requestId, printPartnerId: partner.id, amount: money(quote.amount), turnaroundDays: quote.turnaroundDays },
  });
  res.status(201).json({ success: true, data: shapeQuote(quote) });
}

export async function withdrawQuoteHandler(req: Request, res: Response): Promise<void> {
  const partner = await me(req);
  const quote = await withdrawQuote(partner, requestId(req));
  await logActivity(userId(req), 'PRINT_QUOTE_WITHDRAWN', {
    req,
    module: 'print-partners',
    targetType: 'PrintQuote',
    targetId: quote.id,
    metadata: { requestId: quote.requestId, printPartnerId: partner.id },
  });
  res.json({ success: true, data: shapeQuote(quote) });
}

export async function myJobsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.MyJobsQuery>(schema.myJobsQuerySchema, req.query);
  const page = await listPartnerJobs(await me(req), {
    page: query.page,
    pageSize: query.pageSize,
    ...(query.status ? { status: query.status } : {}),
  });
  res.json({
    success: true,
    data: { ...page, items: page.items.map(({ job, order }) => ({ ...shapeJob(job), order: shapeOrderForPrint(order) })) },
  });
}

export async function myJobHandler(req: Request, res: Response): Promise<void> {
  const { job, order } = await partnerJobDetail(await me(req), jobId(req));
  res.json({ success: true, data: { ...shapeJob(job), order: shapeOrderForPrint(order) } });
}

/** Every move on the floor is a row under the partner's user, with the status diff. */
async function auditMove(req: Request, action: string, before: JobRow, after: JobRow, metadata: Record<string, unknown> = {}): Promise<void> {
  await logActivity(userId(req), action, {
    req,
    module: 'print-partners',
    targetType: 'PrintJob',
    targetId: after.id,
    diff: auditDiff({ status: before.status }, { status: after.status }),
    metadata: { orderId: after.orderId, printPartnerId: after.printPartnerId, ...metadata },
  });
}

export async function acceptJobHandler(req: Request, res: Response): Promise<void> {
  const { before, after } = await acceptJob(await me(req), jobId(req));
  await auditMove(req, 'PRINT_JOB_ACCEPTED', before, after);
  res.json({ success: true, data: shapeJob(after) });
}

export async function declineJobHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason: string }>(schema.declineJobSchema, req.body);
  const { before, after, reopenedRequestId } = await declineJob(await me(req), jobId(req), body.reason);
  await auditMove(req, 'PRINT_JOB_DECLINED', before, after, { reason: body.reason, reopenedRequestId });
  res.json({ success: true, data: { ...shapeJob(after), reopenedRequestId } });
}

export async function printingJobHandler(req: Request, res: Response): Promise<void> {
  const { before, after } = await markPrinting(await me(req), jobId(req));
  await auditMove(req, 'PRINT_JOB_PRINTING', before, after);
  res.json({ success: true, data: shapeJob(after) });
}

export async function readyJobHandler(req: Request, res: Response): Promise<void> {
  const { before, after } = await markReady(await me(req), jobId(req));
  await auditMove(req, 'PRINT_JOB_READY', before, after);
  res.json({ success: true, data: shapeJob(after) });
}

export async function handoverJobHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ qrToken: string }>(schema.handoverSchema, req.body);
  const { before, after } = await handoverJob(await me(req), jobId(req), body.qrToken);
  await auditMove(req, 'PRINT_JOB_HANDED_OVER', before, after, { handoverQrId: after.handoverQrId });
  res.json({ success: true, data: shapeJob(after) });
}

export async function myEarningsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ limit?: number; cursor?: string }>(schema.ledgerQuerySchema, req.query);
  const view = await partnerEarnings(await me(req), query);
  res.json({
    success: true,
    data: {
      walletId: view.walletId,
      balances: view.balances,
      allowance: view.allowance,
      entries: view.entries,
      withdrawals: view.withdrawals.map(shapeWithdrawal),
    },
  });
}

/** G13-B: the earnings page's four figures, Indian months, from the ledger. */
export async function myEarningsSummaryHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await partnerEarningsSummary(await me(req)) });
}

/** G13-B: the partner's own invoices with their months. */
export async function myInvoicesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: (await listPartnerInvoicesWithMonths(await me(req))).map(shapeInvoice) });
}

export async function myWithdrawalHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.PartnerWithdrawalInput>(schema.partnerWithdrawalSchema, req.body);
  const partner = await me(req);
  const created = await requestPartnerWithdrawal(partner, body);
  await logActivity(userId(req), 'WITHDRAWAL_REQUESTED', {
    req,
    module: 'print-partners',
    targetType: 'Withdrawal',
    targetId: created.id,
    metadata: { walletId: created.walletId, amount: money(created.amount), printPartnerId: partner.id },
  });
  res.status(201).json({ success: true, data: shapeWithdrawal(created) });
}

export async function myPayoutMethodsHandler(req: Request, res: Response): Promise<void> {
  const methods = await listPartnerPayoutMethods(await me(req));
  res.json({ success: true, data: methods.map(shapeMethod) });
}

export async function addMyPayoutMethodHandler(req: Request, res: Response): Promise<void> {
  const body = parse<AddMethodInput>(addMethodSchema, req.body);
  const partner = await me(req);
  const method = await addPartnerPayoutMethod(partner, body);
  await logActivity(userId(req), 'PAYOUT_METHOD_ADDED', {
    req,
    module: 'print-partners',
    targetType: 'PayoutMethod',
    targetId: method.id,
    metadata: { type: method.type, printPartnerId: partner.id },
  });
  res.status(201).json({ success: true, data: shapeMethod(method) });
}

export async function myInvoiceHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.PartnerInvoiceInput>(schema.partnerInvoiceSchema, req.body);
  const { before, after } = await recordPartnerInvoice(await me(req), body);
  await logActivity(userId(req), 'PARTNER_INVOICE_UPLOADED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartner',
    targetId: after.id,
    diff: auditDiff({ invoiceUploadFileId: before.invoiceUploadFileId }, { invoiceUploadFileId: after.invoiceUploadFileId }),
    metadata: { month: body.month, fileId: body.fileId },
  });
  res.status(201).json({ success: true, data: { fileId: after.invoiceUploadFileId, month: body.month, url: `/api/v1/files/${body.fileId}` } });
}

/* ── Jobs, under the order ───────────────────────────────────────── */

export async function getJobHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: shapeJob(await getJobForOrder(orderId(req))) });
}

export async function openJobHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.OpenJobInput>(schema.openJobSchema, req.body);
  // The award sets the quote; the desk's own open never does.
  const job = await openPrintJob(orderId(req), { ...body, awardedQuoteId: null });
  await logActivity(userId(req), 'PRINT_JOB_OPENED', {
    req,
    module: 'print-partners',
    targetType: 'PrintJob',
    targetId: job.id,
    metadata: {
      orderId: job.orderId,
      printPartnerId: job.printPartnerId,
      quotedCost: job.quotedCost === null ? null : money(job.quotedCost),
    },
  });
  // Lot H: the partner has a phone now — a hand-opened job is told like an awarded one.
  const partner = await getPartner(job.printPartnerId);
  await tellJobAssigned(partner.userId, {
    orderId: job.orderId,
    amount: job.quotedCost === null ? null : money(job.quotedCost),
    partnerName: partner.name,
  });
  res.status(201).json({ success: true, data: shapeJob(job) });
}

export async function updateJobHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.UpdateJobInput>(schema.updateJobSchema, req.body);
  const { before, after } = await updatePrintJob(orderId(req), body);
  await logActivity(userId(req), 'PRINT_JOB_UPDATED', {
    req,
    module: 'print-partners',
    targetType: 'PrintJob',
    targetId: after.id,
    diff: auditDiff(
      { status: before.status, actualCost: before.actualCost, notes: before.notes },
      { status: after.status, actualCost: after.actualCost, notes: after.notes }
    ),
    metadata: { orderId: after.orderId },
  });
  res.json({ success: true, data: shapeJob(after) });
}

export async function approveCostHandler(req: Request, res: Response): Promise<void> {
  const before = await getJobForOrder(orderId(req));
  const approval = await approvePrintCost(orderId(req), { byUserId: userId(req) });
  await logActivity(userId(req), 'PRINT_COST_APPROVED', {
    req,
    module: 'print-partners',
    targetType: 'PrintJob',
    targetId: approval.job.id,
    diff: auditDiff(
      { costApprovedAt: before.costApprovedAt, ledgerTransactionId: before.ledgerTransactionId },
      { costApprovedAt: approval.job.costApprovedAt, ledgerTransactionId: approval.job.ledgerTransactionId }
    ),
    metadata: {
      orderId: approval.job.orderId,
      printPartnerId: approval.job.printPartnerId,
      walletId: approval.walletId,
      gross: approval.gross,
      taxWithheld: approval.taxWithheld,
      taxRatePct: approval.taxRatePct,
      taxSection: approval.taxSection,
      net: approval.net,
      posted: approval.created,
    },
  });
  res.json({
    success: true,
    data: {
      job: shapeJob(approval.job),
      gross: approval.gross,
      taxWithheld: approval.taxWithheld,
      taxRatePct: approval.taxRatePct,
      taxSection: approval.taxSection,
      net: approval.net,
      walletId: approval.walletId,
      ledgerTransactionId: approval.ledgerTransactionId,
      posted: approval.created,
    },
  });
}

/* ── Lot H: quote requests, under the order (ADMIN) ──────────────── */

export async function createQuoteRequestHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.QuoteRequestInput>(schema.quoteRequestSchema, req.body);
  const { request, invited } = await createQuoteRequest(orderId(req), body, userId(req));
  await logActivity(userId(req), 'PRINT_QUOTE_REQUESTED', {
    req,
    module: 'print-partners',
    targetType: 'PrintQuoteRequest',
    targetId: request.id,
    metadata: {
      orderId: request.orderId,
      deadlineAt: request.deadlineAt,
      invite: body.invite === 'AUTO' ? 'AUTO' : 'MANUAL',
      invitedPartnerIds: invited.map((partner) => partner.id),
    },
  });
  res.status(201).json({
    success: true,
    data: {
      ...shapeRequestForDesk(request),
      invited: invited.map((partner) => ({ id: partner.id, name: partner.name, city: partner.city, hasRateCard: partner.rateCardUpdatedAt !== null })),
    },
  });
}

export async function getQuoteRequestHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: shapeRequestForDesk(await getQuoteRequestForOrder(orderId(req))) });
}

/** G13-B: ops close an OPEN request with a reason; every invited partner is told. */
export async function cancelQuoteRequestHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.CancelQuoteRequestInput>(schema.cancelQuoteRequestSchema, req.body);
  const request = await cancelQuoteRequest(orderId(req), body.reason);
  await logActivity(userId(req), 'PRINT_QUOTE_REQUEST_CANCELLED', {
    req,
    module: 'print-partners',
    targetType: 'PrintQuoteRequest',
    targetId: request.id,
    diff: auditDiff({ status: 'OPEN' }, { status: request.status }),
    metadata: { orderId: request.orderId, reason: body.reason, invitedPartnerIds: envelopeOf(request).invitedPartnerIds },
  });
  res.json({ success: true, data: shapeRequestForDesk(request) });
}

/** G13-B: `GET /print-quote-requests` — the desk's list across orders, on the list contract. */
export async function listQuoteRequestsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.ListQuoteRequestsQuery>(schema.listQuoteRequestsQuerySchema, req.query);
  const page = await listQuoteRequests({
    page: query.page,
    pageSize: query.pageSize,
    ...(query.q ? { q: query.q } : {}),
    ...(query.status ? { status: query.status } : {}),
  });
  res.json({
    success: true,
    data: {
      ...page,
      items: page.items.map(({ request, order, invitedCount, standingQuotes, lowest }) => {
        const envelope = envelopeOf(request);
        return {
          id: request.id,
          orderId: request.orderId,
          order: order
            ? { id: order.id, status: order.status, campaignName: order.campaignName, site: { id: order.listing.id, title: order.listing.title, city: order.listing.city } }
            : null,
          status: request.status,
          city: request.city,
          deadlineAt: request.deadlineAt,
          inviteMode: envelope.inviteMode,
          invitedCount,
          reinvitedAt: envelope.reinvitedAt,
          standingQuotes,
          lowest: lowest ? { quoteId: lowest.id, amount: money(lowest.amount), turnaroundDays: lowest.turnaroundDays, partner: { id: lowest.printPartner.id, name: lowest.printPartner.name } } : null,
          awardedQuoteId: request.awardedQuoteId,
          cancelReason: envelope.cancelReason,
          createdAt: request.createdAt,
        };
      }),
    },
  });
}

export async function awardQuoteRequestHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.AwardInput>(schema.awardSchema, req.body);
  const result = await awardQuoteRequest(orderId(req), body);
  await logActivity(userId(req), 'PRINT_QUOTE_AWARDED', {
    req,
    module: 'print-partners',
    targetType: 'PrintQuoteRequest',
    targetId: result.request.id,
    diff: auditDiff({ status: 'OPEN', awardedQuoteId: null }, { status: result.request.status, awardedQuoteId: result.request.awardedQuoteId }),
    metadata: {
      orderId: result.request.orderId,
      printJobId: result.job.id,
      quoteId: result.quote.id,
      printPartnerId: result.quote.printPartnerId,
      amount: money(result.quote.amount),
      lowestQuoteId: result.lowest.id,
      lowestAmount: money(result.lowest.amount),
      overridden: result.overridden,
      note: body.note ?? null,
    },
  });
  res.json({
    success: true,
    data: {
      request: shapeRequestForDesk(result.request),
      job: shapeJob(result.job),
      quote: shapeQuote(result.quote),
      overridden: result.overridden,
    },
  });
}
