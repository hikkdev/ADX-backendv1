import { ApiError } from '../../../shared/errors';
import { Decimal } from '../../../shared/money';
import { cityKeyFor } from '../../pricing';
import { MIN_COHORT } from '../rating/rating.rules';
import { prismaAgentsRepository as agents } from '../prisma-agents.repository';
import { prismaLeaderboardRepository as repository } from './prisma-leaderboard.repository';
import type { LeadFigures } from './leaderboard.repository';
import { periodWindow, rank, viewFor, type Competitor, type LeaderboardPeriod, type MeRow, type PodiumRow, type PublicRow } from './leaderboard.rules';

/**
 * The leaderboard (DR 05): agents ranked by earnings over a period, within
 * their city.
 *
 * Earnings are credited AgentIncentives — the only earnings the platform
 * records for an agent (EarningAccrual belongs to publishers) — summed as
 * Decimal and printed as money; the gaps are Decimal subtraction. The cohort
 * is the city, the way AgentRating's percentile already does it, and it has
 * the same floor: below MIN_COHORT there is no board, because a leaderboard
 * of three people is a list of three people's salaries.
 *
 * There is no prize. "PRIZE ZONE" on the frame implies one, nothing pays
 * one, and DR 04's rule is that money is real or absent — so `prize` is
 * null and the app draws the podium without the words.
 */

export type LeaderboardView = {
  period: LeaderboardPeriod;
  cohort: { city: string | null; size: number; minimum: number; enough: boolean };
  me: MeRow | null;
  top: PodiumRow[];
  window: PublicRow[];
  around: PublicRow[];
  prize: null;
};

async function board(city: string | null, period: LeaderboardPeriod, viewerAgentId: string | null, now: Date, windowTo?: number, cityId?: string | null): Promise<LeaderboardView> {
  const empty: LeaderboardView = {
    period,
    cohort: { city, size: 0, minimum: MIN_COHORT, enough: false },
    me: null,
    top: [],
    window: [],
    around: [],
    prize: null,
  };
  if (!city) return empty;

  // Lot X-B: the cohort is keyed — the agent's own key when the profile carries one, else the spelling resolved.
  const members = await repository.cohort({ cityId: cityId ?? (await cityKeyFor(city))?.cityId ?? null, spelling: city });
  if (members.length < MIN_COHORT) return { ...empty, cohort: { ...empty.cohort, size: members.length } };

  const { from, to, previous } = periodWindow(period, now);
  const ids = members.map((member) => member.agentId);
  const [current, before, leads] = await Promise.all([
    repository.earningsByAgent(ids, { from, to }),
    previous ? repository.earningsByAgent(ids, previous) : Promise.resolve(null),
    // LH8: the "from leads" column is read once, for the current window; the
    // previous window ranks on earnings alone, which is all the delta needs.
    repository.leadFiguresByAgent(ids, { from, to }),
  ]);

  const competitors = (earnings: Map<string, Decimal>, figures: Map<string, LeadFigures> | null): Competitor[] =>
    members.map((member) => ({
      ...member,
      earnings: earnings.get(member.agentId) ?? new Decimal(0),
      fromLeads: figures?.get(member.agentId)?.fromLeads ?? new Decimal(0),
      conversions: figures?.get(member.agentId)?.conversions ?? 0,
    }));

  const ranked = rank(competitors(current, leads));
  const previouslyRanked = before ? rank(competitors(before, null)) : null;
  const view = viewFor(ranked, viewerAgentId, previouslyRanked, windowTo);

  return {
    period,
    cohort: { city, size: members.length, minimum: MIN_COHORT, enough: true },
    ...view,
    prize: null,
  };
}

/** GET /agents/me/leaderboard */
export async function getMyLeaderboard(userId: string, period: LeaderboardPeriod, now = new Date()): Promise<LeaderboardView> {
  const profile = await agents.findByUserId(userId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  return board(profile.city, period, profile.id, now, undefined, profile.cityId);
}

/**
 * GET /agents/leaderboard — the desk's read: a city, nobody's own row, and
 * the whole cohort ranked (decision 9 is about agents seeing each other's
 * figures; ops see rank, name and locality for everyone, and the podium's
 * figures like anyone else).
 */
export async function getLeaderboardForCity(city: string, period: LeaderboardPeriod, now = new Date()): Promise<LeaderboardView> {
  return board(city, period, null, now, Number.POSITIVE_INFINITY);
}
