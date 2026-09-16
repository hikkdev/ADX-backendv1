import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import type { AgentTier, TierLevel } from '../../../shared/database';
import { getLeaderboardForCity, getMyLeaderboard } from '../leaderboard/leaderboard.service';
import {
  acknowledgeTierSchema,
  adminLeaderboardQuerySchema,
  leaderboardQuerySchema,
  pinTierSchema,
  putLadderSchema,
} from './tier.schema';
import {
  acknowledgeTierEvent,
  getMyTier,
  getTierForAgent,
  loadLadder,
  loadSupportLines,
  pinTier,
  saveLadder,
  saveSupportLines,
} from './tier.service';

export async function getMyTierHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyTier(req.user!.sub) });
}

export async function acknowledgeTierHandler(req: Request, res: Response): Promise<void> {
  const parsed = acknowledgeTierSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await acknowledgeTierEvent(req.user!.sub, parsed.data.eventId) });
}

export async function getMyLeaderboardHandler(req: Request, res: Response): Promise<void> {
  const parsed = leaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await getMyLeaderboard(req.user!.sub, parsed.data.period) });
}

/* ─── ADMIN ────────────────────────────────────────────────────────────── */

export async function getLadderHandler(_req: Request, res: Response): Promise<void> {
  const [rungs, supportLines] = await Promise.all([loadLadder(), loadSupportLines()]);
  res.json({ success: true, data: { rungs, supportLines } });
}

export async function putLadderHandler(req: Request, res: Response): Promise<void> {
  const parsed = putLadderSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const rungs = parsed.data.rungs
    ? await saveLadder(parsed.data.rungs.map((r) => ({ tier: r.tier as AgentTier, level: r.level as TierLevel, from: r.from })))
    : await loadLadder();
  const supportLines = parsed.data.supportLines ? await saveSupportLines(parsed.data.supportLines) : await loadSupportLines();
  res.json({ success: true, data: { rungs, supportLines } });
}

export async function getAgentTierHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getTierForAgent(req.params['id'] as string) });
}

export async function pinTierHandler(req: Request, res: Response): Promise<void> {
  const parsed = pinTierSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const body = parsed.data;
  const input =
    body.tier === null
      ? { tier: null, reason: body.reason }
      : { tier: body.tier as AgentTier, level: body.level as TierLevel, reason: body.reason };
  res.json({ success: true, data: await pinTier(req.params['id'] as string, input, req.user!.sub) });
}

export async function getCityLeaderboardHandler(req: Request, res: Response): Promise<void> {
  const parsed = adminLeaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await getLeaderboardForCity(parsed.data.city, parsed.data.period) });
}
