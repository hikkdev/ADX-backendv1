import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { getAdvertiserForUser } from '../advertisers';
import { findAgentProfile } from '../agents';
import type { CampaignActor } from '../campaigns';
import { hideSchema, listReviewsQuerySchema, myAgentReviewsQuerySchema, rateSchema, reviewPageQuerySchema } from './reviews.schema';
import {
  agentReviews,
  myAgentReviews,
  hideReview,
  listReviews,
  listingReviews,
  rateAgent,
  rateAgentEligibility,
  reviewSpot,
  unhideReview,
} from './reviews.service';

function parse<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten(): unknown } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error?.flatten());
  return parsed.data as T;
}

/**
 * Who is asking, the way `campaigns` resolves it: the token's user looked up
 * against both tables, never trusted to say which it is.
 */
async function resolveActor(req: Request): Promise<CampaignActor> {
  const userId = req.user!.sub;
  const [advertiser, agent] = await Promise.all([getAdvertiserForUser(userId), findAgentProfile(userId)]);
  return {
    userId,
    isAdmin: req.user!.roles.includes('ADMIN'),
    advertiserId: advertiser?.id ?? null,
    agentId: agent?.id ?? null,
  };
}

/* ── A spot — Q104 ──────────────────────────────────────────────────── */

export async function reviewSpotHandler(req: Request, res: Response): Promise<void> {
  const body = parse<ReturnType<typeof rateSchema.parse>>(rateSchema, req.body);
  const actor = await resolveActor(req);
  const review = await reviewSpot(req.params['id'] as string, req.params['spotId'] as string, body, actor);
  res.status(201).json({ success: true, data: review });
}

export async function listingReviewsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<ReturnType<typeof reviewPageQuerySchema.parse>>(reviewPageQuerySchema, req.query);
  res.json({ success: true, data: await listingReviews(req.params['listingId'] as string, query) });
}

/* ── An agent — Q112 ────────────────────────────────────────────────── */

export async function rateAgentHandler(req: Request, res: Response): Promise<void> {
  const body = parse<ReturnType<typeof rateSchema.parse>>(rateSchema, req.body);
  const review = await rateAgent(req.params['id'] as string, body, req.user!.sub);
  res.status(201).json({ success: true, data: review });
}

export async function rateAgentEligibilityHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await rateAgentEligibility(req.params['id'] as string, req.user!.sub) });
}

/** E7-2: the agent's own stars — the profile behind the session, never a named id. */
export async function myAgentReviewsHandler(req: Request, res: Response): Promise<void> {
  const agent = await findAgentProfile(req.user!.sub);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  const query = parse<ReturnType<typeof myAgentReviewsQuerySchema.parse>>(myAgentReviewsQuerySchema, req.query);
  res.json({ success: true, data: await myAgentReviews(agent.id, query) });
}

/* ── The desk ───────────────────────────────────────────────────────── */

export async function hideReviewHandler(req: Request, res: Response): Promise<void> {
  const body = parse<ReturnType<typeof hideSchema.parse>>(hideSchema, req.body);
  res.json({ success: true, data: await hideReview(req.params['id'] as string, body.reason, req.user!.sub, req) });
}

export async function unhideReviewHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await unhideReview(req.params['id'] as string, req.user!.sub, req) });
}

export async function listReviewsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<ReturnType<typeof listReviewsQuerySchema.parse>>(listReviewsQuerySchema, req.query);
  res.json({ success: true, data: await listReviews(query) });
}

export async function agentReviewsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<ReturnType<typeof reviewPageQuerySchema.parse>>(reviewPageQuerySchema, req.query);
  res.json({ success: true, data: await agentReviews(req.params['id'] as string, query) });
}
