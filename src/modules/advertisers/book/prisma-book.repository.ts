import { Prisma, prisma } from '../../../shared/database';
import type { CampaignStatus, FieldVisitStatus } from '../../../shared/database';
import { Decimal } from '../../../shared/money';
import { countsFrom, listArgs } from '../../../shared/pagination';
import type { BookRepository, BrandCounts, CampaignFacts, CampaignLine, FeedEvent, OpenVisit } from './book.repository';
import { BOOK_STATUSES, type AdvertiserBookQuery } from './book.schema';

/** Money has been committed on these. DRAFT and PENDING_PAYMENT have committed nothing. */
const COMMITTED: CampaignStatus[] = ['SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED'];
const OPEN_VISIT: FieldVisitStatus[] = ['REQUESTED', 'SCHEDULED', 'IN_PROGRESS'];

const accountSelect = {
  id: true,
  displayId: true,
  name: true,
  companyName: true,
  mobile: true,
  city: true,
  kycStatus: true,
  activatedAt: true,
  createdAt: true,
} as const;

const lineSelect = {
  id: true,
  name: true,
  status: true,
  budget: true,
  startDate: true,
  endDate: true,
  brandId: true,
  awareness: true,
  industry: true,
  createdAt: true,
  _count: { select: { spots: true } },
} as const;

const toLine = (row: {
  id: string; name: string; status: CampaignStatus; budget: Decimal | null; startDate: Date | null; endDate: Date | null;
  brandId: string | null; awareness: string | null; industry: string | null; createdAt: Date; _count: { spots: number };
}): CampaignLine => ({
  id: row.id,
  name: row.name,
  status: row.status,
  budget: row.budget,
  startDate: row.startDate,
  endDate: row.endDate,
  spots: row._count.spots,
  brandId: row.brandId,
  awareness: row.awareness,
  industry: row.industry,
  createdAt: row.createdAt,
});

/** ACTIVE is an activated account; PENDING is one still on its way. */
const statusWhere = (status: string): Prisma.AdvertiserWhereInput =>
  status === 'ACTIVE' ? { activatedAt: { not: null } } : { activatedAt: null };

