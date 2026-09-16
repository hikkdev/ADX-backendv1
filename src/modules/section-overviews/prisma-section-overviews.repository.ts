import { Prisma, prisma } from '../../shared/database';
import { KYC_QUEUE_STATES, kycPartyStateWhere, type KycQueueState } from '../../shared/kyc-state';
import { Decimal, money, type Money } from '../../shared/money';
import type {
  CityCount,
  CityGroup,
  DayCount,
  DaySum,
  GroupCount,
  KycStateCountMap,
  Scope,
  SectionOverviewsRepository,
  Window,
} from './section-overviews.repository';

/**
 * Aggregates only — every method below is a `count`, an `aggregate`, a
 * `groupBy` folded into counts, or (twice) a raw `SELECT` that is itself one
 * aggregate (an AVG over a date difference, a GROUP BY over an unnested
 * array — neither of which Prisma's query builder can express). Nothing here
 * returns a row.
 *
 * Series by day: Prisma groups a timestamp column by its exact value, so a
 * `groupBy` over `createdAt` gives one group per instant; the fold below
 * buckets those into Indian days. The groups are bounded by the window's
 * rows, and the columns that are a `@db.Date` (`EarningAccrual.forDate`)
 * group by the day directly.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const between = (window: Window) => ({ gte: window.start, lt: window.end });
const before = (at: Date) => ({ lt: at });
/** The spelling clause alone — for a table that carries no key (PrintQuoteRequest), and as the fallback below. */
const cityStringOf = (scope: Scope) => (scope.city ? { city: { equals: scope.city.trim(), mode: 'insensitive' as const } } : {});
/**
 * Lot X-B: the key is the identity. A party row is in the scope's city by
 * its key when the facet resolved to one, whatever it was typed as; a row
 * with no key (a typed town) by the spelling, case-insensitively — which is
 * also all a facet that resolved to no key can ever match. Spread it, or put
 * it under AND beside another OR.
 */
type CityWhere = { OR?: ({ cityId: string } | { cityId: null; city: { equals: string; mode: 'insensitive' } })[]; cityId?: null; city?: { equals: string; mode: 'insensitive' } };
const cityOf = (scope: Scope): CityWhere => {
  if (!scope.city) return {};
  const spelling = { equals: scope.city.trim(), mode: 'insensitive' as const };
  return scope.cityId ? { OR: [{ cityId: scope.cityId }, { cityId: null, city: spelling }] } : { cityId: null, city: spelling };
};
/** The same narrowing through a relation — omitted entirely without a city, so a nullable relation is not asked to exist. */
const viaCity = (scope: Scope) => (scope.city ? cityOf(scope) : undefined);
const notNull = { not: null } as const;

/**
 * Lot X-B: the city groups of one party table — the keyed rows grouped by
 * `cityId` and labelled from the `City` row, the rows with no key folded
 * into one group carrying the strings they were typed under.
 */
type KeyedGroup = { cityId: string | null; _count: { _all: number } };
type TypedGroup = { city: string | null; _count: { _all: number } };
async function cityGroups(keyed: readonly KeyedGroup[], typed: readonly TypedGroup[]): Promise<CityCount[]> {
  const ids = keyed.map((group) => group.cityId).filter((id): id is string => id !== null);
  const cities = ids.length ? await prisma.city.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, name: true } }) : [];
  const byId = new Map(cities.map((city) => [city.id, city]));
  const rows: CityCount[] = keyed
    .filter((group): group is KeyedGroup & { cityId: string } => group.cityId !== null)
    .map((group) => {
      const city = byId.get(group.cityId);
      return { cityId: group.cityId, slug: city?.slug ?? null, name: city?.name ?? null, typed: [], count: group._count._all };
    });
  const strings = typed.filter((group): group is TypedGroup & { city: string } => !!group.city && group.city.trim() !== '');
  if (strings.length) {
    rows.push({
      cityId: null,
      slug: null,
      name: null,
      typed: [...new Set(strings.map((group) => group.city.trim()))].sort((a, b) => a.localeCompare(b)),
      count: strings.reduce((n, group) => n + group._count._all, 0),
    });
  }
  return rows.sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''));
}
/** Merges city groups from several tables (the users overview) by key, the typed buckets folded together. */
function mergeCityGroups(lists: readonly CityCount[][]): CityCount[] {
  const byKey = new Map<string, CityCount>();
  for (const row of lists.flat()) {
    const key = row.cityId ?? '';
    const current = byKey.get(key);
    if (!current) byKey.set(key, { ...row, typed: [...row.typed] });
    else {
      current.count += row.count;
      current.typed = [...new Set([...current.typed, ...row.typed])].sort((a, b) => a.localeCompare(b));
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''));
}
/** The where a keyed group's own counts read — the key, or the typed strings for the null bucket. */
const groupWhere = (group: CityGroup) => (group.cityId ? { cityId: group.cityId } : { cityId: null, city: { in: group.typed, mode: 'insensitive' as const } });

