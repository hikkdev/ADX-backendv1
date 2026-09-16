import { Prisma, prisma } from '../../shared/database';
import type { HealthService } from '../../shared/database';
import { countsFrom, listArgs, type ListQuery } from '../../shared/pagination';
import {
  HEALTH_SERVICES,
  INCIDENT_STATUSES,
  type HealthDay,
  type IncidentFilter,
  type IncidentPatch,
  type NewHealthSample,
  type NewIncident,
  type NewIncidentUpdate,
  type OpsRepository,
} from './ops.repository';

const withUpdates = { updates: { orderBy: { at: 'asc' as const } } };

function incidentWhere(filter: IncidentFilter, withStatus: boolean): Prisma.IncidentWhereInput {
  return {
    ...(filter.q ? { title: { contains: filter.q, mode: 'insensitive' } } : {}),
    ...(filter.service ? { services: { has: filter.service } } : {}),
    ...(withStatus && filter.status?.length ? { status: { in: [...filter.status] } } : {}),
  };
}

export const prismaOpsRepository: OpsRepository = {
  async writeSamples(samples) {
    if (samples.length === 0) return 0;
    const result = await prisma.healthSample.createMany({ data: samples.map((s) => ({ ...s })) });
    return result.count;
  },

  async latestSamples() {
    const rows = await Promise.all(HEALTH_SERVICES.map((service) => prisma.healthSample.findFirst({ where: { service }, orderBy: { at: 'desc' } })));
    return rows.filter((row): row is NonNullable<typeof row> => row !== null);
  },

  async dailyHealth(since) {
    // The Indian day is the UTC instant shifted by 5h30; p95 by interpolation
    // over the non-null latencies (percentile_cont ignores NULLs), null when
    // a day has none — the JOBS probe carries no latency.
    const rows = await prisma.$queryRaw<{ service: string; date: string; okPct: number; p95Ms: number | null }[]>`
      SELECT "service"::text AS "service",
             to_char(("at" + interval '330 minutes')::date, 'YYYY-MM-DD') AS "date",
             (100.0 * sum(CASE WHEN "ok" THEN 1 ELSE 0 END) / count(*))::float AS "okPct",
             (percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs"))::float AS "p95Ms"
      FROM "HealthSample"
      WHERE "at" >= ${since}
      GROUP BY 1, 2
      ORDER BY 2, 1`;
    return rows.map(
      (row): HealthDay => ({
        service: row.service as HealthService,
        date: row.date,
        okPct: Math.round(Number(row.okPct) * 10) / 10,
        p95Ms: row.p95Ms === null ? null : Math.round(Number(row.p95Ms)),
      }),
    );
  },

  async pruneSamples(before) {
    const result = await prisma.healthSample.deleteMany({ where: { at: { lt: before } } });
    return result.count;
  },

  createIncident(data: NewIncident, first: NewIncidentUpdate) {
    return prisma.incident.create({
      data: { ...data, status: first.status, updates: { create: { ...first } } },
      include: withUpdates,
    });
  },

  findIncident(id) {
    return prisma.incident.findUnique({ where: { id }, include: withUpdates });
  },

  async listIncidents(filter, page: ListQuery) {
    const where = incidentWhere(filter, true);
    const [items, total, groups] = await Promise.all([
      prisma.incident.findMany({ where, orderBy: { startedAt: page.sort === 'oldest' ? 'asc' : 'desc' }, include: withUpdates, ...listArgs(page) }),
      prisma.incident.count({ where }),
      prisma.incident.groupBy({ by: ['status'], where: incidentWhere(filter, false), _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, INCIDENT_STATUSES) };
  },

  openIncidents() {
    return prisma.incident.findMany({ where: { status: { not: 'RESOLVED' } }, orderBy: { startedAt: 'desc' }, include: withUpdates });
  },

  async latestIncidentAt() {
    const row = await prisma.incident.findFirst({ where: { services: { isEmpty: false } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
    return row?.startedAt ?? null;
  },

  addUpdate(id, update: NewIncidentUpdate, patch: IncidentPatch) {
    return prisma.$transaction(async (tx) => {
      await tx.incidentUpdate.create({ data: { incidentId: id, ...update } });
      return tx.incident.update({ where: { id }, data: patch, include: withUpdates });
    });
  },

  patchIncident(id, patch: IncidentPatch) {
    return prisma.incident.update({ where: { id }, data: patch, include: withUpdates });
  },

  findSubscriberByEmail(email) {
    return prisma.statusSubscriber.findUnique({ where: { email } });
  },

  findSubscriberByToken(token) {
    return prisma.statusSubscriber.findUnique({ where: { token } });
  },

  async upsertSubscriber(email, token) {
    const existing = await prisma.statusSubscriber.findUnique({ where: { email } });
    if (existing?.confirmedAt) return existing;
    if (existing) return prisma.statusSubscriber.update({ where: { id: existing.id }, data: { token } });
    return prisma.statusSubscriber.create({ data: { email, token } });
  },

  confirmSubscriber(id, at) {
    return prisma.statusSubscriber.update({ where: { id }, data: { confirmedAt: at } });
  },

  async deleteSubscriber(id) {
    await prisma.statusSubscriber.delete({ where: { id } });
  },

  confirmedSubscribers() {
    return prisma.statusSubscriber.findMany({ where: { confirmedAt: { not: null } }, select: { email: true, token: true }, orderBy: { createdAt: 'asc' } });
  },

  async subscriberCounts() {
    const [confirmed, pending] = await Promise.all([
      prisma.statusSubscriber.count({ where: { confirmedAt: { not: null } } }),
      prisma.statusSubscriber.count({ where: { confirmedAt: null } }),
    ]);
    return { confirmed, pending };
  },
};
