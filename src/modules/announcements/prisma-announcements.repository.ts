import { prisma } from '../../shared/database';
import type { AnnouncementAudience, AnnouncementStatus, Prisma, Role } from '../../shared/database';
import { countsFrom, listArgs, type ListQuery } from '../../shared/pagination';
import {
  ANNOUNCEMENT_STATUSES,
  type AnnouncementFilter,
  type AnnouncementPatch,
  type AnnouncementsRepository,
  type DeliveryMark,
  type NewAnnouncement,
} from './announcements.repository';

const PARTY_ROLES: Record<AnnouncementAudience, Role[]> = {
  ALL: ['PUBLISHER', 'ADVERTISER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER'],
  PUBLISHERS: ['PUBLISHER'],
  ADVERTISERS: ['ADVERTISER'],
  AGENTS: ['AGENT_PUBLISHER', 'AGENT_ADVERTISER'],
};

/**
 * Who an announcement reaches: a live, verified account holding one of the
 * audience's roles — and, when a city is named, whose profile for that
 * audience is in it. Admins and partners are never an audience.
 */
function audienceWhere(audience: AnnouncementAudience, city: string | null): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {
    isActive: true,
    closedAt: null,
    mobileVerifiedAt: { not: null },
    roles: { some: { role: { in: PARTY_ROLES[audience] } } },
  };
  if (!city) return where;

  const inCity = { city: { equals: city, mode: 'insensitive' as const } };
  const byProfile: Record<AnnouncementAudience, Prisma.UserWhereInput[]> = {
    PUBLISHERS: [{ publisherProfile: { is: inCity } }],
    ADVERTISERS: [{ advertiserProfile: { is: inCity } }],
    AGENTS: [{ agentProfile: { is: inCity } }],
    ALL: [{ publisherProfile: { is: inCity } }, { advertiserProfile: { is: inCity } }, { agentProfile: { is: inCity } }],
  };
  return { ...where, OR: byProfile[audience] };
}

function listWhere(filter: AnnouncementFilter, withStatus: boolean): Prisma.AnnouncementWhereInput {
  return {
    ...(filter.audience ? { audience: filter.audience } : {}),
    ...(filter.q ? { title: { contains: filter.q, mode: 'insensitive' } } : {}),
    ...(withStatus && filter.status?.length ? { status: { in: [...filter.status] } } : {}),
  };
}

const patchData = (patch: AnnouncementPatch): Prisma.AnnouncementUpdateInput => ({
  ...(patch.status !== undefined ? { status: patch.status } : {}),
  ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
  ...(patch.recipientCount !== undefined ? { recipientCount: patch.recipientCount } : {}),
  ...(patch.deliveredByChannel !== undefined ? { deliveredByChannel: patch.deliveredByChannel as Prisma.InputJsonValue } : {}),
  ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {}),
});

export const prismaAnnouncementsRepository: AnnouncementsRepository = {
  create(data: NewAnnouncement) {
    return prisma.announcement.create({ data });
  },

  findById(id: string) {
    return prisma.announcement.findUnique({ where: { id } });
  },

  async list(filter: AnnouncementFilter, page: ListQuery) {
    const where = listWhere(filter, true);
    const [items, total, groups] = await Promise.all([
      prisma.announcement.findMany({ where, orderBy: { createdAt: page.sort === 'oldest' ? 'asc' : 'desc' }, ...listArgs(page) }),
      prisma.announcement.count({ where }),
      prisma.announcement.groupBy({ by: ['status'], where: listWhere(filter, false), _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, ANNOUNCEMENT_STATUSES) };
  },

  update(id: string, patch: AnnouncementPatch) {
    return prisma.announcement.update({ where: { id }, data: patchData(patch) });
  },

  async transition(id: string, from: readonly AnnouncementStatus[], to: AnnouncementStatus, patch: AnnouncementPatch = {}) {
    const result = await prisma.announcement.updateMany({
      where: { id, status: { in: [...from] } },
      data: { ...patchData(patch), status: to } as Prisma.AnnouncementUpdateManyMutationInput,
    });
    return result.count === 1;
  },

  findDue(now: Date) {
    return prisma.announcement.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: now } }, orderBy: { scheduledAt: 'asc' } });
  },

  findSending() {
    return prisma.announcement.findMany({ where: { status: 'SENDING' }, orderBy: { scheduledAt: 'asc' } });
  },

  async audienceCounts(audience: AnnouncementAudience, city: string | null) {
    const where = audienceWhere(audience, city);
    const [total, withEmail, devices] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.count({ where: { AND: [where, { email: { not: null }, emailUnsubscribedAt: null }] } }),
      // G11-2: the devices a PUSH would go to — every registered token whose owner is in the audience.
      prisma.deviceToken.count({ where: { user: where } }),
    ]);
    // Every account has a mobile — it is the identity — so the SMS reach is the audience.
    return { total, withEmail, withMobile: total, devices };
  },

  audiencePage(audience: AnnouncementAudience, city: string | null, afterId: string | null, take: number) {
    return prisma.user.findMany({
      where: { AND: [audienceWhere(audience, city), ...(afterId ? [{ id: { gt: afterId } }] : [])] },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, email: true, mobile: true, emailUnsubscribedAt: true },
    });
  },

  existingMarks(announcementId: string, userIds: readonly string[]) {
    if (userIds.length === 0) return Promise.resolve([]);
    return prisma.announcementDelivery.findMany({
      where: { announcementId, userId: { in: [...userIds] } },
      select: { userId: true, channel: true },
    });
  },

  async writeMarks(announcementId: string, marks: readonly DeliveryMark[]) {
    if (marks.length === 0) return 0;
    const result = await prisma.announcementDelivery.createMany({
      data: marks.map((mark) => ({ announcementId, userId: mark.userId, channel: mark.channel, status: mark.status })),
      skipDuplicates: true,
    });
    return result.count;
  },

  async markCounts(announcementId: string) {
    const groups = await prisma.announcementDelivery.groupBy({
      by: ['channel', 'status'],
      where: { announcementId },
      _count: { _all: true },
    });
    const counts: Record<string, Record<string, number>> = {};
    for (const group of groups) {
      counts[group.channel] = { ...(counts[group.channel] ?? {}), [group.status]: group._count._all };
    }
    return counts;
  },
};
