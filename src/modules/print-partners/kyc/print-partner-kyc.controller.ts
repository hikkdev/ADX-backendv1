import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { assignCaseSchema, documentDecisionSchema, kycEscalateSchema, reuploadRequestSchema } from '../../kyc';
import { getPartnerForUser } from '../print-partners.service';
import {
  printPartnerKycQueueQuerySchema,
  requestPrintPartnerKycSchema,
  reviewPrintPartnerKycSchema,
  submitPrintPartnerKycSchema,
  type PrintPartnerKycQueueQuery,
} from './print-partner-kyc.schema';
import {
  assignPrintPartnerCase,
  escalatePrintPartnerCase,
  getMyPrintPartnerKyc,
  getPrintPartnerKycCase,
  listPrintPartnerKycQueue,
  recordPrintPartnerKycAtDesk,
  requestPrintPartnerKyc,
  requestPrintPartnerReupload,
  requireCase,
  reviewPrintPartnerDocument,
  reviewPrintPartnerKyc,
  submitMyPrintPartnerKyc,
} from './print-partner-kyc.service';
import { initiatePrintPartnerDigioKyc, printPartnerDigioStatus, restartPrintPartnerDigioKyc } from './print-partner-digio.service';

/**
 * `/print-partners/me/kyc*` (PARTNER — the partner's own) and
 * `/print-partner-kyc*` (ADMIN — the desk) — Lot N.
 */

function parse<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { flatten: () => unknown } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error?.flatten());
  return parsed.data as T;
}

const userId = (req: Request) => req.user!.sub;
const caseId = (req: Request) => req.params['id'] as string;
const me = (req: Request) => getPartnerForUser(userId(req));

/* ── the partner's own ────────────────────────────────────────────────── */

export async function myKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyPrintPartnerKyc(await me(req)) });
}

export async function submitMyKycHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof submitMyPrintPartnerKyc>[1]>(submitPrintPartnerKycSchema, req.body ?? {});
  const partner = await me(req);
  const row = await submitMyPrintPartnerKyc(partner, body, req);
  const { printPartner: _partner, ...record } = row;
  res.status(201).json({ success: true, data: record });
}

export async function initiateMyDigioHandler(req: Request, res: Response): Promise<void> {
  const partner = await me(req);
  res.json({ success: true, data: await initiatePrintPartnerDigioKyc(partner) });
}

export async function myDigioStatusHandler(req: Request, res: Response): Promise<void> {
  const partner = await me(req);
  const status = await printPartnerDigioStatus(partner.id);
  if (!status) throw new ApiError(404, 'NOT_FOUND', 'No KYC record found');
  res.json({ success: true, data: status });
}

/* ── the desk ─────────────────────────────────────────────────────────── */

export async function listQueueHandler(req: Request, res: Response): Promise<void> {
  const query = parse<PrintPartnerKycQueueQuery>(printPartnerKycQueueQuerySchema, req.query);
  // N3-B: `state=` is the facet; `status=` its alias.
  const where = {
    ...(query.state ? { state: query.state } : query.status ? { state: query.status } : {}),
    ...(query.requested !== undefined ? { requested: query.requested } : {}),
    ...(query.assignedTo ? { assignedToId: query.assignedTo === 'me' ? userId(req) : null } : {}),
    ...(query.escalated !== undefined ? { escalated: query.escalated } : {}),
    ...(query.q ? { q: query.q } : {}),
  };
  res.json({ success: true, data: await listPrintPartnerKycQueue(where, query.page, query.pageSize, query.sort === 'newest' ? 'newest' : undefined) });
}

export async function getCaseHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getPrintPartnerKycCase(caseId(req)) });
}

export async function recordAtDeskHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof recordPrintPartnerKycAtDesk>[1]>(submitPrintPartnerKycSchema, req.body ?? {});
  res.json({ success: true, data: await recordPrintPartnerKycAtDesk(caseId(req), body, userId(req), req) });
}

export async function requestKycHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof requestPrintPartnerKyc>[1]>(requestPrintPartnerKycSchema, req.body ?? {});
  res.json({ success: true, data: await requestPrintPartnerKyc(caseId(req), body, userId(req), req) });
}

export async function reviewHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof reviewPrintPartnerKyc>[1]>(reviewPrintPartnerKycSchema, req.body ?? {});
  res.json({ success: true, data: await reviewPrintPartnerKyc(caseId(req), body, { userId: userId(req), req }) });
}

export async function reviewDocumentHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof reviewPrintPartnerDocument>[2]>(documentDecisionSchema, req.body ?? {});
  res.json({ success: true, data: await reviewPrintPartnerDocument(caseId(req), req.params['field'] as string, body, userId(req), req) });
}

export async function requestReuploadHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof requestPrintPartnerReupload>[1]>(reuploadRequestSchema, req.body ?? {});
  res.json({ success: true, data: await requestPrintPartnerReupload(caseId(req), body, userId(req), req) });
}

export async function assignHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof assignPrintPartnerCase>[1]>(assignCaseSchema, req.body ?? {});
  res.json({ success: true, data: await assignPrintPartnerCase(caseId(req), body, userId(req), req) });
}

export async function escalateHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof escalatePrintPartnerCase>[1]>(kycEscalateSchema, req.body ?? {});
  res.json({ success: true, data: await escalatePrintPartnerCase(caseId(req), body, userId(req), req) });
}

export async function restartDigioHandler(req: Request, res: Response): Promise<void> {
  const row = await requireCase(caseId(req));
  res.json({ success: true, data: await restartPrintPartnerDigioKyc(row, userId(req), req) });
}
