import type { AgentCompensation } from '../../../shared/database';
import type { Money } from '../../../shared/money';

/** CP-1: the pay record as it is written — money already as a decimal string. */
export type NewCompensation = {
  agentId: string;
  monthlySalary: Money;
  dailyQuota: number;
  workingDaysPerMonth: number;
  commissionUpliftPct: Money;
  effectiveFrom: Date;
  note: string | null;
  createdByUserId: string;
};

/**
 * CP-2: which side of the market a cost read is about.
 *
 * The two are apart because the work is: a field agent walking a market and
 * a sales agent sitting in an office are not the same money per account, and
 * the whole point of the figure is to say so. An agent holding BOTH roles
 * counts on both sides, so the two never add up to `ALL` — their salary
 * genuinely buys both, and splitting it by guesswork would turn a real
 * number into a made-up one.
 */
export type CostSide = 'PUBLISHER' | 'ADVERTISER' | 'ALL';

/** CP-2: a salary and the span it was in force, clamped to the engagement, with the agent's own city. */
export type SalarySpanRow = { agentId: string; cityId: string | null; city: string | null; monthlySalary: Money; from: Date; to: Date | null };

/**
 * CP-2: what one agent was credited in a window, split in two.
 *
 * `commission` is the per-onboarding commission alone. `rewards` is
 * everything else that buys an account: the lead rewards, the milestone and
 * tier bonuses, the site visit, the campaign assist. In NEITHER are
 * `INSTALLATION` and `PACKAGE_SOLD` — they pay for executing an order or
 * selling a package, which happens after the account is won, and charging
 * them to a cost per onboarding would make the figure meaningless.
 */
export type AgentPaymentRow = { agentId: string; cityId: string | null; city: string | null; commission: Money; rewards: Money };

export interface CompensationRepository {
  /**
   * CP-2: every salary span overlapping the window for agents of one side,
   * clamped to the engagement — an agent hired or exited mid-window costs
   * only the days they were here. Rows, deliberately: the service prorates
   * them into the aggregate the rest of the platform reads.
   */
  salarySpansIn(window: { start: Date; end: Date }, scope: { city?: string | undefined; cityId?: string | null | undefined }, side: CostSide): Promise<SalarySpanRow[]>;
  /** CP-2: CREDITED incentives by `verifiedAt` in the window, per agent, split into commission and the rest. */
  paymentsIn(window: { start: Date; end: Date }, scope: { city?: string | undefined; cityId?: string | null | undefined }, side: CostSide): Promise<AgentPaymentRow[]>;
  /** CP-2: the `City` rows behind a set of keys, so a cost can be labelled per zone. */
  labelCities(cityIds: readonly string[]): Promise<Map<string, { slug: string; name: string }>>;
  /** The record in force for an agent at an instant, or null when they are not on the quota model. */
  findInForce(agentId: string, at: Date): Promise<AgentCompensation | null>;
  /** Every record for an agent, newest first — the history the desk reads. */
  listForAgent(agentId: string): Promise<AgentCompensation[]>;
  /** Writes a new record and closes the one it supersedes. */
  create(data: NewCompensation): Promise<AgentCompensation>;
  /** The agents who have any pay record in force at an instant — the report's cohort. */
  inForceFor(agentIds: readonly string[], at: Date): Promise<Map<string, AgentCompensation>>;

  /**
   * How many onboardings the agent completed inside a window — a publisher
   * reaching ONBOARDING_COMPLETE, an advertiser reaching `activatedAt`. The
   * same two counters the tier ladder climbs on, so the quota, the rung and
   * the cost report can never disagree about what an onboarding is.
   */
  countOnboardingsIn(agentId: string, window: { start: Date; end: Date }): Promise<number>;
  /** The same count for several agents at once — the monthly report. */
  countOnboardingsForAgents(agentIds: readonly string[], window: { start: Date; end: Date }): Promise<Map<string, number>>;
}
