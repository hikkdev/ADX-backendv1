import { Prisma, prisma } from '../../shared/database';
import type { CityStage } from '../../shared/database';
import { listArgs } from '../../shared/pagination';
import type { CityStageValue } from '../pricing';
import type {
  CityCounts,
  CityMatch,
  CityKey,
  CityListFilter,
  GeoCityPatch,
  GeoCityRow,
  GeoDistrictRow,
  GeoRepository,
  GeoStateRow,
  LiveListingRef,
  ListingPoint,
  MapBounds,
  MapPoint,
  NewGeoCity,
  NewGeoDistrict,
  NewGeoState,
  NewRolloutEvent,
  RolloutEventRow,
  StageCounts,
} from './geo.repository';
import { CITY_STAGES } from '../pricing';

/** The note the wind-down writes on its marker event — see `winddown.service.ts`. */
export const WIND_DOWN_MARK = 'WIND_DOWN_DONE';

const CITY_SELECT = {
  id: true,
  slug: true,
  name: true,
  state: true,
  aliases: true,
  isActive: true,
  stateId: true,
  districtId: true,
  latitude: true,
  longitude: true,
  population: true,
  kind: true,
  geonameId: true,
  source: true,
  stage: true,
  supplyIntake: true,
  publishing: true,
  demand: true,
  agentOnboarding: true,
  printPartners: true,
  leadFeeds: true,
  launchedAt: true,
  pausedAt: true,
  withdrawnAt: true,
  rolloutNote: true,
  geoState: { select: { code: true, name: true } },
  geoDistrict: { select: { code: true, name: true } },
} satisfies Prisma.CitySelect;

type CitySelected = Prisma.CityGetPayload<{ select: typeof CITY_SELECT }>;

function toRow(row: CitySelected): GeoCityRow {
  const { supplyIntake, publishing, demand, agentOnboarding, printPartners, leadFeeds, ...rest } = row;
  return {
    ...rest,
    kind: rest.kind as GeoCityRow['kind'],
    source: rest.source as GeoCityRow['source'],
    switches: { supplyIntake, publishing, demand, agentOnboarding, printPartners, leadFeeds },
  };
}

function toData(patch: GeoCityPatch): Prisma.CityUncheckedUpdateInput {
  const { switches, ...rest } = patch;
  return { ...rest, ...(switches ?? {}) };
}

function emptyCounts(): StageCounts {
  const counts = {} as StageCounts;
  for (const stage of CITY_STAGES) counts[stage] = 0;
  return counts;
}

/** `city IN (...)`, case-insensitively, over a free-text column. */
const cityIn = (spellings: string[]) => ({ in: spellings, mode: 'insensitive' as const });
/**
 * Lot X-B: a party row is the city's when its key says so, or — for a row
 * whose key is null (a typed town, or a row from before an alias was
 * taught) — when its free-text city is one of the city's spellings.
 */
const inCity = (city: CityMatch) => ({
  OR: [{ cityId: city.cityId }, ...(city.spellings.length ? [{ cityId: null, city: cityIn(city.spellings) }] : [])],
});

function listWhere(filter: CityListFilter, withStage: boolean): Prisma.CityWhereInput {
  const where: Prisma.CityWhereInput = {};
  if (filter.stateId) where.stateId = filter.stateId;
  if (filter.districtId) where.districtId = filter.districtId;
  if (withStage && filter.stage && filter.stage.length > 0) where.stage = { in: [...filter.stage] as CityStage[] };
  if (filter.kind && filter.kind.length > 0) where.kind = { in: [...filter.kind] };
  if (filter.minPopulation !== undefined) where.population = { gte: filter.minPopulation };
  if (filter.q) {
    const key = filter.q.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    where.OR = [
      { name: { contains: filter.q, mode: 'insensitive' } },
      ...(key ? [{ aliases: { has: key } }, { slug: { startsWith: key } }] : []),
    ];
  }
  return where;
}

