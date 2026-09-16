import { z } from 'zod';
import { upperEnum } from '../../../shared/validation';
import { AGENT_TIERS, TIER_LEVELS } from '../tier-ladder';
import { LEADERBOARD_PERIODS } from '../leaderboard/leaderboard.rules';

export const acknowledgeTierSchema = z.object({ eventId: z.string().trim().min(1).max(64) });

const rungSchema = z.object({
  tier: upperEnum(AGENT_TIERS),
  level: z.enum(TIER_LEVELS),
  from: z.number().int().min(0),
});

const line = z.string().trim().max(40).nullable().optional();

/** PUT /agents/tier-ladder — the thresholds and, optionally, the support lines. */
export const putLadderSchema = z
  .object({
    rungs: z.array(rungSchema).min(2).max(30).optional(),
    supportLines: z.object({ BRONZE: line, SILVER: line, GOLD: line, PLATINUM: line }).optional(),
  })
  .refine((body) => body.rungs || body.supportLines, { message: 'Nothing to change' });

/** PATCH /agents/:id/tier — pin, or unpin with `tier: null`. A reason either way. */
export const pinTierSchema = z.union([
  z.object({
    tier: upperEnum(AGENT_TIERS),
    level: z.enum(TIER_LEVELS),
    reason: z.string().trim().min(3).max(300),
  }),
  z.object({
    tier: z.null(),
    reason: z.string().trim().min(3).max(300),
  }),
]);

export const leaderboardQuerySchema = z.object({
  period: z.enum(LEADERBOARD_PERIODS).default('WEEK'),
});

export const adminLeaderboardQuerySchema = leaderboardQuerySchema.extend({
  city: z.string().trim().min(1).max(80),
});
