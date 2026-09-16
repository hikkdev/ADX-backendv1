import { prisma, Prisma } from '../../shared/database';
import { countsFrom, listArgs, type ListQuery } from '../../shared/pagination';
import {
  DELIVERY_STATUSES,
  MAX_DELIVERY_ATTEMPTS,
  TEMPLATE_STATUSES,
  type CapSubject,
  type CommsRepository,
  type DeliveryFilter,
  type DeliveryPatch,
  type DeliverySlice,
  type NewAttempt,
  type NewDelivery,
  type TemplateFilter,
  type TemplateInput,
} from './comms.repository';
import { DEFERRAL_MARKER } from './comms-rules';
import type { TemplateSeed } from './templates';
import { NOTIFICATION_CHANNELS } from './notifications.types';

function templateWhere(filter: TemplateFilter, withStatus: boolean): Prisma.NotificationTemplateWhereInput {
  return {
    ...(filter.event ? { event: filter.event } : {}),
    ...(filter.q
      ? {
          OR: [
            { key: { contains: filter.q, mode: 'insensitive' } },
            { event: { contains: filter.q, mode: 'insensitive' } },
            { subject: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(withStatus && filter.status?.length ? { status: { in: [...filter.status] } } : {}),
  };
}

function deliveryWhere(filter: DeliveryFilter, withStatus: boolean, withChannel = true): Prisma.NotificationDeliveryWhereInput {
  return {
    ...(withChannel && filter.channel ? { channel: filter.channel } : {}),
    ...(filter.templateKey ? { templateKey: filter.templateKey } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.recipientHash ? { recipientHash: filter.recipientHash } : {}),
    ...(filter.maskedContains ? { recipientMasked: { contains: filter.maskedContains, mode: 'insensitive' } } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
    ...(withStatus && filter.status?.length ? { status: { in: [...filter.status] } } : {}),
  };
}

export const prismaCommsRepository: CommsRepository = {
  async ensureTemplates(seeds: readonly TemplateSeed[]) {
    const result = await prisma.notificationTemplate.createMany({
      data: seeds.map((seed) => ({
        key: seed.key,
        event: seed.event,
        channels: seed.channels,
        subject: seed.subject ?? null,
        emailBody: seed.emailBody ?? null,
        smsKind: seed.smsKind ?? null,
        smsBody: seed.smsBody ?? null,
        isSensitive: seed.isSensitive ?? false,
        transactional: seed.transactional ?? true,
        pushTitle: seed.pushTitle ?? null,
        pushBody: seed.pushBody ?? null,
        status: 'ACTIVE',
      })),
      skipDuplicates: true,
    });
    return result.count;
  },

  async ensureTransactionalFlags(seeds) {
    let moved = 0;
    for (const seed of seeds) {
      const result = await prisma.notificationTemplate.updateMany({
        where: { key: seed.key, version: 1, transactional: { not: seed.transactional } },
        data: { transactional: seed.transactional },
      });
      moved += result.count;
    }
    return moved;
  },

  findActiveTemplate(event: string) {
    return prisma.notificationTemplate.findFirst({ where: { event, status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' } });
  },

  findTemplateByKey(key: string) {
    return prisma.notificationTemplate.findUnique({ where: { key } });
  },

  async listTemplates(filter: TemplateFilter, page: ListQuery) {
    const where = templateWhere(filter, true);
    const [items, total, groups] = await Promise.all([
      prisma.notificationTemplate.findMany({
        where,
        orderBy: page.sort === 'newest' ? { updatedAt: 'desc' } : { key: 'asc' },
        ...listArgs(page),
      }),
      prisma.notificationTemplate.count({ where }),
      prisma.notificationTemplate.groupBy({ by: ['status'], where: templateWhere(filter, false), _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, TEMPLATE_STATUSES) };
  },

  createTemplate(data: TemplateInput) {
    return prisma.notificationTemplate.create({
      data: {
        key: data.key,
        event: data.event,
        channels: data.channels,
        subject: data.subject ?? null,
        emailBody: data.emailBody ?? null,
        smsKind: data.smsKind ?? null,
        smsBody: data.smsBody ?? null,
        isSensitive: data.isSensitive ?? false,
        transactional: data.transactional ?? true,
        pushTitle: data.pushTitle ?? null,
        pushBody: data.pushBody ?? null,
        status: data.status ?? 'DRAFT',
        updatedById: data.updatedById ?? null,
      },
    });
  },

  updateTemplate(key: string, data: Partial<TemplateInput>) {
    const { key: _ignored, ...rest } = data;
    return prisma.notificationTemplate.update({
      where: { key },
      data: { ...rest, version: { increment: 1 } },
    });
  },

  async sensitiveTemplateKeys() {
    const rows = await prisma.notificationTemplate.findMany({ where: { isSensitive: true }, select: { key: true } });
    return rows.map((row) => row.key);
  },

  async nonTransactionalTemplateKeys() {
    const rows = await prisma.notificationTemplate.findMany({ where: { transactional: false }, select: { key: true } });
    return rows.map((row) => row.key);
  },

  allTemplates() {
    return prisma.notificationTemplate.findMany({
      select: { key: true, event: true, status: true, channels: true },
      orderBy: { key: 'asc' },
    });
  },

  async templateStats(since: Date) {
    const groups = await prisma.notificationDelivery.groupBy({
      by: ['templateKey', 'status'],
      where: { createdAt: { gte: since }, templateKey: { not: null } },
      _count: { _all: true },
    });
    return groups
      .filter((group): group is typeof group & { templateKey: string } => typeof group.templateKey === 'string')
      .map((group) => ({ templateKey: group.templateKey, status: group.status, count: group._count._all }));
  },

  findRecipient(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, mobile: true, emailUnsubscribedAt: true, isActive: true, closedAt: true },
    });
  },

  async markEmailUnsubscribed(userId: string, at: Date) {
    const result = await prisma.user.updateMany({ where: { id: userId, emailUnsubscribedAt: null }, data: { emailUnsubscribedAt: at } });
    return result.count > 0;
  },

  createDelivery(data: NewDelivery) {
    return prisma.notificationDelivery.create({
      data: {
        userId: data.userId,
        notificationId: data.notificationId,
        templateKey: data.templateKey,
        channel: data.channel,
        recipientMasked: data.recipientMasked,
        recipientHash: data.recipientHash,
        variables: data.variables ?? undefined,
        ...(data.status ? { status: data.status } : {}),
        ...(data.lastError !== undefined ? { lastError: data.lastError } : {}),
        ...(data.scheduledFor !== undefined ? { scheduledFor: data.scheduledFor } : {}),
      },
    });
  },

  findDelivery(id: string) {
    return prisma.notificationDelivery.findUnique({ where: { id } });
  },

  async listDeliveries(filter: DeliveryFilter, page: ListQuery) {
    const where = deliveryWhere(filter, true);
    const [items, total, groups, channels] = await Promise.all([
      prisma.notificationDelivery.findMany({
        where,
        orderBy: { createdAt: page.sort === 'oldest' ? 'asc' : 'desc' },
        ...listArgs(page),
      }),
      prisma.notificationDelivery.count({ where }),
      prisma.notificationDelivery.groupBy({ by: ['status'], where: deliveryWhere(filter, false), _count: { _all: true } }),
      // E10-2: the channel chips, counted with the channel facet removed so
      // picking SMS does not zero the EMAIL chip — the same rule as status.
      prisma.notificationDelivery.groupBy({ by: ['channel'], where: deliveryWhere(filter, true, false), _count: { _all: true } }),
    ]);
    return {
      items,
      total,
      counts: countsFrom(groups, DELIVERY_STATUSES),
      byChannel: countsFrom(
        channels.map((group) => ({ status: group.channel, _count: group._count })),
        NOTIFICATION_CHANNELS,
      ),
    };
  },

  /* E12-B: keyset, not offset. The order is (createdAt, id) both ways, and
     the slice after a cursor is "strictly past it in that order": a later
     createdAt, or the same createdAt and a later id. The cursor rides in
     its own AND arm so it never collides with the filter's own createdAt
     window. */
  findDeliveryRows(filter: DeliveryFilter, slice: DeliverySlice) {
    const dir = slice.sort === 'oldest' ? 'asc' : 'desc';
    const past = dir === 'asc' ? 'gt' : 'lt';
    const where = deliveryWhere(filter, true);
    return prisma.notificationDelivery.findMany({
      where: slice.after
        ? {
            AND: [
              where,
              {
                OR: [
                  { createdAt: { [past]: slice.after.createdAt } },
                  { createdAt: slice.after.createdAt, id: { [past]: slice.after.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ createdAt: dir }, { id: dir }],
      take: slice.take,
    });
  },

  findQueued(limit: number, now: Date) {
    return prisma.notificationDelivery.findMany({
      where: {
        status: 'QUEUED',
        attempts: { lt: MAX_DELIVERY_ATTEMPTS },
        // Lot G (Q117) / G10: a deferred row waits on its own column.
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
        // One release: a row written before the column keeps its marker until the fold has moved it.
        NOT: { lastError: { startsWith: DEFERRAL_MARKER } },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },

  findLegacyDeferred(limit: number) {
    return prisma.notificationDelivery.findMany({
      where: { status: 'QUEUED', scheduledFor: null, lastError: { startsWith: DEFERRAL_MARKER } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },

  countDeliveriesInWindow(subject: CapSubject, from: Date, to: Date, templateKeys) {
    if (templateKeys.length === 0) return Promise.resolve(0);
    return prisma.notificationDelivery.count({
      where: {
        ...('userId' in subject ? { userId: subject.userId } : { recipientHash: subject.recipientHash }),
        createdAt: { gte: from, lt: to },
        templateKey: { in: [...templateKeys] },
        status: { not: 'SKIPPED' },
      },
    });
  },

  updateDelivery(id: string, patch: DeliveryPatch) {
    return prisma.notificationDelivery.update({ where: { id }, data: patch });
  },

  recordAttempt(data: NewAttempt) {
    return prisma.deliveryAttempt.create({ data });
  },

  findAttempts(deliveryId: string) {
    return prisma.deliveryAttempt.findMany({ where: { deliveryId }, orderBy: { attempt: 'asc' } });
  },

  findByProviderMessageId(provider: string, providerMessageId: string) {
    return prisma.notificationDelivery.findFirst({ where: { provider, providerMessageId }, orderBy: { createdAt: 'desc' } });
  },

  async purgeVariables(before: Date, at: Date, templateKeys?: readonly string[]) {
    const result = await prisma.notificationDelivery.updateMany({
      where: {
        createdAt: { lt: before },
        purgedAt: null,
        ...(templateKeys ? { templateKey: { in: [...templateKeys] } } : {}),
      },
      data: { variables: Prisma.DbNull, purgedAt: at },
    });
    return result.count;
  },

  async deleteCreatedBefore(before: Date) {
    const result = await prisma.notificationDelivery.deleteMany({ where: { createdAt: { lt: before } } });
    return result.count;
  },
};
