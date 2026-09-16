import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { requireAgentProfile } from '../../agents';
import { listPublisherActivity, recordPublisherActivity } from './publisher-activity.service';
import { publisherActivityQuerySchema, publisherActivitySchema, publisherBookQuerySchema } from './publisher-book.schema';
import { publisherBook } from './publisher-book.service';
import { publisherSummary } from './publisher-summary.service';

const viewer = (req: Request) => ({ userId: req.user!.sub, isAdmin: req.user!.roles.includes('ADMIN') });

/** GET /publishers/book — the agent's publisher book. */
export async function publisherBookHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const parsed = publisherBookQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await publisherBook(agent.id, parsed.data) });
}

/** P-B: GET /publishers/:publisherId/summary — the detail card (ADMIN). */
export async function publisherSummaryHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await publisherSummary(req.params['publisherId'] as string, req.user!.sub) });
}

/** R-B: GET /publishers/:publisherId/activity — the action log on the list contract; the account's agent or ADMIN. */
export async function listPublisherActivityHandler(req: Request, res: Response): Promise<void> {
  const parsed = publisherActivityQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await listPublisherActivity(req.params['publisherId'] as string, viewer(req), parsed.data) });
}

/**
 * R-B: POST /publishers/:publisherId/activity — Check in, Follow up, a call, a note.
 *
 * A READ-level act, as on the advertiser: the agent the account is attributed
 * to may log that they called, without a live grant; ADMIN's is recorded
 * against the account's own agent.
 */
export async function recordPublisherActivityHandler(req: Request, res: Response): Promise<void> {
  const parsed = publisherActivitySchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.status(201).json({ success: true, data: await recordPublisherActivity(req.params['publisherId'] as string, viewer(req), parsed.data) });
}
