import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import type { KycStatus } from '../../../shared/database';
import { kycRequestSchema, pagination, reviewSchema } from '../kyc.schema';
import { employeeKycDocumentsSchema, employeeKycSearchSchema, employeeKycStateFilterSchema, employeeKycStatusFilterSchema } from './employee-kyc.schema';
import { getEmployeeIntakeLadder, getEmployeeKyc, getMyEmployeeKyc, listEmployeeKycs, recordEmployeeKyc, requestEmployeeKyc, reviewEmployeeKyc } from './employee-kyc.service';

const employeeId = (req: Request) => req.params['employeeId'] as string;

export async function getMyEmployeeKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyEmployeeKyc(req.user!.sub) });
}

// GET /employee-kyc — N3-B: every employee, `?state=` the facet (`?status=` its alias), `?q=` the search box.
export async function listEmployeeKycsHandler(req: Request, res: Response): Promise<void> {
  const parsed = employeeKycStatusFilterSchema.safeParse(req.query['status']);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid status', parsed.error.flatten());
  const state = employeeKycStateFilterSchema.safeParse(req.query['state']);
  if (!state.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid state', state.error.flatten());
  const q = employeeKycSearchSchema.safeParse(req.query['q']);
  const { page, pageSize } = pagination(req.query as Record<string, unknown>);
  const where = {
    ...(state.data ? { state: state.data } : parsed.data ? { status: parsed.data as KycStatus } : {}),
    ...(q.success && q.data ? { q: q.data } : {}),
  };
  const { items, meta } = await listEmployeeKycs(where, page, pageSize);
  res.json({ success: true, data: items, meta });
}

// POST /employee-kyc/:employeeId/request — N3-B: the one click; the channel defaults to DIGIO.
export async function requestEmployeeKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = kycRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await requestEmployeeKyc(employeeId(req), parsed.data, req.user!.sub, req) });
}

/** Lot G (Q126/Q141): the desk's checklist — `flows.employee-intake`, or the code ladder. */
export async function getEmployeeIntakeLadderHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await getEmployeeIntakeLadder() });
}

export async function getEmployeeKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getEmployeeKyc(employeeId(req)) });
}

/** On behalf: the admin at the desk records what they were shown. */
export async function recordEmployeeKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = employeeKycDocumentsSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid documents', parsed.error.flatten());
  res.json({ success: true, data: await recordEmployeeKyc(employeeId(req), parsed.data, req.user!.sub, req) });
}

export async function reviewEmployeeKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid decision', parsed.error.flatten());
  res.json({
    success: true,
    data: await reviewEmployeeKyc(employeeId(req), parsed.data.status as KycStatus, parsed.data.rejectionReason, req.user!.sub, req),
  });
}
