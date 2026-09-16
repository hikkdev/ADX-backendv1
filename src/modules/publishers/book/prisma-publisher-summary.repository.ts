import { Prisma, prisma } from '../../../shared/database';
import type { AccountActivity, AccountActivityKind, ListingCategory, ListingStatus } from '../../../shared/database';
import type { Decimal } from '../../../shared/money';
import { countsFrom, listArgs } from '../../../shared/pagination';
import { OCCUPYING_ORDER_STATUSES } from '../publishers.repository';
import { ACCOUNT_ACTIVITY_KINDS, type PublisherActivityQuery } from './publisher-book.schema';

/**
 * P-B: the publisher's own facts behind `GET /publishers/:id/summary` — the
 * spots, the bookings on them and the events this module itself can vouch
 * for. The money (accruals, wallet, payouts), the subscription and the
 * visits are read through their modules' exports in the service, never
 * their tables.
 */

/** One spot on the card, with the two live facts the frame draws. */
export type SummaryListing = {
  id: string;
  displayId: string | null;
  title: string;
  category: ListingCategory;
  city: string | null;
  status: ListingStatus;
  publishedAt: Date | null;
  ratePerDay: Decimal | null;
  /** The reviews module's snapshot on the spot — the only rating a publisher has. */
  ratingAvg: Decimal | null;
  reviewCount: number;
  /** A booking the publisher accepted whose flight covers now — the dashboard's rule. */
  occupied: boolean;
};

export type BookingFacts = { lifetime: number; thisMonth: number };

export type ActivityPage = { items: AccountActivity[]; total: number; counts: Record<string, number> };

export type SummaryFeedRow = { kind: 'ACTIVITY' | 'LISTING_LIVE' | 'BOOKING_AUTHORISED'; at: Date; title: string; detail: string | null };

const kindLabel: Record<string, string> = { CHECK_IN: 'Checked in', FOLLOW_UP: 'Followed up', CALLED: 'Called', MESSAGED: 'Messaged', NOTE: 'Note' };

export const prismaPublisherSummaryRepository = {
  /** R-B: one row of the action log, written by `POST /publishers/:id/activity`. */
  createActivity(data: { publisherId: string; agentId: string; kind: AccountActivityKind; note: string | null; createdByUserId: string; at: Date }): Promise<AccountActivity> {
    return prisma.accountActivity.create({ data });
  },

  /**
   * R-B: the log on the list contract — newest first, `status=` narrowing by
   * kind and `q=` reaching the note. The chips count with the kind facet
   * removed and the search kept, the contract's rule.
   */
  async listActivity(publisherId: string, query: PublisherActivityQuery): Promise<ActivityPage> {
    const base: Prisma.AccountActivityWhereInput = {
      publisherId,
      ...(query.q ? { note: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const where: Prisma.AccountActivityWhereInput = { ...base, ...(query.status?.length ? { kind: { in: query.status } } : {}) };
    const [items, total, groups] = await Promise.all([
      prisma.accountActivity.findMany({ where, orderBy: { at: 'desc' }, ...listArgs(query) }),
      prisma.accountActivity.count({ where }),
      prisma.accountActivity.groupBy({ by: ['kind'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups.map((group) => ({ status: group.kind, _count: group._count })), ACCOUNT_ACTIVITY_KINDS) };
  },

  async listingsOf(publisherId: string, now: Date): Promise<SummaryListing[]> {
    const live: Prisma.OrderWhereInput = {
      status: { in: [...OCCUPYING_ORDER_STATUSES] },
      OR: [{ startDate: null }, { startDate: { lte: now } }],
      AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
    };
    const rows = await prisma.listing.findMany({
      where: { publisherId },
      select: {
        id: true,
        displayId: true,
        title: true,
        category: true,
        city: true,
        status: true,
        publishedAt: true,
        ratePerDay: true,
        ratingAvg: true,
        reviewCount: true,
        orders: { where: live, select: { id: true }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ orders, ...listing }) => ({ ...listing, occupied: orders.length > 0 }));
  },

  /**
   * Bookings raised on the publisher's spots that were not abandoned as
   * drafts — the book's "12 Bookings" — lifetime and inside the month window.
   */
  async bookingFacts(publisherId: string, month: { start: Date; end: Date }): Promise<BookingFacts> {
    const base: Prisma.OrderWhereInput = { listing: { publisherId }, status: { not: 'DRAFT' } };
    const [lifetime, thisMonth] = await Promise.all([
      prisma.order.count({ where: base }),
      prisma.order.count({ where: { ...base, createdAt: { gte: month.start, lt: month.end } } }),
    ]);
    return { lifetime, thisMonth };
  },

  /**
   * The events this module can vouch for: the action log on the publisher,
   * spots that went live (`publishedAt`), and bookings the publisher
   * authorised — by their own hand or by instant booking. Each source capped
   * at `limit`; the service merges them with the other modules' events.
   */
  async feedOf(publisherId: string, limit: number): Promise<SummaryFeedRow[]> {
    const [activity, live, authorised] = await Promise.all([
      prisma.accountActivity.findMany({ where: { publisherId }, orderBy: { at: 'desc' }, take: limit }),
      prisma.listing.findMany({
        where: { publisherId, publishedAt: { not: null } },
        select: { title: true, publishedAt: true },
        orderBy: { publishedAt: 'desc' },
        take: limit,
      }),
      prisma.order.findMany({
        where: { listing: { publisherId }, OR: [{ publisherAcceptedAt: { not: null } }, { autoAcceptedAt: { not: null } }] },
        select: { campaignName: true, publisherAcceptedAt: true, autoAcceptedAt: true, listing: { select: { title: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);
    return [
      ...activity.map((row) => ({ kind: 'ACTIVITY' as const, at: row.at, title: kindLabel[row.kind] ?? row.kind, detail: row.note })),
      ...live.map((row) => ({ kind: 'LISTING_LIVE' as const, at: row.publishedAt!, title: `Listing went live: ${row.title}`, detail: null })),
      ...authorised.map((row) => ({
        kind: 'BOOKING_AUTHORISED' as const,
        at: (row.publisherAcceptedAt ?? row.autoAcceptedAt)!,
        title: `Booking authorised: ${row.campaignName ?? 'Untitled campaign'}`,
        detail: row.autoAcceptedAt && !row.publisherAcceptedAt ? `${row.listing.title} · instant booking` : row.listing.title,
      })),
    ];
  },
};

export type PublisherSummaryRepository = typeof prismaPublisherSummaryRepository;
