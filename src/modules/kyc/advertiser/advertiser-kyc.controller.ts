import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import type { KycStatus } from '../../../shared/database';
import {
  assignCaseSchema,
  assignedToSchema,
  documentDecisionSchema,
  escalatedFilterSchema,
  kycEscalateSchema,
  kycRequestSchema,
  pagination,
  requestedFilterSchema,
  reuploadRequestSchema,
  reviewSchema,
} from '../kyc.schema';
import {
  advertiserIdFilterSchema,
  advertiserKycSearchSchema,
  advertiserKycStateFilterSchema,
  advertiserKycStatusFilterSchema,
  createAdvertiserKycSchema,
  updateAdvertiserKycSchema,
} from './advertiser-kyc.schema';
import {
  assignAdvertiserCase,
  createAdvertiserKyc,
  deleteAdvertiserKyc,
  escalateAdvertiserCase,
  getAdvertiserKycCase,
  requestAdvertiserReupload,
  reviewAdvertiserDocument,
  getMyAdvertiserKyc,
  listAdvertiserKycs,
  requestAdvertiserKyc,
  resubmitAdvertiserKyc,
  reviewAdvertiserKyc,
  updateAdvertiserKycById,
} from './advertiser-kyc.service';
import { advertiserDigioStatus, initiateAdvertiserDigioKyc, restartAdvertiserDigioKyc } from './advertiser-digio.service';
import { getAdvertiserForUser } from '../../advertisers';

export async function createAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = createAdvertiserKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await createAdvertiserKyc(req.user!.sub, parsed.data);
  res.status(201).json({ success: true, data: kyc });
}

export async function getMyAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyAdvertiserKyc(req.user!.sub) });
}

export async function getAllAdvertiserKycsHandler(req: Request, res: Response): Promise<void> {
  const { page, pageSize } = pagination(req.query as Record<string, unknown>);

  // N3-B: `state=` is the facet — one of the six party states; `status=` stays
  // as its alias (each record status names the state of the same word).
  // An unparseable status is ignored rather than rejected — the listing falls
  // back to unfiltered. Inherited behaviour; do not turn this into a 400.
  const stateFilter = advertiserKycStateFilterSchema.safeParse(req.query['state']);
  const statusFilter = advertiserKycStatusFilterSchema.safeParse(req.query['status']);
  const state = stateFilter.success && stateFilter.data ? stateFilter.data : statusFilter.success && statusFilter.data ? statusFilter.data : undefined;
  // N3-B: `q=` over the party's name, company, display id, email or mobile.
  const q = advertiserKycSearchSchema.safeParse(req.query['q']);
  // Lot D (Q119): `assignedTo=me|none` — a filter, not ownership.
  const assignedTo = assignedToSchema.safeParse(req.query['assignedTo']);
  // Lot G (Q127/142): `escalated=true|false`.
  const escalated = escalatedFilterSchema.safeParse(req.query['escalated']);
  // Lot N: `requested=true|false` — a request from the desk with nothing submitted yet.
  const requested = requestedFilterSchema.safeParse(req.query['requested']);
  // N2-B / N3-B: `advertiserId=` — one advertiser (their profile id or user id), one row or none.
  const advertiserId = advertiserIdFilterSchema.safeParse(req.query['advertiserId']);
  const where = {
    ...(state ? { state } : {}),
    ...(q.success && q.data ? { q: q.data } : {}),
    ...(assignedTo.success && assignedTo.data ? { assignedToId: assignedTo.data === 'me' ? req.user!.sub : null } : {}),
    ...(escalated.success && escalated.data !== undefined ? { escalated: escalated.data } : {}),
    ...(requested.success && requested.data !== undefined ? { requested: requested.data } : {}),
    ...(advertiserId.success && advertiserId.data ? { advertiserId: advertiserId.data } : {}),
  };

  // Absent means "what is late first"; `newest` is the arrival order.
  const sort = req.query['sort'] === 'newest' ? 'newest' : undefined;

  // E7-3: the publisher queue's shape as `data`; the old `meta` sibling stays one release.
  const { meta, ...data } = await listAdvertiserKycs(where, page, pageSize, sort);
  res.json({ success: true, data, meta });
}

