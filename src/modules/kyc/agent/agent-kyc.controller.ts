import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import type { KycStatus } from '../../../shared/database';
import { kycRequestSchema, pagination, reviewSchema } from '../kyc.schema';
import { agentKycDocumentsSchema, agentKycSearchSchema, agentKycStateFilterSchema, agentKycStatusFilterSchema } from './agent-kyc.schema';
import { getAgentKyc, getMyAgentKyc, listAgentKycs, recordAgentKyc, requestAgentKyc, reviewAgentKyc } from './agent-kyc.service';

const agentId = (req: Request) => req.params['agentId'] as string;

export async function getMyAgentKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyAgentKyc(req.user!.sub) });
}

// GET /agent-kyc — N3-B: every agent, `?state=` the facet (`?status=` its alias), `?q=` the search box.
export async function listAgentKycsHandler(req: Request, res: Response): Promise<void> {
  const parsed = agentKycStatusFilterSchema.safeParse(req.query['status']);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid status', parsed.error.flatten());
  const state = agentKycStateFilterSchema.safeParse(req.query['state']);
  if (!state.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid state', state.error.flatten());
  const q = agentKycSearchSchema.safeParse(req.query['q']);
  const { page, pageSize } = pagination(req.query as Record<string, unknown>);
  const where = {
    ...(state.data ? { state: state.data } : parsed.data ? { status: parsed.data as KycStatus } : {}),
    ...(q.success && q.data ? { q: q.data } : {}),
  };
  const { items, meta } = await listAgentKycs(where, page, pageSize);
  res.json({ success: true, data: items, meta });
}

// POST /agent-kyc/:agentId/request — N3-B: the one click; the channel defaults to DIGIO.
export async function requestAgentKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = kycRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await requestAgentKyc(agentId(req), parsed.data, req.user!.sub, req) });
}

export async function getAgentKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getAgentKyc(agentId(req)) });
}

/** On behalf: the admin at the desk records what they were shown. */
export async function recordAgentKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = agentKycDocumentsSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid documents', parsed.error.flatten());
  res.json({ success: true, data: await recordAgentKyc(agentId(req), parsed.data, req.user!.sub) });
}

export async function reviewAgentKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid decision', parsed.error.flatten());
  res.json({
    success: true,
    data: await reviewAgentKyc(agentId(req), parsed.data.status as KycStatus, parsed.data.rejectionReason, req.user!.sub),
  });
}
