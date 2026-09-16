import { Prisma, prisma } from '../../shared/database';
import type {
  ListingCategory,
  MarketDataSource,
  MediaType,
  MediaTypeMatchOutcome,
  Material,
  OrderStatus,
  PricingFactor,
  PricingFactorKind,
  PricingFactorMode,
  PricingSettings,
  ScraperRun,
  ScraperRunStatus,
  ScraperSource,
  SizeClass,
  SurgeEvent,
  VenueType,
  VocabularyKind,
} from '../../shared/database';
import type {
  CityKeyedTable,
  CityRow,
  Comparable,
  ComparableQuery,
  MediaTypeDetail,
  FactorApplication,
  ListingPricingContext,
  MediaTypePatch,
  Money,
  NewMarketDataPoint,
  NewMediaType,
  NewScraperSource,
  NewSizeClass,
  NewSurgeEvent,
  PricingRepository,
  UnresolvedCityString,
} from './pricing.repository';

const D = Prisma.Decimal;
const money = (value: Prisma.Decimal | number | string): Money => new D(value).toFixed(2);

/**
 * Orders that count as a price having been tested by the market.
 *
 * A cancelled order proves nothing about the rate — somebody changed their
 * mind, which is not the same as nobody being willing to pay. A rejected one
 * proves less than nothing.
 *
 * Deliberately narrow. Earlier states like SLOT_CONFIRMED are cheap to reach,
 * and three of them inside one 200 m circle discards the research-derived range
 * entirely (see pickTier). Requiring the campaign to have actually run means
 * gaming the local market rate costs a publisher three real campaigns rather
 * than three arrangements with a friend.
 */
const VALIDATING_ORDER_STATUSES: OrderStatus[] = ['IN_PROGRESS', 'COMPLETED'];

const SETTINGS_ID = 'default';

/**
 * Two decimal places on the way out, always.
 *
 * A Decimal serialises to whatever string it happens to hold, so the same
 * amount reached the console as "1200.5" from one endpoint and "1200.50" from
 * another. A client comparing them gets a false negative, and the bug looks
 * like a pricing error rather than a formatting one.
 */
function normaliseFactor(row: PricingFactor): PricingFactor {
  return {
    ...row,
    baseAdjust: row.baseAdjust === null ? null : (new D(money(row.baseAdjust)) as never),
  };
}

/**
 * The media type as every read answers it — the row with the ids of the sizes
 * and materials it comes in. T-B: the create and the patch answer it too, the
 * same include on the write, so the vocabulary screen updates its row from
 * the answer.
 */
const mediaTypeDetailInclude = {
  sizeClasses: { select: { sizeClassId: true } },
  materials: { select: { materialId: true } },
} satisfies Prisma.MediaTypeInclude;

function toMediaTypeDetail(
  row: MediaType & { sizeClasses: { sizeClassId: string }[]; materials: { materialId: string }[] },
): MediaTypeDetail {
  const { sizeClasses, materials, ...rest } = row;
  return {
    ...rest,
    sizeClassIds: sizeClasses.map((link) => link.sizeClassId),
    materialIds: materials.map((link) => link.materialId),
  };
}

/**
 * Lot V: the columns a city row carries out of this module — the resolver's
 * three, the mirror, and the rollout stage with its six switches.
 */
const CITY_SELECT = {
  id: true,
  slug: true,
  name: true,
  state: true,
  aliases: true,
  isActive: true,
  stage: true,
  population: true,
  supplyIntake: true,
  publishing: true,
  demand: true,
  agentOnboarding: true,
  printPartners: true,
  leadFeeds: true,
} as const;

type CitySelected = {
  id: string;
  slug: string;
  name: string;
  state: string | null;
  aliases: string[];
  isActive: boolean;
  stage: CityRow['stage'];
  population: number | null;
  supplyIntake: boolean;
  publishing: boolean;
  demand: boolean;
  agentOnboarding: boolean;
  printPartners: boolean;
  leadFeeds: boolean;
};

function toCityRow(row: CitySelected): CityRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state,
    aliases: row.aliases,
    isActive: row.isActive,
    stage: row.stage,
    population: row.population,
    switches: {
      supplyIntake: row.supplyIntake,
      publishing: row.publishing,
      demand: row.demand,
      agentOnboarding: row.agentOnboarding,
      printPartners: row.printPartners,
      leadFeeds: row.leadFeeds,
    },
  };
}

