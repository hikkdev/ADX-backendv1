import { Decimal, money, type Money } from '../../../shared/money';

/**
 * CP-1 — the pure half of agent pay. No I/O, no clock of its own.
 *
 * The model in one paragraph: an agent is paid a **monthly salary**, and that
 * salary covers a **daily quota** of onboardings. Work past the quota on a
 * given day is not covered, so it pays a **commission** — the planned unit
 * cost of one onboarding plus an uplift. Nothing else about the agent's pay
 * changes: lead rewards, site visits and bonuses are recorded as they always
 * were.
 *
 * Three decisions are worth stating here rather than leaving to be inferred:
 *
 * 1. **The quota is a day, and it resets.** Not a month. An agent who works
 *    fifteen days is never measured against a month's worth of work, and a
 *    day nobody works simply has no quota — which is why none of this needs
 *    an attendance record. The day is an Indian calendar day, the same one
 *    every other read in the platform uses.
 *
 * 2. **`workingDaysPerMonth` prices the commission and nothing else.** It is
 *    a planning figure — six-day weeks for a field agent, five for anyone
 *    selling into offices, since Saturday and Sunday are closed to them. It
 *    keeps the commission rate still while attendance moves. No report reads
 *    it as days worked.
 *
 * 3. **The uplift is on top.** `commissionUpliftPct: 10` means the unit cost
 *    plus a tenth, not a tenth of it. At ₹25,000 over 10 a day and 26 days,
 *    an onboarding costs ₹96.15 in salary and an eleventh one that day pays
 *    ₹105.77 — a real marginal incentive. A tenth OF the unit cost would pay
 *    ₹9.62, which would move nobody.
 */

export type CompensationTerms = {
  monthlySalary: Money;
  dailyQuota: number;
  workingDaysPerMonth: number;
  commissionUpliftPct: Money;
};

/** What one onboarding costs in salary, at the plan. Null when the terms cannot price one. */
export function plannedUnitCost(terms: Pick<CompensationTerms, 'monthlySalary' | 'dailyQuota' | 'workingDaysPerMonth'>): Money | null {
  const plannedPerMonth = terms.dailyQuota * terms.workingDaysPerMonth;
  if (plannedPerMonth <= 0) return null;
  const salary = new Decimal(terms.monthlySalary);
  if (salary.lessThanOrEqualTo(0)) return null;
  return money(salary.dividedBy(plannedPerMonth).toFixed(2));
}

/** What an onboarding past the day's quota pays: the unit cost plus the uplift. Null when it cannot be priced. */
export function commissionPerExtra(terms: CompensationTerms): Money | null {
  const unit = plannedUnitCost(terms);
  if (unit === null) return null;
  const uplift = new Decimal(terms.commissionUpliftPct).dividedBy(100).plus(1);
  return money(new Decimal(unit).times(uplift).toFixed(2));
}

/**
 * What the next onboarding of the day earns.
 *
 * `doneToday` is how many the agent has already completed on this Indian day,
 * NOT counting the one being recorded — so the first of the day arrives with
 * zero. Within the quota it earns nothing, because the salary already paid
 * for it; past the quota it earns the commission.
 */
export type OnboardingPay =
  | { covered: true; reason: 'WITHIN_QUOTA'; quota: number; doneToday: number; amount: null }
  | { covered: false; reason: 'BEYOND_QUOTA'; quota: number; doneToday: number; amount: Money }
  // UNPRICEABLE still knows the quota it measured against; NO_TERMS has none to know.
  | { covered: false; reason: 'UNPRICEABLE'; quota: number; doneToday: number; amount: null }
  | { covered: false; reason: 'NO_TERMS'; quota: null; doneToday: number; amount: null };

export function payForOnboarding(terms: CompensationTerms | null, doneToday: number): OnboardingPay {
  // No terms recorded: this agent is not on the quota model, and the caller
  // falls back to the flat rate table — which is what every agent was on
  // before CP-1 and what a fleet partner's rider may stay on.
  if (!terms) return { covered: false, reason: 'NO_TERMS', quota: null, doneToday, amount: null };
  if (doneToday < terms.dailyQuota) {
    return { covered: true, reason: 'WITHIN_QUOTA', quota: terms.dailyQuota, doneToday, amount: null };
  }
  const amount = commissionPerExtra(terms);
  if (amount === null) return { covered: false, reason: 'UNPRICEABLE', quota: terms.dailyQuota, doneToday, amount: null };
  return { covered: false, reason: 'BEYOND_QUOTA', quota: terms.dailyQuota, doneToday, amount };
}

