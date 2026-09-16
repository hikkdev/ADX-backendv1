import { Prisma, prisma } from '../../shared/database';
import type {
  CategoryRuleRow,
  ConditionInput,
  DimensionRow,
  DimensionValueInput,
  NewCategoryRule,
  NewDimension,
  NewPriceRule,
  NewQuote,
  PriceModelRepository,
  PriceRuleRow,
  QuoteRow,
} from './price-model.repository';

const dimensionInclude = {
  values: { orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] },
} satisfies Prisma.PriceDimensionInclude;

const ruleInclude = { conditions: true } satisfies Prisma.PriceRuleInclude;

const quoteInclude = {
  lines: { include: { mediaType: { select: { name: true } } } },
  advertiser: { select: { name: true } },
} satisfies Prisma.QuoteInclude;

const toQuote = (row: Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>): QuoteRow => ({
  ...row,
  advertiserName: row.advertiser?.name ?? null,
  lines: row.lines.map((line) => ({ ...line, mediaTypeName: line.mediaType.name })),
});

export const prismaPriceModelRepository: PriceModelRepository = {
  listDimensions(includeInactive = false) {
    return prisma.priceDimension.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: dimensionInclude,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }) as Promise<DimensionRow[]>;
  },

  findDimension(id: string) {
    return prisma.priceDimension.findUnique({
      where: { id },
      include: dimensionInclude,
    }) as Promise<DimensionRow | null>;
  },

  createDimension(data: NewDimension) {
    return prisma.priceDimension.create({
      data,
      include: dimensionInclude,
    }) as Promise<DimensionRow>;
  },

  updateDimension(id, patch) {
    return prisma.priceDimension.update({
      where: { id },
      data: patch,
      include: dimensionInclude,
    }) as Promise<DimensionRow>;
  },

  async deleteDimension(id: string) {
    await prisma.priceDimension.delete({ where: { id } });
  },

  async replaceDimensionValues(dimensionId: string, values: DimensionValueInput[]) {
    // Replaced whole rather than diffed: a dimension is edited as a set of
    // options, and a partial update leaves an option nobody meant to keep.
    await prisma.$transaction([
      prisma.priceDimensionValue.deleteMany({ where: { dimensionId } }),
      prisma.priceDimensionValue.createMany({
        data: values.map((value, index) => ({
          dimensionId,
          label: value.label,
          multiplier: value.multiplier,
          minAreaSqFt: value.minAreaSqFt ?? null,
          maxAreaSqFt: value.maxAreaSqFt ?? null,
          sortOrder: value.sortOrder ?? index,
          isActive: value.isActive ?? true,
        })),
      }),
    ]);
  },

  async listCategoryRules() {
    const rows = await prisma.pricingCategoryRule.findMany({
      include: { mediaType: { select: { name: true } } },
      orderBy: [{ sector: 'asc' }, { mediaTypeId: 'asc' }],
    });
    return rows.map((row) => ({ ...row, mediaTypeName: row.mediaType?.name ?? null }));
  },

  async createCategoryRule(data: NewCategoryRule) {
    const row = await prisma.pricingCategoryRule.create({
      data,
      include: { mediaType: { select: { name: true } } },
    });
    return { ...row, mediaTypeName: row.mediaType?.name ?? null };
  },

  async updateCategoryRule(id, patch) {
    const row = await prisma.pricingCategoryRule.update({
      where: { id },
      data: patch,
      include: { mediaType: { select: { name: true } } },
    });
    return { ...row, mediaTypeName: row.mediaType?.name ?? null };
  },

  async deleteCategoryRule(id: string) {
    await prisma.pricingCategoryRule.delete({ where: { id } });
  },

  async findCategoryRule(sector: string, mediaTypeId: string) {
    /*
     * Most specific wins. Ordering by `mediaTypeId` descending puts the
     * non-null row first in Postgres, so one query answers "is there a rule for
     * this sector on this media type, and if not, a rule for the sector at
     * large" — which is the precedence the screen describes.
     */
    const row = await prisma.pricingCategoryRule.findFirst({
      where: {
        isActive: true,
        sector: { equals: sector, mode: 'insensitive' },
        OR: [{ mediaTypeId }, { mediaTypeId: null }],
      },
      include: { mediaType: { select: { name: true } } },
      orderBy: { mediaTypeId: 'desc' },
    });
    return row ? { ...row, mediaTypeName: row.mediaType?.name ?? null } : null;
  },

  listRules(includeInactive = false) {
    return prisma.priceRule.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: ruleInclude,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    }) as Promise<PriceRuleRow[]>;
  },

  findRule(id: string) {
    return prisma.priceRule.findUnique({
      where: { id },
      include: ruleInclude,
    }) as Promise<PriceRuleRow | null>;
  },

  createRule(data: NewPriceRule) {
    return prisma.priceRule.create({ data, include: ruleInclude }) as Promise<PriceRuleRow>;
  },

  updateRule(id, patch) {
    return prisma.priceRule.update({
      where: { id },
      data: patch,
      include: ruleInclude,
    }) as Promise<PriceRuleRow>;
  },

  async deleteRule(id: string) {
    await prisma.priceRule.delete({ where: { id } });
  },

  async replaceConditions(ruleId: string, conditions: ConditionInput[]) {
    await prisma.$transaction([
      prisma.priceRuleCondition.deleteMany({ where: { ruleId } }),
      prisma.priceRuleCondition.createMany({
        data: conditions.map((condition) => ({ ...condition, ruleId })),
      }),
    ]);
  },

  rulesInForce(on: Date) {
    return prisma.priceRule.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: on } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: on } }] },
        ],
      },
      include: ruleInclude,
      // Ties break on id so the firing order is total, and a trace produced
      // twice reads the same way twice.
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    }) as Promise<PriceRuleRow[]>;
  },

  async listQuotes(status?: string) {
    const rows = await prisma.quote.findMany({
      where: status ? { status: status as never } : {},
      include: quoteInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toQuote);
  },

  async findQuote(id: string) {
    const row = await prisma.quote.findUnique({ where: { id }, include: quoteInclude });
    return row ? toQuote(row) : null;
  },

  async createQuote(data: NewQuote) {
    const { lines, ...header } = data;
    const row = await prisma.quote.create({
      data: {
        ...header,
        lines: {
          create: lines.map((line) => ({
            ...line,
            grade: line.grade as never,
            trace: line.trace as Prisma.InputJsonValue,
          })),
        },
      },
      include: quoteInclude,
    });
    return toQuote(row);
  },

  async setQuoteStatus(id: string, status: string) {
    const row = await prisma.quote.update({
      where: { id },
      data: { status: status as never },
      include: quoteInclude,
    });
    return toQuote(row);
  },

  getSettings() {
    return prisma.priceModelSettings.findUnique({ where: { id: 'default' } });
  },

  upsertSettings(patch) {
    const { updatedById, ...data } = patch;
    return prisma.priceModelSettings.upsert({
      where: { id: 'default' },
      update: { ...(data as Prisma.PriceModelSettingsUpdateInput), updatedById },
      create: { id: 'default', ...(data as Prisma.PriceModelSettingsCreateInput), updatedById },
    });
  },

  async listingForSimulation(listingId: string) {
    const row = await prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        title: true,
        city: true,
        latitude: true,
        longitude: true,
        mediaTypeId: true,
        areaSqFt: true,
        rateGrade: true,
        mediaType: { select: { name: true } },
      },
    });
    if (!row) return null;
    // Listings carry a city name; cards are scoped by id. Reconciled here, the
    // same way the rate-card gate does it.
    const city = row.city
      ? await prisma.city.findFirst({
          where: { name: { equals: row.city, mode: 'insensitive' } },
          select: { id: true },
        })
      : null;
    return {
      id: row.id,
      title: row.title,
      city: row.city,
      cityId: city?.id ?? null,
      latitude: row.latitude,
      longitude: row.longitude,
      mediaTypeId: row.mediaTypeId,
      mediaTypeName: row.mediaType?.name ?? 'Unclassified',
      areaSqFt: row.areaSqFt,
      rateGrade: row.rateGrade,
    };
  },

  async referenceExists(reference: string) {
    const found = await prisma.quote.findUnique({ where: { reference }, select: { id: true } });
    return found !== null;
  },
};