export const prismaGeoRepository: GeoRepository = {
  /* ── states and districts ─────────────────────────────────────── */

  listStates(): Promise<GeoStateRow[]> {
    return prisma.geoState.findMany({ orderBy: { name: 'asc' } });
  },

  findStateByCode(code: string): Promise<GeoStateRow | null> {
    return prisma.geoState.findUnique({ where: { code } });
  },

  async createStates(rows: NewGeoState[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await prisma.geoState.createMany({ data: rows, skipDuplicates: true });
    return count;
  },

  async updateState(id: string, patch: Partial<NewGeoState>): Promise<void> {
    await prisma.geoState.update({ where: { id }, data: patch });
  },

  listDistricts(stateId?: string): Promise<GeoDistrictRow[]> {
    return prisma.geoDistrict.findMany({ where: stateId ? { stateId } : {}, orderBy: { name: 'asc' } });
  },

  findDistrict(id: string): Promise<GeoDistrictRow | null> {
    return prisma.geoDistrict.findUnique({ where: { id } });
  },

  async createDistricts(rows: NewGeoDistrict[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await prisma.geoDistrict.createMany({ data: rows, skipDuplicates: true });
    return count;
  },

  async updateDistrict(id: string, patch: Partial<NewGeoDistrict>): Promise<void> {
    await prisma.geoDistrict.update({ where: { id }, data: patch });
  },

  /* ── cities ───────────────────────────────────────────────────── */

  async listCityKeys(): Promise<CityKey[]> {
    const rows = await prisma.city.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        state: true,
        aliases: true,
        stateId: true,
        districtId: true,
        latitude: true,
        longitude: true,
        population: true,
        kind: true,
        geonameId: true,
        source: true,
      },
    });
    return rows.map((row) => ({ ...row, kind: row.kind as CityKey['kind'], source: row.source as CityKey['source'] }));
  },

  async createCities(rows: NewGeoCity[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await prisma.city.createMany({
      data: rows.map(({ switches, ...rest }) => ({ ...rest, ...switches })),
      skipDuplicates: true,
    });
    return count;
  },

  async updateCity(id: string, patch: GeoCityPatch): Promise<GeoCityRow> {
    return toRow(await prisma.city.update({ where: { id }, data: toData(patch), select: CITY_SELECT }));
  },

  async updateCities(updates: { id: string; patch: GeoCityPatch }[]): Promise<number> {
    if (updates.length === 0) return 0;
    await prisma.$transaction(updates.map(({ id, patch }) => prisma.city.update({ where: { id }, data: toData(patch), select: { id: true } })));
    return updates.length;
  },

  async findCityBySlug(slug: string): Promise<GeoCityRow | null> {
    const row = await prisma.city.findUnique({ where: { slug }, select: CITY_SELECT });
    return row ? toRow(row) : null;
  },

  async findCitiesBySlugs(slugs: string[]): Promise<GeoCityRow[]> {
    if (slugs.length === 0) return [];
    const rows = await prisma.city.findMany({ where: { slug: { in: slugs } }, select: CITY_SELECT });
    return rows.map(toRow);
  },

  async findCitiesIn(scope: { stateId?: string; districtId?: string }): Promise<GeoCityRow[]> {
    const rows = await prisma.city.findMany({
      where: { ...(scope.stateId ? { stateId: scope.stateId } : {}), ...(scope.districtId ? { districtId: scope.districtId } : {}) },
      select: CITY_SELECT,
      orderBy: { population: 'desc' },
    });
    return rows.map(toRow);
  },

  async listCities(filter: CityListFilter): Promise<{ items: GeoCityRow[]; total: number; counts: StageCounts }> {
    const where = listWhere(filter, true);
    const orderBy: Prisma.CityOrderByWithRelationInput[] =
      filter.sort === 'name' ? [{ name: 'asc' }, { population: 'desc' }] : [{ population: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }];
    const [items, total, groups] = await Promise.all([
      prisma.city.findMany({ where, select: CITY_SELECT, orderBy, ...listArgs(filter) }),
      prisma.city.count({ where }),
      prisma.city.groupBy({ by: ['stage'], where: listWhere(filter, false), _count: { _all: true } }),
    ]);
    const counts = emptyCounts();
    for (const group of groups) counts[group.stage] = group._count._all;
    return { items: items.map(toRow), total, counts };
  },

  async stageCounts(): Promise<StageCounts> {
    const groups = await prisma.city.groupBy({ by: ['stage'], _count: { _all: true } });
    const counts = emptyCounts();
    for (const group of groups) counts[group.stage] = group._count._all;
    return counts;
  },

  async stageCountsByState() {
    const groups = await prisma.city.groupBy({ by: ['stateId', 'stage'], where: { stateId: { not: null } }, _count: { _all: true } });
    return groups.map((group) => ({ stateId: group.stateId!, stage: group.stage, count: group._count._all }));
  },

  async stageCountsByDistrict(stateId: string) {
    const groups = await prisma.city.groupBy({ by: ['districtId', 'stage'], where: { stateId, districtId: { not: null } }, _count: { _all: true } });
    return groups.map((group) => ({ districtId: group.districtId!, stage: group.stage, count: group._count._all }));
  },

  async mapPoints(bounds: MapBounds | null, stages: readonly CityStageValue[] | null): Promise<MapPoint[]> {
    const rows = await prisma.city.findMany({
      where: {
        latitude: bounds ? { gte: bounds.minLat, lte: bounds.maxLat } : { not: null },
        longitude: bounds ? { gte: bounds.minLng, lte: bounds.maxLng } : { not: null },
        ...(stages && stages.length > 0 ? { stage: { in: [...stages] as CityStage[] } } : {}),
      },
      select: { id: true, slug: true, name: true, stage: true, latitude: true, longitude: true, population: true, kind: true },
      orderBy: { population: { sort: 'desc', nulls: 'last' } },
      take: 5000,
    });
    return rows.map((row) => ({ ...row, kind: row.kind as MapPoint['kind'] }));
  },

  async pickerCities(input): Promise<GeoCityRow[]> {
    const key = input.q ? input.q.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
    const stageClause: Prisma.CityWhereInput[] = [{ stage: { in: [...input.stages] as CityStage[] } }];
    if (input.plannedCapitals) stageClause.push({ stage: 'PLANNED', kind: { in: ['NATIONAL_CAPITAL', 'STATE_CAPITAL'] } });
    const rows = await prisma.city.findMany({
      where: {
        AND: [
          { OR: stageClause },
          ...(input.q ? [{ OR: [{ name: { startsWith: input.q, mode: 'insensitive' as const } }, ...(key ? [{ aliases: { has: key } }] : [])] }] : []),
        ],
      },
      select: CITY_SELECT,
      orderBy: { population: { sort: 'desc', nulls: 'last' } },
      take: input.limit,
    });
    return rows.map(toRow);
  },

  /* ── events ───────────────────────────────────────────────────── */

  async createRolloutEvents(events: NewRolloutEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const { count } = await prisma.cityRolloutEvent.createMany({
      data: events.map((event) => ({ ...event, flags: event.flags as Prisma.InputJsonObject })),
    });
    return count;
  },

  listRolloutEvents(cityId: string, limit: number): Promise<RolloutEventRow[]> {
    return prisma.cityRolloutEvent.findMany({ where: { cityId }, orderBy: { at: 'desc' }, take: limit });
  },

  async withdrawnCities() {
    const rows = await prisma.city.findMany({
      where: { stage: 'WITHDRAWN' },
      select: { ...CITY_SELECT, rolloutEvents: { where: { note: WIND_DOWN_MARK }, orderBy: { at: 'desc' }, take: 1, select: { at: true } } },
    });
    return rows.map(({ rolloutEvents, ...row }) => ({ city: toRow(row), woundDownAt: rolloutEvents[0]?.at ?? null }));
  },

  /* ── read-only aggregates ─────────────────────────────────────── */

  async cityCounts(city: CityMatch): Promise<CityCounts> {
    const where = inCity(city);
    const [publishers, listingsLive, listingsTotal, advertisers, agents, printPartners, openLeads] = await Promise.all([
      prisma.publisher.count({ where }),
      prisma.listing.count({ where: { ...where, status: 'ACTIVE' } }),
      prisma.listing.count({ where }),
      prisma.advertiser.count({ where }),
      prisma.agentProfile.count({ where: { ...where, status: 'ACTIVE' } }),
      prisma.printPartner.count({ where: { ...where, isActive: true } }),
      prisma.lead.count({ where: { ...where, status: { notIn: ['CONVERTED', 'LOST'] } } }),
    ]);
    return { publishers, listingsLive, listingsTotal, advertisers, agents, printPartners, openLeads };
  },

  async liveListingsByCity(cities: CityMatch[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (cities.length === 0) return out;
    // By key first; then the rows with no key, folded onto the city whose spelling they carry.
    const byKey = await prisma.listing.groupBy({ by: ['cityId'], where: { cityId: { in: cities.map((city) => city.cityId) }, status: 'ACTIVE' }, _count: { _all: true } });
    for (const group of byKey) if (group.cityId) out.set(group.cityId, (out.get(group.cityId) ?? 0) + group._count._all);
    const idBySpelling = new Map<string, string>();
    for (const city of cities) for (const spelling of city.spellings) if (!idBySpelling.has(spelling.toLowerCase())) idBySpelling.set(spelling.toLowerCase(), city.cityId);
    if (idBySpelling.size === 0) return out;
    const typed = await prisma.listing.groupBy({ by: ['city'], where: { cityId: null, city: cityIn([...idBySpelling.keys()]), status: 'ACTIVE' }, _count: { _all: true } });
    for (const group of typed) {
      const id = group.city ? idBySpelling.get(group.city.toLowerCase()) : undefined;
      if (id) out.set(id, (out.get(id) ?? 0) + group._count._all);
    }
    return out;
  },

  async rateCardInForce(cityId: string, on: Date) {
    const card = await prisma.rateCard.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [{ cityId }, { cityId: null }],
        AND: [{ OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: on } }] }, { OR: [{ effectiveTo: null }, { effectiveTo: { gt: on } }] }],
      },
      // The city's own card first, then a national one.
      orderBy: [{ cityId: { sort: 'desc', nulls: 'last' } }, { effectiveFrom: 'desc' }],
      select: { id: true, name: true, cityId: true },
    });
    return card ? { cardId: card.id, name: card.name, national: card.cityId === null } : null;
  },

  async activeAgentsBySide(city: CityMatch) {
    const where = inCity(city);
    const [publisher, advertiser] = await Promise.all([
      prisma.agentProfile.count({ where: { ...where, status: 'ACTIVE', user: { isActive: true, roles: { some: { role: 'AGENT_PUBLISHER' } } } } }),
      prisma.agentProfile.count({ where: { ...where, status: 'ACTIVE', user: { isActive: true, roles: { some: { role: 'AGENT_ADVERTISER' } } } } }),
    ]);
    return { publisher, advertiser };
  },

  activePrintPartners(city: CityMatch): Promise<number> {
    return prisma.printPartner.count({ where: { ...inCity(city), isActive: true, activatedAt: { not: null } } });
  },

  async vocabularyPresent(): Promise<boolean> {
    return (await prisma.mediaType.count({ where: { mergedIntoId: null } })) > 0;
  },

  async activeListings(city: CityMatch): Promise<LiveListingRef[]> {
    const rows = await prisma.listing.findMany({
      where: { ...inCity(city), status: 'ACTIVE' },
      select: { id: true, title: true, publisher: { select: { userId: true } } },
    });
    return rows.map((row) => ({ id: row.id, title: row.title, publisherUserId: row.publisher?.userId ?? null }));
  },

  async listingPoints(city: CityMatch): Promise<ListingPoint[]> {
    return prisma.listing.findMany({
      where: { ...inCity(city), status: 'ACTIVE' },
      select: { id: true, latitude: true, longitude: true },
    });
  },

  async agentUserIds(city: CityMatch): Promise<string[]> {
    const rows = await prisma.agentProfile.findMany({ where: { ...inCity(city), status: 'ACTIVE' }, select: { userId: true } });
    return rows.map((row) => row.userId);
  },
};
