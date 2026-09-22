import { Decimal, money, type Money } from '../../../shared/money';

/**
 * The pure half of the leaderboard: periods, ranking, and what each viewer
 * is shown. No I/O.
 */

export const LEADERBOARD_PERIODS = ['WEEK', 'MONTH', 'ALL'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rolling windows, not calendar ones: "this week" on a Monday morning would
 * rank nobody. The previous window is the same length, ending where this
 * one starts — that is what the "▲ 3" delta is measured against. ALL has no
 * window and no delta.
 */
export function periodWindow(period: LeaderboardPeriod, now: Date): { from: Date | null; to: Date; previous: { from: Date; to: Date } | null } {
  const days = period === 'WEEK' ? 7 : period === 'MONTH' ? 30 : null;
  if (days === null) return { from: null, to: now, previous: null };
  const from = new Date(now.getTime() - days * DAY_MS);
  return { from, to: now, previous: { from: new Date(from.getTime() - days * DAY_MS), to: from } };
}

export type Competitor = {
  agentId: string;
  name: string;
  locality: string | null;
  earnings: Decimal;
  /** LH8: the share of `earnings` the hunt paid — LEAD_CONVERTED / ACTIVATED / RETAINED. */
  fromLeads: Decimal;
  /** LH8: leads held that converted in the window. */
  conversions: number;
};

export type Ranked = Competitor & { rank: number };

/** Earnings descending, then name, so a tie is still a fixed order. Ranks are 1..n. */
export function rank(competitors: Competitor[]): Ranked[] {
  return [...competitors]
    .sort((a, b) => b.earnings.comparedTo(a.earnings) || a.name.localeCompare(b.name))
    .map((competitor, i) => ({ ...competitor, rank: i + 1 }));
}

/** The frame's podium: three, with the crown on one. */
export const PODIUM = 3;
/** "Show ranks 4–10" — the disclosure's window. */
export const WINDOW_TO = 10;

/** LH8: `conversions` is a count, not a figure, so it may leave the server for every row (decision 9 is about money). */
export type PublicRow = { rank: number; agentId: string; name: string; locality: string | null; you: boolean; conversions: number };
export type PodiumRow = PublicRow & { earnings: Money; fromLeads: Money };

export type MeRow = {
  rank: number;
  earnings: Money;
  /** LH8: how much of `earnings` came from leads. */
  fromLeads: Money;
  /** Places climbed since the previous window; negative is a fall; null on ALL or a newcomer. */
  delta: number | null;
  /** The neighbour above: how far behind them you are. */
  behind: { rank: number; gap: Money } | null;
  /** The neighbour below: how far ahead of them you are. */
  ahead: { rank: number; gap: Money } | null;
};

/**
 * What one viewer sees (decision 9). The podium shows its three figures —
 * a leaderboard with no winners is a list — and everyone else is rank, name
 * and locality. The viewer's own figure and the gaps to their two neighbours
 * are theirs to see; nobody else's absolute figure leaves the server.
 */
export function viewFor(
  ranked: Ranked[],
  viewerAgentId: string | null,
  previous: Ranked[] | null,
  /** How far the public window runs: ranks 4–10 for an agent, the whole cohort for the desk. */
  windowTo: number = WINDOW_TO,
) {
  const you = (row: Ranked): boolean => row.agentId === viewerAgentId;
  const pub = (row: Ranked): PublicRow => ({ rank: row.rank, agentId: row.agentId, name: row.name, locality: row.locality, you: you(row), conversions: row.conversions });

  const top: PodiumRow[] = ranked.slice(0, PODIUM).map((row) => ({ ...pub(row), earnings: money(row.earnings), fromLeads: money(row.fromLeads) }));
  const window: PublicRow[] = ranked.slice(PODIUM, windowTo).map(pub);

  const mine = viewerAgentId ? ranked.find(you) ?? null : null;
  let me: MeRow | null = null;
  let around: PublicRow[] = [];
  if (mine) {
    const above = ranked[mine.rank - 2] ?? null;
    const below = ranked[mine.rank] ?? null;
    const before = previous?.find((row) => row.agentId === viewerAgentId) ?? null;
    me = {
      rank: mine.rank,
      earnings: money(mine.earnings),
      fromLeads: money(mine.fromLeads),
      delta: previous === null ? null : before ? before.rank - mine.rank : null,
      behind: above ? { rank: above.rank, gap: money(above.earnings.minus(mine.earnings)) } : null,
      ahead: below ? { rank: below.rank, gap: money(mine.earnings.minus(below.earnings)) } : null,
    };
    // The rows around you are drawn only when you are off the first page.
    if (mine.rank > WINDOW_TO) {
      around = ranked.slice(Math.max(0, mine.rank - 2), mine.rank + 1).map(pub);
    }
  }

  return { top, window, around, me };
}
