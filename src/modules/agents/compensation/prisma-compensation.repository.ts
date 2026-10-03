import { prisma } from '../../../shared/database';
import { Decimal, money } from '../../../shared/money';
import type { AgentPaymentRow, CompensationRepository, CostSide, NewCompensation, SalarySpanRow } from './compensation.repository';

type Scope = { city?: string | undefined; cityId?: string | null | undefined };

/**
 * CP-2: the agents one side's cost is read over — the role on their login,
 * which is what makes a publisher-side cost and an advertiser-side cost two
 * different figures. `ALL` narrows nothing.
 */
const sideOf = (side: CostSide) =>
  side === 'ALL' ? {} : { user: { roles: { some: { role: side === 'PUBLISHER' ? ('AGENT_PUBLISHER' as const) : ('AGENT_ADVERTISER' as const) } } } };

/**
 * Lot X-B's city narrowing, the agent's own: by the key when the facet
 * resolved to one, by the spelling for a typed town.
 */
const cityOf = (scope: Scope) => {
  if (!scope.city) return {};
  const spelling = { equals: scope.city.trim(), mode: 'insensitive' as const };
  return scope.cityId ? { OR: [{ cityId: scope.cityId }, { cityId: null, city: spelling }] } : { cityId: null, city: spelling };
};

/** CP-2: the per-onboarding commission — the one payment priced per account won. */
const COMMISSION_EVENTS: ('PUBLISHER_ONBOARDED' | 'ADVERTISER_ONBOARDED')[] = ['PUBLISHER_ONBOARDED', 'ADVERTISER_ONBOARDED'];
/** CP-2: everything else that buys an account. See `AgentPaymentRow` for what is in neither list, and why. */
const REWARD_EVENTS: ('LEAD_CONVERTED' | 'LEAD_ACTIVATED' | 'LEAD_RETAINED' | 'MILESTONE_BONUS' | 'TIER_BONUS' | 'SITE_VISIT' | 'CAMPAIGN_ASSIST')[] = [
  'LEAD_CONVERTED',
  'LEAD_ACTIVATED',
  'LEAD_RETAINED',
  'MILESTONE_BONUS',
  'TIER_BONUS',
  'SITE_VISIT',
  'CAMPAIGN_ASSIST',
];

/**
 * CP-1 over Prisma. The onboarding counters read the party tables directly,
 * the way the tier ladder's own counter does — a publisher at
 * ONBOARDING_COMPLETE with its completion stamped, an advertiser activated.
 */