/**
 * What the month's salary works out to per onboarding actually done — the
 * figure cost-per-onboarding divides by, as opposed to the planned one the
 * commission is priced from. An agent who beat the plan costs less per
 * onboarding than planned; one who missed it costs more, and the report says
 * so rather than quietly using the plan.
 *
 * Null with no onboardings: a month that produced none has no cost per one.
 */
export function salaryPerOnboarding(monthlySalary: Money, onboardingsInMonth: number): Money | null {
  if (onboardingsInMonth <= 0) return null;
  return money(new Decimal(monthlySalary).dividedBy(onboardingsInMonth).toFixed(2));
}

/* ------------------------------------------------------------------ */
/* CP-2 — what a stretch of work cost                                  */
/* ------------------------------------------------------------------ */

/**
 * A salary as the cost report reads it: an amount and the span it was in
 * force, already clamped to the agent's engagement by whoever read it. Null
 * `to` means "still in force"; the window closes it.
 */
export type SalarySpan = { monthlySalary: Money; from: Date; to: Date | null };

/** How many days the Indian calendar month containing `day` (as `YYYY-MM`) has. */
function daysInIstMonth(month: string): number {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
}

/**
 * What a set of salary spans cost over a window.
 *
 * A day costs `monthlySalary / days in that calendar month`, so a full
 * calendar month costs exactly the salary and any shorter window costs its
 * share. The obvious alternative — a flat thirtieth — would make February
 * expensive and a 31-day month cheap for no reason anyone could explain to
 * an agent, and the figure this feeds is divided by real onboardings.
 *
 * Days no span covers cost nothing, which is how an agent hired mid-month or
 * exited mid-month costs only what they were there for. Note this is the
 * salary the platform COMMITTED over the window, not a payroll record: there
 * is no payroll module, and a month nobody was paid still shows here. The
 * report says so rather than implying a payment was made.
 */
export function salaryCostOverWindow(spans: readonly SalarySpan[], window: { start: Date; end: Date }): Money {
  if (spans.length === 0 || window.end <= window.start) return money('0');
  let total = new Decimal(0);
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let at = istDayWindow(window.start).start; at < window.end; at = new Date(at.getTime() + DAY_MS)) {
    // A day counts when its start is inside the window — the window's own
    // edges are Indian day boundaries, so this never half-counts a day.
    if (at < window.start) continue;
    const span = spans.find((candidate) => candidate.from <= at && (candidate.to === null || candidate.to > at));
    if (!span) continue;
    const day = istDayOf(at);
    total = total.plus(new Decimal(span.monthlySalary).dividedBy(daysInIstMonth(day.slice(0, 7))));
  }
  return money(total.toFixed(2));
}

/**
 * CP-5: is this milestone target a stretch, or is it work the salary already
 * bought?
 *
 * An agent on ten a day over a twenty-six-day month is already paid to
 * onboard 260. A milestone that pays a bonus for onboarding 100 would pay
 * twice for the same work — once in salary and once in bonus — and nobody
 * reading the board would notice. A target ABOVE the planned month is a real
 * stretch and deserves its bonus; at or below it, the desk is told.
 *
 * Unknown (null) for an agent not on the quota model: there is no plan to
 * measure against, and guessing would flag every milestone on the platform.
 */
export function isStretchTarget(target: number, plannedPerMonth: number | null): boolean | null {
  if (plannedPerMonth === null || plannedPerMonth <= 0) return null;
  return target > plannedPerMonth;
}

/**
 * The cost of one onboarding: what was spent, over what it bought.
 *
 * Null with nothing onboarded — a window that produced none has no cost per
 * one, and a zero there would read as "free".
 */
export function costPerOnboarding(basis: Money, onboardings: number): Money | null {
  if (onboardings <= 0) return null;
  return money(new Decimal(basis).dividedBy(onboardings).toFixed(2));
}

/** The Indian calendar day an instant falls in — the day the quota resets on. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const istDayOf = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** That day's window as UTC instants, `[start, end)`. */
export function istDayWindow(at: Date): { start: Date; end: Date } {
  const day = istDayOf(at);
  const start = new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** The Indian month an instant falls in, and its window — what the salary is spread over. */
export function istMonthWindow(at: Date): { month: string; start: Date; end: Date } {
  const day = istDayOf(at);
  const month = day.slice(0, 7);
  const start = new Date(Date.parse(`${month}-01T00:00:00.000Z`) - IST_OFFSET_MS);
  const [year, mon] = month.split('-').map(Number);
  const nextMonth = mon === 12 ? `${year! + 1}-01` : `${year}-${String(mon! + 1).padStart(2, '0')}`;
  const end = new Date(Date.parse(`${nextMonth}-01T00:00:00.000Z`) - IST_OFFSET_MS);
  return { month, start, end };
}
