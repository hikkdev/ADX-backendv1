import { prisma, type Prisma } from '../../shared/database';
import { kycPartyStateWhere } from '../../shared/kyc-state';
import { ACCOUNT_STATES, agentStateWhere, workingAgentWhere, type AccountState } from '../../shared/party-status';
import { mobileSearchNeedle } from '../../shared/validation';
import { pickAssignable, priorityWindowStart, type DispatchAsk } from '../../shared/dispatch';
import { money } from '../../shared/money';
import {
  AGENT_ACTIVE_ORDER_STATUSES,
  type AgentFilter,
  type AssignablePlace,
  type AgentProfilePatch,
  type AgentsRepository,
  type NewAgent,
} from './agents.repository';

/**
 * 29 Sep 2026: the side an agent works, as a where — the rule
 * `application.service.sideOf` reads off the roles: an AGENT_PUBLISHER role,
 * or no AGENT_ADVERTISER one, is the publisher side.
 */
function sideWhere(side: 'PUBLISHER' | 'ADVERTISER'): Prisma.AgentProfileWhereInput {
  return side === 'PUBLISHER'
    ? { user: { OR: [{ roles: { some: { role: 'AGENT_PUBLISHER' } } }, { roles: { none: { role: 'AGENT_ADVERTISER' } } }] } }
    : { user: { roles: { some: { role: 'AGENT_ADVERTISER' }, none: { role: 'AGENT_PUBLISHER' } } } };
}

