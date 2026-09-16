import { Prisma, prisma } from '../../../shared/database';
import type { ListingCategory } from '../../../shared/database';
import { Decimal } from '../../../shared/money';
import { countsFrom, listArgs } from '../../../shared/pagination';
import { PUBLISHER_BOOK_STATUSES, type PublisherBookQuery } from './publisher-book.schema';

export type BookPublisher = {
  id: string;
  displayId: string | null;
  name: string;
  mobile: string;
  city: string | null;
  address: string | null;
  kycStatus: string;
  onboardingStatus: string;
  activatedAt: Date | null;
  createdAt: Date;
};

export type PublisherFacts = {
  listings: number;
  /** Orders raised on the publisher's listings that were not abandoned as drafts. */
  bookings: number;
  /** Distinct categories of the publisher's listings — the only category a publisher has. */
  categories: ListingCategory[];
  /** Net earnings accrued to date, as Decimal. */
  revenue: Decimal;
};

/** ACTIVE has come all the way through; PENDING has not. */
const statusWhere = (status: string): Prisma.PublisherWhereInput =>
  status === 'ACTIVE'
    ? { onboardingStatus: 'ONBOARDING_COMPLETE', kycStatus: 'VERIFIED' }
    : { OR: [{ onboardingStatus: { not: 'ONBOARDING_COMPLETE' } }, { kycStatus: { not: 'VERIFIED' } }] };

const select = {
  id: true,
  displayId: true,
  name: true,
  mobile: true,
  city: true,
  address: true,
  kycStatus: true,
  onboardingStatus: true,
  activatedAt: true,
  createdAt: true,
} as const;

export const prismaPublisherBookRepository = {
  async findBook(agentId: string, query: PublisherBookQuery): Promise<{ items: BookPublisher[]; total: number; counts: Record<string, number> }> {
    const base: Prisma.PublisherWhereInput = {
      agentId,
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { city: { contains: query.q, mode: 'insensitive' } },
              { address: { contains: query.q, mode: 'insensitive' } },
              { displayId: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const where: Prisma.PublisherWhereInput = {
      AND: [base, ...(query.status?.length ? [{ OR: query.status.map(statusWhere) }] : [])],
    };
    const orderBy: Prisma.PublisherOrderByWithRelationInput[] = query.sort === 'NAME' ? [{ name: 'asc' }] : [{ createdAt: 'desc' }];
    const [items, total, active, pending] = await Promise.all([
      prisma.publisher.findMany({ where, orderBy, ...listArgs(query), select }),
      prisma.publisher.count({ where }),
      prisma.publisher.count({ where: { AND: [base, statusWhere('ACTIVE')] } }),
      prisma.publisher.count({ where: { AND: [base, statusWhere('PENDING')] } }),
    ]);
    const counts = countsFrom(
      [
        { status: 'ACTIVE', _count: { _all: active } },
        { status: 'PENDING', _count: { _all: pending } },
      ],
      PUBLISHER_BOOK_STATUSES,
    );
    return { items, total, counts };
  },

  async facts(publisherIds: string[]): Promise<Map<string, PublisherFacts>> {
    if (publisherIds.length === 0) return new Map();
    const [listings, accruals, bookings] = await Promise.all([
      prisma.listing.findMany({
        where: { publisherId: { in: publisherIds } },
        select: { publisherId: true, category: true },
      }),
      prisma.earningAccrual.groupBy({
        by: ['publisherId'],
        where: { publisherId: { in: publisherIds } },
        _sum: { net: true },
      }),
      prisma.order.findMany({
        where: { listing: { publisherId: { in: publisherIds } }, status: { not: 'DRAFT' } },
        select: { listing: { select: { publisherId: true } } },
      }),
    ]);
    const facts = new Map<string, PublisherFacts>();
    const ensure = (id: string) => {
      const current = facts.get(id) ?? { listings: 0, bookings: 0, categories: [], revenue: new Decimal(0) };
      facts.set(id, current);
      return current;
    };
    for (const order of bookings) {
      if (order.listing.publisherId) ensure(order.listing.publisherId).bookings += 1;
    }
    for (const listing of listings) {
      if (!listing.publisherId) continue;
      const current = ensure(listing.publisherId);
      current.listings += 1;
      if (!current.categories.includes(listing.category)) current.categories.push(listing.category);
    }
    for (const group of accruals) {
      ensure(group.publisherId).revenue = new Decimal(group._sum.net ?? 0);
    }
    return facts;
  },
};