/** The Indian calendar day an instant falls in. */
export const istDay = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

function foldDays(points: readonly { at: Date | null; count: number }[]): DayCount[] {
  const days = new Map<string, number>();
  for (const point of points) {
    if (!point.at) continue;
    const day = istDay(point.at);
    days.set(day, (days.get(day) ?? 0) + point.count);
  }
  return [...days.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day));
}

function foldSums(points: readonly { at: Date | null; sum: Decimal | null }[]): DaySum[] {
  const days = new Map<string, Decimal>();
  for (const point of points) {
    if (!point.at) continue;
    const day = istDay(point.at);
    days.set(day, (days.get(day) ?? new Decimal(0)).plus(point.sum ?? 0));
  }
  return [...days.entries()].map(([day, sum]) => ({ day, sum: money(sum) })).sort((a, b) => a.day.localeCompare(b.day));
}

/** Per-party `_min` timestamps kept when they fall inside the window, then folded by day. */
function firstsInWindow(mins: readonly (Date | null)[], window: Window): DayCount[] {
  return foldDays(mins.filter((at): at is Date => !!at && at >= window.start && at < window.end).map((at) => ({ at, count: 1 })));
}

const groups = (rows: readonly { key: string | null; count: number }[]): GroupCount[] =>
  rows
    .filter((row): row is { key: string; count: number } => row.key !== null && row.key !== '')
    .map((row) => ({ key: row.key, count: row.count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

async function kycByState(count: (state: KycQueueState) => Promise<number>): Promise<KycStateCountMap> {
  const entries = await Promise.all(KYC_QUEUE_STATES.map(async (state) => [state, await count(state)] as const));
  return Object.fromEntries(entries) as KycStateCountMap;
}

const sum = (value: Decimal | null | undefined): Money => money(value ?? 0);

export const prismaSectionOverviewsRepository: SectionOverviewsRepository = {
  /* ── publishers ──────────────────────────────────────────────────────── */

  publishersAsAt(at, scope) {
    return prisma.publisher.count({ where: { createdAt: before(at), ...cityOf(scope) } });
  },
  publishersCreated(window, scope) {
    return prisma.publisher.count({ where: { createdAt: between(window), ...cityOf(scope) } });
  },
  async publishersCreatedByDay(window, scope) {
    const rows = await prisma.publisher.groupBy({ by: ['createdAt'], where: { createdAt: between(window), ...cityOf(scope) }, _count: { _all: true } });
    return foldDays(rows.map((row) => ({ at: row.createdAt, count: row._count._all })));
  },
  publishersWithLiveListing(scope) {
    return prisma.publisher.count({ where: { ...cityOf(scope), listings: { some: { status: 'ACTIVE' } } } });
  },
  publishersKycByState(scope) {
    return kycByState((state) => prisma.publisher.count({ where: { AND: [cityOf(scope), kycPartyStateWhere(state, true)] } }));
  },
  publishersSuspended(scope) {
    return prisma.publisher.count({ where: { ...cityOf(scope), suspendedAt: notNull } });
  },
  publishersClosed(scope) {
    return prisma.publisher.count({ where: { ...cityOf(scope), user: { closedAt: notNull } } });
  },
  async publishersFirstListingByDay(window, scope) {
    const rows = await prisma.listing.groupBy({
      by: ['publisherId'],
      where: { publisherId: notNull, publishedAt: { not: null, lt: window.end }, publisher: viaCity(scope) },
      _min: { publishedAt: true },
    });
    return firstsInWindow(rows.map((row) => row._min.publishedAt), window);
  },
  async publishersFirstBookingByDay(window, scope) {
    // `forDate` is a UTC-midnight date; an IST window's bounds fall at 18:30
    // UTC the evening before, so the comparison lands on the right days.
    const rows = await prisma.earningAccrual.groupBy({
      by: ['publisherId'],
      where: { forDate: { lt: window.end }, publisher: viaCity(scope) },
      _min: { forDate: true },
    });
    return firstsInWindow(rows.map((row) => row._min.forDate), window);
  },
  async publishersByCity(window, scope) {
    const [keyed, typed] = await Promise.all([
      prisma.publisher.groupBy({ by: ['cityId'], where: { cityId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
      prisma.publisher.groupBy({ by: ['city'], where: { cityId: null, city: notNull, ...cityOf(scope) }, _count: { _all: true } }),
    ]);
    const cities = await cityGroups(keyed, typed);
    return Promise.all(
      cities.map(async (group) => {
        const publisher = groupWhere(group);
        const [listings, gross] = await Promise.all([
          prisma.listing.count({ where: { status: 'ACTIVE', publisher } }),
          prisma.earningAccrual.aggregate({ where: { forDate: between(window), publisher }, _sum: { gross: true } }),
        ]);
        return { ...group, listings, gmv: sum(gross._sum.gross) };
      }),
    );
  },
  async publishersByCategory(scope) {
    const categories = await prisma.listing.groupBy({ by: ['category'], where: { status: 'ACTIVE', publisher: viaCity(scope) }, _count: { _all: true } });
    return Promise.all(
      categories.map(async (group) => ({
        key: group.category,
        listings: group._count._all,
        publishers: await prisma.publisher.count({ where: { ...cityOf(scope), listings: { some: { category: group.category } } } }),
      })),
    );
  },
  async runningSubscriptionsByTier(now, scope) {
    const rows = await prisma.publisherSubscription.groupBy({
      by: ['tier'],
      where: { startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }], publisher: viaCity(scope) },
      _count: { _all: true },
    });
    return groups(rows.map((row) => ({ key: row.tier, count: row._count._all })));
  },
  async publishersByAgent(scope) {
    const rows = await prisma.publisher.groupBy({ by: ['agentId'], where: { agentId: notNull, ...cityOf(scope) }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.agentId, count: row._count._all })));
  },
  async topPublishersByEarnings(window, scope, limit) {
    const rows = await prisma.earningAccrual.groupBy({
      by: ['publisherId'],
      where: { forDate: between(window), publisher: viaCity(scope) },
      _sum: { net: true },
      orderBy: { _sum: { net: 'desc' } },
      take: limit,
    });
    return rows.map((row) => ({ key: row.publisherId, sum: sum(row._sum.net) }));
  },
  async publisherEarningsNet(window, scope) {
    const result = await prisma.earningAccrual.aggregate({ where: { forDate: between(window), publisher: viaCity(scope) }, _sum: { net: true } });
    return sum(result._sum.net);
  },
  async publisherPayoutsReleased(window, scope) {
    const result = await prisma.withdrawalRequest.aggregate({
      where: { status: 'PAID', paidAt: between(window), wallet: { publisherId: notNull, publisher: viaCity(scope) } },
      _sum: { netAmount: true },
    });
    return sum(result._sum.netAmount);
  },

  /* ── advertisers ─────────────────────────────────────────────────────── */

  advertisersAsAt(at, scope) {
    return prisma.advertiser.count({ where: { createdAt: before(at), ...cityOf(scope) } });
  },
  advertisersCreated(window, scope) {
    return prisma.advertiser.count({ where: { createdAt: between(window), ...cityOf(scope) } });
  },
  async advertisersCreatedByDay(window, scope) {
    const rows = await prisma.advertiser.groupBy({ by: ['createdAt'], where: { createdAt: between(window), ...cityOf(scope) }, _count: { _all: true } });
    return foldDays(rows.map((row) => ({ at: row.createdAt, count: row._count._all })));
  },
  advertisersWithLiveCampaign(window, scope) {
    return prisma.advertiser.count({
      where: {
        ...cityOf(scope),
        campaigns: { some: { status: { in: ['LIVE', 'PAUSED', 'COMPLETED'] }, startDate: { lt: window.end }, endDate: { gte: window.start } } },
      },
    });
  },
  advertisersKycByState(scope) {
    return kycByState((state) => prisma.advertiser.count({ where: { AND: [cityOf(scope), kycPartyStateWhere(state, true)] } }));
  },
  async advertisersByIndustry(scope) {
    const rows = await prisma.advertiser.groupBy({ by: ['industry'], where: { industry: notNull, ...cityOf(scope) }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.industry, count: row._count._all })));
  },
  async advertisersFirstCampaignByDay(window, scope) {
    const rows = await prisma.campaign.groupBy({
      by: ['advertiserId'],
      where: { paidAt: { not: null, lt: window.end }, status: { not: 'CANCELLED' }, advertiser: viaCity(scope) },
      _min: { paidAt: true },
    });
    return firstsInWindow(rows.map((row) => row._min.paidAt), window);
  },
  async advertiserSpendByDay(window, scope) {
    const [campaigns, packages] = await Promise.all([
      prisma.campaign.groupBy({
        by: ['paidAt'],
        where: { paidAt: between(window), status: { not: 'CANCELLED' }, advertiser: viaCity(scope) },
        _sum: { total: true },
      }),
      prisma.packageSale.groupBy({
        by: ['paidAt'],
        where: { paidAt: between(window), status: { not: 'CANCELLED' }, advertiser: viaCity(scope) },
        _sum: { total: true },
      }),
    ]);
    return foldSums([
      ...campaigns.map((row) => ({ at: row.paidAt, sum: row._sum.total })),
      ...packages.map((row) => ({ at: row.paidAt, sum: row._sum.total })),
    ]);
  },
  async advertisersByCity(window, scope) {
    const [keyed, typed] = await Promise.all([
      prisma.advertiser.groupBy({ by: ['cityId'], where: { cityId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
      prisma.advertiser.groupBy({ by: ['city'], where: { cityId: null, city: notNull, ...cityOf(scope) }, _count: { _all: true } }),
    ]);
    const cities = await cityGroups(keyed, typed);
    return Promise.all(
      cities.map(async (group) => {
        const advertiser = groupWhere(group);
        const [campaigns, packages] = await Promise.all([
          prisma.campaign.aggregate({ where: { paidAt: between(window), status: { not: 'CANCELLED' }, advertiser }, _sum: { total: true } }),
          prisma.packageSale.aggregate({ where: { paidAt: between(window), status: { not: 'CANCELLED' }, advertiser }, _sum: { total: true } }),
        ]);
        return { ...group, spend: money(new Decimal(campaigns._sum.total ?? 0).plus(packages._sum.total ?? 0)) };
      }),
    );
  },
  async activePackageSalesByTier(scope) {
    const rows = await prisma.packageSale.groupBy({ by: ['tier'], where: { status: 'ACTIVE', advertiser: viaCity(scope) }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.tier, count: row._count._all })));
  },
  async advertisersByAgent(scope) {
    const rows = await prisma.advertiser.groupBy({ by: ['agentId'], where: { agentId: notNull, ...cityOf(scope) }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.agentId, count: row._count._all })));
  },
  async topAdvertisersBySpend(window, scope, limit) {
    const [campaigns, packages] = await Promise.all([
      prisma.campaign.groupBy({
        by: ['advertiserId'],
        where: { paidAt: between(window), status: { not: 'CANCELLED' }, advertiser: viaCity(scope) },
        _sum: { total: true },
      }),
      prisma.packageSale.groupBy({
        by: ['advertiserId'],
        where: { paidAt: between(window), status: { not: 'CANCELLED' }, advertiser: viaCity(scope) },
        _sum: { total: true },
      }),
    ]);
    const totals = new Map<string, Decimal>();
    for (const row of [...campaigns, ...packages]) {
      totals.set(row.advertiserId, (totals.get(row.advertiserId) ?? new Decimal(0)).plus(row._sum.total ?? 0));
    }
    return [...totals.entries()]
      .sort((a, b) => b[1].comparedTo(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key, total]) => ({ key, sum: money(total) }));
  },
  async advertiserWalletBalance(scope) {
    const result = await prisma.wallet.aggregate({ where: { advertiserId: notNull, advertiser: viaCity(scope) }, _sum: { balance: true } });
    return sum(result._sum.balance);
  },
  async advertiserTopUps(window, scope) {
    const result = await prisma.walletTopUp.aggregate({
      where: { receivedAt: between(window), wallet: { advertiserId: notNull, advertiser: viaCity(scope) } },
      _sum: { amount: true },
    });
    return sum(result._sum.amount);
  },

  /* ── agents ──────────────────────────────────────────────────────────── */

  agentsAsAt(at, scope) {
    return prisma.agentProfile.count({ where: { createdAt: before(at), ...cityOf(scope) } });
  },
  agentsCreated(window, scope) {
    return prisma.agentProfile.count({ where: { createdAt: between(window), ...cityOf(scope) } });
  },
  agentsActive(window, scope) {
    return prisma.agentProfile.count({
      where: {
        ...cityOf(scope),
        OR: [
          { orders: { some: { updatedAt: between(window) } } },
          { fieldVisits: { some: { OR: [{ scheduledFor: between(window) }, { completedAt: between(window) }] } } },
        ],
      },
    });
  },
  async agentsByRole(scope) {
    const [publisherAgents, advertiserAgents] = await Promise.all([
      prisma.userRole.count({ where: { role: 'AGENT_PUBLISHER', user: { agentProfile: agentIn(scope) } } }),
      prisma.userRole.count({ where: { role: 'AGENT_ADVERTISER', user: { agentProfile: agentIn(scope) } } }),
    ]);
    return { publisherAgents, advertiserAgents };
  },
  async agentsByTier(scope) {
    const rows = await prisma.agentProfile.groupBy({ by: ['tier'], where: cityOf(scope), _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.tier, count: row._count._all })));
  },
  agentsKycByState(scope) {
    return kycByState((state) => prisma.agentProfile.count({ where: { AND: [cityOf(scope), kycPartyStateWhere(state, false)] } }));
  },
  agentsSuspended(scope) {
    return prisma.agentProfile.count({ where: { AND: [cityOf(scope), { OR: [{ status: 'SUSPENDED' }, { suspendedAt: notNull }] }] } });
  },
  async onboardingsByDay(window, scope) {
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.groupBy({ by: ['activatedAt'], where: { activatedAt: between(window), agentId: notNull, agent: viaCity(scope) }, _count: { _all: true } }),
      prisma.advertiser.groupBy({ by: ['activatedAt'], where: { activatedAt: between(window), agentId: notNull, agent: viaCity(scope) }, _count: { _all: true } }),
    ]);
    return foldDays([
      ...publishers.map((row) => ({ at: row.activatedAt, count: row._count._all })),
      ...advertisers.map((row) => ({ at: row.activatedAt, count: row._count._all })),
    ]);
  },
  async visitsCompletedByDay(window, scope) {
    const rows = await prisma.fieldVisit.groupBy({
      by: ['completedAt'],
      where: { status: 'COMPLETED', completedAt: between(window), agent: viaCity(scope) },
      _count: { _all: true },
    });
    return foldDays(rows.map((row) => ({ at: row.completedAt, count: row._count._all })));
  },
  async jobsCompletedByDay(window, scope) {
    const rows = await prisma.order.groupBy({
      by: ['adminApprovedAt'],
      where: { status: 'COMPLETED', adminApprovedAt: between(window), agentId: notNull, agent: viaCity(scope) },
      _count: { _all: true },
    });
    return foldDays(rows.map((row) => ({ at: row.adminApprovedAt, count: row._count._all })));
  },
  async agentsByCity(scope) {
    const [keyed, typed] = await Promise.all([
      prisma.agentProfile.groupBy({ by: ['cityId'], where: { cityId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
      prisma.agentProfile.groupBy({ by: ['city'], where: { cityId: null, city: notNull, ...cityOf(scope) }, _count: { _all: true } }),
    ]);
    return cityGroups(keyed, typed);
  },
  async topAgentsByCommission(window, scope, limit) {
    const rows = await prisma.agentIncentive.groupBy({
      by: ['agentId'],
      where: { status: 'CREDITED', verifiedAt: between(window), agent: viaCity(scope) },
      _sum: { netAmount: true },
      orderBy: { _sum: { netAmount: 'desc' } },
      take: limit,
    });
    return rows.map((row) => ({ key: row.agentId, sum: sum(row._sum.netAmount) }));
  },
  async incentivesPaid(window, scope) {
    const result = await prisma.agentIncentive.aggregate({
      where: { status: 'CREDITED', verifiedAt: between(window), agent: viaCity(scope) },
      _sum: { netAmount: true },
    });
    return sum(result._sum.netAmount);
  },

  /* ── print partners ──────────────────────────────────────────────────── */

  printPartnersAsAt(at, scope) {
    return prisma.printPartner.count({ where: { createdAt: before(at), ...cityOf(scope) } });
  },
  printPartnersCreated(window, scope) {
    return prisma.printPartner.count({ where: { createdAt: between(window), ...cityOf(scope) } });
  },
  printPartnersActive(scope) {
    return prisma.printPartner.count({ where: { ...cityOf(scope), isActive: true } });
  },
  printPartnersAcceptingQuotes(scope) {
    return prisma.printPartner.count({ where: { ...cityOf(scope), isActive: true, acceptsQuoteRequests: true } });
  },
  printPartnersKycByState(scope) {
    return kycByState((state) => prisma.printPartner.count({ where: { AND: [cityOf(scope), kycPartyStateWhere(state, true)] } }));
  },
  async printPartnersByCity(scope) {
    const [keyed, typed] = await Promise.all([
      prisma.printPartner.groupBy({ by: ['cityId'], where: { cityId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
      prisma.printPartner.groupBy({ by: ['city'], where: { cityId: null, city: notNull, ...cityOf(scope) }, _count: { _all: true } }),
    ]);
    return cityGroups(keyed, typed);
  },
  async quoteRequestsByDay(window, scope) {
    // The request's own city is a string with no key: the spelling, as before.
    const rows = await prisma.printQuoteRequest.groupBy({ by: ['createdAt'], where: { createdAt: between(window), ...cityStringOf(scope) }, _count: { _all: true } });
    return foldDays(rows.map((row) => ({ at: row.createdAt, count: row._count._all })));
  },
  async quotesReceivedByDay(window, scope) {
    const rows = await prisma.printQuote.groupBy({
      by: ['submittedAt'],
      where: { submittedAt: between(window), printPartner: viaCity(scope) },
      _count: { _all: true },
    });
    return foldDays(rows.map((row) => ({ at: row.submittedAt, count: row._count._all })));
  },
  async printJobsCompletedByDay(window, scope) {
    const rows = await prisma.printJob.groupBy({
      by: ['collectedAt'],
      where: { collectedAt: between(window), printPartner: viaCity(scope) },
      _count: { _all: true },
    });
    return foldDays(rows.map((row) => ({ at: row.collectedAt, count: row._count._all })));
  },
  async printPartnersByCapability(scope) {
    // A text[] column; Prisma cannot group by its elements, so one SELECT
    // over the unnested array — a GROUP BY and nothing else.
    // Lot X-B: by key with the spelling as the fallback, the way `cityOf` reads.
    const city = scope.city
      ? scope.cityId
        ? Prisma.sql`WHERE ("cityId" = ${scope.cityId} OR ("cityId" IS NULL AND lower("city") = lower(${scope.city.trim()})))`
        : Prisma.sql`WHERE "cityId" IS NULL AND lower("city") = lower(${scope.city.trim()})`
      : Prisma.empty;
    const rows = await prisma.$queryRaw<{ key: string; count: bigint | number }[]>(
      Prisma.sql`SELECT capability AS key, COUNT(*) AS count FROM "PrintPartner", unnest("capabilities") AS capability ${city} GROUP BY capability`,
    );
    return groups(rows.map((row) => ({ key: row.key, count: Number(row.count) })));
  },
  async topPrintPartners(window, scope, limit) {
    const rows = await prisma.printJob.groupBy({
      by: ['printPartnerId'],
      where: { collectedAt: between(window), printPartner: viaCity(scope) },
      _count: { _all: true },
      _sum: { actualCost: true },
      orderBy: [{ _count: { printPartnerId: 'desc' } }, { _sum: { actualCost: 'desc' } }],
      take: limit,
    });
    return rows.map((row) => ({ key: row.printPartnerId, jobs: row._count._all, earnings: sum(row._sum.actualCost) }));
  },
  async printTurnaroundDays(window, scope) {
    // AVG over a date difference — one aggregate Prisma's builder cannot write.
    const city = scope.city
      ? scope.cityId
        ? Prisma.sql`AND (p."cityId" = ${scope.cityId} OR (p."cityId" IS NULL AND lower(p."city") = lower(${scope.city.trim()})))`
        : Prisma.sql`AND p."cityId" IS NULL AND lower(p."city") = lower(${scope.city.trim()})`
      : Prisma.empty;
    const rows = await prisma.$queryRaw<{ avg: unknown }[]>(
      Prisma.sql`SELECT AVG(EXTRACT(EPOCH FROM (j."collectedAt" - j."requestedAt")) / 86400) AS avg
        FROM "PrintJob" j JOIN "PrintPartner" p ON p."id" = j."printPartnerId"
        WHERE j."collectedAt" >= ${window.start} AND j."collectedAt" < ${window.end} ${city}`,
    );
    const raw = rows[0]?.avg;
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  },
  async quoteAwards(window, scope) {
    const [quotes, awarded] = await Promise.all([
      prisma.printQuote.count({ where: { submittedAt: between(window), printPartner: viaCity(scope) } }),
      prisma.printQuote.count({ where: { submittedAt: between(window), status: 'ACCEPTED', printPartner: viaCity(scope) } }),
    ]);
    return { quotes, awarded };
  },

  /* ── employees ───────────────────────────────────────────────────────── */

  employeesJoined(window) {
    return prisma.employee.count({ where: { createdAt: between(window) } });
  },
  async employeesByDepartment() {
    const rows = await prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true, openRoles: true, _count: { select: { members: { where: { isActive: true } } } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({ key: row.id, label: row.name, count: row._count.members, openRoles: row.openRoles }));
  },
  async employeesByWorkMode() {
    const rows = await prisma.employee.groupBy({ by: ['workMode'], where: { isActive: true, workMode: notNull }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.workMode, count: row._count._all })));
  },
  async employeesByEmploymentType() {
    const rows = await prisma.employee.groupBy({ by: ['employmentType'], where: { isActive: true, employmentType: notNull }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.employmentType, count: row._count._all })));
  },
  async employeesByRegion() {
    const rows = await prisma.employee.groupBy({ by: ['region'], where: { isActive: true, region: notNull }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.region, count: row._count._all })));
  },
  employeesKycByState() {
    return kycByState((state) => prisma.employee.count({ where: kycPartyStateWhere(state, false) }));
  },
  async employeesTenure(now) {
    const oneYearAgo = new Date(now.getTime() - 365 * DAY_MS);
    const threeYearsAgo = new Date(now.getTime() - 3 * 365 * DAY_MS);
    const [under1y, from1to3y, over3y] = await Promise.all([
      prisma.employee.count({ where: { isActive: true, createdAt: { gt: oneYearAgo } } }),
      prisma.employee.count({ where: { isActive: true, createdAt: { gt: threeYearsAgo, lte: oneYearAgo } } }),
      prisma.employee.count({ where: { isActive: true, createdAt: { lte: threeYearsAgo } } }),
    ]);
    return { under1y, from1to3y, over3y };
  },
  holidaysInWindow(window) {
    // `date` is a @db.Date at UTC midnight; the IST window's bounds sit at
    // 18:30 UTC the evening before, so the day lands where the calendar says.
    return prisma.holiday.count({ where: { date: between(window) } });
  },

  /* ── users ───────────────────────────────────────────────────────────── */

  usersAsAt(at, scope) {
    return prisma.user.count({ where: { createdAt: before(at), ...partyCityOf(scope) } });
  },
  usersCreated(window, scope) {
    return prisma.user.count({ where: { createdAt: between(window), ...partyCityOf(scope) } });
  },
  async usersCreatedByDay(window, scope) {
    const rows = await prisma.user.groupBy({ by: ['createdAt'], where: { createdAt: between(window), ...partyCityOf(scope) }, _count: { _all: true } });
    return foldDays(rows.map((row) => ({ at: row.createdAt, count: row._count._all })));
  },
  async usersByRole(scope) {
    const rows = await prisma.userRole.groupBy({ by: ['role'], where: { user: partyCityOf(scope) }, _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.role, count: row._count._all })));
  },
  usersWithoutRole(scope) {
    return prisma.user.count({ where: { roles: { none: {} }, ...partyCityOf(scope) } });
  },
  usersActive(window, scope) {
    return prisma.user.count({ where: { lastLoginAt: between(window), ...partyCityOf(scope) } });
  },
  async usersSignInsByDay(window, scope) {
    const rows = await prisma.user.groupBy({ by: ['lastLoginAt'], where: { lastLoginAt: between(window), ...partyCityOf(scope) }, _count: { _all: true } });
    return foldDays(rows.map((row) => ({ at: row.lastLoginAt, count: row._count._all })));
  },
  async adminsTwoFactor() {
    const admin = { roles: { some: { role: 'ADMIN' as const } } };
    const [admins, enrolled] = await Promise.all([
      prisma.user.count({ where: admin }),
      prisma.user.count({ where: { ...admin, totpEnrolledAt: notNull } }),
    ]);
    return { admins, enrolled };
  },
  usersClosed(scope) {
    return prisma.user.count({ where: { closedAt: notNull, ...partyCityOf(scope) } });
  },
  usersClosedInWindow(window, scope) {
    return prisma.user.count({ where: { closedAt: between(window), ...partyCityOf(scope) } });
  },
  erasureRequestsOpen() {
    return prisma.erasureRequest.count({ where: { status: { in: ['PENDING', 'APPROVED'] } } });
  },
  async contactsVerified(scope) {
    const [total, verified] = await Promise.all([
      prisma.userContact.count({ where: { user: partyCityOf(scope) } }),
      prisma.userContact.count({ where: { verifiedAt: notNull, user: partyCityOf(scope) } }),
    ]);
    return { verified, total };
  },
  async usersByLanguage(scope) {
    const rows = await prisma.user.groupBy({ by: ['language'], where: partyCityOf(scope), _count: { _all: true } });
    return groups(rows.map((row) => ({ key: row.language, count: row._count._all })));
  },
  async usersByPartyCity(scope) {
    const [publishers, advertisers, agents] = await Promise.all([
      Promise.all([
        prisma.publisher.groupBy({ by: ['cityId'], where: { cityId: notNull, userId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
        prisma.publisher.groupBy({ by: ['city'], where: { cityId: null, city: notNull, userId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
      ]).then(([keyed, typed]) => cityGroups(keyed, typed)),
      Promise.all([
        prisma.advertiser.groupBy({ by: ['cityId'], where: { cityId: notNull, userId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
        prisma.advertiser.groupBy({ by: ['city'], where: { cityId: null, city: notNull, userId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
      ]).then(([keyed, typed]) => cityGroups(keyed, typed)),
      Promise.all([
        prisma.agentProfile.groupBy({ by: ['cityId'], where: { cityId: notNull, ...cityOf(scope) }, _count: { _all: true } }),
        prisma.agentProfile.groupBy({ by: ['city'], where: { cityId: null, city: notNull, ...cityOf(scope) }, _count: { _all: true } }),
      ]).then(([keyed, typed]) => cityGroups(keyed, typed)),
    ]);
    return mergeCityGroups([publishers, advertisers, agents]);
  },
};

/** A login with an agent profile — in the city, when one is asked for. */
const agentIn = (scope: Scope): Prisma.AgentProfileNullableScalarRelationFilter => (scope.city ? { is: cityOf(scope) } : { isNot: null });

/** A login "is in" a city when any of its party profiles says so. */
function partyCityOf(scope: Scope): Prisma.UserWhereInput {
  if (!scope.city) return {};
  const city = cityOf(scope);
  return { OR: [{ publisherProfile: { is: city } }, { advertiserProfile: { is: city } }, { agentProfile: { is: city } }] };
}
