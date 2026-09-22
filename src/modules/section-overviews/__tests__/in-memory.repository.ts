import { Decimal, money, type Money } from '../../../shared/money';
import type { CityCount, DayCount, DaySum, GroupCount, GroupSum, KycStateCountMap, Scope, SectionOverviewsRepository, Window } from '../section-overviews.repository';

/**
 * A seeded in-memory repository for the section overview tests.
 *
 * Facts are instants with an optional city, key and amount; every method
 * below filters them the way the Prisma repository's where clause would
 * (window, city case-insensitively) and answers a count, a decimal string
 * or grouped counts — the same contract, so the service's maths can be
 * pinned without a database. States (KYC, suspended, active) are plain
 * seeded numbers.
 */

export type Fact = { at: Date; city?: string; key?: string; amount?: string };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The UTC instant of a wall-clock time in India, e.g. `ist('2026-09-01T00:15')`. */
export const ist = (local: string): Date => new Date(Date.parse(`${local}:00.000Z`) - IST_OFFSET_MS);
const istDay = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export type Kind =
  | 'publisher'
  | 'publisherFirstListing'
  | 'publisherFirstBooking'
  | 'publisherEarning'
  | 'publisherPayout'
  | 'advertiser'
  | 'advertiserFirstCampaign'
  | 'advertiserSpend'
  | 'advertiserTopUp'
  | 'agent'
  | 'onboarding'
  | 'visit'
  | 'job'
  | 'incentive'
  | 'printPartner'
  | 'quoteRequest'
  | 'quote'
  | 'printJob'
  | 'employee'
  | 'holiday'
  | 'user'
  | 'signIn'
  | 'userClosed'
  // LH9: a lead's moments, each a fact at its instant — `key` the lead's id so a recycle and its conversion can be paired.
  | 'lead'
  | 'leadContact'
  | 'leadConversion'
  | 'leadActivation'
  | 'leadLoss'
  | 'leadIncentive'
  | 'leadTopUp'
  | 'leadRecycle';

export type Seed = Partial<Record<Kind, Fact[]>> & {
  kyc?: Partial<KycStateCountMap>;
  states?: Partial<{
    publishersWithLiveListing: number;
    publishersSuspended: number;
    publishersClosed: number;
    agentsSuspended: number;
    printPartnersActive: number;
    printPartnersAccepting: number;
    erasureRequestsOpen: number;
    usersWithoutRole: number;
    turnaroundDays: Record<string, number | null>;
    /** LH9 */
    leadsOpen: number;
  }>;
  groups?: Partial<Record<string, GroupCount[]>>;
  /**
   * Lot X-B: the rows typed under towns with no key — the Prisma repository
   * folds them into one group (`cityId` null) carrying the strings; here the
   * seed names the strings and the count.
   */
  typedCities?: { strings: string[]; count: number };
};

const kycOf = (seed: Seed): KycStateCountMap => ({
  AWAITING_DOCUMENTS: seed.kyc?.AWAITING_DOCUMENTS ?? 0,
  REQUESTED: seed.kyc?.REQUESTED ?? 0,
  PENDING: seed.kyc?.PENDING ?? 0,
  NEEDS_INFO: seed.kyc?.NEEDS_INFO ?? 0,
  REJECTED: seed.kyc?.REJECTED ?? 0,
  VERIFIED: seed.kyc?.VERIFIED ?? 0,
});

