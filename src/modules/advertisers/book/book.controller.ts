import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { findWorkingAgentProfile } from '../../agents';
import { assertMayActFor } from '../advertisers.policy';
import { getAdvertiser } from '../advertisers.service';
import { accountActivitySchema, advertiserBookQuerySchema, brandsQuerySchema } from './book.schema';
import {
  advertiserBook,
  advertiserSummary,
  brandCards,
  brandDetail,
  listAccountActivity,
  recordAccountActivity,
} from './book.service';

const id = (req: Request) => req.params['id'] as string;

/** GET /advertisers/mine — the agent's book, on the list contract. */
export async function advertiserBookHandler(req: Request, res: Response): Promise<void> {
  const agent = await findWorkingAgentProfile(req.user!.sub);
  if (!agent) throw new ApiError(403, 'FORBIDDEN', 'Only an agent has advertisers assigned to them.');
  const parsed = advertiserBookQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await advertiserBook(agent.id, parsed.data) });
}

/** GET /advertisers/:id/summary — the detail card. */
export async function advertiserSummaryHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  res.json({ success: true, data: await advertiserSummary(id(req)) });
}

export async function listAccountActivityHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  res.json({ success: true, data: await listAccountActivity(id(req)) });
}

/**
 * POST /advertisers/:id/activity — Check in, Follow up, a call, a note.
 *
 * A READ-level act: the agent the account is attributed to may log that they
 * called, without a live grant — a phone call is not a write to the account.
 */
export async function recordAccountActivityHandler(req: Request, res: Response): Promise<void> {
  const acting = await assertMayActFor(req, id(req), 'READ');
  const parsed = accountActivitySchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const agent = await findWorkingAgentProfile(req.user!.sub);
  if (!agent && acting.as !== 'ADMIN') throw new ApiError(403, 'FORBIDDEN', 'Only an agent logs account activity');
  // An admin logging on the desk is recorded against the account's own agent when it has one.
  const agentId = agent?.id ?? (await getAdvertiser(id(req))).agentId;
  if (!agentId) throw new ApiError(409, 'CONFLICT', 'This account has no agent to log against');
  res.status(201).json({ success: true, data: await recordAccountActivity(id(req), agentId, parsed.data, req.user!.sub) });
}

/** GET /advertisers/:id/brands?status= — cards with their numbers. */
export async function brandCardsHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  const parsed = brandsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await brandCards(id(req), parsed.data.status) });
}

export async function brandDetailHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  res.json({ success: true, data: await brandDetail(id(req), req.params['brandId'] as string) });
}
