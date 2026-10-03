import { LISTING_PRIVATE_COLUMNS, Prisma, prisma } from '../../shared/database';
import { money } from '../../shared/money';
import {
  ADMIN_RECORD_INCLUDE,
  INSIGHT_METRICS,
  type InsightDayRow,
  type InsightLifetimeRow,
  type InsightMetric,
  type InstantSpan,
  type ListingDeskRepository,
} from './listing-desk.repository';
import { blockedDatesWhere, datedHolds, slotHoldingOrdersWhere, type SlotWindow } from './slot-holds';

/**
 * The listing page's reads (3 Oct 2026). See `listing-desk.repository.ts`.
 *
 * The insights are aggregates only: one raw `SELECT … UNION ALL …` folds
 * every metric's rows into (metric, Indian day, count, sum) — Prisma's
 * `groupBy` groups a timestamp by its exact instant, and the joins behind
 * a scan (event → code → campaign spot → listing) are not something its
 * builder can group across. Every value is bound as a parameter; the enum
 * literals are constants of this file.
 */

/** A row's instant as the Indian day it fell on. */
const IST_DAY = (column: string) => Prisma.raw(`to_char((${column} + interval '330 minutes')::date, 'YYYY-MM-DD')`);

/** Orders that are bookings: everything past the advertiser's draft. */
const NOT_A_BOOKING = Prisma.raw(`('DRAFT')`);

type RawRow = { metric: string; day?: string; count: bigint | number; sum: unknown };

const isMetric = (value: string): value is InsightMetric => (INSIGHT_METRICS as readonly string[]).includes(value);
const sumOf = (value: unknown): string | null => (value === null || value === undefined ? null : money(String(value)));

/**
 * The (metric, day, count, sum) rows for one listing. With no window it is
 * the lifetime read: the same SELECTs without the day column or the bounds.
 */
function insightQuery(listingId: string, window: { span: InstantSpan; fromDay: string; toDay: string } | null): Prisma.Sql {
  const dayCol = (column: string) => (window ? Prisma.sql`${IST_DAY(column)} AS day,` : Prisma.empty);
  const groupDay = window ? Prisma.sql`GROUP BY 2` : Prisma.empty;
  const between = (column: string) =>
    window ? Prisma.sql`AND ${Prisma.raw(column)} >= ${window.span.start} AND ${Prisma.raw(column)} < ${window.span.end}` : Prisma.empty;
  const days = window ? Prisma.sql`AND a."forDate" >= ${window.fromDay}::date AND a."forDate" <= ${window.toDay}::date` : Prisma.empty;
  const accrualDay = window ? Prisma.sql`to_char(a."forDate", 'YYYY-MM-DD') AS day,` : Prisma.empty;
  /* LD-1: the spot page's day rows — already Indian days, bounded like the accruals. */
  const viewDay = window ? Prisma.sql`to_char(lv."day", 'YYYY-MM-DD') AS day,` : Prisma.empty;
  const viewDays = window ? Prisma.sql`AND lv."day" >= ${window.fromDay}::date AND lv."day" <= ${window.toDay}::date` : Prisma.empty;
  /* The tracking events: by type, through the code's spot to this listing. */
  const tracked = (type: string, metric: InsightMetric) => Prisma.sql`
    SELECT ${metric} AS metric, ${dayCol('e."occurredAt"')} count(*) AS count, NULL::numeric AS sum
      FROM "TrackingEvent" e
      JOIN "CampaignTrackingCode" c ON c.id = e."codeId"
      JOIN "CampaignSpot" s ON s.id = c."spotId"
     WHERE s."listingId" = ${listingId} AND e.type = ${Prisma.raw(`'${type}'`)}::"TrackingEventType" ${between('e."occurredAt"')}
     ${groupDay}`;

  return Prisma.sql`
    SELECT 'saves' AS metric, ${dayCol('v."createdAt"')} count(*) AS count, NULL::numeric AS sum
      FROM "SavedListing" v
     WHERE v."listingId" = ${listingId} ${between('v."createdAt"')}
     ${groupDay}
    UNION ALL
    SELECT 'bookings' AS metric, ${dayCol('o."createdAt"')} count(*) AS count, NULL::numeric AS sum
      FROM "Order" o
     WHERE o."listingId" = ${listingId} AND o.status NOT IN ${NOT_A_BOOKING} ${between('o."createdAt"')}
     ${groupDay}
    UNION ALL
    SELECT 'bookedValue' AS metric, ${dayCol('o."createdAt"')} count(*) AS count, sum(s."lineTotal") AS sum
      FROM "Order" o
      JOIN "CampaignSpot" s ON s."orderId" = o.id
     WHERE o."listingId" = ${listingId} AND o.status NOT IN ${NOT_A_BOOKING} ${between('o."createdAt"')}
     ${groupDay}
    UNION ALL
    ${tracked('SCAN', 'scans')}
    UNION ALL
    ${tracked('CLICK', 'clicks')}
    UNION ALL
    ${tracked('FORM_SUBMIT', 'enquiries')}
    UNION ALL
    ${tracked('VIEW', 'landingViews')}
    UNION ALL
    SELECT 'reviews' AS metric, ${dayCol('r."createdAt"')} count(*) AS count, sum(r.rating)::numeric AS sum
      FROM "Review" r
     WHERE r."subjectType" = 'LISTING'::"ReviewSubjectType" AND r."subjectId" = ${listingId}
       AND r.status = 'PUBLISHED'::"ReviewStatus" ${between('r."createdAt"')}
     ${groupDay}
    UNION ALL
    SELECT 'gmv' AS metric, ${accrualDay} count(*) AS count, sum(a.gross) AS sum
      FROM "EarningAccrual" a
     WHERE a."listingId" = ${listingId} ${days}
     ${groupDay}
    UNION ALL
    SELECT 'views' AS metric, ${viewDay} COALESCE(sum(lv.views), 0)::bigint AS count, NULL::numeric AS sum
      FROM "ListingView" lv
     WHERE lv."listingId" = ${listingId} ${viewDays}
     ${groupDay}
    UNION ALL
    SELECT 'uniqueVisitors' AS metric, ${viewDay} COALESCE(sum(lv."uniqueVisitors"), 0)::bigint AS count, NULL::numeric AS sum
      FROM "ListingView" lv
     WHERE lv."listingId" = ${listingId} ${viewDays}
     ${groupDay}`;
}

