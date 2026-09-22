import { Prisma, prisma } from '../../shared/database';
import type { LeadStatus, LeadImportance, LeadTemperature, LeadSourceKind } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import { money } from '../../shared/money';
import type {
  AccountByPhone,
  FunnelFilter,
  FunnelRows,
  LeadCluster,
  LeadClusterScope,
  LeadPatch,
  LeadsRepository,
  NewLead,
} from './leads.repository';
import type { LeadStage, LeadLostReason, LeadFeedRunStatus, ReferrerKind, LeadSide } from '../../shared/database';
import { LEAD_STATUSES, LEAD_TEMPERATURES, type AdminLeadsQuery, type NearLeadsQuery } from './leads.schema';

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

/** LH1: the temperature histogram, every temperature present (unscored rows fall under none). */
function temperatureCountsFrom(groups: { temperature: LeadTemperature | null; _count: { _all: number } }[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(LEAD_TEMPERATURES.map((t) => [t, 0]));
  for (const group of groups) if (group.temperature) counts[group.temperature] = group._count._all;
  return counts;
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

/** LH1: the temperature facet, laid over the status one. */
const withTemperature = (base: Prisma.LeadWhereInput, temperature: string | undefined): Prisma.LeadWhereInput => ({
  ...base,
  ...(temperature ? { temperature: temperature as LeadTemperature } : {}),
});

/** LH2: the stage facet. */
const withStage = (base: Prisma.LeadWhereInput, stage: readonly string[] | undefined): Prisma.LeadWhereInput => ({
  ...base,
  ...(stage?.length ? { stage: { in: stage as LeadStage[] } } : {}),
});

/** LH2: the stage histogram, every stage present. */
function stageCountsFrom(groups: { stage: LeadStage; _count: { _all: number } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const group of groups) counts[group.stage] = group._count._all;
  return counts;
}

/** LH1: a box `radiusM` metres around a point, for the listing reads. */
const boxMetres = (point: { latitude: number; longitude: number }, radiusM: number) => boxAround(point.latitude, point.longitude, radiusM / 1000);

/** LH1: the statuses under which a listing is on the market. */
const LIVE_LISTING: Prisma.ListingWhereInput = { status: 'ACTIVE' };

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

  async findNear(query: NearLeadsQuery, importances?: readonly string[]) {
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
      // AG-5: a KEY or ENTERPRISE lead is not on a G1's map.
      ...(importances ? { importance: { in: [...importances] as LeadImportance[] } } : {}),
    };
    const where = withStage(withTemperature(withStatus(base, query.status), query.temperature), query.stage);
    // The temperature chips count under the status facet with the temperature facet removed, the way the status chips drop theirs.
    const temperatureBase = withStage(withStatus(base, query.status), query.stage);

    // Around a point the box is read whole and ordered by exact distance,
    // because a box corner is farther than its edge and the frame promises
    // "0.8 km away" in order. The cap is the same 500 browse uses.
    if (near && query.sort === 'NEAREST') {
      const [rows, counts, temperatures] = await Promise.all([
        prisma.lead.findMany({ where, take: 500 }),
        prisma.lead.groupBy({ by: ['status'], where: withTemperature(base, query.temperature), _count: { _all: true } }),
        prisma.lead.groupBy({ by: ['temperature'], where: temperatureBase, _count: { _all: true } }),
      ]);
      const within = rows
        .map((lead) => ({ lead, metres: distanceM(near, lead) }))
        .filter((row) => row.metres !== null && row.metres <= near.radiusKm * 1000)
        .sort((a, b) => a.metres! - b.metres!);
      const start = (query.page - 1) * query.pageSize;
      const stageGroups = await prisma.lead.groupBy({ by: ['stage'], where: withTemperature(withStatus(base, query.status), query.temperature), _count: { _all: true } });
      return {
        items: within.slice(start, start + query.pageSize).map((row) => row.lead),
        total: within.length,
        counts: countsFrom(counts, LEAD_STATUSES),
        temperatureCounts: temperatureCountsFrom(temperatures),
        stageCounts: stageCountsFrom(stageGroups),
      };
    }

    const orderBy: Prisma.LeadOrderByWithRelationInput[] =
      query.sort === 'ESTIMATE_DESC'
        ? [{ estimatedCommission: { sort: 'desc', nulls: 'last' } }]
        : query.sort === 'HOTTEST'
          ? [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
          : [{ createdAt: 'desc' }];

    const [items, total, groups, temperatures, stageGroups] = await Promise.all([
      prisma.lead.findMany({ where, orderBy, ...listArgs(query) }),
      prisma.lead.count({ where }),
      prisma.lead.groupBy({ by: ['status'], where: withStage(withTemperature(base, query.temperature), query.stage), _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['temperature'], where: temperatureBase, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['stage'], where: withTemperature(withStatus(base, query.status), query.temperature), _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, LEAD_STATUSES), temperatureCounts: temperatureCountsFrom(temperatures), stageCounts: stageCountsFrom(stageGroups) };
  },

  async findForAdmin(query: AdminLeadsQuery) {
    const base: Prisma.LeadWhereInput = {
      ...baseWhere(query),
      ...(query.unassigned ? { assignedAgentId: null } : {}),
      ...(query.assignedAgentId ? { assignedAgentId: query.assignedAgentId } : {}),
    };
    const where = withStage(withTemperature(withStatus(base, query.status), query.temperature), query.stage);

    const orderBy: Prisma.LeadOrderByWithRelationInput[] =
      query.sort === 'OLDEST'
        ? [{ createdAt: 'asc' }]
        : query.sort === 'ESTIMATE_DESC'
          ? [{ estimatedCommission: { sort: 'desc', nulls: 'last' } }]
          : query.sort === 'HOTTEST'
            ? [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
            : [{ createdAt: 'desc' }];

    const [items, total, groups, temperatures, stageGroups] = await Promise.all([
      prisma.lead.findMany({ where, orderBy, ...listArgs(query) }),
      prisma.lead.count({ where }),
      prisma.lead.groupBy({ by: ['status'], where: withStage(withTemperature(base, query.temperature), query.stage), _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['temperature'], where: withStage(withStatus(base, query.status), query.stage), _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['stage'], where: withTemperature(withStatus(base, query.status), query.temperature), _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, LEAD_STATUSES), temperatureCounts: temperatureCountsFrom(temperatures), stageCounts: stageCountsFrom(stageGroups) };
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

  // ── LH1: scoring ────────────────────────────────────────────────────────

  findForScoring(leadId, since) {
    return prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        sourceRef: true,
        activity: { where: { createdAt: { gte: since } }, select: { kind: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 500 },
      },
    });
  },

  async openLeadIdsAfter(cursor, take) {
    const rows = await prisma.lead.findMany({
      where: { status: { notIn: ['CONVERTED', 'LOST'] }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });
    return rows.map((row) => row.id);
  },

  countLiveListingsNear(point, radiusM) {
    return prisma.listing.count({ where: { ...LIVE_LISTING, ...(boxMetres(point, radiusM) as Prisma.ListingWhereInput) } });
  },

  async medianLiveRateNear(point, radiusM) {
    const rows = await prisma.listing.findMany({
      where: { ...LIVE_LISTING, ratePerDay: { not: null }, ...(boxMetres(point, radiusM) as Prisma.ListingWhereInput) },
      select: { ratePerDay: true },
      orderBy: { ratePerDay: 'asc' },
      take: 200,
    });
    if (rows.length === 0) return null;
    const middle = rows[Math.floor(rows.length / 2)]!;
    return money(middle.ratePerDay as never);
  },

  async averageCampaignBudget(cityId, since) {
    const aggregate = await prisma.campaign.aggregate({
      where: {
        status: { in: ['SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED'] },
        createdAt: { gte: since },
        budget: { not: null },
        ...(cityId ? { cityId } : {}),
      },
      _avg: { budget: true },
    });
    return aggregate._avg.budget === null ? null : money(aggregate._avg.budget as never);
  },

  async sourceStats(since) {
    const [created, converted] = await Promise.all([
      prisma.lead.groupBy({ by: ['sourceId'], where: { sourceId: { not: null }, createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['sourceId'], where: { sourceId: { not: null }, createdAt: { gte: since }, status: 'CONVERTED' }, _count: { _all: true } }),
    ]);
    const convertedBy = new Map(converted.map((row) => [row.sourceId, row._count._all]));
    return created.map((row) => ({ sourceId: row.sourceId!, created: row._count._all, converted: convertedBy.get(row.sourceId) ?? 0 }));
  },

  // ── LH2: stages ────────────────────────────────────────────────────────

  findAtStages(stages, take, cursor) {
    return prisma.lead.findMany({
      where: { stage: { in: stages as LeadStage[] }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take,
    });
  },

  dueForRecycle(now, take) {
    return prisma.lead.findMany({ where: { stage: 'LOST', recycleAt: { lte: now } }, orderBy: { recycleAt: 'asc' }, take });
  },

  async accountActivation(account) {
    if (account.publisherId) {
      const listing = await prisma.listing.findFirst({
        where: { publisherId: account.publisherId, status: 'ACTIVE' },
        orderBy: [{ publishedAt: 'asc' }, { updatedAt: 'asc' }],
        select: { publishedAt: true, updatedAt: true, title: true },
      });
      return listing ? { activatedAt: listing.publishedAt ?? listing.updatedAt, label: listing.title } : { activatedAt: null, label: null };
    }
    if (account.advertiserId) {
      const campaign = await prisma.campaign.findFirst({
        where: { advertiserId: account.advertiserId, status: { in: ['SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED'] } },
        orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
        select: { paidAt: true, createdAt: true, name: true },
      });
      return campaign ? { activatedAt: campaign.paidAt ?? campaign.createdAt, label: campaign.name } : { activatedAt: null, label: null };
    }
    return { activatedAt: null, label: null };
  },

  async accountRetention(account) {
    if (account.publisherId) {
      const [repeatCount, live] = await Promise.all([
        prisma.order.count({ where: { listing: { publisherId: account.publisherId }, status: { notIn: ['DRAFT', 'CANCELLED', 'PUBLISHER_REJECTED'] } } }),
        prisma.listing.count({ where: { publisherId: account.publisherId, status: 'ACTIVE' } }),
      ]);
      return { repeatCount, stillLive: live > 0 };
    }
    if (account.advertiserId) {
      const [repeatCount, live] = await Promise.all([
        prisma.campaign.count({ where: { advertiserId: account.advertiserId, status: { in: ['SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED'] } } }),
        prisma.campaign.count({ where: { advertiserId: account.advertiserId, status: { in: ['SCHEDULED', 'LIVE', 'PAUSED'] } } }),
      ]);
      return { repeatCount, stillLive: live > 0 };
    }
    return { repeatCount: 0, stillLive: false };
  },

  async attributeAccountToAgent(account, agentId) {
    // Only where nothing is stamped: a QR-scanned or desk-onboarded account
    // keeps the agent who brought it in, and the ladder never counts one
    // account for two people.
    if (account.publisherId) {
      const stamped = await prisma.publisher.updateMany({ where: { id: account.publisherId, agentId: null }, data: { agentId } });
      return stamped.count > 0 ? 'PUBLISHER' : null;
    }
    if (account.advertiserId) {
      const stamped = await prisma.advertiser.updateMany({ where: { id: account.advertiserId, agentId: null }, data: { agentId } });
      return stamped.count > 0 ? 'ADVERTISER' : null;
    }
    return null;
  },

  async rewardsFor(lead) {
    const rows = await prisma.agentIncentive.findMany({
      where: {
        event: { in: ['LEAD_CONVERTED', 'LEAD_ACTIVATED', 'LEAD_RETAINED'] },
        OR: [
          ...(lead.convertedPublisherId ? [{ publisherId: lead.convertedPublisherId }] : []),
          ...(lead.convertedAdvertiserId ? [{ advertiserId: lead.convertedAdvertiserId }] : []),
          // The priority top-up is keyed `priority:<zone>:<lead>` (LH5).
          { orderId: { endsWith: `:${lead.id}` } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, event: true, amount: true, status: true, note: true, createdAt: true },
    });
    return rows.map((row) => ({ id: row.id, event: row.event, amount: row.amount.toFixed(2), status: row.status, note: row.note, at: row.createdAt }));
  },

  async funnel(filter) {
    const where: Prisma.LeadWhereInput = {
      ...(filter.side ? { side: filter.side as Prisma.LeadWhereInput['side'] } : {}),
      ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
      ...(filter.agentId ? { assignedAgentId: filter.agentId } : {}),
      ...(filter.city ? (filter.cityId ? { OR: [{ cityId: filter.cityId }, { cityId: null, city: { contains: filter.city, mode: 'insensitive' } }] } : { cityId: null, city: { contains: filter.city, mode: 'insensitive' } }) : {}),
      ...(filter.category ? { category: { equals: filter.category, mode: 'insensitive' } } : {}),
      ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
    };
    const won: Prisma.LeadWhereInput = { ...where, stage: { in: ['CONVERTED', 'ONBOARDING', 'ACTIVATED', 'RETAINED'] } };
    const activatedWhere: Prisma.LeadWhereInput = { ...where, stage: { in: ['ACTIVATED', 'RETAINED'] } };
    const [byStage, stageValue, stageAge, bySource, sourceWon, sourceActivated, byAgent, agentWon, agentActivated, byCity, cityWon, cityActivated, byCategory, categoryWon, categoryActivated, lossMix, sources, converted, totals] = await Promise.all([
      prisma.lead.groupBy({ by: ['stage'], where, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['stage'], where: { ...where, estimatedValue: { not: null } }, _sum: { estimatedValue: true } }),
      prisma.lead.findMany({ where: { ...where, stageChangedAt: { not: null } }, select: { stage: true, stageChangedAt: true }, take: 5000 }),
      prisma.lead.groupBy({ by: ['sourceId'], where, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['sourceId'], where: won, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['sourceId'], where: activatedWhere, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['assignedAgentId'], where: { ...where, assignedAgentId: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['assignedAgentId'], where: { ...won, assignedAgentId: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['assignedAgentId'], where: { ...activatedWhere, assignedAgentId: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['city'], where: { ...where, city: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['city'], where: { ...won, city: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['city'], where: { ...activatedWhere, city: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['category'], where: { ...where, category: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['category'], where: { ...won, category: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['category'], where: { ...activatedWhere, category: { not: null } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['lostReason'], where: { ...where, stage: 'LOST' }, _count: { _all: true } }),
      prisma.leadSource.findMany({ select: { id: true, key: true, label: true } }),
      prisma.lead.findMany({ where: { ...won, convertedAt: { not: null } }, select: { createdAt: true, convertedAt: true, attribution: true }, take: 5000 }),
      Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.count({ where: won }),
        prisma.lead.count({ where: activatedWhere }),
        prisma.lead.count({ where: { ...where, stage: 'RETAINED' } }),
        prisma.lead.count({ where: { ...where, stage: 'LOST' } }),
        prisma.lead.count({ where: { ...where, stage: { not: 'LOST' }, lostReason: { not: null } } }),
      ]),
    ]);
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const valueOf = new Map(stageValue.map((row) => [row.stage, row._sum.estimatedValue]));
    const ageOf = new Map<string, number[]>();
    for (const row of stageAge) {
      if (!row.stageChangedAt) continue;
      const list = ageOf.get(row.stage) ?? [];
      list.push((now - row.stageChangedAt.getTime()) / DAY);
      ageOf.set(row.stage, list);
    }
    const avg = (list: number[] | undefined) => (list && list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
    const sourceLabel = new Map(sources.map((row) => [row.id, row]));
    const fold = <K extends string | null>(all: { [key: string]: unknown; _count: { _all: number } }[], wonRows: typeof all, activatedRows: typeof all, key: string, label?: (k: K) => { key: string; label?: string } | null) => {
      const wonBy = new Map(wonRows.map((row) => [row[key] as K, row._count._all]));
      const activatedBy = new Map(activatedRows.map((row) => [row[key] as K, row._count._all]));
      return all
        .map((row) => {
          const k = row[key] as K;
          const named = label ? label(k) : { key: String(k) };
          return named ? { ...named, total: row._count._all, converted: wonBy.get(k) ?? 0, activated: activatedBy.get(k) ?? 0 } : null;
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((a, b) => b.total - a.total);
    };
    const channels = new Map<string, { firstContact: number; engaged: number; converted: number }>();
    const bump = (channel: string | undefined, moment: 'firstContact' | 'engaged' | 'converted') => {
      if (!channel) return;
      const row = channels.get(channel) ?? { firstContact: 0, engaged: 0, converted: 0 };
      row[moment] += 1;
      channels.set(channel, row);
    };
    const days: number[] = [];
    for (const row of converted) {
      if (row.convertedAt) days.push((row.convertedAt.getTime() - row.createdAt.getTime()) / DAY);
      const attribution = (row.attribution ?? {}) as { firstContact?: { channel: string }; engaged?: { channel: string }; converted?: { channel: string } };
      bump(attribution.firstContact?.channel, 'firstContact');
      bump(attribution.engaged?.channel, 'engaged');
      bump(attribution.converted?.channel, 'converted');
    }
    return {
      byStage: byStage
        .map((row) => ({ stage: row.stage, count: row._count._all, value: valueOf.get(row.stage) ? money(valueOf.get(row.stage) as never) : null, avgDaysInStage: avg(ageOf.get(row.stage)) }))
        .sort((a, b) => a.stage.localeCompare(b.stage)),
      bySource: fold<string | null>(bySource as never, sourceWon as never, sourceActivated as never, 'sourceId', (k) => (k ? { key: sourceLabel.get(k)?.key ?? k, label: sourceLabel.get(k)?.label ?? k } : { key: 'none', label: 'No source' })).map((row) => ({ key: row.key, label: row.label ?? row.key, total: row.total, converted: row.converted, activated: row.activated })),
      byAgent: fold<string | null>(byAgent as never, agentWon as never, agentActivated as never, 'assignedAgentId'),
      byCity: fold<string | null>(byCity as never, cityWon as never, cityActivated as never, 'city'),
      byCategory: fold<string | null>(byCategory as never, categoryWon as never, categoryActivated as never, 'category'),
      byChannel: [...channels.entries()].map(([channel, counts]) => ({ channel, ...counts })).sort((a, b) => b.converted - a.converted),
      lossMix: lossMix.map((row) => ({ reason: (row.lostReason as LeadLostReason | null) ?? 'OTHER', count: row._count._all })).sort((a, b) => b.count - a.count),
      avgDaysToConvert: avg(days),
      totals: { leads: totals[0], converted: totals[1], activated: totals[2], retained: totals[3], lost: totals[4], recycled: totals[5] },
    };
  },

  // ── LH3: feeds, inbound, referrals ─────────────────────────────────────

  findByExternalKeys(keys) {
    if (keys.length === 0) return Promise.resolve([]);
    return prisma.lead.findMany({ where: { externalKey: { in: keys } }, select: { id: true, externalKey: true } });
  },

  countCreatedForSourceSince(sourceId, since) {
    return prisma.lead.count({ where: { sourceId, createdAt: { gte: since } } });
  },

  createFeedRun(data) {
    return prisma.leadFeedRun.create({ data: { ...data, side: data.side as Prisma.LeadFeedRunCreateInput['side'], status: data.status as LeadFeedRunStatus, polygon: (data.polygon ?? Prisma.JsonNull) as Prisma.InputJsonValue } as Prisma.LeadFeedRunUncheckedCreateInput });
  },

  updateFeedRun(id, patch) {
    return prisma.leadFeedRun.update({ where: { id }, data: { ...patch, status: patch.status as LeadFeedRunStatus | undefined, report: patch.report as Prisma.InputJsonValue | undefined } as Prisma.LeadFeedRunUncheckedUpdateInput, include: { source: { select: { key: true, label: true } } } });
  },

  listFeedRuns(sourceId, take) {
    return prisma.leadFeedRun.findMany({ where: sourceId ? { sourceId } : {}, orderBy: { startedAt: 'desc' }, take, include: { source: { select: { key: true, label: true } } } });
  },

  findFeedRun(id) {
    return prisma.leadFeedRun.findUnique({ where: { id }, include: { source: { select: { key: true, label: true } } } });
  },

  async candidateAgents(side, cityId) {
    const role = side === 'ADVERTISER' ? 'AGENT_ADVERTISER' : 'AGENT_PUBLISHER';
    const agents = await prisma.agentProfile.findMany({
      where: {
        status: 'ACTIVE',
        user: { isActive: true, roles: { some: { role: role as never } } },
        ...(cityId ? { cityId } : {}),
      },
      select: { id: true, userId: true, tier: true, cityId: true },
      take: 500,
    });
    if (agents.length === 0) return [];
    const open = await prisma.lead.groupBy({ by: ['assignedAgentId'], where: { assignedAgentId: { in: agents.map((row) => row.id) }, status: { notIn: ['CONVERTED', 'LOST'] } }, _count: { _all: true } });
    const openBy = new Map(open.map((row) => [row.assignedAgentId, row._count._all]));
    return agents.map((row) => ({ id: row.id, userId: row.userId, tier: row.tier, cityId: row.cityId, openLeads: openBy.get(row.id) ?? 0 }));
  },

  findListingPoint(listingId) {
    return prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, title: true, locality: true, city: true, cityId: true, latitude: true, longitude: true, publisherId: true } });
  },

  async findAgentBrief(agentId) {
    const row = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { id: true, userId: true, city: true, cityId: true, user: { select: { roles: { select: { role: true } } } } } });
    if (!row) return null;
    const roles = row.user.roles.map((r) => String(r.role));
    const sides = [...(roles.includes('AGENT_PUBLISHER') ? ['PUBLISHER'] : []), ...(roles.includes('AGENT_ADVERTISER') ? ['ADVERTISER'] : [])];
    return { id: row.id, userId: row.userId, city: row.city, cityId: row.cityId, sides };
  },

  findReferralLink(referrerKind, referrerId) {
    return prisma.referralLink.findUnique({ where: { referrerKind_referrerId: { referrerKind: referrerKind as ReferrerKind, referrerId } } });
  },

  findReferralLinkByCode(code) {
    return prisma.referralLink.findUnique({ where: { code } });
  },

  createReferralLink(data) {
    return prisma.referralLink.create({ data: { referrerKind: data.referrerKind as ReferrerKind, referrerId: data.referrerId, code: data.code } });
  },

  createReferral(data) {
    return prisma.leadReferral.create({ data: { linkId: data.linkId, referrerKind: data.referrerKind as ReferrerKind, referrerId: data.referrerId, leadId: data.leadId } });
  },

  findReferralForLead(leadId) {
    return prisma.leadReferral.findUnique({ where: { leadId }, include: { link: true } });
  },

  listReferralsBy(referrerKind, referrerId) {
    return prisma.leadReferral.findMany({ where: { referrerKind: referrerKind as ReferrerKind, referrerId }, orderBy: { createdAt: 'desc' }, include: { lead: true }, take: 200 });
  },

  listReferrals(take) {
    return prisma.leadReferral.findMany({ orderBy: { createdAt: 'desc' }, include: { lead: true }, take });
  },

  markReferralCredited(id, data) {
    return prisma.leadReferral.update({ where: { id }, data: { creditAmount: data.creditAmount, creditedAt: data.creditedAt, walletEntryId: data.walletEntryId } });
  },

  async referrerLabel(referrerKind, referrerId) {
    if (referrerKind === 'PUBLISHER') {
      const row = await prisma.publisher.findUnique({ where: { id: referrerId }, select: { name: true, mobile: true } });
      return row ? { name: row.name, mobile: row.mobile } : null;
    }
    if (referrerKind === 'ADVERTISER') {
      const row = await prisma.advertiser.findUnique({ where: { id: referrerId }, select: { companyName: true, name: true, mobile: true } });
      return row ? { name: row.companyName ?? row.name ?? referrerId, mobile: row.mobile } : null;
    }
    const row = await prisma.agentProfile.findUnique({ where: { id: referrerId }, select: { displayId: true, user: { select: { name: true, mobile: true } } } });
    return row ? { name: row.user.name ?? row.displayId ?? referrerId, mobile: row.user.mobile } : null;
  },

  findOpenNear(point, radiusM, side) {
    return prisma.lead.findMany({
      where: { side: side as Prisma.LeadWhereInput['side'], status: { notIn: ['CONVERTED', 'LOST'] }, ...boxMetres(point, radiusM) },
      take: 50,
    });
  },

  // ── LH5: the map, territories, zones, claims ────────────────────────────

  findOpenInBBox(box, facets, take) {
    return prisma.lead.findMany({
      where: {
        status: { notIn: ['CONVERTED', 'LOST'] },
        latitude: { gte: box.south, lte: box.north },
        longitude: { gte: box.west, lte: box.east },
        ...(facets.side ? { side: facets.side as LeadSide } : {}),
        ...(facets.temperature ? { temperature: facets.temperature as LeadTemperature } : {}),
        ...(facets.category ? { category: { equals: facets.category, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take,
    });
  },

  async liveListingPoints(box, take) {
    const rows = await prisma.listing.findMany({
      where: { ...LIVE_LISTING, latitude: { gte: box.south, lte: box.north }, longitude: { gte: box.west, lte: box.east } },
      select: { latitude: true, longitude: true },
      take,
    });
    return rows.filter((row): row is { latitude: number; longitude: number } => row.latitude !== null && row.longitude !== null);
  },

  async demandPoints(box, since, take) {
    const rows = await prisma.order.findMany({
      where: { createdAt: { gte: since }, status: { notIn: ['DRAFT', 'CANCELLED'] }, listing: { latitude: { gte: box.south, lte: box.north }, longitude: { gte: box.west, lte: box.east } } },
      select: { listing: { select: { latitude: true, longitude: true } } },
      take,
    });
    return rows.map((row) => row.listing).filter((row): row is { latitude: number; longitude: number } => row.latitude !== null && row.longitude !== null);
  },

  createTerritory(data) {
    return prisma.territory.create({ data: { ...data, side: data.side as LeadSide, polygon: data.polygon as Prisma.InputJsonValue } });
  },

  updateTerritory(id, patch) {
    return prisma.territory.update({ where: { id }, data: { ...patch, polygon: patch.polygon as Prisma.InputJsonValue | undefined } });
  },

  findTerritory(id) {
    return prisma.territory.findUnique({ where: { id } });
  },

  async listTerritories(filter) {
    const rows = await prisma.territory.findMany({ where: filter.activeOnly ? { isActive: true } : {}, orderBy: { createdAt: 'desc' }, include: { _count: { select: { leads: true } } } });
    return rows.map(({ _count, ...row }) => ({ ...row, leadCount: _count.leads }));
  },

  territoriesCovering(point, side) {
    return prisma.territory.findMany({
      where: { isActive: true, side: side as LeadSide, south: { lte: point.latitude }, north: { gte: point.latitude }, west: { lte: point.longitude }, east: { gte: point.longitude } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  },

  createZone(data) {
    return prisma.priorityZone.create({ data: { ...data, side: (data.side as LeadSide | null) ?? null, polygon: (data.polygon ?? Prisma.JsonNull) as Prisma.InputJsonValue } });
  },

  updateZone(id, patch) {
    return prisma.priorityZone.update({ where: { id }, data: patch as Prisma.PriorityZoneUncheckedUpdateInput });
  },

  findZone(id) {
    return prisma.priorityZone.findUnique({ where: { id } });
  },

  listZones(filter = {}) {
    return prisma.priorityZone.findMany({
      where: filter.activeAt ? { isActive: true, startsAt: { lte: filter.activeAt }, endsAt: { gte: filter.activeAt } } : {},
      orderBy: { startsAt: 'desc' },
    });
  },

  async addZoneSpend(id, amount) {
    await prisma.priorityZone.update({ where: { id }, data: { spent: { increment: amount } } });
  },

  async priorityTopUpsSince(since) {
    const aggregate = await prisma.agentIncentive.aggregate({ where: { event: 'LEAD_ACTIVATED', orderId: { startsWith: 'priority:' }, createdAt: { gte: since }, status: { not: 'REJECTED' } }, _sum: { amount: true } });
    return aggregate._sum.amount === null ? 0 : Number(aggregate._sum.amount);
  },

  async priorityTopUpPaid(leadId) {
    const row = await prisma.agentIncentive.findFirst({ where: { event: 'LEAD_ACTIVATED', orderId: { startsWith: 'priority:', endsWith: `:${leadId}` }, status: { not: 'REJECTED' } }, select: { id: true } });
    return row !== null;
  },

  createClaim(data) {
    return prisma.leadClaim.create({ data });
  },

  async closeOpenClaims(leadId, at, reason) {
    const result = await prisma.leadClaim.updateMany({ where: { leadId, releasedAt: null }, data: { releasedAt: at, reason } });
    return result.count;
  },

  claimsExpiredBefore(at, take) {
    return prisma.leadClaim.findMany({ where: { releasedAt: null, expiresAt: { lte: at } }, orderBy: { expiresAt: 'asc' }, take });
  },

  claimsExpiringBetween(from, to, take) {
    return prisma.leadClaim.findMany({ where: { releasedAt: null, expiresAt: { gt: from, lte: to } }, orderBy: { expiresAt: 'asc' }, take });
  },

  async lastLapsedClaim(leadId, agentId) {
    const row = await prisma.leadClaim.findFirst({ where: { leadId, agentId, reason: 'lapsed' }, orderBy: { releasedAt: 'desc' }, select: { releasedAt: true } });
    return row?.releasedAt ?? null;
  },

  countOpenFor(agentId) {
    return prisma.lead.count({ where: { status: { notIn: ['CONVERTED', 'LOST'] }, OR: [{ assignedAgentId: agentId }, { claimedByAgentId: agentId }] } });
  },

  async partyOfUser(userId) {
    const [publisher, advertiser, agent] = await Promise.all([
      prisma.publisher.findFirst({ where: { userId }, select: { id: true } }),
      prisma.advertiser.findFirst({ where: { userId }, select: { id: true } }),
      prisma.agentProfile.findUnique({ where: { userId }, select: { id: true } }),
    ]);
    if (publisher) return { kind: 'PUBLISHER', id: publisher.id };
    if (advertiser) return { kind: 'ADVERTISER', id: advertiser.id };
    if (agent) return { kind: 'AGENT', id: agent.id };
    return null;
  },

  listSources() {
    return prisma.leadSource.findMany({ orderBy: [{ kind: 'asc' }, { label: 'asc' }] });
  },

  findSourceByKey(key) {
    return prisma.leadSource.findUnique({ where: { key } });
  },

  createSource(data) {
    return prisma.leadSource.create({ data: { key: data.key, kind: data.kind as LeadSourceKind, label: data.label, ...(data.quality !== undefined ? { quality: data.quality } : {}) } });
  },

  updateSource(id, patch) {
    return prisma.leadSource.update({ where: { id }, data: patch as Prisma.LeadSourceUncheckedUpdateInput });
  },

  findCommsTemplate(key) {
    return prisma.notificationTemplate.findFirst({ where: { key, status: 'ACTIVE' }, select: { key: true, subject: true, emailBody: true, smsBody: true, pushBody: true, channels: true } });
  },

  async attributionCounts(from, to, side) {
    // A stamp is written on the row when the moment happens, so a row untouched since `from` carries no moment in the window.
    const rows = await prisma.lead.findMany({ where: { attribution: { not: Prisma.DbNull }, updatedAt: { gte: from }, ...(side ? { side: side as LeadSide } : {}) }, select: { attribution: true } });
    const counts = new Map<string, { channel: string; firstContact: number; engaged: number; converted: number }>();
    const bump = (moment: { channel?: string; at?: string } | undefined, key: 'firstContact' | 'engaged' | 'converted') => {
      if (!moment?.channel || !moment.at) return;
      const at = new Date(moment.at);
      if (!(at >= from && at < to)) return;
      const row = counts.get(moment.channel) ?? { channel: moment.channel, firstContact: 0, engaged: 0, converted: 0 };
      row[key] += 1;
      counts.set(moment.channel, row);
    };
    for (const row of rows) {
      const attribution = (row.attribution ?? {}) as { firstContact?: { channel?: string; at?: string }; engaged?: { channel?: string; at?: string }; converted?: { channel?: string; at?: string } };
      bump(attribution.firstContact, 'firstContact');
      bump(attribution.engaged, 'engaged');
      bump(attribution.converted, 'converted');
    }
    return [...counts.values()];
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