export const prismaAgentsRepository: AgentsRepository = {
  async findUserByMobile(mobile: string) {
    const user = await prisma.user.findUnique({
      where: { mobile },
      select: {
        id: true,
        agentProfile: { select: { id: true } },
        roles: { select: { role: true } },
      },
    });
    if (!user) return null;
    return {
      id: user.id,
      agentProfileId: user.agentProfile?.id ?? null,
      roles: user.roles.map((entry) => entry.role),
    };
  },

  async emailTaken(email: string, exceptUserId: string | null) {
    const holder = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    return holder !== null && holder.id !== exceptUserId;
  },

  createAgent(input: NewAgent) {
    return prisma.agentProfile.create({
      data: {
        displayId: input.displayId,
        city: input.city ?? null,
        // The nested `user` create puts this write on Prisma's checked shape, where the key is the relation, not the scalar.
        ...(input.cityId ? { cityRef: { connect: { id: input.cityId } } } : {}),
        state: input.state ?? null,
        // AG-1: the desk's one-step create is ACTIVE from birth; an application starts at PROFILE.
        stage: input.stage ?? 'ACTIVE',
        sourceKind: 'DESK',
        ...(input.stage === 'PROFILE' ? {} : { activatedAt: new Date() }),
        user: {
          create: {
            mobile: input.mobile,
            ...(input.userDisplayId ? { displayId: input.userDisplayId } : {}),
            name: input.name,
            email: input.email ?? null,
            roles: { create: { role: input.role } },
          },
        },
      },
    });
  },

  attachAgent(userId: string, input: NewAgent) {
    // One transaction: the role and the profile arrive together or not at
    // all, so there is never a user who can sign in as an agent and has no
    // profile for the app to load.
    return prisma.$transaction(async (tx) => {
      const holder = await tx.user.findUnique({
        where: { id: userId },
        select: { roles: { where: { role: input.role }, select: { id: true } } },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          name: input.name,
          ...(input.email ? { email: input.email } : {}),
          ...(holder?.roles.length ? {} : { roles: { create: { role: input.role } } }),
        },
      });
      return tx.agentProfile.create({
        data: {
          userId,
          displayId: input.displayId,
          city: input.city ?? null,
          cityId: input.cityId ?? null,
          state: input.state ?? null,
          stage: input.stage ?? 'ACTIVE',
          sourceKind: 'DESK',
          ...(input.stage === 'PROFILE' ? {} : { activatedAt: new Date() }),
        },
      });
    });
  },

  async findPage(filter: AgentFilter, limit: number, offset: number) {
    const { city, cityId, tier, search, sourceKind, side, kycState } = filter;
    // Account lifecycle (2 Oct 2026): the roster's default is the working accounts; ALL is everyone.
    const status = filter.status ?? 'ACTIVE';
    const digits = search ? mobileSearchNeedle(search) : null;
    // Each cut is one AND part, so the city's `OR` and the search's `OR` cannot overwrite each other.
    const parts: Prisma.AgentProfileWhereInput[] = [
      // Lot X-B: the key is the identity — by the key when the facet resolved
      // to one, the spelling catching only the rows whose key is null.
      ...(city
        ? [
            cityId
              ? { OR: [{ cityId }, { cityId: null, city: { equals: city, mode: 'insensitive' as const } }] }
              : { cityId: null, city: { equals: city, mode: 'insensitive' as const } },
          ]
        : []),
      ...(tier ? [{ tier }] : []),
      // Search spans the joined user — agents are recognised by the person's
      // name or number — and, 29 Sep 2026, the email, the AGT- id and the city.
      ...(search
        ? [
            {
              OR: [
                { user: { name: { contains: search, mode: 'insensitive' as const } } },
                { user: { mobile: { contains: search } } },
                ...(digits ? [{ user: { mobile: { contains: digits } } }] : []),
                { user: { email: { contains: search, mode: 'insensitive' as const } } },
                { displayId: { contains: search, mode: 'insensitive' as const } },
                { city: { contains: search, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
      // 29 Sep 2026: the door, the side and the KYC state — the cuts every party desk takes.
      ...(sourceKind ? [{ sourceKind }] : []),
      ...(side ? [sideWhere(side)] : []),
      ...(kycState ? [kycPartyStateWhere(kycState, false)] : []),
    ];
    const cuts: Prisma.AgentProfileWhereInput = { AND: parts };
    const where: Prisma.AgentProfileWhereInput = status === 'ALL' ? cuts : { AND: [cuts, agentStateWhere(status)] };

    const [rows, total, perState] = await Promise.all([
      prisma.agentProfile.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          // No `city` here: it lives on the profile, not the user. Selecting it
          // off `user` was a runtime PrismaClientValidationError on every call.
          // 29 Sep 2026: the email and the roles ride the join — the roster's Contact and Type.
          user: { select: { id: true, name: true, mobile: true, email: true, isActive: true, closedAt: true, roles: { select: { role: true } } } },
          // The six columns the KYC state is derived from — never the document links.
          kyc: { select: { id: true, status: true, submittedAt: true, requestedAt: true, requestedChannel: true, method: true } },
          // The roster's activity: the publishers and advertisers this agent brought in.
          _count: { select: { publishers: true, advertisers: true } },
        },
      }),
      prisma.agentProfile.count({ where }),
      // The status chips leave the status facet out, so each stays a way back in.
      Promise.all(ACCOUNT_STATES.map(async (state) => [state, await prisma.agentProfile.count({ where: { AND: [cuts, agentStateWhere(state)] } })] as const)),
    ]);
    const items = rows.map(({ _count, ...row }) => ({ ...row, onboardedCount: _count.publishers + _count.advertisers }));
    return { items, total, statusCounts: Object.fromEntries(perState) as Record<AccountState, number> };
  },

  findById(id: string) {
    // The by-id join adds email; the listing does not. Both are contract.
    // E10-1: the closure columns ride the same slice (Lot A, Q21), the way
    // the publisher and advertiser reads carry them.
    return prisma.agentProfile.findUnique({
      where: { id },
      include: {
        user: {
          // 28 Sep 2026: displayId — the person's own ADX-… id, beside the AGT- id that names the agent profile.
          select: { id: true, displayId: true, name: true, mobile: true, email: true, isActive: true, closedAt: true, closeReason: true },
        },
        // N3-B: the KYC record's summary, for the `kyc: { state, ... }` the party read carries.
        kyc: { select: { id: true, status: true, submittedAt: true, requestedAt: true, requestedChannel: true, method: true } },
      },
    });
  },

  async exists(id: string) {
    return (await prisma.agentProfile.findUnique({ where: { id }, select: { id: true } })) !== null;
  },

  findByUserId(userId: string) {
    return prisma.agentProfile.findUnique({ where: { userId } });
  },

  async findLabelsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await prisma.agentProfile.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayId: true, user: { select: { name: true, mobile: true } } },
    });
    return rows.map((row) => ({ id: row.id, label: row.user.name ?? row.user.mobile, displayId: row.displayId }));
  },

  async findLabelsByUserIds(userIds: string[]) {
    if (userIds.length === 0) return [];
    const rows = await prisma.agentProfile.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, userId: true, displayId: true, user: { select: { name: true } }, kyc: { select: { status: true } } },
    });
    return rows.map((row) => ({ id: row.id, userId: row.userId, displayId: row.displayId, name: row.user.name, kycStatus: row.kyc?.status ?? null }));
  },

  async findWithUser(agentId: string) {
    const agent = await prisma.agentProfile.findUnique({
      where: { id: agentId },
      select: { id: true, user: { select: { id: true } } },
    });
    return agent?.user ? { id: agent.id, userId: agent.user.id } : null;
  },

  async findAssignable(excludeIds: string[], ask: DispatchAsk = {}, now: Date = new Date(), place?: AssignablePlace) {
    // 3 Oct 2026: a place narrows the pool to that city's agents (by the key, the spelling for null keys).
    const cityParts: Prisma.AgentProfileWhereInput[] = place
      ? [
          place.cityId
            ? { OR: [{ cityId: place.cityId }, ...(place.city ? [{ cityId: null, city: { equals: place.city, mode: 'insensitive' as const } }] : [])] }
            : { city: { equals: place.city ?? '', mode: 'insensitive' as const } },
        ]
      : [];
    // D5: only agents offered work (profile ACTIVE), and only under their own
    // cap. The cap is a comparison between two columns of the same row, which
    // the query language cannot express, so a short list is read and filtered.
    // DR 07: the order of that list is the offer priority — the sweep goes to
    // the fast lane first — so each candidate's recent answers come with them.
    const candidates = await prisma.agentProfile.findMany({
      // Account lifecycle (2 Oct 2026): the one working-agent predicate — stage
      // and status ACTIVE, no BLOCK_NEW (belt and braces beside `status`), the
      // account signing in and not closed.
      where: {
        AND: [{ id: { notIn: excludeIds } }, workingAgentWhere(), { user: { roles: { some: { role: 'AGENT_PUBLISHER' } } } }, ...cityParts],
      },
      select: {
        id: true,
        createdAt: true,
        maxActiveOrders: true,
        // AG-5: the grade the band asks for, the tier, and where they are.
        grade: true,
        tier: true,
        tierLevel: true,
        currentLatitude: true,
        currentLongitude: true,
        _count: { select: { orders: { where: { status: { in: [...AGENT_ACTIVE_ORDER_STATUSES] } } } } },
        agentAssignments: { where: { assignedAt: { gte: priorityWindowStart(now) } }, select: { status: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const open = pickAssignable(
      candidates.map((candidate) => ({
        id: candidate.id,
        createdAt: candidate.createdAt,
        maxActiveOrders: candidate.maxActiveOrders,
        activeOrders: candidate._count.orders,
        recentOffers: candidate.agentAssignments,
        grade: candidate.grade,
        tier: candidate.tier,
        tierLevel: candidate.tierLevel,
        latitude: candidate.currentLatitude,
        longitude: candidate.currentLongitude,
      })),
      ask,
    );
    return open ? { id: open.id } : null;
  },

  update(id: string, patch: AgentProfilePatch) {
    return prisma.agentProfile.update({ where: { id }, data: patch });
  },

  async findWorkState(id: string) {
    const agent = await prisma.agentProfile.findUnique({
      where: { id },
      select: { status: true, suspensionScopes: true, stage: true, user: { select: { roles: { select: { role: true } } } } },
    });
    return agent ? { status: agent.status, scopes: agent.suspensionScopes, stage: agent.stage, roles: agent.user.roles.map((r) => r.role) } : null;
  },

  findZone(id: string) {
    return prisma.agentProfile.findUnique({
      where: { id },
      select: { autoAcceptInZone: true, city: true, homeZone: true },
    });
  },

  findDirectory(q?: string, includeInactive = false) {
    return prisma.agentProfile.findMany({
      where: {
        ...(includeInactive ? {} : { status: 'ACTIVE' }),
        user: {
          ...(includeInactive ? {} : { isActive: true }),
          ...(q
            ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { mobile: { contains: q } }, { email: { contains: q, mode: 'insensitive' } }] }
            : {}),
        },
      },
      select: { id: true, userId: true, tier: true, tierLevel: true, city: true, status: true, user: { select: { name: true, isActive: true } } },
      orderBy: { user: { name: 'asc' } },
      take: 200,
    });
  },

  async findDashboardProfile(userId: string) {
    const agent = await prisma.agentProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        displayId: true,
        city: true,
        state: true,
        tier: true,
        tierLevel: true,
        tierPinnedAt: true,
        status: true,
        suspensionScopes: true,
        suspensionReason: true,
        suspendedAt: true,
        stage: true,
        grade: true,
        activatedAt: true,
        user: { select: { name: true, roles: { select: { role: true } } } },
      },
    });
    if (!agent) return null;
    return {
      id: agent.id,
      displayId: agent.displayId,
      city: agent.city,
      state: agent.state,
      tier: agent.tier,
      tierLevel: agent.tierLevel,
      tierPinnedAt: agent.tierPinnedAt,
      name: agent.user.name,
      roles: agent.user.roles.map((entry) => entry.role),
      status: agent.status,
      suspensionScopes: agent.suspensionScopes,
      suspensionReason: agent.suspensionReason,
      suspendedAt: agent.suspendedAt,
      stage: agent.stage,
      grade: agent.grade,
      activatedAt: agent.activatedAt,
    };
  },

  async countOnboarded(agentId: string) {
    // A publisher is onboarded when the ladder says so; an advertiser when
    // KYC is verified and the agreement accepted, which is what activatedAt
    // records. Both are the moment the account becomes usable, not the scan.
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.count({ where: { agentId, onboardingStatus: 'ONBOARDING_COMPLETE' } }),
      prisma.advertiser.count({ where: { agentId, activatedAt: { not: null } } }),
    ]);
    return { publishers, advertisers };
  },

  async countSales(agentId: string) {
    const [packagesSold, campaignsLaunched] = await Promise.all([
      prisma.packageSale.count({ where: { agentId, paidAt: { not: null } } }),
      prisma.campaign.count({
        where: { agentId, status: { in: ['SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED'] } },
      }),
    ]);
    return { packagesSold, campaignsLaunched };
  },

  async walletBalance(agentId: string) {
    const wallet = await prisma.wallet.findUnique({
      where: { agentId },
      select: { balance: true, currency: true },
    });
    return { balance: money(wallet?.balance ?? 0), currency: wallet?.currency ?? 'INR' };
  },

  async countToday(agentId: string, start: Date, end: Date) {
    const [orders, milestones, fieldVisits] = await Promise.all([
      prisma.order.count({
        where: {
          agentId,
          OR: [
            { slotTime: { gte: start, lt: end } },
            { status: { in: ['IN_PROGRESS', 'PENDING_OTP'] } },
          ],
        },
      }),
      prisma.orderMilestone.count({
        where: {
          assignedAgentId: agentId,
          status: { in: ['PENDING', 'DISPATCHED', 'IN_PROGRESS'] },
          OR: [{ dueDate: { gte: start, lt: end } }, { status: 'IN_PROGRESS' }],
        },
      }),
      // G12-B: DR 06's field visits are the other half of the agent's day —
      // the milestone rule, on the FieldVisit table. Counted here rather
      // than through `visits` because `visits` imports this module.
      prisma.fieldVisit.count({
        where: {
          agentId,
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
          OR: [{ scheduledFor: { gte: start, lt: end } }, { status: 'IN_PROGRESS' }],
        },
      }),
    ]);
    return { orders, visits: milestones + fieldVisits };
  },

};