export function inMemoryRepository(seed: Seed): SectionOverviewsRepository & { calls: string[] } {
  const calls: string[] = [];
  const facts = (kind: Kind): Fact[] => seed[kind] ?? [];
  const inCity = (scope: Scope) => (fact: Fact) => !scope.city || (fact.city ?? '').toLowerCase() === scope.city.trim().toLowerCase();
  const inWindow = (window: Window) => (fact: Fact) => fact.at >= window.start && fact.at < window.end;
  const pick = (kind: Kind, window: Window, scope: Scope) => facts(kind).filter(inWindow(window)).filter(inCity(scope));

  const count = (kind: Kind, window: Window, scope: Scope): number => pick(kind, window, scope).length;
  const asAt = (kind: Kind, at: Date, scope: Scope): number => facts(kind).filter((fact) => fact.at < at).filter(inCity(scope)).length;
  const byDay = (kind: Kind, window: Window, scope: Scope): DayCount[] => {
    const days = new Map<string, number>();
    for (const fact of pick(kind, window, scope)) days.set(istDay(fact.at), (days.get(istDay(fact.at)) ?? 0) + 1);
    return [...days.entries()].map(([day, n]) => ({ day, count: n }));
  };
  const sumByDay = (kind: Kind, window: Window, scope: Scope): DaySum[] => {
    const days = new Map<string, Decimal>();
    for (const fact of pick(kind, window, scope)) days.set(istDay(fact.at), (days.get(istDay(fact.at)) ?? new Decimal(0)).plus(fact.amount ?? 0));
    return [...days.entries()].map(([day, sum]) => ({ day, sum: money(sum) }));
  };
  const total = (kind: Kind, window: Window, scope: Scope): Money =>
    money(pick(kind, window, scope).reduce((acc, fact) => acc.plus(fact.amount ?? 0), new Decimal(0)));
  const top = (kind: Kind, window: Window, scope: Scope, limit: number): GroupSum[] => {
    const totals = new Map<string, Decimal>();
    for (const fact of pick(kind, window, scope)) totals.set(fact.key ?? '?', (totals.get(fact.key ?? '?') ?? new Decimal(0)).plus(fact.amount ?? 0));
    return [...totals.entries()]
      .sort((a, b) => b[1].comparedTo(a[1]))
      .slice(0, limit)
      .map(([key, sum]) => ({ key, sum: money(sum) }));
  };
  const group = (name: string, scope: Scope): GroupCount[] =>
    (seed.groups?.[name] ?? []).filter((row) => !scope.city || row.key.toLowerCase() === scope.city.trim().toLowerCase() || name !== 'city');
  const slugOf = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  /**
   * Lot X-B: the city groups the way the Prisma repository answers them —
   * the seed's `groups.city` keyed (`city_<slug>`, labelled by the name;
   * `scope.city` matches the slug or the name, the way a key or a spelling
   * would), and the typed strings as the one null-keyed group. The typed
   * group is only in scope when the scope resolved to no key (a typed town
   * itself) and names one of its strings.
   */
  const cityGroups = (scope: Scope): CityCount[] => {
    const wanted = scope.city?.trim().toLowerCase();
    const keyed = (seed.groups?.['city'] ?? [])
      .filter((row) => !wanted || row.key.toLowerCase() === wanted || slugOf(row.key) === wanted)
      .map((row) => ({ cityId: `city_${slugOf(row.key)}`, slug: slugOf(row.key), name: row.key, typed: [], count: row.count }));
    const typed = seed.typedCities;
    const typedInScope = typed && (!wanted || (!scope.cityId && typed.strings.some((s) => s.toLowerCase() === wanted)));
    return [...keyed, ...(typedInScope ? [{ cityId: null, slug: null, name: null, typed: [...typed.strings].sort(), count: typed.count }] : [])].sort((a, b) => b.count - a.count);
  };
  const state = (name: keyof NonNullable<Seed['states']>): number => {
    const value = seed.states?.[name];
    return typeof value === 'number' ? value : 0;
  };

  const track = <T extends object>(object: T): T =>
    new Proxy(object, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value === 'function' && property !== 'calls') {
          return (...args: unknown[]) => {
            calls.push(String(property));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });

  return track({
    calls,

    publishersAsAt: async (at, scope) => asAt('publisher', at, scope),
    publishersCreated: async (window, scope) => count('publisher', window, scope),
    publishersCreatedByDay: async (window, scope) => byDay('publisher', window, scope),
    publishersWithLiveListing: async () => state('publishersWithLiveListing'),
    publishersKycByState: async () => kycOf(seed),
    publishersSuspended: async () => state('publishersSuspended'),
    publishersClosed: async () => state('publishersClosed'),
    publishersFirstListingByDay: async (window, scope) => byDay('publisherFirstListing', window, scope),
    publishersFirstBookingByDay: async (window, scope) => byDay('publisherFirstBooking', window, scope),
    publishersByCity: async (window, scope) =>
      cityGroups(scope).map((row) => ({ ...row, listings: row.count * 2, gmv: row.name ? total('publisherEarning', window, { city: row.name }) : money(0) })),
    publishersByCategory: async () => [{ key: 'OUTDOOR', publishers: 3, listings: 5 }],
    runningSubscriptionsByTier: async () => [{ key: 'PLUS', count: 2 }, { key: 'STANDARD', count: 1 }],
    publishersByAgent: async (scope) => group('agent', scope),
    topPublishersByEarnings: async (window, scope, limit) => top('publisherEarning', window, scope, limit),
    publisherEarningsNet: async (window, scope) => total('publisherEarning', window, scope),
    publisherPayoutsReleased: async (window, scope) => total('publisherPayout', window, scope),

    advertisersAsAt: async (at, scope) => asAt('advertiser', at, scope),
    advertisersCreated: async (window, scope) => count('advertiser', window, scope),
    advertisersCreatedByDay: async (window, scope) => byDay('advertiser', window, scope),
    advertisersWithLiveCampaign: async (window, scope) => new Set(pick('advertiserSpend', window, scope).map((fact) => fact.key)).size,
    advertisersKycByState: async () => kycOf(seed),
    advertisersByIndustry: async (scope) => group('industry', scope),
    advertisersFirstCampaignByDay: async (window, scope) => byDay('advertiserFirstCampaign', window, scope),
    advertiserSpendByDay: async (window, scope) => sumByDay('advertiserSpend', window, scope),
    advertisersByCity: async (window, scope) =>
      cityGroups(scope).map((row) => ({ ...row, spend: row.name ? total('advertiserSpend', window, { city: row.name }) : money(0) })),
    activePackageSalesByTier: async () => [{ key: 'GROWTH', count: 4 }],
    advertisersByAgent: async (scope) => group('agent', scope),
    topAdvertisersBySpend: async (window, scope, limit) => top('advertiserSpend', window, scope, limit),
    advertiserWalletBalance: async () => '12345.50',
    advertiserTopUps: async (window, scope) => total('advertiserTopUp', window, scope),

    agentsAsAt: async (at, scope) => asAt('agent', at, scope),
    agentsCreated: async (window, scope) => count('agent', window, scope),
    agentsActive: async (window, scope) => new Set([...pick('job', window, scope), ...pick('visit', window, scope)].map((fact) => fact.key)).size,
    agentsByRole: async () => ({ publisherAgents: 5, advertiserAgents: 3 }),
    agentsByTier: async () => [{ key: 'BRONZE', count: 6 }, { key: 'SILVER', count: 2 }],
    agentsKycByState: async () => kycOf(seed),
    agentsSuspended: async () => state('agentsSuspended'),
    onboardingsByDay: async (window, scope) => byDay('onboarding', window, scope),
    visitsCompletedByDay: async (window, scope) => byDay('visit', window, scope),
    jobsCompletedByDay: async (window, scope) => byDay('job', window, scope),
    agentsByCity: async (scope) => cityGroups(scope),
    topAgentsByCommission: async (window, scope, limit) => top('incentive', window, scope, limit),
    incentivesPaid: async (window, scope) => total('incentive', window, scope),

    printPartnersAsAt: async (at, scope) => asAt('printPartner', at, scope),
    printPartnersCreated: async (window, scope) => count('printPartner', window, scope),
    printPartnersActive: async () => state('printPartnersActive'),
    printPartnersAcceptingQuotes: async () => state('printPartnersAccepting'),
    printPartnersKycByState: async () => kycOf(seed),
    printPartnersByCity: async (scope) => cityGroups(scope),
    quoteRequestsByDay: async (window, scope) => byDay('quoteRequest', window, scope),
    quotesReceivedByDay: async (window, scope) => byDay('quote', window, scope),
    printJobsCompletedByDay: async (window, scope) => byDay('printJob', window, scope),
    printPartnersByCapability: async () => [{ key: 'flex', count: 3 }, { key: 'vinyl', count: 1 }],
    topPrintPartners: async (window, scope, limit) =>
      top('printJob', window, scope, limit).map((row) => ({ key: row.key, jobs: pick('printJob', window, scope).filter((fact) => fact.key === row.key).length, earnings: row.sum })),
    printTurnaroundDays: async (window) => seed.states?.turnaroundDays?.[window.start.toISOString()] ?? null,
    quoteAwards: async (window, scope) => {
      const quotes = pick('quote', window, scope);
      return { quotes: quotes.length, awarded: quotes.filter((fact) => fact.key === 'ACCEPTED').length };
    },

    employeesJoined: async (window) => count('employee', window, {}),
    employeesByDepartment: async () => [{ key: 'dep_ops', label: 'Operations', count: 4, openRoles: 1 }],
    employeesByWorkMode: async () => [{ key: 'OFFICE', count: 3 }, { key: 'HYBRID', count: 1 }],
    employeesByEmploymentType: async () => [{ key: 'FULL_TIME', count: 4 }],
    employeesByRegion: async () => [{ key: 'South', count: 4 }],
    employeesKycByState: async () => kycOf(seed),
    employeesTenure: async () => ({ under1y: 2, from1to3y: 1, over3y: 1 }),
    holidaysInWindow: async (window) => count('holiday', window, {}),

    usersAsAt: async (at, scope) => asAt('user', at, scope),
    usersCreated: async (window, scope) => count('user', window, scope),
    usersCreatedByDay: async (window, scope) => byDay('user', window, scope),
    usersByRole: async () => seed.groups?.['role'] ?? [],
    usersWithoutRole: async () => state('usersWithoutRole'),
    usersActive: async (window, scope) => count('signIn', window, scope),
    usersSignInsByDay: async (window, scope) => byDay('signIn', window, scope),
    adminsTwoFactor: async () => ({ admins: 4, enrolled: 3 }),
    usersClosed: async () => facts('userClosed').length,
    usersClosedInWindow: async (window, scope) => count('userClosed', window, scope),
    erasureRequestsOpen: async () => state('erasureRequestsOpen'),
    contactsVerified: async () => ({ verified: 30, total: 40 }),
    usersByLanguage: async () => [{ key: 'en', count: 9 }, { key: 'kn', count: 3 }],
    usersByPartyCity: async (scope) => cityGroups(scope),

    /* ── leads (LH9) ─────────────────────────────────────────────────── */
    leadsOpen: async () => state('leadsOpen'),
    leadsCreated: async (window, scope) => count('lead', window, scope),
    leadsCreatedByDay: async (window, scope) => byDay('lead', window, scope),
    leadsContacted: async (window, scope) => count('leadContact', window, scope),
    leadsConverted: async (window, scope) => count('leadConversion', window, scope),
    leadsConvertedByDay: async (window, scope) => byDay('leadConversion', window, scope),
    leadsActivated: async (window, scope) => count('leadActivation', window, scope),
    leadsActivatedByDay: async (window, scope) => byDay('leadActivation', window, scope),
    leadsLost: async (window, scope) => count('leadLoss', window, scope),
    leadsByTemperature: async () => seed.groups?.['temperature'] ?? [],
    leadsByCity: async (window, scope) =>
      cityGroups(scope).map((row) => ({
        ...row,
        count: row.name ? count('lead', window, { city: row.name }) : row.count,
        // The cohort's conversions: of the leads created in the window, those with a conversion fact at any time.
        converted: row.name ? pick('lead', window, { city: row.name }).filter((lead) => facts('leadConversion').some((conversion) => conversion.key === lead.key)).length : 0,
      })),
    // The mean and the median of the seeded conversions' `amount`, read as days.
    leadsTimeToConvert: async (window, scope) => {
      const days = pick('leadConversion', window, scope).map((fact) => Number(fact.amount ?? 0)).sort((a, b) => a - b);
      if (days.length === 0) return { converted: 0, meanDays: 0, medianDays: 0 };
      const mean = days.reduce((a, b) => a + b, 0) / days.length;
      const mid = Math.floor(days.length / 2);
      const median = days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2;
      return { converted: days.length, meanDays: Math.round(mean * 10) / 10, medianDays: Math.round(median * 10) / 10 };
    },
    leadIncentivesRecorded: async (window, scope) => total('leadIncentive', window, scope),
    leadTopUpsRecorded: async (window, scope) => total('leadTopUp', window, scope),
    leadsRecycled: async (window, scope) => count('leadRecycle', window, scope),
    // A recycled lead converted since when a conversion fact for the same key follows the recycle.
    leadsConvertedAfterRecycle: async (window, scope) =>
      pick('leadRecycle', window, scope).filter((recycle) => facts('leadConversion').some((conversion) => conversion.key === recycle.key && conversion.at >= recycle.at)).length,
  });
}