// GET /advertiser-kyc/:id — N2-B / N3-B: the row id, the profile id, or the advertiser's user id.
export async function getAdvertiserKycByIdHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getAdvertiserKycCase(req.params['id'] as string) });
}

/* ── Lot D (Q42/Q119): the per-document desk ─────────────────────────────── */

// PATCH /advertiser-kyc/:id/documents/:field
export async function reviewAdvertiserDocumentHandler(req: Request, res: Response): Promise<void> {
  const parsed = documentDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid decision', parsed.error.flatten());
  res.json({
    success: true,
    data: await reviewAdvertiserDocument(req.params['id'] as string, req.params['field'] as string, parsed.data, req.user!.sub, req),
  });
}

// POST /advertiser-kyc/:id/request-reupload
export async function requestAdvertiserReuploadHandler(req: Request, res: Response): Promise<void> {
  const parsed = reuploadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await requestAdvertiserReupload(req.params['id'] as string, parsed.data, req.user!.sub, req) });
}

// PATCH /advertiser-kyc/:id/assign
export async function assignAdvertiserCaseHandler(req: Request, res: Response): Promise<void> {
  const parsed = assignCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await assignAdvertiserCase(req.params['id'] as string, parsed.data, req.user!.sub, req) });
}

// POST /advertiser-kyc/:id/escalate — Lot G (Q127/142)
export async function escalateAdvertiserCaseHandler(req: Request, res: Response): Promise<void> {
  const parsed = kycEscalateSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await escalateAdvertiserCase(req.params['id'] as string, parsed.data, req.user!.sub, req) });
}

export async function updateAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateAdvertiserKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await resubmitAdvertiserKyc(req.user!.sub, parsed.data);
  res.json({ success: true, data: kyc });
}

// PUT /advertiser-kyc/:id — Lot N: recorded at the desk, on the advertiser's behalf; N2-B / N3-B: by the row id, the profile id or the user id, the row made when there is none.
export async function updateAdvertiserKycByIdHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateAdvertiserKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await updateAdvertiserKycById(req.params['id'] as string, parsed.data, req.user!.sub, req);
  res.json({ success: true, data: kyc });
}

// POST /advertiser-kyc/:id/request — Lot N: the desk asks the advertiser for their KYC.
export async function requestAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = kycRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await requestAdvertiserKyc(req.params['id'] as string, parsed.data, req.user!.sub, req) });
}

export async function reviewAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await reviewAdvertiserKyc(
    req.params['id'] as string,
    parsed.data.status as KycStatus,
    parsed.data.rejectionReason,
    { userId: req.user!.sub, note: parsed.data.reviewNote ?? null, req },
  );
  res.json({ success: true, data: kyc });
}

export async function deleteAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  await deleteAdvertiserKyc(req.params['id'] as string);
  res.json({ success: true, data: { message: 'KYC record deleted' } });
}

/* ── U7, demand side: Digio from the advertiser's own phone ──────────── */

export async function initiateMyAdvertiserDigioHandler(req: Request, res: Response): Promise<void> {
  const advertiser = await getAdvertiserForUser(req.user!.sub);
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'Advertiser profile not found. Complete registration first.');
  // N3-B: the session is keyed by the caller's profile.
  const session = await initiateAdvertiserDigioKyc(advertiser);
  res.json({ success: true, data: session });
}

// POST /advertiser-kyc/:id/digio/restart — the desk asks Digio again for this row.
export async function restartAdvertiserDigioHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await restartAdvertiserDigioKyc(req.params['id'] as string, req.user!.sub, req) });
}

export async function myAdvertiserDigioStatusHandler(req: Request, res: Response): Promise<void> {
  const status = await advertiserDigioStatus(req.user!.sub);
  if (!status) throw new ApiError(404, 'NOT_FOUND', 'No KYC record found');
  res.json({ success: true, data: status });
}
