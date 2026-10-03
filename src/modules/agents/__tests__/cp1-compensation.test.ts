import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CP-1 (23 Sep 2026) — the salary, the daily quota and what an onboarding
 * past it pays.
 *
 * Pinned: the owner's own figures, computed — a ₹12,000 field agent at ten a
 * day over twenty-six days costs ₹46.15 an onboarding, a ₹25,000 sales agent
 * at twelve a day over twenty-two (offices close at the weekend) costs
 * ₹94.70; the uplift is ON TOP of the unit cost, not a tenth of it; the quota
 * is a day and it resets, so a day nobody works needs no attendance record;
 * an agent with no pay record is not on the model at all and keeps the flat
 * rate table; and the salary the cost report divides by is the one actually
 * spread over the month's work, not the plan.
 */

const { repository, agents, settings, audit } = vi.hoisted(() => ({
  repository: {
    findInForce: vi.fn(),
    listForAgent: vi.fn(async () => []),
    create: vi.fn(),
    inForceFor: vi.fn(async () => new Map()),
    countOnboardingsIn: vi.fn(async () => 0),
    countOnboardingsForAgents: vi.fn(async () => new Map()),
  },
  agents: { prismaAgentsRepository: { findById: vi.fn(async () => ({ id: 'agt_1', grade: 'G1' })) } },
  settings: {
    getPlatformSettings: vi.fn(async () => ({
      agents: {
        compensation: {
          commissionUpliftPct: 10,
          byGrade: {
            G1: { monthlySalary: 12_000, dailyQuota: 10, workingDaysPerMonth: 26 },
            G2: { monthlySalary: 25_000, dailyQuota: 10, workingDaysPerMonth: 26 },
            G3: { monthlySalary: 25_000, dailyQuota: 12, workingDaysPerMonth: 22 },
            G4: { monthlySalary: 25_000, dailyQuota: 10, workingDaysPerMonth: 22 },
          },
        },
      },
    })),
  },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../compensation/prisma-compensation.repository', () => ({ prismaCompensationRepository: repository }));
vi.mock('../prisma-agents.repository', () => agents);
vi.mock('../../app-config', () => settings);
vi.mock('../../../shared/audit', () => ({ ...audit, auditDiff: vi.fn(() => ({})) }));

import {
  commissionPerExtra,
  istDayWindow,
  istMonthWindow,
  payForOnboarding,
  plannedUnitCost,
  salaryPerOnboarding,
  type CompensationTerms,
} from '../compensation/compensation.rules';
import { compensationDefaults, payForNextOnboarding, setCompensation, standingFor } from '../compensation/compensation.service';

const terms = (over: Partial<CompensationTerms> = {}): CompensationTerms => ({
  monthlySalary: '25000.00',
  dailyQuota: 10,
  workingDaysPerMonth: 26,
  commissionUpliftPct: '10.00',
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cmp_1',
  agentId: 'agt_1',
  monthlySalary: '25000.00',
  dailyQuota: 10,
  workingDaysPerMonth: 26,
  commissionUpliftPct: '10.00',
  effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
  effectiveTo: null,
  note: null,
  createdByUserId: 'usr_admin',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findInForce.mockResolvedValue(row());
  repository.countOnboardingsIn.mockResolvedValue(0);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => row(data));
  agents.prismaAgentsRepository.findById.mockResolvedValue({ id: 'agt_1', grade: 'G1' } as never);
});

describe("the owner's own figures", () => {
  it('prices an onboarding the way the salary does', () => {
    // A ₹12,000 field agent onboarding autos, ten a day, six-day week.
    expect(plannedUnitCost(terms({ monthlySalary: '12000.00', dailyQuota: 10, workingDaysPerMonth: 26 }))).toBe('46.15');
    // The same agent treating ADX as a side gig alongside their delivery work.
    expect(plannedUnitCost(terms({ monthlySalary: '12000.00', dailyQuota: 6, workingDaysPerMonth: 26 }))).toBe('76.92');
    // A ₹25,000 publisher agent, dedicated.
    expect(plannedUnitCost(terms({ dailyQuota: 10, workingDaysPerMonth: 26 }))).toBe('96.15');
    // An advertiser agent onboarding without selling — thirty minutes each,
    // but only twenty-two days, because offices shut on Saturday and Sunday.
    expect(plannedUnitCost(terms({ dailyQuota: 12, workingDaysPerMonth: 22 }))).toBe('94.70');
    // The same agent when a real sale is involved: an hour each.
    expect(plannedUnitCost(terms({ dailyQuota: 10, workingDaysPerMonth: 22 }))).toBe('113.64');
  });

  it('puts the uplift ON TOP of the unit cost, which is the difference between an incentive and a rounding error', () => {
    expect(commissionPerExtra(terms({ monthlySalary: '12000.00', dailyQuota: 10, workingDaysPerMonth: 26 }))).toBe('50.77');
    expect(commissionPerExtra(terms())).toBe('105.77');
    expect(commissionPerExtra(terms({ dailyQuota: 12, workingDaysPerMonth: 22 }))).toBe('104.17');
    // A tenth OF the unit cost would have paid ₹9.62 for the eleventh
    // onboarding of the day. The uplift is a multiplier on the whole.
    expect(commissionPerExtra(terms({ commissionUpliftPct: '0.00' }))).toBe('96.15');
  });

  it('refuses to price what cannot be priced, rather than dividing by zero', () => {
    expect(plannedUnitCost(terms({ dailyQuota: 0 }))).toBeNull();
    expect(plannedUnitCost(terms({ monthlySalary: '0.00' }))).toBeNull();
    expect(commissionPerExtra(terms({ workingDaysPerMonth: 0 }))).toBeNull();
  });
});

describe('the daily quota', () => {
  it('covers the first N of the day and pays the commission after them', () => {
    const inside = payForOnboarding(terms(), 9);
    expect(inside).toMatchObject({ covered: true, reason: 'WITHIN_QUOTA', quota: 10, amount: null });

    const eleventh = payForOnboarding(terms(), 10);
    expect(eleventh).toMatchObject({ covered: false, reason: 'BEYOND_QUOTA', quota: 10, amount: '105.77' });

    // And it keeps paying for each one after that.
    expect(payForOnboarding(terms(), 25)).toMatchObject({ reason: 'BEYOND_QUOTA', amount: '105.77' });
  });

  it('leaves an agent with no pay record on the flat rate table', () => {
    expect(payForOnboarding(null, 40)).toMatchObject({ covered: false, reason: 'NO_TERMS', quota: null, amount: null });
  });

  it('resets on the Indian day, so a day nobody works needs no attendance record', () => {
    // 23:30 UTC is already the next day in India; the quota has turned over.
    const lateUtc = istDayWindow(new Date('2026-09-23T23:30:00.000Z'));
    const earlyIst = istDayWindow(new Date('2026-09-24T04:00:00.000Z'));
    expect(lateUtc.start.toISOString()).toBe(earlyIst.start.toISOString());
    // And the window is exactly a day long.
    expect(lateUtc.end.getTime() - lateUtc.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('spreads the salary over the month it was earned in', () => {
    const september = istMonthWindow(new Date('2026-09-23T10:00:00.000Z'));
    expect(september.month).toBe('2026-09');
    expect(september.start.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(september.end.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    // December rolls the year, which is the arithmetic worth pinning.
    expect(istMonthWindow(new Date('2026-12-15T10:00:00.000Z')).end.toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });
});

describe('what the cost report divides by', () => {
  it('is the salary over the work actually done, not the plan', () => {
    // The plan says ₹96.15; a month of 200 against a plan of 260 really cost ₹125.
    expect(salaryPerOnboarding('25000.00', 200)).toBe('125.00');
    expect(salaryPerOnboarding('25000.00', 400)).toBe('62.50');
    // A month that onboarded nobody has no cost per onboarding, and says so.
    expect(salaryPerOnboarding('25000.00', 0)).toBeNull();
  });
});

describe('the service', () => {
  it("asks the day's count and answers what the next onboarding earns", async () => {
    repository.countOnboardingsIn.mockResolvedValue(10 as never);
    const pay = await payForNextOnboarding('agt_1', new Date('2026-09-23T10:00:00.000Z'));
    expect(pay).toMatchObject({ agentId: 'agt_1', reason: 'BEYOND_QUOTA', amount: '105.77', doneToday: 10 });
    // Counted over the Indian day, not the UTC one.
    const [, window] = repository.countOnboardingsIn.mock.calls[0] as unknown as [string, { start: Date; end: Date }];
    expect(window.start.toISOString()).toBe('2026-09-22T18:30:00.000Z');
  });

  it('falls back to the rate table when the terms cannot be read, rather than failing an onboarding', async () => {
    repository.findInForce.mockRejectedValue(new Error('database away'));
    expect(await payForNextOnboarding('agt_1')).toMatchObject({ reason: 'NO_TERMS', amount: null });
  });

  it('records a pay term with its arithmetic, audited', async () => {
    const view = await setCompensation('agt_1', { monthlySalary: '12000', dailyQuota: 10 }, 'usr_admin', new Date('2026-09-23T10:00:00.000Z'));
    expect(view).toMatchObject({ monthlySalary: '12000.00', dailyQuota: 10, plannedUnitCost: '46.15', commissionPerExtra: '50.77', plannedPerMonth: 260 });
    // The grade's defaults fill what the desk did not type.
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ workingDaysPerMonth: 26, commissionUpliftPct: '10.00' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'AGENT_COMPENSATION_SET', undefined, expect.objectContaining({ agentId: 'agt_1', plannedUnitCost: '46.15' }));
  });

  it('starts the form from the grade — and a sales grade plans on twenty-two days', async () => {
    expect(await compensationDefaults('G1')).toMatchObject({ monthlySalary: '12000.00', dailyQuota: 10, workingDaysPerMonth: 26, plannedUnitCost: '46.15' });
    expect(await compensationDefaults('G3')).toMatchObject({ monthlySalary: '25000.00', dailyQuota: 12, workingDaysPerMonth: 22, plannedUnitCost: '94.70' });
    // An unknown grade falls to the field band rather than refusing.
    expect(await compensationDefaults(null)).toMatchObject({ grade: 'G1' });
  });

  it("reads an agent's standing: the quota, what is left of it today, and the month's real unit cost", async () => {
    repository.countOnboardingsIn.mockResolvedValueOnce(7 as never).mockResolvedValueOnce(200 as never);
    const standing = await standingFor('agt_1', new Date('2026-09-23T10:00:00.000Z'));
    expect(standing).toMatchObject({
      onTheQuotaModel: true,
      dailyQuota: 10,
      doneToday: 7,
      quotaLeftToday: 3,
      doneThisMonth: 200,
      plannedUnitCost: '96.15',
      salaryPerOnboarding: '125.00',
      month: '2026-09',
    });
  });

  it('says plainly when an agent is not on the model at all', async () => {
    repository.findInForce.mockResolvedValue(null as never);
    const standing = await standingFor('agt_1');
    expect(standing).toMatchObject({ onTheQuotaModel: false, dailyQuota: null, quotaLeftToday: null, salaryPerOnboarding: null });
  });
});
