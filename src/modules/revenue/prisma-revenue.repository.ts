import { Prisma, prisma } from '../../shared/database';
import type {
  CommissionRate,
  FeeSchedule,
  ListingCategory,
  PriceLock,
  PublisherCommissionOverride,
  PublisherSubscription,
  TaxSettings,
} from '../../shared/database';
import type {
  NewCommissionRate,
  NewFee,
  NewOverride,
  NewSubscription,
  PricingInputs,
  Rate,
  RevenueRepository,
} from './revenue.repository';

const D = Prisma.Decimal;
const SETTINGS_ID = 'default';

/** In force at `at`: started, and either open-ended or not yet finished. */
const runningAt = (at: Date) => ({
  startsAt: { lte: at },
  OR: [{ endsAt: null }, { endsAt: { gt: at } }],
});

export const prismaRevenueRepository: RevenueRepository = {
  /**
   * Everything a quote needs, in one round trip.
   *
   * Deliberately one call rather than four. Rates fetched at different moments
   * can straddle an ops edit, and a quote assembled from a pre-edit commission
   * and a post-edit fee is internally inconsistent in a way its total does not
   * reveal.
   */
  async pricingInputs(input: {
    publisherId: string | null;
    category: ListingCategory;
    mediaTypeId: string | null;
    perDayMediaValue: string;
    at: Date;
  }): Promise<PricingInputs> {
    const [defaultCommission, categoryCommission, mediaTypeRows, subscription, override, fees, tax] =
      await Promise.all([
        prisma.commissionRate.findFirst({
          where: { category: null, mediaTypeId: null, isActive: true },
        }),
        prisma.commissionRate.findFirst({
          where: { category: input.category, mediaTypeId: null, isActive: true },
        }),
        // Every active row for the media type, banded or not; the band is
        // chosen in code because the partial unique index cannot express
        // "the one whose range contains this value" and two rows are cheap.
        input.mediaTypeId
          ? prisma.commissionRate.findMany({
              where: { mediaTypeId: input.mediaTypeId, isActive: true },
              // Highest floor first, so the narrowest matching band wins.
              orderBy: [{ minMediaValue: 'desc' }],
            })
          : Promise.resolve([] as CommissionRate[]),
        input.publisherId
          ? prisma.publisherSubscription.findFirst({
              where: { publisherId: input.publisherId, ...runningAt(input.at) },
              // Best rate wins if a publisher somehow holds two: they paid for
              // both, and the cheaper commission is the one they bought.
              orderBy: { ratePct: 'asc' },
            })
          : Promise.resolve(null),
        input.publisherId
          ? prisma.publisherCommissionOverride.findFirst({
              where: { publisherId: input.publisherId, ...runningAt(input.at) },
              orderBy: { ratePct: 'asc' },
            })
          : Promise.resolve(null),
        prisma.feeSchedule.findMany({ where: { isActive: true }, orderBy: { kind: 'asc' } }),
        prisma.taxSettings.findUnique({ where: { id: SETTINGS_ID } }),
      ]);

    const value = new D(input.perDayMediaValue);
    const banded = mediaTypeRows.filter((row) => row.minMediaValue !== null || row.maxMediaValue !== null);
    // A band is [min, max): inclusive floor, exclusive ceiling, so adjacent
    // bands written as 0–1000 and 1000–5000 cannot both claim ₹1,000.
    const mediaTypeSlabCommission =
      banded.find(
        (row) =>
          (row.minMediaValue === null || value.greaterThanOrEqualTo(row.minMediaValue)) &&
          (row.maxMediaValue === null || value.lessThan(row.maxMediaValue))
      ) ?? null;
    const mediaTypeCommission =
      mediaTypeRows.find((row) => row.minMediaValue === null && row.maxMediaValue === null) ?? null;

    return {
      defaultCommission,
      categoryCommission,
      mediaTypeCommission,
      mediaTypeSlabCommission,
      subscription,
      override,
      fees,
      tax,
    };
  },

  /* ---------------------------------------------------------------- */
  /* Commission rates                                                  */
  /* ---------------------------------------------------------------- */

  async listCommissionRates(): Promise<CommissionRate[]> {
    return prisma.commissionRate.findMany({
      orderBy: [{ isActive: 'desc' }, { category: 'asc' }, { mediaTypeId: 'asc' }, { minMediaValue: 'asc' }],
    });
  },

  /**
   * Retires the previous rate and writes a new one, in one transaction.
   *
   * Not an update: the old rate is what past bookings were priced under, and
   * overwriting it would erase the record of what ADX charged last quarter. The
   * partial unique indexes make "two active rates for one category" impossible,
   * so this has to deactivate before it inserts.
   *
   * Lot B: the key is (category | mediaTypeId | band). The row retired is the
   * one with the same key — the same category, or the same media type with
   * the same floor and ceiling — so writing a second band for a media type
   * leaves the first band and the unbanded row alone.
   */
  async upsertCommissionRate(data: NewCommissionRate): Promise<CommissionRate> {
    const minMediaValue = data.minMediaValue === null ? null : new D(data.minMediaValue);
    const maxMediaValue = data.maxMediaValue === null ? null : new D(data.maxMediaValue);
    return prisma.$transaction(async (tx) => {
      await tx.commissionRate.updateMany({
        where: {
          category: data.category,
          mediaTypeId: data.mediaTypeId,
          minMediaValue,
          maxMediaValue,
          isActive: true,
        },
        data: { isActive: false, updatedById: data.userId },
      });
      return tx.commissionRate.create({
        data: {
          category: data.category,
          mediaTypeId: data.mediaTypeId,
          minMediaValue,
          maxMediaValue,
          ratePct: new D(data.ratePct),
          note: data.note,
          updatedById: data.userId,
        },
      });
    });
  },

  /* ---------------------------------------------------------------- */
  /* Subscriptions and overrides                                       */
  /* ---------------------------------------------------------------- */

  async listSubscriptions(publisherId?: string): Promise<PublisherSubscription[]> {
    return prisma.publisherSubscription.findMany({
      where: publisherId ? { publisherId } : {},
      orderBy: { startsAt: 'desc' },
    });
  },

  async createSubscription(data: NewSubscription): Promise<PublisherSubscription> {
    return prisma.publisherSubscription.create({
      data: {
        ...data,
        ratePct: new D(data.ratePct),
        pricePerMonth: new D(data.pricePerMonth),
      },
    });
  },

  async endSubscription(id: string, endsAt: Date): Promise<PublisherSubscription> {
    return prisma.publisherSubscription.update({ where: { id }, data: { endsAt } });
  },

  async findSubscription(id: string): Promise<PublisherSubscription | null> {
    return prisma.publisherSubscription.findUnique({ where: { id } });
  },

  async findRunningSubscription(publisherId: string, at: Date): Promise<PublisherSubscription | null> {
    return prisma.publisherSubscription.findFirst({
      where: { publisherId, ...runningAt(at) },
      orderBy: { ratePct: 'asc' },
    });
  },

  async findRunningSubscriptions(publisherIds: readonly string[], at: Date): Promise<PublisherSubscription[]> {
    if (publisherIds.length === 0) return [];
    return prisma.publisherSubscription.findMany({
      where: { publisherId: { in: [...publisherIds] }, ...runningAt(at) },
      orderBy: { ratePct: 'asc' },
    });
  },

  async findLapsedSubscription(publisherId: string, since: Date, at: Date): Promise<PublisherSubscription | null> {
    return prisma.publisherSubscription.findFirst({
      where: { publisherId, endsAt: { gt: since, lte: at } },
      orderBy: { endsAt: 'desc' },
    });
  },

  async findLapsedSubscriptions(publisherIds: readonly string[], since: Date, at: Date): Promise<PublisherSubscription[]> {
    if (publisherIds.length === 0) return [];
    return prisma.publisherSubscription.findMany({
      where: { publisherId: { in: [...publisherIds] }, endsAt: { gt: since, lte: at } },
      orderBy: { endsAt: 'desc' },
    });
  },

  async listOverrides(publisherId?: string): Promise<PublisherCommissionOverride[]> {
    return prisma.publisherCommissionOverride.findMany({
      where: publisherId ? { publisherId } : {},
      orderBy: { startsAt: 'desc' },
    });
  },

  async createOverride(data: NewOverride): Promise<PublisherCommissionOverride> {
    return prisma.publisherCommissionOverride.create({
      data: { ...data, ratePct: new D(data.ratePct) },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Fees and tax                                                      */
  /* ---------------------------------------------------------------- */

  async listFees(includeInactive = false): Promise<FeeSchedule[]> {
    return prisma.feeSchedule.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { kind: 'asc' }],
    });
  },

  async findFee(id: string): Promise<FeeSchedule | null> {
    return prisma.feeSchedule.findUnique({ where: { id } });
  },

  async createFee(data: NewFee): Promise<FeeSchedule> {
    return prisma.feeSchedule.create({
      data: {
        ...data,
        percentPct: data.percentPct === null ? null : new D(data.percentPct),
        flatAmount: data.flatAmount === null ? null : new D(data.flatAmount),
        gstPct: new D(data.gstPct),
      },
    });
  },

  async updateFee(
    id: string,
    patch: Record<string, unknown>,
    userId: string
  ): Promise<FeeSchedule> {
    return prisma.feeSchedule.update({ where: { id }, data: { ...patch, updatedById: userId } });
  },

  async getTaxSettings(): Promise<TaxSettings | null> {
    return prisma.taxSettings.findUnique({ where: { id: SETTINGS_ID } });
  },

  async updateTaxSettings(mediaGstPct: Rate, userId: string): Promise<TaxSettings> {
    return prisma.taxSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, mediaGstPct: new D(mediaGstPct), updatedById: userId },
      update: { mediaGstPct: new D(mediaGstPct), updatedById: userId },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Price locks                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Re-locking refreshes rather than stacks.
   *
   * An advertiser returning to a spot they already held gets a fresh window at
   * the current rate; letting locks accumulate would mean the oldest one — the
   * stalest price — is the one a later read happens to find.
   */
  async upsertPriceLock(data: {
    advertiserId: string;
    listingId: string;
    ratePerDay: string;
    expiresAt: Date;
  }): Promise<PriceLock> {
    const payload = { ...data, ratePerDay: new D(data.ratePerDay) };
    return prisma.priceLock.upsert({
      where: {
        advertiserId_listingId: {
          advertiserId: data.advertiserId,
          listingId: data.listingId,
        },
      },
      create: payload,
      update: { ...payload, consumedAt: null },
    });
  },

  async findPriceLock(advertiserId: string, listingId: string): Promise<PriceLock | null> {
    return prisma.priceLock.findUnique({
      where: { advertiserId_listingId: { advertiserId, listingId } },
    });
  },

  async consumePriceLock(id: string): Promise<void> {
    await prisma.priceLock.update({ where: { id }, data: { consumedAt: new Date() } });
  },

  /* ---------------------------------------------------------------- */
  /* Listings                                                          */
  /* ---------------------------------------------------------------- */

  async listingForQuote(listingId: string) {
    const row = await prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        publisherId: true,
        category: true,
        mediaTypeId: true,
        ratePerDay: true,
        title: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      publisherId: row.publisherId,
      category: row.category as ListingCategory,
      mediaTypeId: row.mediaTypeId,
      ratePerDay: row.ratePerDay === null ? null : new D(row.ratePerDay).toFixed(2),
      title: row.title,
    };
  },
};
