import { Prisma, prisma } from '../../shared/database';
import type { LeadStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import type {
  AccountByPhone,
  LeadCluster,
  LeadClusterScope,
  LeadPatch,
  LeadsRepository,
  NewLead,
} from './leads.repository';
import { LEAD_STATUSES, type AdminLeadsQuery, type NearLeadsQuery } from './leads.schema';

/**
 * Degrees per kilometre, near enough for a bounding box.
 *
 * The same approximation `listings` browse makes, and for the same reason: the
 * box is a coarse cut the database can index, and the exact radius is applied
 * afterwards. One degree of latitude is ~111 km; longitude narrows with the
 * cosine of the latitude.
 */
const boxAround = (latitude: number, longitude: number, radiusKm: number): Prisma.LeadWhereInput => ({
  latitude: { gte: latitude - radiusKm / 111, lte: latitude + radiusKm / 111 },
  longitude: {
    gte: longitude - radiusKm / (111 * Math.cos((latitude * Math.PI) / 180)),
    lte: longitude + radiusKm / (111 * Math.cos((latitude * Math.PI) / 180)),
  },
});

/** Metres between two points. Haversine, as the rating and browse use. */
export function distanceM(
  from: { latitude: number; longitude: number },
  to: { latitude: number | null; longitude: number | null },
): number | null {
  if (to.latitude === null || to.longitude === null) return null;
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.latitude - from.latitude);
  const dLng = toRad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Facets every lead list shares, minus the status — the chips count on that. */
function baseWhere(query: {
  q?: string | undefined;
  side?: string | undefined;
  city?: string | undefined;
  cityId?: string | null | undefined;
  category?: string | undefined;
}): Prisma.LeadWhereInput {
  return {
    ...(query.side ? { side: query.side as Prisma.LeadWhereInput['side'] } : {}),
    // Lot X-B: the key is the identity — by the key when the facet resolved
    // to one, the spelling (contains, as before) catching only the rows
    // whose key is null.
    ...(query.city
      ? query.cityId
        ? { OR: [{ cityId: query.cityId }, { cityId: null, city: { contains: query.city, mode: 'insensitive' } }] }
        : { cityId: null, city: { contains: query.city, mode: 'insensitive' } }
      : {}),
    ...(query.category ? { category: { equals: query.category, mode: 'insensitive' } } : {}),
    ...(query.q
      ? {
          OR: [
            { businessName: { contains: query.q, mode: 'insensitive' } },
            { contactName: { contains: query.q, mode: 'insensitive' } },
            { locality: { contains: query.q, mode: 'insensitive' } },
            { address: { contains: query.q, mode: 'insensitive' } },
            { displayId: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

const withStatus = (
  base: Prisma.LeadWhereInput,
  status: readonly string[] | undefined,
): Prisma.LeadWhereInput => ({
  ...base,
  ...(status?.length ? { status: { in: status as LeadStatus[] } } : {}),
});

export const prismaLeadsRepository: LeadsRepository = {
  create(data: NewLead) {
    return prisma.lead.create({ data: data as Prisma.LeadUncheckedCreateInput });
  },

  async createMany(rows: NewLead[]) {
    const result = await prisma.lead.createMany({
      data: rows as Prisma.LeadCreateManyInput[],
    });
    return result.count;
  },

  findById(leadId: string) {
    return prisma.lead.findUnique({
      where: { id: leadId },
      include: { activity: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
  },

  update(leadId: string, patch: LeadPatch) {
    return prisma.lead.update({
      where: { id: leadId },
      data: patch as Prisma.LeadUncheckedUpdateInput,
    });
  },

  async findNear(query: NearLeadsQuery) {
    const near =
      query.lat !== undefined && query.lng !== undefined
        ? { latitude: query.lat, longitude: query.lng, radiusKm: query.radiusKm }
        : null;

    const base: Prisma.LeadWhereInput = {
      ...baseWhere(query),
      // The agent's list is work to do. A converted or lost lead is neither,
      // and putting them in the "23 near you" count would inflate it with
      // things nobody should visit.
      status: { notIn: ['CONVERTED', 'LOST'] },
      ...(near ? boxAround(near.latitude, near.longitude, near.radiusKm) : {}),
    };
    const where = withStatus(base, query.status);

    // Around a point the box is read whole and ordered by exact distance,
    // because a box corner is farther than its edge and the frame promises
    // "0.8 km away" in order. The cap is the same 500 browse uses.
    if (near && query.sort === 'NEAREST') {
      const [rows, counts] = await Promise.all([
        prisma.lead.findMany({ where, take: 500 }),
        prisma.lead.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      ]);
      const within = rows
        .map((lead) => ({ lead, metres: distanceM(near, lead) }))
        .filter((row) => row.metres !== null && row.metres <= near.radiusKm * 1000)
        .sort((a, b) => a.metres! - b.metres!);
      const start = (query.page - 1) * query.pageSize;
      return {
        items: within.slice(start, start + query.pageSize).map((row) => row.lead),
        total: within.length,
        counts: countsFrom(counts, LEAD_STATUSES),
      };
    }

    const orderBy: Prisma.LeadOrderByWithRelationInput =
      query.sort === 'ESTIMATE_DESC'
        ? { estimatedCommission: { sort: 'desc', nulls: 'last' } }
        : { createdAt: 'desc' };

    const [items, total, groups] = await Promise.all([
      prisma.lead.findMany({ where, orderBy, ...listArgs(query) }),
      prisma.lead.count({ where }),
      prisma.lead.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, LEAD_STATUSES) };
  },

  async findForAdmin(query: AdminLeadsQuery) {
    const base: Prisma.LeadWhereInput = {
      ...baseWhere(query),
      ...(query.unassigned ? { assignedAgentId: null } : {}),
      ...(query.assignedAgentId ? { assignedAgentId: query.assignedAgentId } : {}),
    };
    const where = withStatus(base, query.status);

    const orderBy: Prisma.LeadOrderByWithRelationInput =
      query.sort === 'OLDEST'
        ? { createdAt: 'asc' }
        : query.sort === 'ESTIMATE_DESC'
          ? { estimatedCommission: { sort: 'desc', nulls: 'last' } }
          : { createdAt: 'desc' };

    const [items, total, groups] = await Promise.all([
      prisma.lead.findMany({ where, orderBy, ...listArgs(query) }),
      prisma.lead.count({ where }),
      prisma.lead.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, LEAD_STATUSES) };
  },

  async clustersNear(scope: LeadClusterScope) {
    const rows = await prisma.lead.groupBy({
      by: ['locality'],
      where: {
        status: { notIn: ['CONVERTED', 'LOST'] },
        locality: { not: null },
        // Lot X-L: the key is the identity — keyed leads by key, null-keyed ones by the spelling — so the map is not split by spelling.
        ...(scope.point
          ? boxAround(scope.point.latitude, scope.point.longitude, scope.point.radiusKm)
          : scope.cityId
            ? { OR: [{ cityId: scope.cityId }, { cityId: null, city: { equals: scope.city, mode: 'insensitive' as const } }] }
            : { city: { equals: scope.city, mode: 'insensitive' as const } }),
      },
      _count: { _all: true },
      _avg: { latitude: true, longitude: true },
    });

    return rows
      .filter((row) => row._avg.latitude !== null && row._avg.longitude !== null)
      .map<LeadCluster>((row) => ({
        // The bubble sits at the middle of the leads it covers rather than at
        // the locality's official centre, which the platform does not hold.
        latitude: row._avg.latitude!,
        longitude: row._avg.longitude!,
        count: row._count._all,
        label: row.locality!,
      }))
      .sort((a, b) => b.count - a.count);
  },

  logActivity(entry: { leadId: string; actorUserId: string | null; kind: string; note?: string | null }) {
    return prisma.leadActivity.create({
      data: entry as Prisma.LeadActivityUncheckedCreateInput,
    });
  },

  // ── Lot D (Q93): dedup ─────────────────────────────────────────────────

  findByPhones(phones: string[]) {
    if (phones.length === 0) return Promise.resolve([]);
    return prisma.lead.findMany({
      where: { phoneNormalised: { in: phones } },
      select: { id: true, displayId: true, phoneNormalised: true },
    });
  },

  async findAccountsByPhones(phones: string[]) {
    if (phones.length === 0) return [];
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.findMany({ where: { mobile: { in: phones } }, select: { id: true, mobile: true } }),
      prisma.advertiser.findMany({ where: { mobile: { in: phones } }, select: { id: true, mobile: true } }),
    ]);
    return [
      ...publishers.map<AccountByPhone>((row) => ({ phoneNormalised: row.mobile, kind: 'PUBLISHER', id: row.id })),
      ...advertisers.map<AccountByPhone>((row) => ({ phoneNormalised: row.mobile, kind: 'ADVERTISER', id: row.id })),
    ];
  },

  findByNameAndCity(names: string[]) {
    if (names.length === 0) return Promise.resolve([]);
    return prisma.lead.findMany({
      where: { OR: names.map((name) => ({ businessName: { equals: name, mode: 'insensitive' as const } })) },
      select: { id: true, displayId: true, businessName: true, city: true },
      take: 1000,
    });
  },

  closeOpenLeadsInCities(city, actorUserId, note) {
    if (!city.cityId && city.spellings.length === 0) return Promise.resolve([]);
    return prisma.$transaction(async (tx) => {
      const open = await tx.lead.findMany({
        where: {
          status: { notIn: ['CONVERTED', 'LOST'] },
          OR: [
            ...(city.cityId ? [{ cityId: city.cityId }] : []),
            ...(city.spellings.length ? [{ cityId: null, city: { in: city.spellings, mode: 'insensitive' as const } }] : []),
          ],
        },
        select: { id: true, status: true },
      });
      if (open.length === 0) return [];
      await tx.lead.updateMany({ where: { id: { in: open.map((lead) => lead.id) } }, data: { status: 'LOST' } });
      await tx.leadActivity.createMany({
        data: open.map((lead) => ({ leadId: lead.id, actorUserId, kind: 'STATUS_CHANGED', note: `${lead.status} → LOST — ${note}` })),
      });
      return open.map((lead) => lead.id);
    });
  },

  importBatch(rows) {
    // One transaction: a batch either lands whole or not at all, so a
    // duplicate the pre-checks missed (the partial unique on phoneNormalised
    // refuses it) rolls the whole sheet back for ops to re-run.
    return prisma.$transaction(async (tx) => {
      const created: { id: string; displayId: string | null }[] = [];
      for (const row of rows) {
        const lead = await tx.lead.create({
          data: row as Prisma.LeadUncheckedCreateInput,
          select: { id: true, displayId: true },
        });
        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            actorUserId: row.createdByUserId ?? null,
            kind: 'IMPORTED',
            note: row.source ? `Added from ${row.source}` : 'Added',
          },
        });
        created.push(lead);
      }
      return created;
    });
  },
};
