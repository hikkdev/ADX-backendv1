import { prisma } from '../../shared/database';
import type { AccessGrantScope, AccessGrantStatus } from '../../shared/database';
import type {
  AccessGrantsRepository,
  GrantDetail,
  NewGrant,
} from './access-grants.repository';

const withNames = {
  publisher: { select: { id: true, name: true, userId: true } },
  assignedAgent: { select: { id: true, userId: true } },
} as const;

export const prismaAccessGrantsRepository: AccessGrantsRepository = {
  create(data: NewGrant) {
    return prisma.delegatedAccessGrant.create({ data });
  },

  createOnboarding({ subject, assignedAgentId, qrId, durationMinutes }) {
    const now = new Date();
    return prisma.delegatedAccessGrant.create({
      data: {
        ...subject,
        assignedAgentId,
        qrId,
        purpose: 'ONBOARDING',
        reason: 'Onboarding at the door',
        scope: 'PROFILE',
        listingIds: [],
        supportTicketId: null,
        durationMinutes,
        status: 'ACTIVE',
        claimedAt: now,
        expiresAt: new Date(now.getTime() + durationMinutes * 60_000),
      },
    });
  },

  createRequested({ subject, assignedAgentId, scope, reason, durationMinutes }) {
    const now = new Date();
    return prisma.delegatedAccessGrant.create({
      data: {
        ...subject,
        assignedAgentId,
        purpose: 'SUPPORT',
        reason,
        scope,
        listingIds: [],
        supportTicketId: null,
        durationMinutes,
        status: 'ACTIVE',
        claimedAt: now,
        expiresAt: new Date(now.getTime() + durationMinutes * 60_000),
      },
    });
  },

  findLiveOnboarding(subject, now: Date) {
    return prisma.delegatedAccessGrant.findFirst({
      where: { ...subject, purpose: 'ONBOARDING', status: 'ACTIVE', expiresAt: { gt: now } },
    });
  },

  async expireOnboarding(subject, now: Date) {
    const { count } = await prisma.delegatedAccessGrant.updateMany({
      where: { ...subject, purpose: 'ONBOARDING', status: 'ACTIVE' },
      data: { status: 'EXPIRED', expiresAt: now },
    });
    return count;
  },

  async attachQr(grantId: string, qrId: string) {
    await prisma.delegatedAccessGrant.update({ where: { id: grantId }, data: { qrId } });
  },

  findById(grantId: string) {
    return prisma.delegatedAccessGrant.findUnique({
      where: { id: grantId },
      include: withNames,
    }) as Promise<GrantDetail | null>;
  },

  findLiveForAgent(agentId: string, subject, scope: AccessGrantScope, now: Date) {
    return prisma.delegatedAccessGrant.findMany({
      where: {
        assignedAgentId: agentId,
        ...subject,
        scope,
        status: 'ACTIVE',
        // A window that has run out is not a grant. Filtering here rather than
        // marking rows EXPIRED on a schedule means access never outlives its
        // window, however late the sweep is.
        expiresAt: { gt: now },
      },
    });
  },

  claim(grantId: string, expiresAt: Date) {
    return prisma.delegatedAccessGrant.update({
      where: { id: grantId },
      data: { status: 'ACTIVE', claimedAt: new Date(), expiresAt },
    });
  },

  setStatus(
    grantId: string,
    status: AccessGrantStatus,
    fields: { revokedAt?: Date; revokedById?: string }
  ) {
    return prisma.delegatedAccessGrant.update({
      where: { id: grantId },
      data: { status, ...fields },
    });
  },

  listForPublisher(publisherId: string) {
    return prisma.delegatedAccessGrant.findMany({
      where: { publisherId },
      orderBy: { createdAt: 'desc' },
    });
  },

  listForSubject(subject) {
    return prisma.delegatedAccessGrant.findMany({
      where: subject,
      orderBy: { createdAt: 'desc' },
    });
  },

  listForAgent(agentId: string) {
    return prisma.delegatedAccessGrant.findMany({
      where: { assignedAgentId: agentId },
      orderBy: { createdAt: 'desc' },
    });
  },

  listForAgentWithNames(agentId: string) {
    return prisma.delegatedAccessGrant.findMany({
      where: { assignedAgentId: agentId },
      include: withNames,
      orderBy: { createdAt: 'desc' },
    }) as Promise<GrantDetail[]>;
  },

  listOpen() {
    return prisma.delegatedAccessGrant.findMany({
      where: { status: { in: ['PENDING', 'ACTIVE'] } },
      include: withNames,
      orderBy: { createdAt: 'desc' },
    }) as Promise<GrantDetail[]>;
  },

  async listingIdsFor(publisherId: string) {
    const rows = await prisma.listing.findMany({
      where: { publisherId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async findLabelsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await prisma.delegatedAccessGrant.findMany({
      where: { id: { in: ids } },
      select: { id: true, scope: true, status: true, purpose: true },
    });
    return rows.map((row) => ({ id: row.id, label: row.purpose + ' - ' + row.scope + ' - ' + row.status, displayId: null }));
  },

  publisherFor(publisherId: string) {
    return prisma.publisher.findUnique({
      where: { id: publisherId },
      select: { id: true, userId: true },
    });
  },

  ticketFor(ticketId: string) {
    return prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true, title: true, status: true, assignedAgentId: true },
    });
  },
};
