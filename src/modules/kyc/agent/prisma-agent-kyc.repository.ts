import { Prisma, prisma } from '../../../shared/database';
import type { AgentKyc, KycStatus } from '../../../shared/database';
import { KYC_QUEUE_STATES, deriveKycState, kycPartyStateWhere, type KycQueueState } from '../../../shared/kyc-state';
import { AGENT_DEAD_END_STAGES, accountStateOf, workingAgentAccountWhere, type AccountFacts } from '../../../shared/party-status';
import { PROVIDER_FAILED_STATUS } from '../../../shared/verification';
import type { AgentDigioFields, AgentDigioUpdate, AgentKycFilter, AgentKycQueueRow, AgentKycRepository, AgentKycRequestStamp, AgentSlice } from './agent-kyc.repository';
import type { AgentKycDocuments } from './agent-kyc.schema';

const agentSelect = {
  select: { id: true, userId: true, displayId: true, city: true, createdAt: true, user: { select: { name: true, mobile: true, email: true } } },
} as const;

const withAgent = { agent: agentSelect } as const;

/** Account lifecycle: what the queue reads beside the slice to say the row's `accountState` — stripped before the row goes out. */
const queueSelect = {
  ...agentSelect.select,
  stage: true,
  status: true,
  suspensionScopes: true,
  user: { select: { name: true, mobile: true, email: true, isActive: true, closedAt: true } },
} as const;

/* ── N3-B: the queue is every AgentProfile ───────────────────────────────── */

/** The state the filter asks for: `state`, else the `status` alias. */
const stateOf = (filter: AgentKycFilter): KycQueueState | undefined => filter.state ?? filter.status;

/** The agent's search box — name, display id or mobile contains. */
function searchWhere(q: string | undefined): Prisma.AgentProfileWhereInput {
  const term = q?.trim();
  if (!term) return {};
  return {
    OR: [
      { displayId: { contains: term, mode: 'insensitive' } },
      { user: { name: { contains: term, mode: 'insensitive' } } },
      { user: { mobile: { contains: term } } },
    ],
  };
}

/** Every agent (there is no mirror column on the profile), narrowed by state and the search box. */
function partyWhere(filter: AgentKycFilter): Prisma.AgentProfileWhereInput {
  const parts: Prisma.AgentProfileWhereInput[] = [];
  // Account lifecycle (2 Oct 2026): working accounts, past none of the ladder's dead ends — unless the desk asks for the inactive.
  if (!filter.includeInactive) parts.push(workingAgentAccountWhere(), { stage: { notIn: [...AGENT_DEAD_END_STAGES] } });
  const state = stateOf(filter);
  if (state) parts.push(kycPartyStateWhere(state, false));
  if (filter.q) parts.push(searchWhere(filter.q));
  return { AND: parts };
}

/** A row with no record spreads every record column as null. */
const EMPTY_RECORD = Object.fromEntries(Object.values(Prisma.AgentKycScalarFieldEnum).map((column) => [column, null])) as { [K in keyof AgentKyc]: null };

type QueueAgent = Omit<AgentSlice, 'user'> &
  Pick<AccountFacts, 'stage' | 'status' | 'suspensionScopes'> & {
    user: AgentSlice['user'] & { isActive: boolean; closedAt: Date | null };
    kyc: AgentKyc | null;
  };

function toQueueRow(agent: QueueAgent): AgentKycQueueRow {
  const { kyc, stage, status, suspensionScopes, user, ...rest } = agent;
  const { isActive, closedAt, ...person } = user;
  return {
    ...(kyc ?? EMPTY_RECORD),
    id: kyc?.id ?? agent.id,
    agentId: agent.id,
    kycId: kyc?.id ?? null,
    state: deriveKycState(kyc),
    accountState: accountStateOf({ stage, status, suspensionScopes, user: { isActive, closedAt } }),
    agent: { ...rest, user: person },
  };
}