export const prismaListingDeskRepository: ListingDeskRepository = {
  findRecordForAdmin(listingId) {
    // The desk sees the RC answer and learns whether a site QR exists; the token itself is dropped in the service.
    return prisma.listing.findUnique({ where: { id: listingId }, include: ADMIN_RECORD_INCLUDE, omit: LISTING_PRIVATE_COLUMNS });
  },

  async userNamesById(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return [];
    return prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  },

  async photoStamps(photos) {
    const ids = [...new Set(photos.map((photo) => photo.uploadedFileId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
    const urls = [...new Set(photos.filter((photo) => !photo.uploadedFileId).map((photo) => photo.url).filter(Boolean))];
    if (ids.length === 0 && urls.length === 0) return [];
    return prisma.uploadedFile.findMany({
      where: { OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(urls.length ? [{ url: { in: urls } }] : [])] },
      select: { id: true, url: true, takenAt: true, latitude: true, longitude: true, accuracyM: true, geoStamped: true },
    });
  },

  async boostsFor(listingId, take) {
    const [items, total] = await Promise.all([
      prisma.listingBoost.findMany({
        where: { listingId },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, displayId: true, placements: true, status: true, startDate: true, endDate: true, days: true, total: true, paidAt: true, createdAt: true },
      }),
      prisma.listingBoost.count({ where: { listingId } }),
    ]);
    return { items, total };
  },

  async customFieldValuesFor(listingId) {
    const rows = await prisma.customFieldValue.findMany({
      where: { entity: 'LISTING', entityId: listingId },
      select: { value: true, updatedAt: true, def: { select: { key: true, label: true, kind: true, sortOrder: true, archivedAt: true } } },
      orderBy: [{ def: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
    });
    return rows.map((row) => ({
      key: row.def.key,
      label: row.def.label,
      kind: row.def.kind,
      archived: row.def.archivedAt !== null,
      value: row.value,
      updatedAt: row.updatedAt,
    }));
  },

  insightFacts(listingId) {
    return prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, slotsTotal: true, publishedAt: true, createdAt: true, ratingAvg: true, reviewCount: true },
    });
  },

  async insightDays(listingId, span, days) {
    const rows = await prisma.$queryRaw<RawRow[]>(insightQuery(listingId, { span, ...days }));
    const out: InsightDayRow[] = [];
    for (const row of rows) {
      if (!isMetric(row.metric) || !row.day) continue;
      out.push({ metric: row.metric, day: row.day, count: Number(row.count), sum: sumOf(row.sum) });
    }
    return out;
  },

  async insightLifetime(listingId) {
    const rows = await prisma.$queryRaw<RawRow[]>(insightQuery(listingId, null));
    const out: InsightLifetimeRow[] = [];
    for (const row of rows) {
      if (!isMetric(row.metric)) continue;
      out.push({ metric: row.metric, count: Number(row.count), sum: sumOf(row.sum) });
    }
    return out;
  },

  async occupancyHolds(listingId, window: SlotWindow) {
    const [orders, blocks] = await Promise.all([
      prisma.order.findMany({
        where: { listingId, ...slotHoldingOrdersWhere(window) },
        select: { listingId: true, startDate: true, endDate: true, campaignSpot: { select: { quantity: true } } },
      }),
      prisma.listingBlockedDate.findMany({
        where: { listingId, ...blockedDatesWhere(window) },
        select: { listingId: true, from: true, to: true, listing: { select: { slotsTotal: true } } },
      }),
    ]);
    // Reservations are not bookings: a cart held for twenty minutes occupies nothing.
    return datedHolds({ orders, reservations: [], blocks });
  },
};