export const prismaCompensationRepository: CompensationRepository = {
  findInForce(agentId, at) {
    return prisma.agentCompensation.findFirst({
      where: {
        agentId,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  },

  listForAgent(agentId) {
    return prisma.agentCompensation.findMany({ where: { agentId }, orderBy: { effectiveFrom: 'desc' }, take: 100 });
  },

  async create(data: NewCompensation) {
    // The new record closes whatever it supersedes, so the history never
    // overlaps and a past month keeps the salary it was costed at.
    return prisma.$transaction(async (tx) => {
      await tx.agentCompensation.updateMany({
        where: { agentId: data.agentId, effectiveTo: null, effectiveFrom: { lte: data.effectiveFrom } },
        data: { effectiveTo: data.effectiveFrom },
      });
      return tx.agentCompensation.create({
        data: {
          agentId: data.agentId,
          monthlySalary: new Decimal(data.monthlySalary),
          dailyQuota: data.dailyQuota,
          workingDaysPerMonth: data.workingDaysPerMonth,
          commissionUpliftPct: new Decimal(data.commissionUpliftPct),
          effectiveFrom: data.effectiveFrom,
          note: data.note,
          createdByUserId: data.createdByUserId,
        },
      });
    });
  },

  async inForceFor(agentIds, at) {
    if (agentIds.length === 0) return new Map();
    const rows = await prisma.agentCompensation.findMany({
      where: {
        agentId: { in: [...agentIds] },
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    const byAgent = new Map<string, (typeof rows)[number]>();
    // Newest first, so the first row seen for an agent is the one in force.
    for (const row of rows) if (!byAgent.has(row.agentId)) byAgent.set(row.agentId, row);
    return byAgent;
  },

  async salarySpansIn(window, scope, side) {
    /* Every record whose span overlaps the window. One with no `effectiveTo`
       is still in force, so it overlaps anything starting before the window
       ends. */
    const rows = await prisma.agentCompensation.findMany({
      where: {
        effectiveFrom: { lt: window.end },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: window.start } }],
        agent: { ...cityOf(scope), ...sideOf(side) },
      },
      select: {
        agentId: true,
        monthlySalary: true,
        effectiveFrom: true,
        effectiveTo: true,
        agent: { select: { cityId: true, city: true, activatedAt: true, exitedAt: true } },
      },
    });
    return rows.map((row): SalarySpanRow => {
      /* Clamped to the engagement: an agent hired or exited mid-window costs
         only the days they were with us. A salary record outliving an exit
         is ops forgetting to close it, not a month of pay. */
      const from = row.agent.activatedAt && row.agent.activatedAt > row.effectiveFrom ? row.agent.activatedAt : row.effectiveFrom;
      const to = row.agent.exitedAt && (row.effectiveTo === null || row.agent.exitedAt < row.effectiveTo) ? row.agent.exitedAt : row.effectiveTo;
      return {
        agentId: row.agentId,
        cityId: row.agent.cityId,
        city: row.agent.city,
        monthlySalary: money(new Decimal(row.monthlySalary).toFixed(2)),
        from,
        to,
      };
    });
  },

  async paymentsIn(window, scope, side) {
    const where = {
      status: 'CREDITED' as const,
      verifiedAt: { gte: window.start, lt: window.end },
      agent: { ...cityOf(scope), ...sideOf(side) },
    };
    const [commission, rewards] = await Promise.all([
      prisma.agentIncentive.groupBy({ by: ['agentId'], where: { ...where, event: { in: COMMISSION_EVENTS } }, _sum: { netAmount: true } }),
      prisma.agentIncentive.groupBy({ by: ['agentId'], where: { ...where, event: { in: REWARD_EVENTS } }, _sum: { netAmount: true } }),
    ]);
    const agentIds = [...new Set([...commission, ...rewards].map((row) => row.agentId))];
    if (agentIds.length === 0) return [];
    const agents = await prisma.agentProfile.findMany({ where: { id: { in: agentIds } }, select: { id: true, cityId: true, city: true } });
    const byAgent = new Map(agents.map((agent) => [agent.id, agent]));
    const rows = new Map<string, AgentPaymentRow>();
    const at = (agentId: string): AgentPaymentRow | null => {
      const agent = byAgent.get(agentId);
      if (!agent) return null;
      const row = rows.get(agentId) ?? { agentId, cityId: agent.cityId, city: agent.city, commission: money('0'), rewards: money('0') };
      rows.set(agentId, row);
      return row;
    };
    for (const group of commission) {
      const row = at(group.agentId);
      if (row) row.commission = money(new Decimal(row.commission).plus(group._sum.netAmount ?? 0).toFixed(2));
    }
    for (const group of rewards) {
      const row = at(group.agentId);
      if (row) row.rewards = money(new Decimal(row.rewards).plus(group._sum.netAmount ?? 0).toFixed(2));
    }
    return [...rows.values()];
  },

  async labelCities(cityIds) {
    const keys = [...new Set(cityIds)];
    if (keys.length === 0) return new Map();
    const cities = await prisma.city.findMany({ where: { id: { in: keys } }, select: { id: true, slug: true, name: true } });
    return new Map(cities.map((city) => [city.id, { slug: city.slug, name: city.name }]));
  },

  async countOnboardingsIn(agentId, window) {
    const at = { gte: window.start, lt: window.end };
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.count({ where: { agentId, onboardingStatus: 'ONBOARDING_COMPLETE', onboardingCompletedAt: at } }),
      prisma.advertiser.count({ where: { agentId, activatedAt: at } }),
    ]);
    return publishers + advertisers;
  },

  async countOnboardingsForAgents(agentIds, window) {
    if (agentIds.length === 0) return new Map();
    const at = { gte: window.start, lt: window.end };
    const ids = [...agentIds];
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.groupBy({
        by: ['agentId'],
        where: { agentId: { in: ids }, onboardingStatus: 'ONBOARDING_COMPLETE', onboardingCompletedAt: at },
        _count: { _all: true },
      }),
      prisma.advertiser.groupBy({
        by: ['agentId'],
        where: { agentId: { in: ids }, activatedAt: at },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map<string, number>();
    for (const row of [...publishers, ...advertisers]) {
      if (!row.agentId) continue;
      counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + row._count._all);
    }
    return counts;
  },
};