export const prismaAgentKycRepository: AgentKycRepository = {
  async findPage(where: AgentKycFilter, page: number, pageSize: number) {
    const [rows, total] = await Promise.all([
      prisma.agentProfile.findMany({
        where: partyWhere(where),
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Oldest submission first: the queue is worked in the order it arrived;
        // N3-B: agents with nothing in follow, by when the agent was onboarded.
        orderBy: [{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }],
        select: { ...queueSelect, kyc: true },
      }),
      prisma.agentProfile.count({ where: partyWhere(where) }),
    ]);
    return { items: rows.map(toQueueRow), total };
  },

  async countByState(where: AgentKycFilter) {
    const base: AgentKycFilter = { ...where, state: undefined, status: undefined };
    const entries = await Promise.all(
      KYC_QUEUE_STATES.map(async (state) => [state, await prisma.agentProfile.count({ where: partyWhere({ ...base, state }) })] as const),
    );
    return Object.fromEntries(entries) as Record<KycQueueState, number>;
  },

  findByAgentId(agentId: string) {
    return prisma.agentKyc.findUnique({ where: { agentId }, include: withAgent });
  },

  findAgentContact(agentId: string) {
    return prisma.agentProfile.findUnique({
      where: { id: agentId },
      select: { id: true, userId: true, displayId: true, suspensionScopes: true, user: { select: { name: true, email: true, mobile: true, closedAt: true } } },
    });
  },

  record(agentId: string, data: AgentKycDocuments, recordedById: string) {
    const now = new Date();
    // N3-B: the desk recorded it — `recordedVia` DESK, `method` MANUAL, like the three parties' desk PUTs.
    return prisma.agentKyc.upsert({
      where: { agentId },
      create: { agentId, ...data, recordedById, recordedVia: 'DESK', method: 'MANUAL', status: 'PENDING', submittedAt: now },
      update: { ...data, recordedById, recordedVia: 'DESK', method: 'MANUAL', status: 'PENDING', rejectionReason: null, submittedAt: now, reviewedAt: null, reviewedById: null },
      include: withAgent,
    });
  },

  // AG-1: an applicant's own upload — the slot only, PENDING, via APP; a VERIFIED set is not reopened by a re-upload of one slot.
  recordFromApp(agentId: string, data: AgentKycDocuments, userId: string) {
    const now = new Date();
    return prisma.agentKyc.upsert({
      where: { agentId },
      create: { agentId, ...data, recordedById: userId, recordedVia: 'APP', method: 'MANUAL', status: 'PENDING', submittedAt: now },
      update: { ...data, recordedVia: 'APP', submittedAt: now },
      include: withAgent,
    });
  },

  review(agentId: string, status: KycStatus, rejectionReason: string | null, reviewedById: string) {
    return prisma.agentKyc.update({
      where: { agentId },
      data: { status, rejectionReason, reviewedAt: new Date(), reviewedById },
      include: withAgent,
    });
  },

  requestKyc(agentId: string, stamp: AgentKycRequestStamp) {
    const data = { requestedAt: stamp.at, requestedById: stamp.requestedById, requestedChannel: stamp.requestedChannel };
    return prisma.agentKyc.upsert({ where: { agentId }, update: data, create: { agentId, ...data }, include: withAgent });
  },

  upsertDigio(agentId: string, fields: AgentDigioFields) {
    return prisma.agentKyc.upsert({ where: { agentId }, update: fields, create: { agentId, ...fields }, include: withAgent });
  },

  markProviderFailed(agentId: string) {
    return prisma.agentKyc.upsert({ where: { agentId }, update: { digioStatus: PROVIDER_FAILED_STATUS }, create: { agentId, digioStatus: PROVIDER_FAILED_STATUS } });
  },

  findByDigioRequestId(kycId: string) {
    return prisma.agentKyc.findFirst({ where: { digioRequestId: kycId }, include: withAgent });
  },

  applyDigioWebhook(id: string, update: AgentDigioUpdate) {
    // Cashfree Phase 1: the same road carries a Cashfree session's outcome — `via` says who answered.
    const { digioPayload, via = 'DIGIO', ...rest } = update;
    // Digio's completion is the recording — nobody at ADX held the documents;
    // an approval puts the row on the Digio path.
    return prisma.agentKyc.update({
      where: { id },
      data: {
        ...rest,
        digioPayload: digioPayload as Prisma.InputJsonValue,
        recordedVia: via,
        recordedById: null,
        ...(update.status === 'VERIFIED' ? { method: via } : {}),
      },
      include: withAgent,
    });
  },
};
