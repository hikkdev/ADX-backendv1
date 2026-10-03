import { Decimal, money, type Money } from '../../../shared/money';
import { costPerOnboarding, salaryCostOverWindow, type SalarySpan } from './compensation.rules';
import type { CostSide } from './compensation.repository';
import { prismaCompensationRepository as repository } from './prisma-compensation.repository';

/**
 * CP-2 — what agent money a window cost, ready to be divided by what it
 * bought.
 *
 * The agents module owns the salary rows and the incentive rows, so it owns
 * this read and exports the aggregate — the same shape `supply` exports its
 * funnel in. Nothing below returns a row: a caller gets totals and totals
 * per city, never an agent.
 *
 * **What the figure is made of**, and what the owner asked for. The basis is
 * the salary committed over the window plus everything paid that buys an
 * account — lead rewards, the milestone and tier bonuses, a site visit, a
 * campaign assist. The per-onboarding **commission** is kept out of the
 * basis and reported beside it, because it is the one payment that scales
 * exactly with the thing being counted: adding it to the numerator and its
 * own trigger to the denominator tells you nothing you did not already know
 * from the rate. `allIn` adds it back for anyone who wants the whole bill.
 *
 * **What it is not.** There is no payroll module, so `salary` is what the
 * platform COMMITTED at the recorded terms over the days the agent was
 * engaged — not evidence that anyone was paid. Every caller says so on the
 * screen rather than letting a reader assume otherwise.
 */

export type CostCityRow = {
  key: string;
  cityId: string | null;
  slug: string | null;
  name: string | null;
  typed: string[];
  salary: Money;
  rewards: Money;
  commission: Money;
  basis: Money;
  allIn: Money;
};

export type AgentCostView = {
  side: CostSide;
  /** The salary committed over the window, prorated across the days each record was in force. */
  salary: Money;
  /** Lead rewards, milestone and tier bonuses, site visits, campaign assists — CREDITED in the window. */
  rewards: Money;
  /** The per-onboarding commission alone, reported beside the basis rather than inside it. */
  commission: Money;
  /** `salary + rewards` — the numerator of the cost per onboarding. */
  basis: Money;
  /** `basis + commission` — the whole agent bill for the window. */
  allIn: Money;
  /** How many agents of this side have any salary recorded at all. */
  agentsOnTerms: number;
  byCity: CostCityRow[];
};

const plus = (a: Money, b: Money): Money => money(new Decimal(a).plus(b).toFixed(2));
const ZERO = money('0');

/** The city bucket a row belongs to: the key when it has one, otherwise the single "typed" bucket. */
const bucketOf = (cityId: string | null): string => cityId ?? '';

export async function agentCostOverWindow(
  window: { start: Date; end: Date },
  scope: { city?: string | undefined; cityId?: string | null | undefined },
  side: CostSide,
): Promise<AgentCostView> {
  const [spans, payments] = await Promise.all([repository.salarySpansIn(window, scope, side), repository.paymentsIn(window, scope, side)]);

  /* One agent may hold several salary records inside a window — a raise
     mid-month is exactly that — so the spans are folded per agent before
     they are prorated, and the rule picks whichever was in force each day. */
  const byAgent = new Map<string, { cityId: string | null; city: string | null; spans: SalarySpan[] }>();
  for (const row of spans) {
    const entry = byAgent.get(row.agentId) ?? { cityId: row.cityId, city: row.city, spans: [] };
    entry.spans.push({ monthlySalary: row.monthlySalary, from: row.from, to: row.to });
    byAgent.set(row.agentId, entry);
  }

  const cities = new Map<string, CostCityRow>();
  const typedNames = new Map<string, Set<string>>();
  const rowFor = (cityId: string | null, city: string | null): CostCityRow => {
    const key = bucketOf(cityId);
    const row =
      cities.get(key) ??
      ({ key, cityId, slug: null, name: null, typed: [], salary: ZERO, rewards: ZERO, commission: ZERO, basis: ZERO, allIn: ZERO } as CostCityRow);
    cities.set(key, row);
    if (!cityId && city && city.trim()) {
      const names = typedNames.get(key) ?? new Set<string>();
      names.add(city.trim());
      typedNames.set(key, names);
    }
    return row;
  };

  let salary = ZERO;
  for (const [, entry] of byAgent) {
    const cost = salaryCostOverWindow(entry.spans, window);
    salary = plus(salary, cost);
    const row = rowFor(entry.cityId, entry.city);
    row.salary = plus(row.salary, cost);
  }

  let rewards = ZERO;
  let commission = ZERO;
  for (const payment of payments) {
    rewards = plus(rewards, payment.rewards);
    commission = plus(commission, payment.commission);
    const row = rowFor(payment.cityId, payment.city);
    row.rewards = plus(row.rewards, payment.rewards);
    row.commission = plus(row.commission, payment.commission);
  }

  const labels = await repository.labelCities([...cities.keys()].filter((key) => key !== ''));
  for (const [key, row] of cities) {
    const label = labels.get(key);
    if (label) {
      row.slug = label.slug;
      row.name = label.name;
    }
    row.typed = [...(typedNames.get(key) ?? [])].sort((a, b) => a.localeCompare(b));
    row.basis = plus(row.salary, row.rewards);
    row.allIn = plus(row.basis, row.commission);
  }

  const basis = plus(salary, rewards);
  return {
    side,
    salary,
    rewards,
    commission,
    basis,
    allIn: plus(basis, commission),
    agentsOnTerms: byAgent.size,
    byCity: [...cities.values()].sort((a, b) => new Decimal(b.basis).comparedTo(new Decimal(a.basis)) || (a.name ?? '').localeCompare(b.name ?? '')),
  };
}

export { costPerOnboarding };