export const prismaBookRepository: BookRepository = {
  async findBook(agentId, query) {
    const base: Prisma.AdvertiserWhereInput = {
      agentId,
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { companyName: { contains: query.q, mode: 'insensitive' } },
              { city: { contains: query.q, mode: 'insensitive' } },
              { displayId: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const where: Prisma.AdvertiserWhereInput = {
      AND: [base, ...(query.status?.length ? [{ OR: query.status.map(statusWhere) }] : [])],
    };
    const orderBy: Prisma.AdvertiserOrderByWithRelationInput[] =
      query.sort === 'NAME' ? [{ companyName: 'asc' }, { name: 'asc' }] : [{ createdAt: 'desc' }];

    const [items, total, active, pending] = await Promise.all([
      prisma.advertiser.findMany({ where, orderBy, ...listArgs(query), select: accountSelect }),
      prisma.advertiser.count({ where }),
      prisma.advertiser.count({ where: { AND: [base, statusWhere('ACTIVE')] } }),
      prisma.advertiser.count({ where: { AND: [base, statusWhere('PENDING')] } }),
    ]);
    // The chips are not a column, so the histogram is two counts rather than a groupBy.
    const counts = countsFrom(
      [
        { status: 'ACTIVE', _count: { _all: active } },
        { status: 'PENDING', _count: { _all: pending } },
      ],
      BOOK_STATUSES,
    );
    return { items, total, counts };
  },

  async campaignFacts(advertiserIds) {
    if (advertiserIds.length === 0) return new Map();
    const rows = await prisma.campaign.findMany({
      where: { advertiserId: { in: advertiserIds } },
      select: { advertiserId: true, status: true, budget: true, createdAt: true, industry: true, subCategory: true },
      orderBy: { createdAt: 'desc' },
    });
    const facts = new Map<string, CampaignFacts>();
    for (const row of rows) {
      const current = facts.get(row.advertiserId) ?? { total: 0, live: 0, spend: new Decimal(0), lastCreatedAt: null, industry: null, subCategory: null };
      if (!current.subCategory && row.subCategory) current.subCategory = row.subCategory;
      // A draft the wizard never finished is not a campaign the card counts.
      if (row.status !== 'DRAFT') current.total += 1;
      if (row.status === 'LIVE') current.live += 1;
      if (COMMITTED.includes(row.status) && row.budget) current.spend = current.spend.plus(row.budget);
      // Rows arrive newest first, so the first one seen names the industry and the last campaign.
      if (!current.lastCreatedAt) current.lastCreatedAt = row.createdAt;
      if (!current.industry && row.industry) current.industry = row.industry;
      facts.set(row.advertiserId, current);
    }
    return facts;
  },

  async openVisits(advertiserIds) {
    if (advertiserIds.length === 0) return new Map();
    const rows = await prisma.fieldVisit.findMany({
      where: { advertiserId: { in: advertiserIds }, status: { in: OPEN_VISIT } },
      select: { id: true, advertiserId: true, status: true, scheduledFor: true },
      orderBy: [{ scheduledFor: { sort: 'asc', nulls: 'last' } }],
    });
    const visits = new Map<string, OpenVisit>();
    for (const row of rows) {
      if (row.advertiserId && !visits.has(row.advertiserId)) {
        visits.set(row.advertiserId, { id: row.id, advertiserId: row.advertiserId, status: row.status, scheduledFor: row.scheduledFor });
      }
    }
    return visits;
  },

  findAccount(advertiserId) {
    return prisma.advertiser.findUnique({ where: { id: advertiserId }, select: accountSelect });
  },

  async campaignsOf(advertiserId) {
    const rows = await prisma.campaign.findMany({
      where: { advertiserId, status: { not: 'DRAFT' } },
      select: lineSelect,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(toLine);
  },

  spotsOf(advertiserId) {
    return prisma.campaignSpot.count({ where: { campaign: { advertiserId }, status: { in: ['BOOKED', 'LIVE', 'COMPLETED'] } } });
  },

  async feedOf(advertiserId, limit) {
    const [activity, visits, campaigns, sales] = await Promise.all([
      prisma.accountActivity.findMany({ where: { advertiserId }, orderBy: { at: 'desc' }, take: limit }),
      prisma.fieldVisit.findMany({
        where: { advertiserId, status: { in: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] } },
        select: { kind: true, status: true, businessName: true, locality: true, completedAt: true, scheduledFor: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.campaign.findMany({
        where: { advertiserId, status: { in: ['LIVE', 'COMPLETED'] }, startDate: { not: null } },
        select: { name: true, startDate: true },
        orderBy: { startDate: 'desc' },
        take: limit,
      }),
      prisma.packageSale.findMany({
        where: { advertiserId, paidAt: { not: null } },
        select: { packageName: true, paidAt: true },
        orderBy: { paidAt: 'desc' },
        take: limit,
      }),
    ]);
    const kindLabel: Record<string, string> = { CHECK_IN: 'Checked in', FOLLOW_UP: 'Followed up', CALLED: 'Called', MESSAGED: 'Messaged', NOTE: 'Note' };
    const events: FeedEvent[] = [
      ...activity.map((row) => ({ kind: 'ACTIVITY' as const, at: row.at, title: kindLabel[row.kind] ?? row.kind, detail: row.note })),
      ...visits.map((row) => ({
        kind: 'FIELD_VISIT' as const,
        at: row.completedAt ?? row.scheduledFor ?? row.createdAt,
        title: `${row.kind === 'ONBOARDING' ? 'Onboarded' : row.kind === 'RENEWAL' ? 'Renewal visit' : 'Visit'} at ${row.businessName}${row.locality ? ` ${row.locality}` : ''}`,
        detail: row.status === 'COMPLETED' ? null : row.status === 'IN_PROGRESS' ? 'In progress' : 'Scheduled',
      })),
      ...campaigns.map((row) => ({ kind: 'CAMPAIGN_LIVE' as const, at: row.startDate!, title: `Campaign went live: ${row.name}`, detail: null })),
      ...sales.map((row) => ({ kind: 'PACKAGE_PAID' as const, at: row.paidAt!, title: `Package paid: ${row.packageName}`, detail: null })),
    ];
    return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  },

  createActivity(data) {
    return prisma.accountActivity.create({ data });
  },

  listActivity(advertiserId, limit) {
    return prisma.accountActivity.findMany({ where: { advertiserId }, orderBy: { at: 'desc' }, take: limit });
  },

  brandsOf(advertiserId, status) {
    return prisma.brand.findMany({
      where: { advertiserId, ...(status === 'ACTIVE' ? { isActive: true } : status === 'ARCHIVED' ? { isActive: false } : {}) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  },

  findBrand(advertiserId, brandId) {
    return prisma.brand.findFirst({ where: { id: brandId, advertiserId } });
  },

  async brandCounts(brandIds) {
    if (brandIds.length === 0) return new Map();
    const rows = await prisma.campaign.findMany({
      where: { brandId: { in: brandIds } },
      select: { brandId: true, status: true, budget: true, awareness: true, industry: true, subCategory: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const counts = new Map<string, BrandCounts>();
    for (const row of rows) {
      if (!row.brandId) continue;
      const current = counts.get(row.brandId) ?? { campaigns: 0, live: 0, scheduled: 0, spend: new Decimal(0), awareness: null, industry: null, subCategory: null };
      // Newest first: the first campaign seen names the brand's industry and sub-category.
      if (!current.industry && row.industry) current.industry = row.industry;
      if (!current.subCategory && row.subCategory) current.subCategory = row.subCategory;
      current.campaigns += 1;
      if (row.status === 'LIVE') current.live += 1;
      if (row.status === 'SCHEDULED') current.scheduled += 1;
      if (COMMITTED.includes(row.status) && row.budget) current.spend = current.spend.plus(row.budget);
      if (!current.awareness && row.awareness) current.awareness = row.awareness;
      counts.set(row.brandId, current);
    }
    return counts;
  },

  async campaignsOfBrand(brandId) {
    const rows = await prisma.campaign.findMany({ where: { brandId }, select: lineSelect, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(toLine);
  },
};