export const prismaPricingRepository: PricingRepository = {
  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  async getSettings(): Promise<PricingSettings | null> {
    return prisma.pricingSettings.findUnique({ where: { id: SETTINGS_ID } });
  },

  async updateSettings(
    patch: Record<string, unknown>,
    userId: string | null
  ): Promise<PricingSettings> {
    return prisma.pricingSettings.upsert({
      where: { id: SETTINGS_ID },
      // The row is seeded by migration; the create arm exists so a fresh
      // database that skipped the seed still resolves rather than 500ing.
      create: { id: SETTINGS_ID, ...patch, updatedById: userId },
      update: { ...patch, updatedById: userId },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Vocabularies                                                      */
  /* ---------------------------------------------------------------- */

  async listMediaTypes(includeMerged = false): Promise<MediaTypeDetail[]> {
    const rows = await prisma.mediaType.findMany({
      where: includeMerged ? {} : { status: 'ACTIVE' },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: mediaTypeDetailInclude,
    });
    return rows.map(toMediaTypeDetail);
  },

  /**
   * Replaces the whole set rather than adding to it.
   *
   * A form that shows six ticked sizes and saves a seventh has to be able to
   * express "now five", and a merge-only write cannot. Deleting and re-creating
   * inside one transaction is what makes the screen mean what it shows.
   */
  async setMediaTypeAttributes(
    id: string,
    attributes: { sizeClassIds?: string[]; materialIds?: string[] }
  ): Promise<MediaTypeDetail> {
    await prisma.$transaction(async (tx) => {
      if (attributes.sizeClassIds) {
        await tx.mediaTypeSizeClass.deleteMany({ where: { mediaTypeId: id } });
        if (attributes.sizeClassIds.length > 0) {
          await tx.mediaTypeSizeClass.createMany({
            data: attributes.sizeClassIds.map((sizeClassId) => ({ mediaTypeId: id, sizeClassId })),
          });
        }
      }
      if (attributes.materialIds) {
        await tx.mediaTypeMaterial.deleteMany({ where: { mediaTypeId: id } });
        if (attributes.materialIds.length > 0) {
          await tx.mediaTypeMaterial.createMany({
            data: attributes.materialIds.map((materialId) => ({ mediaTypeId: id, materialId })),
          });
        }
      }
    });

    return toMediaTypeDetail(await prisma.mediaType.findUniqueOrThrow({ where: { id }, include: mediaTypeDetailInclude }));
  },

  async findMediaType(id: string): Promise<MediaType | null> {
    return prisma.mediaType.findUnique({ where: { id } });
  },

  async findMediaTypeBySlug(slug: string): Promise<MediaType | null> {
    return prisma.mediaType.findUnique({ where: { slug } });
  },

  async createMediaType(data: NewMediaType): Promise<MediaTypeDetail> {
    const row = await prisma.mediaType.create({
      include: mediaTypeDetailInclude,
      data: {
        name: data.name,
        slug: data.slug,
        category: data.category,
        description: data.description ?? null,
        venueTypeId: data.venueTypeId ?? null,
        formatGroup: data.formatGroup ?? null,
        origin: data.origin ?? 'OPS',
        ...(data.sizeClassIds?.length
          ? { sizeClasses: { create: data.sizeClassIds.map((sizeClassId) => ({ sizeClassId })) } }
          : {}),
        ...(data.materialIds?.length
          ? { materials: { create: data.materialIds.map((materialId) => ({ materialId })) } }
          : {}),
      },
    });
    return toMediaTypeDetail(row);
  },

  async updateMediaType(id: string, patch: MediaTypePatch): Promise<MediaTypeDetail> {
    // Status is deliberately not patchable here — see MediaTypePatch.
    return toMediaTypeDetail(await prisma.mediaType.update({ where: { id }, data: patch, include: mediaTypeDetailInclude }));
  },

  /**
   * One transaction, because a half-merged taxonomy is worse than an unmerged
   * one: listings pointing at a tombstone would drop out of every comparable
   * set with nothing to explain why.
   */
  async mergeMediaTypes(sourceId: string, targetId: string): Promise<MediaType> {
    return prisma.$transaction(async (tx) => {
      await tx.listing.updateMany({
        where: { mediaTypeId: sourceId },
        data: { mediaTypeId: targetId },
      });
      await tx.marketDataPoint.updateMany({
        where: { mediaTypeId: sourceId },
        data: { mediaTypeId: targetId },
      });
      // Factors are per media type and keyed by slug within it. Ones whose slug
      // already exists on the target are dropped rather than renamed — the
      // target's own definition is the one ops curated.
      const targetSlugs = new Set(
        (await tx.pricingFactor.findMany({ where: { mediaTypeId: targetId } })).map((f) => f.slug)
      );
      const moving = await tx.pricingFactor.findMany({ where: { mediaTypeId: sourceId } });
      for (const factor of moving) {
        if (targetSlugs.has(factor.slug)) {
          await tx.pricingFactor.delete({ where: { id: factor.id } });
        } else {
          await tx.pricingFactor.update({
            where: { id: factor.id },
            data: { mediaTypeId: targetId },
          });
        }
      }
      return tx.mediaType.update({
        where: { id: sourceId },
        data: { status: 'MERGED', mergedIntoId: targetId, mergedAt: new Date() },
      });
    });
  },

  async listSizeClasses(includeInactive = false): Promise<SizeClass[]> {
    return prisma.sizeClass.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  },

  async findSizeClass(id: string): Promise<SizeClass | null> {
    return prisma.sizeClass.findUnique({ where: { id } });
  },

  /**
   * The class for exactly these dimensions, minting one if it is new.
   *
   * The slug is the dimensions themselves, which makes the lookup the identity:
   * two spots measured at 6 by 4 land on the same class without anybody
   * curating a list, and a spot measured at 6 by 4.5 gets its own rather than
   * being rounded into a comparison it does not belong in.
   */
  async resolveSizeClassForDimensions(
    widthFt: string,
    heightFt: string,
    tolerancePct: string
  ): Promise<SizeClass> {
    const width = new D(widthFt);
    const height = new D(heightFt);
    const slug = `${width.toString()}x${height.toString()}`;

    // The near-miss pass, before the exact one. A class within tolerance on
    // *both* dimensions is this spot's class: the industry builds to standard
    // sizes, so a 20 x 10.5 is a 20 x 10 measured with a tape, and filing it
    // separately would put an identical spot in a pool of one.
    //
    // Bounded in SQL first so this reads a handful of rows rather than the whole
    // table; the comparison itself is decimal, because the whole point of these
    // columns is that they are not floats.
    const tolerance = new D(tolerancePct);
    const one = new D(1);
    const near = await prisma.sizeClass.findMany({
      where: {
        isActive: true,
        widthFt: {
          gte: width.times(one.minus(tolerance)),
          lte: width.times(one.plus(tolerance)),
        },
        heightFt: {
          gte: height.times(one.minus(tolerance)),
          lte: height.times(one.plus(tolerance)),
        },
      },
      // Deterministic. Two classes can both be within tolerance, and the same
      // measurement must not land in different pools on different days.
      orderBy: [{ areaSqFt: 'asc' }, { slug: 'asc' }],
      take: 1,
    });
    if (near[0]) return near[0];

    // An upsert rather than find-then-create. Every listing from the mobile flow
    // comes through here, because that flow measures rather than picks — so two
    // publishers submitting 6 x 4 in the same moment is an ordinary Tuesday, and
    // find-then-create would hand one of them a unique-constraint 500.
    return prisma.sizeClass.upsert({
      where: { slug },
      update: {},
      create: {
        name: `${width.toString()} x ${height.toString()}`,
        slug,
        widthFt: width,
        heightFt: height,
        areaSqFt: width.times(height),
      },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Venue types                                                       */
  /* ---------------------------------------------------------------- */

  async listVenueTypes(includeInactive = false): Promise<VenueType[]> {
    return prisma.venueType.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  },

  async findVenueType(id: string): Promise<VenueType | null> {
    return prisma.venueType.findUnique({ where: { id } });
  },

  async findVenueTypeBySlug(slug: string, includeInactive = false): Promise<VenueType | null> {
    // Active only by default. A deactivated venue must not resolve on the
    // listing path, or ops retiring one would keep quietly filing new spots
    // into it. The uniqueness check passes `true`, because the column does not
    // care whether a row is active.
    return prisma.venueType.findFirst({
      where: includeInactive ? { slug } : { slug, isActive: true },
    });
  },

  async createVenueType(data: {
    name: string;
    slug: string;
    category: ListingCategory;
    description: string | null;
    subVenues?: string[];
  }): Promise<VenueType> {
    return prisma.venueType.create({ data: { ...data, subVenues: data.subVenues ?? [] } });
  },

  async updateVenueType(
    id: string,
    patch: {
      name?: string;
      category?: ListingCategory;
      description?: string | null;
      subVenues?: string[];
      isActive?: boolean;
    }
  ): Promise<VenueType> {
    return prisma.venueType.update({ where: { id }, data: patch });
  },

  /**
   * Area is derived, never supplied.
   *
   * A class whose stored area disagrees with its own dimensions would be a
   * silent pricing error the moment anything normalises by it, and there is no
   * reason for two sources of the same number.
   */
  async createSizeClass(data: NewSizeClass): Promise<SizeClass> {
    const width = data.widthFt === null ? null : new D(data.widthFt);
    const height = data.heightFt === null ? null : new D(data.heightFt);
    return prisma.sizeClass.create({
      data: {
        name: data.name,
        slug: data.slug,
        widthFt: width,
        heightFt: height,
        areaSqFt: width && height ? width.times(height) : null,
      },
    });
  },

  async updateSizeClass(
    id: string,
    patch: Partial<NewSizeClass> & { isActive?: boolean }
  ): Promise<SizeClass> {
    const current = await prisma.sizeClass.findUniqueOrThrow({ where: { id } });
    const width =
      patch.widthFt === undefined ? current.widthFt : patch.widthFt === null ? null : new D(patch.widthFt);
    const height =
      patch.heightFt === undefined
        ? current.heightFt
        : patch.heightFt === null
          ? null
          : new D(patch.heightFt);
    return prisma.sizeClass.update({
      where: { id },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
        widthFt: width,
        heightFt: height,
        areaSqFt: width && height ? new D(width).times(new D(height)) : null,
      },
    });
  },

  /**
   * Active only, matching `listSizeClasses`.
   *
   * These two lookups were dead code until the listing path started using them,
   * and they were written without the `isActive` filter its siblings have. A
   * class ops deactivated was invisible in the picker and rejected by a
   * market-data import, but still accepted on the listing path.
   */
  /**
   * Any class with this slug, retired or not.
   *
   * Deliberately not filtered to active. The slug is globally unique, so a
   * retired class still occupies its name: filtering it out let the duplicate
   * check pass and the insert fail, turning a 409 the handler was written to
   * produce into a 500 nobody could act on.
   */
  async findSizeClassBySlug(slug: string): Promise<SizeClass | null> {
    return prisma.sizeClass.findUnique({ where: { slug } });
  },

  async listMaterials(includeInactive = false): Promise<Material[]> {
    return prisma.material.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  },

  async findMaterial(id: string): Promise<Material | null> {
    return prisma.material.findUnique({ where: { id } });
  },

  async createMaterial(data: { name: string; slug: string }): Promise<Material> {
    return prisma.material.create({ data });
  },

  async updateMaterial(
    id: string,
    patch: { name?: string; isActive?: boolean }
  ): Promise<Material> {
    return prisma.material.update({ where: { id }, data: patch });
  },

  /** Any material with this slug, retired or not — see findSizeClassBySlug. */
  async findMaterialBySlug(slug: string): Promise<Material | null> {
    return prisma.material.findUnique({ where: { slug } });
  },

  async listCities(): Promise<{ id: string; slug: string; name: string; aliases: string[] }[]> {
    return prisma.city.findMany({
      where: { isActive: true },
      select: { id: true, slug: true, name: true, aliases: true },
    });
  },

  async listAllCities(): Promise<CityRow[]> {
    const rows = await prisma.city.findMany({ select: CITY_SELECT, orderBy: { name: 'asc' } });
    return rows.map(toCityRow);
  },

  async findCity(slug: string): Promise<CityRow | null> {
    const row = await prisma.city.findUnique({ where: { slug }, select: CITY_SELECT });
    return row ? toCityRow(row) : null;
  },

  async findCityById(id: string): Promise<CityRow | null> {
    const row = await prisma.city.findUnique({ where: { id }, select: CITY_SELECT });
    return row ? toCityRow(row) : null;
  },

  async findCitiesBySpelling(spelling: string, rawName: string): Promise<CityRow[]> {
    const rows = await prisma.city.findMany({
      where: {
        OR: [{ slug: spelling }, { aliases: { has: spelling } }, { name: { equals: rawName, mode: 'insensitive' } }],
      },
      select: CITY_SELECT,
    });
    return rows.map(toCityRow);
  },

  async updateCity(slug, patch): Promise<CityRow> {
    const row = await prisma.city.update({ where: { slug }, data: patch, select: CITY_SELECT });
    return toCityRow(row);
  },

  /* ── Lot X-B: the city key on the party tables ─────────────────── */

  async foldCityKey(table: CityKeyedTable, cityId: string, spellings: string[]): Promise<number> {
    if (spellings.length === 0) return 0;
    const city = { in: spellings, mode: 'insensitive' as const };
    if (table === 'campaigns') {
      const out = await prisma.campaign.updateMany({ where: { targetMarketCityId: null, targetMarket: city }, data: { targetMarketCityId: cityId } });
      return out.count;
    }
    const where = { cityId: null, city };
    const data = { cityId };
    const out = await (table === 'publishers'
      ? prisma.publisher.updateMany({ where, data })
      : table === 'advertisers'
        ? prisma.advertiser.updateMany({ where, data })
        : table === 'agents'
          ? prisma.agentProfile.updateMany({ where, data })
          : table === 'printPartners'
            ? prisma.printPartner.updateMany({ where, data })
            : table === 'listings'
              ? prisma.listing.updateMany({ where, data })
              : table === 'leads'
                ? prisma.lead.updateMany({ where, data })
                : prisma.fieldVisit.updateMany({ where, data }));
    return out.count;
  },

  async listUnresolvedCityStrings(): Promise<UnresolvedCityString[]> {
    const where = { cityId: null, city: { not: null } };
    const count = { _count: { _all: true } } as const;
    const [publishers, advertisers, agents, printPartners, listings, leads, fieldVisits, campaigns] = await Promise.all([
      prisma.publisher.groupBy({ by: ['city'], where, ...count }),
      prisma.advertiser.groupBy({ by: ['city'], where, ...count }),
      prisma.agentProfile.groupBy({ by: ['city'], where, ...count }),
      prisma.printPartner.groupBy({ by: ['city'], where, ...count }),
      prisma.listing.groupBy({ by: ['city'], where, ...count }),
      prisma.lead.groupBy({ by: ['city'], where, ...count }),
      prisma.fieldVisit.groupBy({ by: ['city'], where, ...count }),
      prisma.campaign.groupBy({ by: ['targetMarket'], where: { targetMarketCityId: null, targetMarket: { not: null } }, ...count }),
    ]);
    const rows = (table: CityKeyedTable, groups: { city: string | null; _count: { _all: number } }[]): UnresolvedCityString[] =>
      groups.flatMap((group) => (group.city && group.city.trim() ? [{ table, city: group.city, count: group._count._all }] : []));
    return [
      ...rows('publishers', publishers),
      ...rows('advertisers', advertisers),
      ...rows('agents', agents),
      ...rows('printPartners', printPartners),
      ...rows('listings', listings),
      ...rows('leads', leads),
      ...rows('fieldVisits', fieldVisits),
      ...rows('campaigns', campaigns.map((group) => ({ city: group.targetMarket, _count: group._count }))),
    ];
  },

  /** Counted rather than duplicated, so the tenth sighting is one row saying 10. */
  async recordVocabularyProposal(
    kind: VocabularyKind,
    rawValue: string,
    context: { listingId?: string | null; importId?: string | null }
  ): Promise<void> {
    await prisma.vocabularyProposal.upsert({
      where: { kind_rawValue: { kind, rawValue } },
      create: {
        kind,
        rawValue,
        listingId: context.listingId ?? null,
        importId: context.importId ?? null,
      },
      update: { occurrences: { increment: 1 } },
    });
  },

  async listVocabularyProposals(resolved: boolean) {
    return prisma.vocabularyProposal.findMany({
      where: resolved ? { resolvedAt: { not: null } } : { resolvedAt: null },
      orderBy: [{ occurrences: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, kind: true, rawValue: true, occurrences: true, createdAt: true },
    });
  },

  async findVocabularyProposal(id: string): Promise<{ id: string } | null> {
    return prisma.vocabularyProposal.findUnique({ where: { id }, select: { id: true } });
  },

  async resolveVocabularyProposal(
    id: string,
    resolvedTo: string | null,
    userId: string
  ): Promise<void> {
    await prisma.vocabularyProposal.update({
      where: { id },
      data: { resolvedAt: new Date(), resolvedById: userId, resolvedTo },
    });
  },

  async logMediaTypeMatch(entry: {
    proposedName: string;
    attributes: Record<string, unknown>;
    mediaTypeId: string | null;
    similarity: number | null;
    outcome: MediaTypeMatchOutcome;
    listingId: string | null;
  }): Promise<void> {
    await prisma.mediaTypeMatchLog.create({
      data: {
        proposedName: entry.proposedName,
        attributes: entry.attributes as Prisma.InputJsonValue,
        mediaTypeId: entry.mediaTypeId,
        similarity: entry.similarity === null ? null : new D(entry.similarity.toFixed(4)),
        outcome: entry.outcome,
        listingId: entry.listingId,
      },
    });
  },

  async listMediaTypeMatchLogs(limit: number) {
    const rows = await prisma.mediaTypeMatchLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        proposedName: true,
        mediaTypeId: true,
        similarity: true,
        outcome: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      similarity: row.similarity === null ? null : new D(row.similarity).toString(),
    }));
  },

  /* ---------------------------------------------------------------- */
  /* Comparables                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * ADX listings inside the bounding box.
   *
   * Read live rather than copied into `MarketDataPoint`: a copy would go stale
   * the moment a publisher edits their price, and a stale comparable is worse
   * than a missing one because it looks authoritative.
   */
  async listingComparables(query: ComparableQuery): Promise<Comparable[]> {
    const rows = await prisma.listing.findMany({
      where: {
        venueTypeId: query.venueTypeId,
        mediaTypeId: query.mediaTypeId,
        sizeClassId: query.sizeClassId,
        status: 'ACTIVE',
        ratePerDay: { not: null },
        // Surge moves the indicator, never the pool: a rate set while a window
        // was lifting the ceiling is not a baseline. The exclusion expires with
        // the window — a permanent one would drain the pool, since a national
        // event covers every spot in the country.
        OR: [{ ratePerDaySurgeUntil: null }, { ratePerDaySurgeUntil: { lte: query.now } }],
        latitude: {
          gte: query.latitude - query.latDelta,
          lte: query.latitude + query.latDelta,
        },
        longitude: {
          gte: query.longitude - query.lngDelta,
          lte: query.longitude + query.lngDelta,
        },
        ...(query.excludeListingId ? { id: { not: query.excludeListingId } } : {}),
      },
      select: {
        id: true,
        title: true,
        publisherId: true,
        latitude: true,
        longitude: true,
        ratePerDay: true,
        ratePerDaySetAt: true,
        publishedAt: true,
        createdAt: true,
        publisher: { select: { name: true } },
        _count: { select: { orders: { where: { status: { in: VALIDATING_ORDER_STATUSES } } } } },
      },
    });

    return rows
      .filter((row) => row.latitude !== null && row.longitude !== null && row.ratePerDay !== null)
      .map((row) => ({
        id: row.id,
        // An unclaimed listing has no publisher, so it speaks for itself rather
        // than joining a null bucket where every orphan would be one voice.
        contributorKey: row.publisherId ? `pub:${row.publisherId}` : `listing:${row.id}`,
        contributorName: row.publisher?.name ?? null,
        ratePerDay: money(row.ratePerDay!),
        latitude: row.latitude!,
        longitude: row.longitude!,
        distanceMeters: 0,
        // When the *price* was set, not when the listing appeared. A rate
        // edited yesterday on a listing published last year is current
        // evidence; dating it by publishedAt would call it stale.
        observedAt: row.ratePerDaySetAt ?? row.publishedAt ?? row.createdAt,
        tier: row._count.orders > 0 ? ('VALIDATED' as const) : ('LISTED' as const),
        origin: 'LISTING' as const,
        label: row.title,
      }));
  },

  async marketDataComparables(query: ComparableQuery): Promise<Comparable[]> {
    const rows = await prisma.marketDataPoint.findMany({
      where: {
        venueTypeId: query.venueTypeId,
        mediaTypeId: query.mediaTypeId,
        sizeClassId: query.sizeClassId,
        isActive: true,
        latitude: {
          gte: query.latitude - query.latDelta,
          lte: query.latitude + query.latDelta,
        },
        longitude: {
          gte: query.longitude - query.lngDelta,
          lte: query.longitude + query.lngDelta,
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      contributorKey: row.contributorKey,
      contributorName: row.contributorName,
      ratePerDay: money(row.ratePerDay),
      latitude: row.latitude,
      longitude: row.longitude,
      distanceMeters: 0,
      observedAt: row.observedAt,
      tier: row.source === 'RATE_CARD' ? ('PROVISIONAL' as const) : ('LISTED' as const),
      origin: 'MARKET_DATA' as const,
      label: row.locality ?? row.city,
    }));
  },

  /* ---------------------------------------------------------------- */
  /* Market data import                                                */
  /* ---------------------------------------------------------------- */

  async createImport(data: {
    source: MarketDataSource;
    filename: string | null;
    note: string | null;
    uploadedById: string | null;
  }): Promise<{ id: string }> {
    const row = await prisma.marketDataImport.create({ data, select: { id: true } });
    return row;
  },

  async insertMarketDataPoints(points: NewMarketDataPoint[]): Promise<number> {
    const result = await prisma.marketDataPoint.createMany({
      data: points.map((p) => ({ ...p, ratePerDay: new D(p.ratePerDay) })),
    });
    return result.count;
  },

  async finishImport(
    importId: string,
    counts: { rowCount: number; acceptedCount: number; rejectedCount: number },
    rejections: unknown
  ): Promise<void> {
    await prisma.marketDataImport.update({
      where: { id: importId },
      data: { ...counts, rejections: rejections as Prisma.InputJsonValue },
    });
  },

  /** Cleared, not deleted — a bad import stays auditable after it is undone. */
  async deactivateImport(importId: string): Promise<number> {
    const result = await prisma.marketDataPoint.updateMany({
      where: { importId },
      data: { isActive: false },
    });
    return result.count;
  },

  /* ---------------------------------------------------------------- */
  /* Factors                                                           */
  /* ---------------------------------------------------------------- */

  async listFactors(mediaTypeId?: string): Promise<PricingFactor[]> {
    const rows = await prisma.pricingFactor.findMany({
      where: mediaTypeId ? { mediaTypeId } : {},
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    return rows.map(normaliseFactor);
  },

  async findFactor(id: string): Promise<PricingFactor | null> {
    const row = await prisma.pricingFactor.findUnique({ where: { id } });
    return row === null ? null : normaliseFactor(row);
  },

  async countFactorApplications(id: string): Promise<number> {
    return prisma.listingPricingFactor.count({ where: { factorId: id } });
  },

  async deleteFactor(id: string): Promise<void> {
    await prisma.pricingFactor.delete({ where: { id } });
  },

  async createFactor(data: {
    name: string;
    slug: string;
    description: string | null;
    kind: PricingFactorKind;
    mediaTypeId: string;
    multiplier: string | null;
    baseAdjust: string | null;
    suggestWhen: unknown;
    mode?: PricingFactorMode;
    bindingDuringSurgeOnly?: boolean;
  }): Promise<PricingFactor> {
    return prisma.pricingFactor.create({
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description,
        kind: data.kind,
        mediaTypeId: data.mediaTypeId,
        multiplier: data.multiplier === null ? null : new D(data.multiplier),
        baseAdjust: data.baseAdjust === null ? null : new D(data.baseAdjust),
        suggestWhen: (data.suggestWhen ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        mode: data.mode ?? 'ADVISORY',
        bindingDuringSurgeOnly: data.bindingDuringSurgeOnly ?? false,
      },
    });
  },

  async updateFactor(id: string, patch: Record<string, unknown>): Promise<PricingFactor> {
    return prisma.pricingFactor.update({ where: { id }, data: patch });
  },

  async listingFactorApplications(listingId: string): Promise<FactorApplication[]> {
    const rows = await prisma.listingPricingFactor.findMany({
      where: { listingId },
      select: { factorId: true, suggested: true, applied: true, appliedRatePerDay: true },
    });
    return rows.map((row) => ({
      factorId: row.factorId,
      suggested: row.suggested,
      applied: row.applied,
      appliedRatePerDay: row.appliedRatePerDay === null ? null : money(row.appliedRatePerDay),
    }));
  },

  /**
   * Replaces the suggestion set without touching what a person applied.
   *
   * The engine re-proposes on every refresh; a decision someone took stands
   * until they take a different one. Clearing `applied` here would silently
   * revoke prices ops had already agreed with publishers.
   */
  async setFactorSuggestions(listingId: string, factorIds: string[]): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.listingPricingFactor.updateMany({
        where: { listingId, factorId: { notIn: factorIds } },
        data: { suggested: false },
      });
      for (const factorId of factorIds) {
        await tx.listingPricingFactor.upsert({
          where: { listingId_factorId: { listingId, factorId } },
          create: { listingId, factorId, suggested: true },
          update: { suggested: true },
        });
      }
    });
  },

  async setFactorApplied(
    listingId: string,
    factorId: string,
    applied: boolean,
    userId: string,
    appliedRatePerDay: Money | null
  ): Promise<void> {
    const rate = appliedRatePerDay === null ? null : new D(appliedRatePerDay);
    await prisma.listingPricingFactor.upsert({
      where: { listingId_factorId: { listingId, factorId } },
      create: {
        listingId,
        factorId,
        applied,
        appliedRatePerDay: rate,
        decidedById: userId,
        decidedAt: new Date(),
      },
      update: { applied, appliedRatePerDay: rate, decidedById: userId, decidedAt: new Date() },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Surge                                                             */
  /* ---------------------------------------------------------------- */

  async activeSurgeWindows(at: Date): Promise<SurgeEvent[]> {
    return prisma.surgeEvent.findMany({
      where: { isEnabled: true, startsAt: { lte: at }, endsAt: { gte: at } },
    });
  },

  async findSurgeWindow(id: string): Promise<SurgeEvent | null> {
    return prisma.surgeEvent.findUnique({ where: { id } });
  },

  async listSurgeWindows(filter: {
    includeDisabled: boolean;
    from?: Date;
    to?: Date;
  }): Promise<SurgeEvent[]> {
    return prisma.surgeEvent.findMany({
      where: {
        ...(filter.includeDisabled ? {} : { isEnabled: true }),
        ...(filter.to ? { startsAt: { lte: filter.to } } : {}),
        ...(filter.from ? { endsAt: { gte: filter.from } } : {}),
      },
      orderBy: { startsAt: 'desc' },
    });
  },

  /**
   * Upsert on the provider's own id, so a re-scrape corrects an event rather
   * than stacking a second window on top of the first.
   */
  async upsertSurgeWindow(data: NewSurgeEvent): Promise<SurgeEvent> {
    const payload = { ...data, upliftPct: new D(data.upliftPct) };
    if (!data.externalRef) return prisma.surgeEvent.create({ data: payload });
    return prisma.surgeEvent.upsert({
      where: { source_externalRef: { source: data.source, externalRef: data.externalRef } },
      create: payload,
      // isEnabled is deliberately absent: a window ops switched off stays off
      // when the scraper next sees the same event, which is the entire point of
      // the kill switch.
      update: {
        name: payload.name,
        scope: payload.scope,
        city: payload.city,
        citySlug: payload.citySlug,
        latitude: payload.latitude,
        longitude: payload.longitude,
        radiusMeters: payload.radiusMeters,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
        upliftPct: payload.upliftPct,
        isPublic: payload.isPublic,
      },
    });
  },

  async setSurgeEnabled(
    id: string,
    enabled: boolean,
    userId: string,
    note: string | null
  ): Promise<SurgeEvent> {
    return prisma.surgeEvent.update({
      where: { id },
      data: enabled
        ? { isEnabled: true, disabledById: null, disabledAt: null, disabledNote: null }
        : { isEnabled: false, disabledById: userId, disabledAt: new Date(), disabledNote: note },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Scraper sources                                                   */
  /* ---------------------------------------------------------------- */

  async listScraperSources(): Promise<ScraperSource[]> {
    return prisma.scraperSource.findMany({
      orderBy: [{ isEnabled: 'desc' }, { name: 'asc' }],
    });
  },

  async findScraperSource(id: string): Promise<ScraperSource | null> {
    return prisma.scraperSource.findUnique({ where: { id } });
  },

  async createScraperSource(data: NewScraperSource): Promise<ScraperSource> {
    return prisma.scraperSource.create({
      data: {
        ...data,
        defaultUpliftPct: new D(data.defaultUpliftPct),
        fieldMap: (data.fieldMap ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  },

  async updateScraperSource(id: string, patch: Record<string, unknown>): Promise<ScraperSource> {
    return prisma.scraperSource.update({ where: { id }, data: patch });
  },

  /**
   * Disabling is recorded, not just flipped.
   *
   * Same reasoning as a surge window: a source switched off because it started
   * inventing events needs to say so, or the next person turns it back on.
   */
  async setScraperSourceEnabled(
    id: string,
    enabled: boolean,
    userId: string,
    note: string | null
  ): Promise<ScraperSource> {
    return prisma.scraperSource.update({
      where: { id },
      data: enabled
        ? { isEnabled: true, disabledById: null, disabledAt: null, disabledNote: null }
        : { isEnabled: false, disabledById: userId, disabledAt: new Date(), disabledNote: note },
    });
  },

  async listScraperRuns(sourceId: string, limit: number): Promise<ScraperRun[]> {
    return prisma.scraperRun.findMany({
      where: { sourceId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  },

  /**
   * Opened before the work rather than written after it.
   *
   * A run row that only appears on success means a source that crashes the
   * process every time looks like a source that has never run.
   */
  async startScraperRun(sourceId: string): Promise<ScraperRun> {
    return prisma.scraperRun.create({ data: { sourceId, status: 'OK' } });
  },

  async finishScraperRun(
    runId: string,
    sourceId: string,
    outcome: {
      status: ScraperRunStatus;
      message: string | null;
      found: number;
      windowsUpserted: number;
    }
  ): Promise<void> {
    await prisma.$transaction([
      prisma.scraperRun.update({
        where: { id: runId },
        data: { ...outcome, finishedAt: new Date() },
      }),
      // Denormalised onto the source so the list screen can show health without
      // a correlated subquery per row.
      prisma.scraperSource.update({
        where: { id: sourceId },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: outcome.status,
          lastRunMessage: outcome.message,
          lastRunFound: outcome.found,
        },
      }),
    ]);
  },

  async findSurgeWindowByRef(source: string, externalRef: string): Promise<SurgeEvent | null> {
    return prisma.surgeEvent.findUnique({
      where: { source_externalRef: { source: source as SurgeEvent['source'], externalRef } },
    });
  },

  async setScraperCreatedWindowDisabled(id: string): Promise<void> {
    await prisma.surgeEvent.update({
      where: { id },
      data: {
        isEnabled: false,
        disabledNote: 'Awaiting review — this source does not publish windows live',
      },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Listings                                                          */
  /* ---------------------------------------------------------------- */

  async listingContext(listingId: string): Promise<ListingPricingContext | null> {
    const row = await prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        publisherId: true,
        venueTypeId: true,
        mediaTypeId: true,
        sizeClassId: true,
        materialId: true,
        latitude: true,
        longitude: true,
        city: true,
        category: true,
        ratePerDay: true,
        illumination: true,
        facing: true,
        elevation: true,
        visibility: true,
        trafficGrade: true,
        areaSqFt: true,
        mediaType: { select: { slug: true } },
        sizeClass: { select: { slug: true } },
        material: { select: { slug: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      publisherId: row.publisherId,
      venueTypeId: row.venueTypeId,
      mediaTypeId: row.mediaTypeId,
      sizeClassId: row.sizeClassId,
      materialId: row.materialId,
      latitude: row.latitude,
      longitude: row.longitude,
      city: row.city,
      category: row.category as ListingCategory,
      ratePerDay: row.ratePerDay === null ? null : money(row.ratePerDay),
      mediaTypeSlug: row.mediaType?.slug ?? null,
      sizeClassSlug: row.sizeClass?.slug ?? null,
      materialSlug: row.material?.slug ?? null,
      illumination: row.illumination,
      facing: row.facing,
      elevation: row.elevation,
      visibility: row.visibility,
      trafficGrade: row.trafficGrade,
      areaSqFt: row.areaSqFt === null ? null : new D(row.areaSqFt).toString(),
    };
  },

  async publisherUserId(publisherId: string): Promise<string | null> {
    const row = await prisma.publisher.findUnique({
      where: { id: publisherId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  },
};
