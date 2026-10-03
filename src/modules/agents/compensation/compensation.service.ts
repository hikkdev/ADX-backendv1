import type { AgentCompensation } from '../../../shared/database';
import { logActivity } from '../../../shared/audit';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { money, type Money } from '../../../shared/money';
import { getPlatformSettings } from '../../app-config';
import { prismaAgentsRepository as agents } from '../prisma-agents.repository';
import { prismaCompensationRepository as repository } from './prisma-compensation.repository';
import {
  commissionPerExtra,
  istDayWindow,
  istMonthWindow,
  payForOnboarding,
  plannedUnitCost,
  salaryPerOnboarding,
  type CompensationTerms,
  type OnboardingPay,
} from './compensation.rules';

/**
 * CP-1 — what an agent is paid, and what their next onboarding earns.
 *
 * The one door the party modules call is `payForNextOnboarding`. Everything
 * else here is the desk's: recording a pay record, reading the history, and
 * the defaults the form starts from.
 *
 * **Nothing in this file moves money.** It answers what an onboarding is
 * worth; the party module records the incentive, as it always did.
 */

export type CompensationView = {
  id: string;
  agentId: string;
  monthlySalary: Money;
  dailyQuota: number;
  workingDaysPerMonth: number;
  commissionUpliftPct: Money;
  /** What one onboarding costs in salary at the plan — `salary / (quota * days)`. */
  plannedUnitCost: Money | null;
  /** What an onboarding past the day's quota pays. */
  commissionPerExtra: Money | null;
  /** The plan's monthly capacity: `quota * days`. */
  plannedPerMonth: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdByUserId: string;
  createdAt: string;
};

const termsOf = (row: AgentCompensation): CompensationTerms => ({
  monthlySalary: money(row.monthlySalary),
  dailyQuota: row.dailyQuota,
  workingDaysPerMonth: row.workingDaysPerMonth,
  commissionUpliftPct: money(row.commissionUpliftPct),
});

