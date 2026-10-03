import { Prisma, prisma } from '../../shared/database';
import type { PromotionStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import { HOLDING_STATUSES, type PromotionsRepository } from './promotions.repository';
import { PROMOTION_STATUSES } from './promotions.schema';

const withSlot = { slot: true } as const;

/** Running on the day: LIVE, or SCHEDULED with the day already inside its dates (the job flips it on its next tick). */
const runningOn = (day: Date) => ({ status: { in: ['LIVE', 'SCHEDULED'] as PromotionStatus[] }, startDate: { lte: day }, endDate: { gte: day } });

const overlapping = (from: Date, to: Date) => ({ startDate: { lte: to }, endDate: { gte: from } });

export const prismaPromotionsRepository: PromotionsRepository = {
  /* ── Slots ────────────────────────────────────────────────────────── */

  listSlots(activeOnly) {
    return prisma.adSlot.findMany({ where: activeOnly ? { isActive: true } : {}, orderBy: [{ isActive: 'desc' }, { label: 'asc' }] });
  },

  findSlotByKey(key) {
    return prisma.adSlot.findUnique({ where: { key } });
  },

  findSlot(idOrKey) {
    return prisma.adSlot.findFirst({ where: { OR: [{ id: idOrKey }, { key: idOrKey }] } });
  },

  createSlot(data) {
    return prisma.adSlot.create({ data });
  },

  updateSlot(id, patch) {
    return prisma.adSlot.update({ where: { id }, data: patch });
  },

  /* ── Placements ───────────────────────────────────────────────────── */

  listPlacements() {
    return prisma.boostPlacementConfig.findMany({ orderBy: { placement: 'asc' } });
  },

  findPlacement(placement) {
    return prisma.boostPlacementConfig.findUnique({ where: { placement } });
  },

  updatePlacement(placement, patch) {
    return prisma.boostPlacementConfig.update({ where: { placement }, data: patch });
  },

  /* ── Ads ──────────────────────────────────────────────────────────── */

  createAd(data) {
    return prisma.adBooking.create({ data: { ...data, status: 'DRAFT' }, include: withSlot });
  },

  findAd(id) {
    return prisma.adBooking.findFirst({ where: { OR: [{ id }, { displayId: id }] }, include: withSlot });
  },

  updateAd(id, patch) {
    return prisma.adBooking.update({ where: { id }, data: patch, include: withSlot });
  },

  async transitionAd(id, from, patch) {
    const { count } = await prisma.adBooking.updateMany({ where: { id, status: { in: [...from] } }, data: patch });
    return count > 0;
  },

  async adHolds(slotId, from, to, excludeId) {
    return prisma.adBooking.findMany({
      where: { slotId, status: { in: [...HOLDING_STATUSES] }, ...overlapping(from, to), ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { startDate: true, endDate: true },
    });
  },

  listAdsForAdvertiser(advertiserId, statuses) {
    return prisma.adBooking.findMany({
      where: { advertiserId, ...(statuses?.length ? { status: { in: [...statuses] } } : {}) },
      orderBy: { createdAt: 'desc' },
      include: withSlot,
      take: 200,
    });
  },

  async listAdsPage(filter) {
    const base: Prisma.AdBookingWhereInput = {
      ...(filter.slotKey ? { slot: { key: filter.slotKey } } : {}),
      ...(filter.q
        ? {
            OR: [
              { displayId: { contains: filter.q, mode: 'insensitive' } },
              { title: { contains: filter.q, mode: 'insensitive' } },
              { headline: { contains: filter.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const where: Prisma.AdBookingWhereInput = { ...base, ...(filter.status?.length ? { status: { in: filter.status as PromotionStatus[] } } : {}) };
    const orderBy: Prisma.AdBookingOrderByWithRelationInput = filter.sort === 'START' ? { startDate: 'asc' } : { createdAt: 'desc' };
    const [items, total, groups] = await Promise.all([
      prisma.adBooking.findMany({ where, orderBy, include: withSlot, ...listArgs(filter) }),
      prisma.adBooking.count({ where }),
      prisma.adBooking.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, PROMOTION_STATUSES) };
  },

  adsWhere(where) {
    return prisma.adBooking.findMany({ where, include: withSlot, take: 500, orderBy: { createdAt: 'asc' } });
  },

  async runningAdsForSlot(slotKey, day) {
    const rows = await prisma.adBooking.findMany({ where: { slot: { key: slotKey, isActive: true }, ...runningOn(day), mediaId: { not: null } }, include: withSlot });
    const media = await prisma.mediaAsset.findMany({ where: { id: { in: rows.map((row) => row.mediaId!) } } });
    const byId = new Map(media.map((asset) => [asset.id, asset]));
    return rows.map((row) => ({ ...row, media: byId.get(row.mediaId!) ?? null }));
  },

  /* ── Boosts ───────────────────────────────────────────────────────── */

  createBoost(data) {
    return prisma.listingBoost.create({ data });
  },

  findBoost(id) {
    return prisma.listingBoost.findFirst({ where: { OR: [{ id }, { displayId: id }] } });
  },

  updateBoost(id, patch) {
    return prisma.listingBoost.update({ where: { id }, data: patch });
  },

  async transitionBoost(id, from, patch) {
    const { count } = await prisma.listingBoost.updateMany({ where: { id, status: { in: [...from] } }, data: patch });
    return count > 0;
  },

  async boostHolds(scope, from, to, excludeId) {
    return prisma.listingBoost.findMany({
      where: {
        placements: { has: scope.placement },
        category: scope.category,
        // The key when the listing had one; the spelling when it did not — as browse groups by city.
        ...(scope.cityId ? { cityId: scope.cityId } : { cityId: null, city: scope.city }),
        status: { in: [...HOLDING_STATUSES] },
        ...overlapping(from, to),
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { startDate: true, endDate: true },
    });
  },

  listBoostsForPublisher(publisherId, statuses) {
    return prisma.listingBoost.findMany({
      where: { publisherId, ...(statuses?.length ? { status: { in: [...statuses] } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  },

  async listBoostsPage(filter) {
    const base: Prisma.ListingBoostWhereInput = {
      ...(filter.placement ? { placements: { has: filter.placement } } : {}),
      ...(filter.q
        ? {
            OR: [
              { displayId: { contains: filter.q, mode: 'insensitive' } },
              { city: { contains: filter.q, mode: 'insensitive' } },
              { listingId: filter.q },
            ],
          }
        : {}),
    };
    const where: Prisma.ListingBoostWhereInput = { ...base, ...(filter.status?.length ? { status: { in: filter.status as PromotionStatus[] } } : {}) };
    const orderBy: Prisma.ListingBoostOrderByWithRelationInput = filter.sort === 'START' ? { startDate: 'asc' } : { createdAt: 'desc' };
    const [items, total, groups] = await Promise.all([
      prisma.listingBoost.findMany({ where, orderBy, ...listArgs(filter) }),
      prisma.listingBoost.count({ where }),
      prisma.listingBoost.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, PROMOTION_STATUSES) };
  },

  boostsWhere(where) {
    return prisma.listingBoost.findMany({ where, take: 500, orderBy: { createdAt: 'asc' } });
  },

  runningBoosts(placement, day) {
    return prisma.listingBoost.findMany({ where: { placements: { has: placement }, ...runningOn(day) }, select: { id: true, listingId: true } });
  },

  /* ── Media ────────────────────────────────────────────────────────── */

  findMedia(id) {
    return prisma.mediaAsset.findUnique({ where: { id } });
  },

  findMediaMany(ids) {
    return ids.length ? prisma.mediaAsset.findMany({ where: { id: { in: ids } } }) : Promise.resolve([]);
  },

  createMedia(data) {
    return prisma.mediaAsset.create({ data });
  },

  async archiveMedia(id, at) {
    await prisma.mediaAsset.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: at } });
  },

  /* ── Stats ────────────────────────────────────────────────────────── */

  async addStat({ date, adBookingId, boostId, surface, kind, count }) {
    // The table's unique index does not bite on the null half of the pair
    // (Postgres treats NULLs as distinct), so an upsert cannot key on it:
    // increment the day's row when one stands, write one when none does.
    // A race that writes two rows is harmless — every read sums `count`.
    const where = { date, adBookingId, boostId, surface, kind };
    const { count: updated } = await prisma.promotionStat.updateMany({ where, data: { count: { increment: count } } });
    if (updated === 0) await prisma.promotionStat.create({ data: { ...where, count } });
  },

  async statsFor(target) {
    const rows = await prisma.promotionStat.groupBy({
      by: ['adBookingId', 'boostId', 'date', 'kind'],
      where: target.adBookingId ? { adBookingId: target.adBookingId } : { boostId: target.boostId ?? '' },
      _sum: { count: true },
      orderBy: { date: 'asc' },
    });
    return rows.map((row) => ({ adBookingId: row.adBookingId, boostId: row.boostId, date: row.date, kind: row.kind, count: row._sum.count ?? 0 }));
  },

  async statsBetween(from, to) {
    const rows = await prisma.promotionStat.groupBy({
      by: ['adBookingId', 'boostId', 'date', 'kind'],
      where: { date: { gte: from, lte: to } },
      _sum: { count: true },
    });
    return rows.map((row) => ({ adBookingId: row.adBookingId, boostId: row.boostId, date: row.date, kind: row.kind, count: row._sum.count ?? 0 }));
  },

  async runningAdIds(ids, day) {
    if (!ids.length) return [];
    const rows = await prisma.adBooking.findMany({ where: { id: { in: ids }, ...runningOn(day) }, select: { id: true } });
    return rows.map((row) => row.id);
  },

  async runningBoostIds(ids, day) {
    if (!ids.length) return [];
    const rows = await prisma.listingBoost.findMany({ where: { id: { in: ids }, ...runningOn(day) }, select: { id: true } });
    return rows.map((row) => row.id);
  },

  /* ── Labels ───────────────────────────────────────────────────────── */

  listingLabels(ids) {
    if (!ids.length) return Promise.resolve([]);
    return prisma.listing.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayId: true, title: true, city: true, cityId: true, category: true, status: true, publisherId: true, rightsLapsedAt: true },
    });
  },

  async advertiserLabels(ids) {
    if (!ids.length) return [];
    const rows = await prisma.advertiser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, companyName: true, displayId: true } });
    return rows.map((row) => ({ id: row.id, name: row.companyName ?? row.name, displayId: row.displayId }));
  },

  publisherLabels(ids) {
    if (!ids.length) return Promise.resolve([]);
    return prisma.publisher.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, displayId: true } });
  },

  cityLabels(keys) {
    if (!keys.length) return Promise.resolve([]);
    return prisma.city.findMany({ where: { OR: [{ id: { in: keys } }, { slug: { in: keys.map((key) => key.toLowerCase()) } }] }, select: { id: true, slug: true, name: true } });
  },
};
