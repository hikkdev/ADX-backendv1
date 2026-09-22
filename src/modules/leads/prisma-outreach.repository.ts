import { Prisma, prisma } from '../../shared/database';
import type { LeadChannel } from '../../shared/database';
import type { ChannelStat, InboxFilter, InboxRow, OutreachRepository, TeleFilter, TeleRow } from './outreach.repository';

/** Rows that count as "we spoke" for the weekly cap — anything that left or is about to. */
const COUNTED_OUTBOUND = ['QUEUED', 'SENT', 'DELIVERED', 'READ'] as const;
const OPEN_STAGES = ['SOURCED', 'SCORED', 'CLAIMED', 'CONTACTED', 'ENGAGED', 'VISIT_BOOKED', 'PROPOSED'] as const;

export const prismaOutreachRepository: OutreachRepository = {
  findConversation(leadId, channel) {
    return prisma.leadConversation.findUnique({ where: { leadId_channel: { leadId, channel } } });
  },

  findConversationByThread(channel, providerThreadId) {
    return prisma.leadConversation.findFirst({ where: { channel, providerThreadId }, include: { lead: true }, orderBy: { updatedAt: 'desc' } });
  },

  createConversation(data) {
    return prisma.leadConversation.create({ data: { leadId: data.leadId, channel: data.channel, providerThreadId: data.providerThreadId ?? null } });
  },

  updateConversation(id, patch) {
    return prisma.leadConversation.update({ where: { id }, data: patch });
  },

  listConversations(leadId) {
    return prisma.leadConversation.findMany({ where: { leadId }, orderBy: { updatedAt: 'desc' } });
  },

  listMessages(leadId, take) {
    return prisma.leadMessage.findMany({ where: { leadId }, orderBy: { at: 'asc' }, take });
  },

  createMessage(data) {
    return prisma.leadMessage.create({ data: data as Prisma.LeadMessageUncheckedCreateInput });
  },

  updateMessage(id, patch) {
    return prisma.leadMessage.update({ where: { id }, data: patch });
  },

  findMessage(id) {
    return prisma.leadMessage.findUnique({ where: { id } });
  },

  findMessageByProviderId(channel, providerId) {
    return prisma.leadMessage.findUnique({ where: { channel_providerId: { channel, providerId } } });
  },

  findMessageByCallId(providerCallId) {
    return prisma.leadMessage.findFirst({ where: { providerCallId }, orderBy: { at: 'desc' } });
  },

  countOutboundBetween(leadId, from, to) {
    return prisma.leadMessage.count({ where: { leadId, direction: 'OUTBOUND', status: { in: [...COUNTED_OUTBOUND] }, at: { gte: from, lt: to } } });
  },

  dueQueuedMessages(now, take) {
    return prisma.leadMessage.findMany({ where: { status: 'QUEUED', direction: 'OUTBOUND', scheduledFor: { lte: now } }, orderBy: { scheduledFor: 'asc' }, take });
  },

  lastOutbound(leadId) {
    return prisma.leadMessage.findFirst({ where: { leadId, direction: 'OUTBOUND', status: { in: [...COUNTED_OUTBOUND] } }, orderBy: { at: 'desc' } });
  },

  async recordingsBefore(cutoff, take) {
    const rows = await prisma.leadMessage.findMany({ where: { recordingFileId: { not: null }, at: { lt: cutoff } }, select: { id: true, recordingFileId: true }, orderBy: { at: 'asc' }, take });
    return rows.filter((row): row is { id: string; recordingFileId: string } => row.recordingFileId !== null);
  },

  async channelStats(from, to, side) {
    const where: Prisma.LeadMessageWhereInput = { at: { gte: from, lt: to }, ...(side ? { lead: { side } } : {}) };
    const grouped = await prisma.leadMessage.groupBy({ by: ['channel', 'direction', 'status'], where, _count: { _all: true } });
    const byChannel = new Map<LeadChannel, ChannelStat>();
    const row = (channel: LeadChannel) => {
      const existing = byChannel.get(channel) ?? { channel, outbound: 0, delivered: 0, failed: 0, inbound: 0, replies: 0 };
      byChannel.set(channel, existing);
      return existing;
    };
    for (const g of grouped) {
      const stat = row(g.channel);
      const n = g._count._all;
      if (g.direction === 'INBOUND') stat.inbound += n;
      else {
        if (g.status === 'FAILED' || g.status === 'SKIPPED') stat.failed += n;
        else stat.outbound += n;
        if (g.status === 'DELIVERED' || g.status === 'READ') stat.delivered += n;
      }
    }
    // A reply is a thread that heard back after we wrote — counted per conversation, once.
    const replied = await prisma.leadConversation.groupBy({
      by: ['channel'],
      where: { lastInboundAt: { gte: from, lt: to }, lastOutboundAt: { not: null }, ...(side ? { lead: { side } } : {}) },
      _count: { _all: true },
    });
    for (const g of replied) row(g.channel).replies += g._count._all;
    return [...byChannel.values()].sort((a, b) => b.outbound + b.inbound - (a.outbound + a.inbound));
  },

  async listSequences(filter) {
    const rows = await prisma.leadSequence.findMany({
      where: { ...(filter.side ? { side: filter.side } : {}), ...(filter.activeOnly ? { isActive: true } : {}) },
      orderBy: [{ side: 'asc' }, { temperature: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { runs: true } } },
    });
    const active = await prisma.leadSequenceRun.groupBy({ by: ['sequenceId'], where: { stoppedAt: null, sequenceId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const activeBy = new Map(active.map((a) => [a.sequenceId, a._count._all]));
    return rows.map(({ _count, ...row }) => ({ ...row, activeRuns: activeBy.get(row.id) ?? 0, totalRuns: _count.runs }));
  },

  findSequence(id) {
    return prisma.leadSequence.findUnique({ where: { id } });
  },

  createSequence(data) {
    return prisma.leadSequence.create({ data: { ...data, steps: data.steps as unknown as Prisma.InputJsonValue } });
  },

  updateSequence(id, patch) {
    return prisma.leadSequence.update({ where: { id }, data: { ...patch, ...(patch.steps ? { steps: patch.steps as unknown as Prisma.InputJsonValue } : {}) } });
  },

  findActiveSequence(side, temperature) {
    return prisma.leadSequence.findFirst({ where: { side: side as 'PUBLISHER' | 'ADVERTISER', temperature: temperature as 'HOT' | 'WARM' | 'COLD', isActive: true }, orderBy: { createdAt: 'desc' } });
  },

  countSequences() {
    return prisma.leadSequence.count();
  },

  findActiveRun(leadId) {
    return prisma.leadSequenceRun.findFirst({ where: { leadId, stoppedAt: null }, include: { sequence: true }, orderBy: { startedAt: 'desc' } });
  },

  listRuns(leadId) {
    return prisma.leadSequenceRun.findMany({ where: { leadId }, include: { sequence: true }, orderBy: { startedAt: 'desc' }, take: 10 });
  },

  createRun(data) {
    return prisma.leadSequenceRun.create({ data });
  },

  updateRun(id, patch) {
    return prisma.leadSequenceRun.update({ where: { id }, data: patch });
  },

  dueRuns(now, take) {
    return prisma.leadSequenceRun.findMany({ where: { stoppedAt: null, nextAt: { lte: now } }, include: { sequence: true, lead: true }, orderBy: { nextAt: 'asc' }, take });
  },

  async stopRuns(leadId, at, reason) {
    const result = await prisma.leadSequenceRun.updateMany({ where: { leadId, stoppedAt: null }, data: { stoppedAt: at, stopReason: reason, nextAt: null } });
    return result.count;
  },

  async inbox(filter: InboxFilter, page) {
    const where: Prisma.LeadConversationWhereInput = {
      lastInboundAt: { not: null },
      ...(filter.channel ? { channel: filter.channel } : {}),
      ...(filter.unansweredOnly ? { OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: prisma.leadConversation.fields.lastInboundAt } }] } : {}),
      lead: {
        ...(filter.side ? { side: filter.side } : {}),
        ...(filter.city ? { city: { contains: filter.city, mode: 'insensitive' } } : {}),
        ...(filter.agentId ? { OR: [{ assignedAgentId: filter.agentId }, { claimedByAgentId: filter.agentId }] } : {}),
      },
    };
    const [rows, total, grouped] = await Promise.all([
      prisma.leadConversation.findMany({ where, include: { lead: true, messages: { orderBy: { at: 'desc' }, take: 1 } }, orderBy: { lastInboundAt: 'desc' }, ...page }),
      prisma.leadConversation.count({ where }),
      prisma.leadConversation.groupBy({ by: ['channel'], where: { ...where, channel: undefined }, _count: { _all: true } }),
    ]);
    const items: InboxRow[] = rows.map(({ messages, ...row }) => ({
      ...row,
      last: messages[0] ?? null,
      unanswered: row.lastInboundAt && (!row.lastOutboundAt || row.lastOutboundAt < row.lastInboundAt) ? 1 : 0,
    }));
    return { items, total, byChannel: Object.fromEntries(grouped.map((g) => [g.channel, g._count._all])) };
  },

  async teleQueue(filter: TeleFilter, page) {
    const where: Prisma.LeadWhereInput = {
      phoneNormalised: { not: null },
      stage: { in: [...OPEN_STAGES] },
      claimedByAgentId: null,
      temperature: filter.temperature ?? 'COLD',
      ...(filter.side ? { side: filter.side } : {}),
      ...(filter.city ? { city: { contains: filter.city, mode: 'insensitive' } } : {}),
      ...(filter.q ? { OR: [{ businessName: { contains: filter.q, mode: 'insensitive' } }, { contactName: { contains: filter.q, mode: 'insensitive' } }, { phone: { contains: filter.q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: [{ score: 'desc' }, { lastTouchedAt: { sort: 'asc', nulls: 'first' } }],
        include: { messages: { where: { channel: 'CALL' }, orderBy: { at: 'desc' }, take: 1 }, _count: { select: { messages: { where: { channel: 'CALL', direction: 'OUTBOUND' } } } } },
        ...page,
      }),
      prisma.lead.count({ where }),
    ]);
    const callbacks = rows.length
      ? await prisma.workTask.findMany({ where: { linkedKind: 'LEAD', linkedId: { in: rows.map((r) => r.id) }, tags: { has: 'callback' }, status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED'] } }, select: { linkedId: true, deadline: true } })
      : [];
    const callbackBy = new Map(callbacks.map((c) => [c.linkedId!, c.deadline]));
    const items: TeleRow[] = rows.map(({ messages, _count, ...lead }) => ({ ...lead, lastCall: messages[0] ?? null, attempts: _count.messages, callbackDue: callbackBy.get(lead.id) ?? null }));
    return { items, total };
  },

  findActiveInvite(leadId, now) {
    return prisma.leadInvite.findFirst({ where: { leadId, revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
  },

  findInviteByCode(code) {
    return prisma.leadInvite.findUnique({ where: { code }, include: { lead: true } });
  },

  listInvites(leadId) {
    return prisma.leadInvite.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 10 });
  },

  createInvite(data) {
    return prisma.leadInvite.create({ data });
  },

  updateInvite(id, patch) {
    const { opens, ...rest } = patch;
    return prisma.leadInvite.update({ where: { id }, data: { ...rest, ...(opens !== undefined ? { opens: opens as Prisma.InputJsonValue } : {}) } });
  },

  createProposal(data) {
    return prisma.leadProposal.create({ data: { ...data, payload: data.payload as Prisma.InputJsonValue } });
  },

  listProposals(leadId) {
    return prisma.leadProposal.findMany({ where: { leadId }, orderBy: { sentAt: 'desc' }, take: 20 });
  },

  findProposal(id) {
    return prisma.leadProposal.findUnique({ where: { id } });
  },

  updateProposal(id, patch) {
    return prisma.leadProposal.update({ where: { id }, data: patch });
  },

  async markProposalsOpened(leadId, now) {
    const result = await prisma.leadProposal.updateMany({ where: { leadId, openedAt: null }, data: { openedAt: now } });
    return result.count;
  },

  async findUserRoles(userId) {
    const rows = await prisma.userRole.findMany({ where: { userId }, select: { role: true } });
    return rows.map((row) => row.role);
  },

  findCaller(userId) {
    return prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, mobile: true } });
  },

  async findAgentUser(agentId) {
    const agent = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { userId: true, user: { select: { name: true, mobile: true } } } });
    return agent ? { userId: agent.userId, name: agent.user.name, mobile: agent.user.mobile } : null;
  },
};