export function compensationView(row: AgentCompensation): CompensationView {
  const terms = termsOf(row);
  return {
    id: row.id,
    agentId: row.agentId,
    monthlySalary: terms.monthlySalary,
    dailyQuota: row.dailyQuota,
    workingDaysPerMonth: row.workingDaysPerMonth,
    commissionUpliftPct: terms.commissionUpliftPct,
    plannedUnitCost: plannedUnitCost(terms),
    commissionPerExtra: commissionPerExtra(terms),
    plannedPerMonth: row.dailyQuota * row.workingDaysPerMonth,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── the door the party modules call ──────────────────────────────── */

export type NextOnboardingPay = OnboardingPay & { agentId: string; day: string };

/**
 * What the onboarding about to be recorded for this agent earns.
 *
 * Counts what they have already finished **today** (an Indian calendar day,
 * so the quota resets at midnight IST and a day nobody works has none), then
 * asks the rules. A `NO_TERMS` answer means the agent is not on the quota
 * model at all and the caller should fall back to the flat rate table — which
 * is every agent before CP-1, and a fleet partner's rider after it.
 *
 * Never throws: a failure to read the terms answers NO_TERMS, because an
 * onboarding must not fail over the pricing of its commission.
 */
export async function payForNextOnboarding(agentId: string, at = new Date()): Promise<NextOnboardingPay> {
  const day = istDayWindow(at);
  try {
    const row = await repository.findInForce(agentId, at);
    if (!row) return { agentId, day: day.start.toISOString().slice(0, 10), ...payForOnboarding(null, 0) };
    const doneToday = await repository.countOnboardingsIn(agentId, day);
    return { agentId, day: day.start.toISOString().slice(0, 10), ...payForOnboarding(termsOf(row), doneToday) };
  } catch (err) {
    logger.warn('Could not price an onboarding against the quota; falling back to the rate table', { agentId, err });
    return { agentId, day: day.start.toISOString().slice(0, 10), ...payForOnboarding(null, 0) };
  }
}

/* ── the desk ─────────────────────────────────────────────────────── */

/** The defaults the form starts from for a grade — the platform settings, not a payment. */
export async function compensationDefaults(grade?: string | null) {
  const settings = await getPlatformSettings();
  const block = settings.agents.compensation;
  const key = (grade ?? 'G1') as 'G1' | 'G2' | 'G3' | 'G4';
  const band = block.byGrade[key] ?? block.byGrade.G1;
  const terms: CompensationTerms = {
    monthlySalary: money(band.monthlySalary),
    dailyQuota: band.dailyQuota,
    workingDaysPerMonth: band.workingDaysPerMonth,
    commissionUpliftPct: money(block.commissionUpliftPct),
  };
  return {
    grade: key,
    ...terms,
    plannedUnitCost: plannedUnitCost(terms),
    commissionPerExtra: commissionPerExtra(terms),
    plannedPerMonth: band.dailyQuota * band.workingDaysPerMonth,
  };
}

export type SetCompensationInput = {
  monthlySalary: Money;
  dailyQuota: number;
  workingDaysPerMonth?: number | undefined;
  commissionUpliftPct?: Money | undefined;
  effectiveFrom?: Date | undefined;
  note?: string | undefined;
};

/**
 * Records what an agent is paid, from a date. Closes the record it
 * supersedes, so a past month keeps the salary it was costed at. Audited —
 * this is a money term, and ops must be able to see who changed it.
 */
export async function setCompensation(agentId: string, input: SetCompensationInput, byUserId: string, now = new Date()): Promise<CompensationView> {
  const profile = await agents.findById(agentId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  const defaults = await compensationDefaults((profile as { grade?: string | null }).grade ?? null);
  const effectiveFrom = input.effectiveFrom ?? now;
  const before = await repository.findInForce(agentId, effectiveFrom);

  const row = await repository.create({
    agentId,
    monthlySalary: money(input.monthlySalary),
    dailyQuota: input.dailyQuota,
    workingDaysPerMonth: input.workingDaysPerMonth ?? defaults.workingDaysPerMonth,
    commissionUpliftPct: money(input.commissionUpliftPct ?? defaults.commissionUpliftPct),
    effectiveFrom,
    note: input.note?.trim() || null,
    createdByUserId: byUserId,
  });

  const view = compensationView(row);
  await logActivity(byUserId, 'AGENT_COMPENSATION_SET', undefined, {
    agentId,
    monthlySalary: view.monthlySalary,
    dailyQuota: view.dailyQuota,
    workingDaysPerMonth: view.workingDaysPerMonth,
    commissionUpliftPct: view.commissionUpliftPct,
    plannedUnitCost: view.plannedUnitCost,
    commissionPerExtra: view.commissionPerExtra,
    effectiveFrom: view.effectiveFrom,
    replaced: before ? { id: before.id, monthlySalary: money(before.monthlySalary), dailyQuota: before.dailyQuota } : null,
  });
  return view;
}

/** The agent's pay history, newest first, with the record in force marked. */
export async function compensationFor(agentId: string, now = new Date()) {
  const [rows, inForce] = await Promise.all([repository.listForAgent(agentId), repository.findInForce(agentId, now)]);
  return {
    current: inForce ? compensationView(inForce) : null,
    history: rows.map(compensationView),
  };
}

/**
 * How the agent stands today and this month: what the quota is, how much of
 * it is used, and what the month's salary works out to per onboarding done.
 * The figure the cost report divides by is this one — actual, not planned.
 */
export async function standingFor(agentId: string, now = new Date()) {
  const row = await repository.findInForce(agentId, now);
  const day = istDayWindow(now);
  const month = istMonthWindow(now);
  const [doneToday, doneThisMonth] = await Promise.all([
    repository.countOnboardingsIn(agentId, day),
    repository.countOnboardingsIn(agentId, { start: month.start, end: month.end }),
  ]);
  const terms = row ? termsOf(row) : null;
  return {
    agentId,
    day: day.start.toISOString().slice(0, 10),
    month: month.month,
    onTheQuotaModel: row !== null,
    dailyQuota: row?.dailyQuota ?? null,
    /** CP-5: the planning figure the commission is priced over — never days worked. */
    workingDaysPerMonth: row?.workingDaysPerMonth ?? null,
    doneToday,
    /** How many more today's salary still covers. Null off the model. */
    quotaLeftToday: row ? Math.max(0, row.dailyQuota - doneToday) : null,
    doneThisMonth,
    monthlySalary: terms ? terms.monthlySalary : null,
    plannedUnitCost: terms ? plannedUnitCost(terms) : null,
    commissionPerExtra: terms ? commissionPerExtra(terms) : null,
    /** The salary spread over what was actually done — null until something is. */
    salaryPerOnboarding: terms ? salaryPerOnboarding(terms.monthlySalary, doneThisMonth) : null,
  };
}
