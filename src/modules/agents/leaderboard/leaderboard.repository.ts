import type { Decimal } from '../../../shared/money';

export type CohortMember = { agentId: string; userId: string; name: string; locality: string | null };

/** Lot X-B: the cohort's city — the key when it resolved, the spelling for the rows whose key is null. */
export type CohortCity = { cityId: string | null; spelling: string };

export interface LeaderboardRepository {
  /** Every offered-work agent in the city: the cohort. */
  cohort(city: CohortCity): Promise<CohortMember[]>;
  /** Credited incentives per agent inside the window (either end open). */
  earningsByAgent(agentIds: string[], window: { from: Date | null; to: Date }): Promise<Map<string, Decimal>>;
  /**
   * LH8: the "from leads" column — per agent, the credited LEAD_* incentives
   * inside the window (a share of `earningsByAgent`) and the leads they held
   * that converted inside it (a count, which is what everyone below the
   * podium is shown).
   */
  leadFiguresByAgent(agentIds: string[], window: { from: Date | null; to: Date }): Promise<Map<string, LeadFigures>>;
}

export type LeadFigures = { fromLeads: Decimal; conversions: number };
