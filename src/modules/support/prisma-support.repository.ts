import { prisma, type Prisma, type TicketPriority, type TicketStatus } from '../../shared/database';
import { countsFrom, listArgs, toListPage } from '../../shared/pagination';
import type { LiveInboxRow, SupportRepository } from './support.repository';
import { TICKET_STATUSES } from './support.schema';
import type {
  CannedReplyPatch,
  ListTicketsOptions,
  LiveInboxOptions,
  NewCannedReply,
  NewReply,
  NewTicket,
  OpsTicketOptions,
  TicketPatch,
} from './support.types';

export const prismaSupportRepository: SupportRepository = {
  findManyForUser(userId: string, opts: ListTicketsOptions) {
    const { limit = 50, offset = 0, status, kind, search } = opts;
    return prisma.supportTicket.findMany({
      where: {
        userId,
        ...(status ? { status: status as any } : {}),
        ...(kind ? { kind } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      // The first message the requester may see: an internal note is never theirs.
      include: { messages: { where: { internal: false }, orderBy: { createdAt: 'asc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
    });
  },

  findById(ticketId: string) {
    return prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  },

  findSummaryById(ticketId: string) {
    return prisma.supportTicket.findUnique({ where: { id: ticketId } });
  },

  create(data: NewTicket) {
    return prisma.supportTicket.create({ data, include: { messages: true } });
  },

  async addReply(data: NewReply) {
    // One transaction so a reply never lands without bumping updatedAt, which
    // is what the ticket list orders by — and, Lot I, lastMessageAt, which
    // the stream's reconnect and the live inbox read.
    const now = new Date();
    const [message] = await prisma.$transaction([
      prisma.ticketMessage.create({ data: { ...data, createdAt: now } }),
      prisma.supportTicket.update({ where: { id: data.ticketId }, data: { updatedAt: now, lastMessageAt: now } }),
    ]);
    return message;
  },

  countOpenForUser(userId: string) {
    return prisma.supportTicket.count({ where: { userId, status: { not: 'CLOSED' } } });
  },

  patch(ticketId: string, patch: TicketPatch) {
    return prisma.supportTicket.update({ where: { id: ticketId }, data: patch });
  },

  async findManyForOps(opts: OpsTicketOptions, now: Date) {
    // Everything but the status facet, so the chip row still counts the
    // other statuses while one is selected.
    const base: Prisma.SupportTicketWhereInput = {
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.priority ? { priority: opts.priority as TicketPriority } : {}),
      ...(opts.unassigned ? { assignedAgentId: null } : {}),
      ...(opts.assignedAdminUserId ? { assignedAdminUserId: opts.assignedAdminUserId } : {}),
      ...(opts.team ? { team: { equals: opts.team, mode: 'insensitive' } } : {}),
      // Late on either clock, and not paused — the same rule slaView applies.
      ...(opts.breached
        ? {
            status: { not: 'CLOSED' },
            slaPausedAt: null,
            OR: [
              { firstRespondedAt: null, slaFirstResponseDueAt: { lt: now } },
              { slaResolutionDueAt: { lt: now } },
            ],
          }
        : {}),
      ...(opts.q
        ? {
            AND: [
              {
                OR: [
                  { displayId: { contains: opts.q, mode: 'insensitive' } },
                  { title: { contains: opts.q, mode: 'insensitive' } },
                  { description: { contains: opts.q, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : {}),
    };
    const where: Prisma.SupportTicketWhereInput = {
      ...base,
      ...(opts.status?.length ? { status: { in: opts.status as TicketStatus[] } } : {}),
    };
    // Oldest first by default: a support queue worked newest-first is a queue
    // where the person who has waited longest keeps waiting. DUE is the
    // resolution clock, soonest first.
    const orderBy: Prisma.SupportTicketOrderByWithRelationInput =
      opts.sort === 'NEWEST'
        ? { createdAt: 'desc' }
        : opts.sort === 'DUE'
          ? { slaResolutionDueAt: { sort: 'asc', nulls: 'last' } }
          : { createdAt: 'asc' };
    const [items, total, groups] = await Promise.all([
      prisma.supportTicket.findMany({ where, orderBy, ...listArgs(opts) }),
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return toListPage(items, total, countsFrom(groups, TICKET_STATUSES), opts);
  },

  async distinctTeams() {
    const rows = await prisma.supportTicket.findMany({
      where: { team: { not: null } },
      distinct: ['team'],
      select: { team: true },
      orderBy: { team: 'asc' },
    });
    return rows.flatMap((row) => (row.team ? [row.team] : []));
  },

  assign(ticketId: string, assignedAgentId: string | null, assignedById: string) {
    return prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        assignedAgentId,
        // Cleared together with the agent. An assignment timestamp left behind
        // on an unassigned ticket reads as though somebody is still on it.
        assignedAt: assignedAgentId ? new Date() : null,
        assignedById: assignedAgentId ? assignedById : null,
      },
    });
  },

  setStatus(ticketId: string, status: 'OPEN' | 'CLOSED') {
    return prisma.supportTicket.update({ where: { id: ticketId }, data: { status } });
  },

  /* ── Lot I: live chat ─────────────────────────────────────────────── */

  findOpenLiveChatForUser(userId: string) {
    return prisma.supportTicket.findFirst({
      where: { userId, channel: 'LIVE_CHAT', status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
    });
  },

  async countOpenLiveChatsByAdmin(adminUserIds: readonly string[]) {
    const counts = new Map<string, number>(adminUserIds.map((id) => [id, 0]));
    if (adminUserIds.length === 0) return counts;
    const groups = await prisma.supportTicket.groupBy({
      by: ['assignedAdminUserId'],
      where: { channel: 'LIVE_CHAT', status: 'OPEN', assignedAdminUserId: { in: [...adminUserIds] } },
      _count: { _all: true },
    });
    for (const group of groups) if (group.assignedAdminUserId) counts.set(group.assignedAdminUserId, group._count._all);
    return counts;
  },

  countOpenLiveChats() {
    return prisma.supportTicket.count({ where: { channel: 'LIVE_CHAT', status: 'OPEN' } });
  },

  findMessagesAfter(ticketId: string, after: Date) {
    return prisma.ticketMessage.findMany({ where: { ticketId, createdAt: { gt: after } }, orderBy: { createdAt: 'asc' }, take: 200 });
  },

  async findMessageByAttachment(fileId: string, ticketUserId?: string) {
    const message = await prisma.ticketMessage.findFirst({
      where: { attachmentFileId: fileId, ...(ticketUserId ? { ticket: { userId: ticketUserId } } : {}) },
      select: { ticketId: true, ticket: { select: { userId: true } } },
    });
    return message ? { ticketId: message.ticketId, ticketUserId: message.ticket.userId } : null;
  },

  async markSeen(ticketId: string, side: 'requester' | 'agent', viewerUserId: string, at: Date) {
    const [ticket] = await prisma.$transaction([
      prisma.supportTicket.update({
        where: { id: ticketId },
        data: side === 'requester' ? { requesterSeenAt: at } : { agentSeenAt: at },
      }),
      prisma.ticketMessage.updateMany({
        where: { ticketId, seenAt: null, authorId: { not: viewerUserId }, ...(side === 'requester' ? { internal: false } : {}) },
        data: { seenAt: at },
      }),
    ]);
    return ticket;
  },

  async findLiveInbox(opts: LiveInboxOptions) {
    const where: Prisma.SupportTicketWhereInput = {
      channel: 'LIVE_CHAT',
      status: 'OPEN',
      ...(opts.assignedAdminUserId ? { assignedAdminUserId: opts.assignedAdminUserId } : {}),
      ...(opts.unassigned ? { assignedAdminUserId: null } : {}),
      ...(opts.q
        ? {
            OR: [
              { displayId: { contains: opts.q, mode: 'insensitive' } },
              { title: { contains: opts.q, mode: 'insensitive' } },
              { description: { contains: opts.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    // WAITING (the default): the chat whose last message is oldest first —
    // the person who has waited longest is at the top.
    const orderBy: Prisma.SupportTicketOrderByWithRelationInput =
      opts.sort === 'NEWEST'
        ? { createdAt: 'desc' }
        : opts.sort === 'OLDEST'
          ? { createdAt: 'asc' }
          : { lastMessageAt: { sort: 'asc', nulls: 'first' } };
    const [rows, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy,
        ...listArgs(opts),
        include: {
          messages: {
            where: { internal: false },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, authorId: true, authorName: true, kind: true, message: true, createdAt: true },
          },
        },
      }),
      prisma.supportTicket.count({ where }),
    ]);
    const ids = rows.map((row) => row.id);
    const unseen = ids.length
      ? await prisma.ticketMessage.findMany({
          where: { ticketId: { in: ids }, seenAt: null, internal: false, kind: { not: 'SYSTEM' } },
          select: { ticketId: true, authorId: true },
        })
      : [];
    const requesterOf = new Map(rows.map((row) => [row.id, row.userId]));
    const unread = new Map<string, number>();
    for (const message of unseen) {
      if (requesterOf.get(message.ticketId) !== message.authorId) continue;
      unread.set(message.ticketId, (unread.get(message.ticketId) ?? 0) + 1);
    }
    const items: LiveInboxRow[] = rows.map(({ messages, ...ticket }) => ({
      ...ticket,
      lastMessage: messages[0] ?? null,
      unreadForAgent: unread.get(ticket.id) ?? 0,
    }));
    return toListPage(items, total, { OPEN: total }, opts);
  },

  findLiveChatsPastFirstResponse(before: Date) {
    return prisma.supportTicket.findMany({
      where: { channel: 'LIVE_CHAT', status: 'OPEN', firstResponseAt: null, createdAt: { lt: before } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  },

  async findIdleLiveChats(before: Date) {
    const rows = await prisma.supportTicket.findMany({
      where: { channel: 'LIVE_CHAT', status: 'OPEN', lastMessageAt: { lt: before } },
      orderBy: { lastMessageAt: 'asc' },
      take: 200,
      include: {
        messages: {
          where: { internal: false, kind: { not: 'SYSTEM' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { authorId: true, createdAt: true },
        },
      },
    });
    return rows.map(({ messages, ...ticket }) => ({ ...ticket, lastMessage: messages[0] ?? null }));
  },

  /* ── Lot I: canned replies ────────────────────────────────────────── */

  listCanned(opts: { team?: string | undefined; includeInactive?: boolean | undefined }) {
    return prisma.cannedReply.findMany({
      where: {
        ...(opts.includeInactive ? {} : { isActive: true }),
        // A team's shortcuts and the ones every team shares.
        ...(opts.team ? { OR: [{ team: { equals: opts.team, mode: 'insensitive' } }, { team: null }] } : {}),
      },
      orderBy: [{ team: { sort: 'asc', nulls: 'first' } }, { title: 'asc' }],
    });
  },

  findCanned(id: string) {
    return prisma.cannedReply.findUnique({ where: { id } });
  },

  createCanned(data: NewCannedReply) {
    return prisma.cannedReply.create({ data });
  },

  updateCanned(id: string, patch: CannedReplyPatch) {
    return prisma.cannedReply.update({ where: { id }, data: patch });
  },

  async deleteCanned(id: string) {
    await prisma.cannedReply.delete({ where: { id } });
  },
};
