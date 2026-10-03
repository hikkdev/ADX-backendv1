import { readThrough } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import type { KycQueueState } from '../../shared/kyc-state';
import { Decimal, money, type Money } from '../../shared/money';
import { MAX_LIST_PAGE_SIZE, type ListPage } from '../../shared/pagination';
import { dayWindowISTFor } from '../../shared/time';
import { advertiserFunnel, findAdvertiserLabels, type AdvertiserFunnel } from '../advertisers';
import { agentCostOverWindow, findAgentLabels, getLeaderboardForCity, type CostSide, type LeaderboardView } from '../agents';
import { launchQueueSummary, WAITING_REASONS, type WaitingReason } from '../campaigns';
import { leadFunnel, LEAD_STAGES, type LeadFunnelRows } from '../leads';
import { employeesOverview, workloadReport, type EmployeesOverview, type WorkloadReport } from '../employees';
import { findPrintPartnerLabels } from '../print-partners';
import { cityKeyFor } from '../pricing';
import { findPublisherLabels } from '../publishers';
import { RISK_WINDOW_DAYS, supplyFunnel, type SupplyFunnel } from '../supply';
import { prismaSectionOverviewsRepository as repository } from './prisma-section-overviews.repository';
import type { CityCount, CityGroup, DayCount, DaySum, GroupCount, KycStateCountMap, LeadTimeToConvert, Scope, Window } from './section-overviews.repository';

/**
 * One overview read per user section — package O-B.
 *
 * Every figure is a count or a sum the tables support today, read through
 * an aggregates-only repository, over an Indian-day window with the window
 * of the same length before it beside every window figure. A figure that is
 * a STATE (how many publishers are suspended now, the KYC queue) has no
 * previous: the platform keeps no history of states, so `previous` and
 * `delta` are null rather than a guess. A population figure (`total`) is
 * read as at the window's close and as at the previous window's close, so
 * the two compare.
 *
 * Where another module already answers a shape — the two funnels, the
 * employees' overview and workload, the agents' leaderboard, the label
 * lookups — it is reused through that module's export, never re-derived
 * here.
 */

// LH9: the Leads section joined the six user sections; the Listings section joined on 2 Oct 2026, and Campaigns the same day.
export const SECTIONS = ['publishers', 'advertisers', 'agents', 'print-partners', 'employees', 'users', 'leads', 'listings', 'campaigns'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_OVERVIEW_CACHE_SECONDS = 60;
/** Cached a minute per section + window + city, the way the console's month is. */
export const sectionOverviewCacheKey = (section: Section, from: string, to: string, city: string | undefined): string =>
  `section-overviews:${section}:${from}:${to}:${city ? city.trim().toLowerCase() : '-'}`;

/** The last thirty Indian days when nothing is asked for; at most a year in one read. */
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 366;
export const TOP_LIMIT = 10;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ── The shapes on the wire ──────────────────────────────────────────── */

/** A window figure against the previous window; a state figure carries nulls. */
export type Figure = { value: number; previous: number | null; delta: number | null };
export type MoneyFigure = { value: Money; previous: Money | null; delta: Money | null };
export type DayPoint = { day: string; value: number };
export type MoneyDayPoint = { day: string; value: Money };
/** Every day of the window, zeros filled, with the previous window's days beside it. */
export type Series = { days: DayPoint[]; previous: DayPoint[]; total: Figure };
export type MoneySeries = { days: MoneyDayPoint[]; previous: MoneyDayPoint[]; total: MoneyFigure };
export type KycByState = { awaitingDocuments: number; requested: number; pending: number; needsInfo: number; rejected: number; verified: number };

export type OverviewQuery = { from?: string | undefined; to?: string | undefined; city?: string | undefined };

export type ResolvedWindow = {
  from: string;
  to: string;
  days: string[];
  window: Window;
  previous: Window;
  previousFrom: string;
  previousTo: string;
  previousDays: string[];
};

type WindowOnWire = { from: string; to: string; start: string; end: string; days: number };

type Base = {
  section: Section;
  window: WindowOnWire;
  previousWindow: WindowOnWire;
  city: string | null;
  generatedAt: string;
};

export type CountRow = { key: string; label: string; href: string | null; count: number };
/**
 * Lot X-B: a city row on the wire — keyed by the city's slug (`?city=` takes
 * it), labelled from the catalogue; the rows typed under a town with no key
 * are one row, key `other`, label "Other (typed)", with the raw strings under
 * `typed` and no link.
 */
export type CityRow = { key: string; label: string; href: string | null; cityId: string | null; typed: string[]; count: number };
export const OTHER_CITY_KEY = 'other';
export const OTHER_CITY_LABEL = 'Other (typed)';
export function cityRowOf(group: CityGroup, href: (slug: string) => string): Omit<CityRow, 'count'> {
  return group.cityId && group.slug
    ? { key: group.slug, label: group.name ?? group.slug, href: href(group.slug), cityId: group.cityId, typed: [] }
    : { key: OTHER_CITY_KEY, label: OTHER_CITY_LABEL, href: null, cityId: null, typed: group.typed };
}
const cityRows = (rows: readonly CityCount[], href: (slug: string) => string): CityRow[] => rows.map((row) => ({ ...cityRowOf(row, href), count: row.count }));
export type LabelledSumRow = { key: string; label: string; displayId: string | null; href: string; amount: Money };
export type LabelledCountRow = { key: string; label: string; displayId: string | null; href: string; count: number };

/**
 * CP-2: what an onboarding cost over the window.
 *
 * `perOnboarding` is the figure the owner asked for — the money that buys
 * accounts, over the accounts agents actually brought in. It deliberately
 * divides by the AGENT-led onboardings only: an account that walked in
 * through the app cost no agent anything, and folding it into the
 * denominator would flatter the number. `selfServe` is reported beside it so
 * the split is visible rather than hidden.
 *
 * `basis` is the salary committed plus the rewards paid; the per-onboarding
 * commission sits outside it in `commission`, and `allInPerOnboarding` adds
 * it back for anyone who wants the whole bill over the same denominator.
 *
 * Null when nothing was onboarded: a window that produced none has no cost
 * per one, and a zero there would read as "free".
 */
export type CostBlock = {
  side: CostSide;
  perOnboarding: Money | null;
  allInPerOnboarding: Money | null;
  salary: Money;
  rewards: Money;
  commission: Money;
  basis: Money;
  allIn: Money;
  onboardings: { byAgent: number; selfServe: number };
  /** How many agents of this side have a salary recorded at all — the figure's coverage. */
  agentsOnTerms: number;
};

/** CP-2: the same figure for one city, folded onto the `byCity` row that page already draws. */
export type CityCost = { basis: Money; onboardings: number; perOnboarding: Money | null };

/**
 * The cost block and the per-city figures behind it.
 *
 * The money comes from `agents` (it owns the salary and incentive rows and
 * exports the aggregate); the onboardings come from this module's own
 * repository. They are keyed together by city the way every other breakdown
 * here is — a slug, or the one "Other (typed)" bucket.
 */
/**
 * The cost of one onboarding: the money, over what it bought.
 *
 * Null twice over, and both matter. With nothing onboarded there is no cost
 * per one. With no money recorded there is no cost either — a zero basis
 * means no agent here has a salary on record, not that the work was free,
 * and printing "₹0.00" would say the opposite of what is true. The screens
 * read the null as "not recorded yet" and say which agents are missing.
 *
 * The division lives here rather than being imported from `agents` because
 * it is a division; pulling it across a module boundary would buy nothing
 * and would put the arithmetic behind a mock in every test of this file.
 */
const perOnboarding = (amount: Money, onboardings: number): Money | null =>
  onboardings <= 0 || new Decimal(amount).lessThanOrEqualTo(0) ? null : money(new Decimal(amount).dividedBy(onboardings).toFixed(2));

async function costOf(window: Window, scope: Scope, side: CostSide): Promise<{ block: CostBlock; byCity: Map<string, CityCost> }> {
  const [cost, onboardings] = await Promise.all([agentCostOverWindow(window, scope, side), repository.onboardingsByProvenance(window, scope, side)]);
  const keyOf = (row: { slug: string | null }): string => row.slug ?? OTHER_CITY_KEY;
  const byCity = new Map<string, CityCost>();
  for (const row of cost.byCity) byCity.set(keyOf(row), { basis: row.basis, onboardings: 0, perOnboarding: null });
  for (const row of onboardings.byCity) {
    const key = keyOf(row);
    const current = byCity.get(key) ?? { basis: money('0'), onboardings: 0, perOnboarding: null };
    current.onboardings += row.count;
    byCity.set(key, current);
  }
  for (const [, row] of byCity) row.perOnboarding = perOnboarding(row.basis, row.onboardings);
  return {
    block: {
      side,
      perOnboarding: perOnboarding(cost.basis, onboardings.byAgent),
      allInPerOnboarding: perOnboarding(cost.allIn, onboardings.byAgent),
      salary: cost.salary,
      rewards: cost.rewards,
      commission: cost.commission,
      basis: cost.basis,
      allIn: cost.allIn,
      onboardings: { byAgent: onboardings.byAgent, selfServe: onboardings.selfServe },
      agentsOnTerms: cost.agentsOnTerms,
    },
    byCity,
  };
}

export type PublishersOverview = Base & {
  section: 'publishers';
  tiles: { total: Figure; newInWindow: Figure; active: Figure; kyc: KycByState; suspended: Figure; closed: Figure };
  /** The supply funnel as `supply` answers it — the platform's state now, not the window's. */
  funnel: SupplyFunnel;
  series: { newPublishers: Series; firstListingsPublished: Series; firstBookings: Series };
  /** CP-2: what a publisher onboarded cost in agent money over the window. */
  cost: CostBlock;
  breakdowns: {
    byCity: ListPage<CityRow & { listings: number; gmv: Money; cost: Money | null; onboardings: number }>;
    byCategory: ListPage<{ key: string; label: string; href: string; publishers: number; listings: number }>;
    bySubscriptionTier: ListPage<CountRow>;
    byAgent: ListPage<LabelledCountRow>;
  };
  top: { byEarnings: ListPage<LabelledSumRow> };
  money: { earningsPaid: MoneyFigure; payoutsReleased: MoneyFigure };
};

export type AdvertisersOverview = Base & {
  section: 'advertisers';
  tiles: { total: Figure; newInWindow: Figure; active: Figure; kyc: KycByState; byIndustry: ListPage<CountRow> };
  /** The demand funnel as `advertisers` answers it — the platform's state now. */
  funnel: AdvertiserFunnel;
  series: { newAdvertisers: Series; firstCampaigns: Series; spend: MoneySeries };
  /** CP-2: what an advertiser onboarded cost in agent money over the window. */
  cost: CostBlock;
  breakdowns: {
    byCity: ListPage<CityRow & { spend: Money; cost: Money | null; onboardings: number }>;
    byIndustry: ListPage<CountRow>;
    byPackageTier: ListPage<CountRow>;
    byAgent: ListPage<LabelledCountRow>;
  };
  top: { bySpend: ListPage<LabelledSumRow> };
  money: { walletBalanceHeld: MoneyFigure; topUps: MoneyFigure };
};

export type AgentsOverview = Base & {
  section: 'agents';
  tiles: {
    total: Figure;
    newInWindow: Figure;
    active: Figure;
    byRole: { publisherAgents: number; advertiserAgents: number };
    byTier: ListPage<CountRow>;
    kyc: KycByState;
    suspended: Figure;
  };
  series: { onboardingsDone: Series; visitsCompleted: Series; jobsCompleted: Series };
  /** CP-2: the blended cost per onboarding, both sides together. It never equals the two side figures added up — an agent holding both roles counts on both. */
  cost: CostBlock;
  breakdowns: { byCity: ListPage<CityRow & { cost: Money | null; onboardings: number }>; byTier: ListPage<CountRow> };
  top: { byCommission: ListPage<LabelledSumRow>; leaderboard: LeaderboardView | null };
  money: { incentivesPaid: MoneyFigure };
};

export type PrintPartnersOverview = Base & {
  section: 'print-partners';
  tiles: { total: Figure; newInWindow: Figure; active: Figure; acceptingQuoteRequests: Figure; kyc: KycByState; byCity: ListPage<CityRow> };
  series: { quoteRequestsSent: Series; quotesReceived: Series; jobsCompleted: Series };
  breakdowns: { byCity: ListPage<CityRow>; byCapability: ListPage<CountRow> };
  top: { byJobs: ListPage<{ key: string; label: string; displayId: string | null; href: string; jobs: number; earnings: Money }> };
  /** Mean days from request to collection over the window's collected jobs; null with none. */
  averageTurnaroundDays: { value: number | null; previous: number | null; delta: number | null };
  awardsWon: { quotes: Figure; awarded: Figure; sharePct: string };
};

export type EmployeesOverviewSection = Base & {
  section: 'employees';
  /** `GET /employees/overview`, verbatim. */
  overview: EmployeesOverview;
  tiles: { joined: Figure; kyc: KycByState; tenure: { under1y: number; from1to3y: number; over3y: number }; holidays: Figure };
  breakdowns: {
    byDepartment: ListPage<{ key: string; label: string; href: string; headcount: number; openRoles: number }>;
    byWorkMode: ListPage<CountRow>;
    byEmploymentType: ListPage<CountRow>;
    byRegion: ListPage<CountRow>;
  };
  /** `GET /employees/workload?granularity=month` over the window, verbatim. */
  workload: WorkloadReport;
};

export type UsersOverview = Base & {
  section: 'users';
  tiles: {
    total: Figure;
    newInWindow: Figure;
    active: Figure;
    byRole: { publisher: number; advertiser: number; agent: number; printPartner: number; admin: number; none: number };
    twoFactor: { admins: number; enrolled: number; sharePct: string };
    closed: Figure;
    closedInWindow: Figure;
    erasureRequestsOpen: Figure;
    contactsVerified: { verified: number; total: number; sharePct: string };
  };
  series: { signUps: Series; signIns: Series };
  breakdowns: { byRole: ListPage<CountRow>; byLanguage: ListPage<CountRow>; byCity: ListPage<CityRow> };
};

/**
 * LH9 (the Lead Hunt): the Leads overview — aggregates only. The funnel by
 * stage (with the pipeline value per stage), the conversion by source /
 * agent / city / category / channel, the loss mix and the mean time to
 * convert are `leads.funnel`'s own answer over the leads CREATED in the
 * window, carried as it is; the tiles and series read the window's events
 * (created, first contacted, converted, activated, lost) against the
 * previous window; the cost per activation is the hunt's recorded rewards
 * plus the priority top-ups over the catches; the recycle yield is how many
 * of the leads recycled in the window have converted since.
 */
export type ConversionRow = { key: string; label: string; href: string | null; leads: number; converted: number; activated: number; ratePct: string };
export type ChannelRow = { key: string; label: string; href: null; firstContact: number; engaged: number; converted: number };
export type StageRow = { key: string; label: string; count: number; value: Money | null; avgDaysInStage: number | null };

export type LeadsOverview = Base & {
  section: 'leads';
  tiles: {
    /** Open now — neither converted nor lost. A state. */
    open: Figure;
    newInWindow: Figure;
    contacted: Figure;
    converted: Figure;
    activated: Figure;
    lost: Figure;
    /** Open leads by temperature now. A state. */
    byTemperature: ListPage<CountRow>;
  };
  /** The funnel over the window's cohort, as `/leads/funnel` answers it, with the stages in the pipeline's own order. */
  funnel: { byStage: StageRow[]; totals: LeadFunnelRows['totals']; lossMix: LeadFunnelRows['lossMix'] };
  series: { newLeads: Series; conversions: Series; activations: Series };
  breakdowns: {
    bySource: ListPage<ConversionRow>;
    byAgent: ListPage<ConversionRow & { displayId: string | null }>;
    byCity: ListPage<CityRow & { converted: number; ratePct: string }>;
    byCategory: ListPage<ConversionRow>;
    byChannel: ListPage<ChannelRow>;
  };
  conversion: {
    /** Days from creation to conversion over the rows converted in the window; null with none. */
    timeToConvert: { meanDays: number | null; medianDays: number | null; previousMeanDays: number | null; previousMedianDays: number | null };
    /** (incentives + top-ups) / activations, this window and the one before; null with no activation. */
    costPerActivation: { value: Money | null; previous: Money | null; incentives: Money; topUps: Money; activations: number };
    /** The pipeline's worth by stage, summed — the funnel's `value` column folded. */
    pipelineValue: Money;
  };
  recycle: { recycled: Figure; convertedAfterRecycle: Figure; yieldPct: string };
  money: { incentives: MoneyFigure; topUps: MoneyFigure };
};

/**
 * The Listings overview (2 Oct 2026, the owner: an Overview tab first on
 * Listings like every other section's). The inventory now and over the
 * window: how many listings there are, how many are live, waiting on the
 * desk or suspended (states — no previous), how many were created and went
 * live in the window, what was booked on them and the accrual gross they
 * earned; the work waiting on the section's three queues; and the listings
 * by status, city, category and publisher.
 */
export type ListingsOverview = Base & {
  section: 'listings';
  tiles: {
    total: Figure;
    live: Figure;
    awaitingReview: Figure;
    suspended: Figure;
    newInWindow: Figure;
    published: Figure;
    bookings: Figure;
  };
  series: { newListings: Series; published: Series };
  /** The section's three queues, as their tabs count them now. */
  work: {
    renewals: { due: number; lapsed: number; horizonDays: number };
    claimsOpen: number;
    verification: { due: number; lapsed: number; horizonDays: number };
  };
  breakdowns: {
    byStatus: ListPage<CountRow>;
    byCity: ListPage<CityRow & { live: number; gmv: Money }>;
    byCategory: ListPage<{ key: string; label: string; href: string; count: number; live: number; gmv: Money }>;
    byPublisher: ListPage<LabelledCountRow & { live: number }>;
  };
  money: { gmv: MoneyFigure };
};

/**
 * The Campaigns overview (the Campaigns lot, 2 Oct 2026 — the owner:
 * "Campaigns section feels too weak here"). The book now (live, scheduled,
 * awaiting payment, waiting to launch — states), what the window did
 * (paid, completed, cancelled, the booked value, the engagement), the three
 * work lists, and the campaigns by status, city, goal and advertiser.
 */
export type CampaignsOverview = Base & {
  section: 'campaigns';
  tiles: {
    live: Figure;
    scheduled: Figure;
    awaitingPayment: Figure;
    /** Paid (or reservation-fee-paid) and blocked — the launch queue's size. A state. */
    waitingToLaunch: Figure;
    paid: Figure;
    completed: Figure;
    cancelled: Figure;
    scans: Figure;
    landingViews: Figure;
    ctaClicks: Figure;
    enquiries: Figure;
  };
  series: { bookedValue: MoneySeries; scans: Series };
  work: {
    /** SCHEDULED campaigns whose flight overlaps the next seven days (today included), the directory filtered to them. */
    launchingSoon: { count: number; horizonDays: number; href: string };
    /** LIVE campaigns ending within the next seven days, the directory ending-soonest first. */
    endingSoon: { count: number; horizonDays: number; href: string };
    /** The launch queue, by what each campaign waits on (a campaign waiting on two counts under both). */
    waitingToLaunch: { total: number; href: string; byReason: ListPage<CountRow> };
  };
  breakdowns: {
    byStatus: ListPage<CountRow>;
    byCity: ListPage<CityRow & { live: number; bookedValue: Money }>;
    byGoal: ListPage<CountRow & { live: number }>;
    /** The ten advertisers whose campaigns paid in the window are worth the most. */
    byAdvertiser: ListPage<LabelledSumRow & { count: number }>;
  };
  money: { bookedValue: MoneyFigure };
};

export type SectionOverview =
  | CampaignsOverview
  | ListingsOverview
  | LeadsOverview
  | PublishersOverview
  | AdvertisersOverview
  | AgentsOverview
  | PrintPartnersOverview
  | EmployeesOverviewSection
  | UsersOverview;

/* ── The window ──────────────────────────────────────────────────────── */

const isoOf = (date: Date): string => date.toISOString().slice(0, 10);
const todayIst = (now: Date): string => isoOf(new Date(now.getTime() + IST_OFFSET_MS));
const shiftDay = (iso: string, days: number): string => isoOf(new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS));

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/**
 * `from`/`to` are inclusive Indian days; absent, the last thirty ending
 * today in India. The previous window is the same number of days
 * immediately before. `to` before `from` and a span past a year are 400s.
 */
export function resolveWindow(query: OverviewQuery, now = new Date()): ResolvedWindow {
  const to = query.to ?? todayIst(now);
  const from = query.from ?? shiftDay(to, -(DEFAULT_WINDOW_DAYS - 1));
  if (to < from) throw new ApiError(400, 'VALIDATION_ERROR', 'to must not be before from');
  const days = daysBetween(from, to);
  if (days.length > MAX_WINDOW_DAYS) throw new ApiError(400, 'VALIDATION_ERROR', `At most ${MAX_WINDOW_DAYS} days in one read`);
  const start = dayWindowISTFor(from).start;
  const end = dayWindowISTFor(to).end;
  const previousTo = shiftDay(from, -1);
  const previousFrom = shiftDay(from, -days.length);
  return {
    from,
    to,
    days,
    window: { start, end },
    previous: { start: new Date(start.getTime() - days.length * DAY_MS), end: start },
    previousFrom,
    previousTo,
    previousDays: daysBetween(previousFrom, previousTo),
  };
}

/* ── Figures, series and lists ───────────────────────────────────────── */

export const figure = (value: number, previous: number): Figure => ({ value, previous, delta: value - previous });
export const stateFigure = (value: number): Figure => ({ value, previous: null, delta: null });
export const moneyFigure = (value: Money, previous: Money): MoneyFigure => ({
  value: money(value),
  previous: money(previous),
  delta: money(new Decimal(value).minus(previous)),
});
export const stateMoney = (value: Money): MoneyFigure => ({ value: money(value), previous: null, delta: null });

function fill(days: readonly string[], points: readonly DayCount[]): DayPoint[] {
  const byDay = new Map(points.map((point) => [point.day, point.count]));
  return days.map((day) => ({ day, value: byDay.get(day) ?? 0 }));
}

function fillMoney(days: readonly string[], points: readonly DaySum[]): MoneyDayPoint[] {
  const byDay = new Map(points.map((point) => [point.day, point.sum]));
  return days.map((day) => ({ day, value: money(byDay.get(day) ?? 0) }));
}

export function seriesOf(resolved: ResolvedWindow, current: readonly DayCount[], previous: readonly DayCount[]): Series {
  const days = fill(resolved.days, current);
  const before = fill(resolved.previousDays, previous);
  const total = (points: DayPoint[]) => points.reduce((acc, point) => acc + point.value, 0);
  return { days, previous: before, total: figure(total(days), total(before)) };
}

export function moneySeriesOf(resolved: ResolvedWindow, current: readonly DaySum[], previous: readonly DaySum[]): MoneySeries {
  const days = fillMoney(resolved.days, current);
  const before = fillMoney(resolved.previousDays, previous);
  const total = (points: MoneyDayPoint[]) => points.reduce((acc, point) => acc.plus(point.value), new Decimal(0));
  return { days, previous: before, total: moneyFigure(money(total(days)), money(total(before))) };
}

/** The list contract with the whole table on one page; there is no status facet, so `counts` is `{}`. */
export function listOf<T>(items: readonly T[]): ListPage<T> {
  return { items: items.slice(0, MAX_LIST_PAGE_SIZE), total: items.length, page: 1, pageSize: MAX_LIST_PAGE_SIZE, counts: {} };
}

const kycOf = (counts: KycStateCountMap): KycByState => ({
  awaitingDocuments: counts.AWAITING_DOCUMENTS,
  requested: counts.REQUESTED,
  pending: counts.PENDING,
  needsInfo: counts.NEEDS_INFO,
  rejected: counts.REJECTED,
  verified: counts.VERIFIED,
});

const KYC_STATES: readonly KycQueueState[] = ['AWAITING_DOCUMENTS', 'REQUESTED', 'PENDING', 'NEEDS_INFO', 'REJECTED', 'VERIFIED'];
export const emptyKyc = (): KycStateCountMap => Object.fromEntries(KYC_STATES.map((state) => [state, 0])) as KycStateCountMap;

const pct = (part: number, whole: number): string => (whole === 0 ? '0.00' : new Decimal(part).dividedBy(whole).times(100).toFixed(2));

const titleCase = (key: string): string => key.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

const countRows = (rows: readonly GroupCount[], href: (key: string) => string | null, label: (key: string) => string = titleCase): CountRow[] =>
  rows.map((row) => ({ key: row.key, label: label(row.key), href: href(row.key), count: row.count }));

type LabelRow = { id: string; label: string; displayId: string | null };

async function labelled<T extends { key: string }>(
  rows: readonly T[],
  lookup: (ids: readonly string[]) => Promise<LabelRow[]>,
  href: (id: string) => string,
): Promise<(T & { label: string; displayId: string | null; href: string })[]> {
  if (rows.length === 0) return [];
  const labels = new Map((await lookup(rows.map((row) => row.key))).map((row) => [row.id, row]));
  return rows.map((row) => {
    const found = labels.get(row.key);
    return { ...row, label: found?.label ?? row.key, displayId: found?.displayId ?? null, href: href(row.key) };
  });
}

const onWire = (from: string, to: string, window: Window, days: number): WindowOnWire => ({
  from,
  to,
  start: window.start.toISOString(),
  end: window.end.toISOString(),
  days,
});

function base<S extends Section>(section: S, resolved: ResolvedWindow, city: string | undefined, now: Date): Base & { section: S } {
  return {
    section,
    window: onWire(resolved.from, resolved.to, resolved.window, resolved.days.length),
    previousWindow: onWire(resolved.previousFrom, resolved.previousTo, resolved.previous, resolved.previousDays.length),
    city: city?.trim() || null,
    generatedAt: now.toISOString(),
  };
}

/* ── The sections ────────────────────────────────────────────────────── */

async function publishers(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<PublishersOverview> {
  const { window, previous } = resolved;
  const [
    total,
    totalBefore,
    created,
    createdBefore,
    active,
    kyc,
    suspended,
    closed,
    funnel,
    newByDay,
    newByDayBefore,
    firstListings,
    firstListingsBefore,
    firstBookings,
    firstBookingsBefore,
    byCity,
    byCategory,
    byTier,
    byAgent,
    top,
    earnings,
    earningsBefore,
    payouts,
    payoutsBefore,
  ] = await Promise.all([
    repository.publishersAsAt(window.end, scope),
    repository.publishersAsAt(previous.end, scope),
    repository.publishersCreated(window, scope),
    repository.publishersCreated(previous, scope),
    repository.publishersWithLiveListing(scope),
    repository.publishersKycByState(scope),
    repository.publishersSuspended(scope),
    repository.publishersClosed(scope),
    supplyFunnel(),
    repository.publishersCreatedByDay(window, scope),
    repository.publishersCreatedByDay(previous, scope),
    repository.publishersFirstListingByDay(window, scope),
    repository.publishersFirstListingByDay(previous, scope),
    repository.publishersFirstBookingByDay(window, scope),
    repository.publishersFirstBookingByDay(previous, scope),
    repository.publishersByCity(window, scope),
    repository.publishersByCategory(scope),
    repository.runningSubscriptionsByTier(now, scope),
    repository.publishersByAgent(scope),
    repository.topPublishersByEarnings(window, scope, TOP_LIMIT),
    repository.publisherEarningsNet(window, scope),
    repository.publisherEarningsNet(previous, scope),
    repository.publisherPayoutsReleased(window, scope),
    repository.publisherPayoutsReleased(previous, scope),
  ]);
  // CP-2: the agent money behind the window's publisher onboardings.
  const cost = await costOf(window, scope, 'PUBLISHER');
  const [topRows, agentRows] = await Promise.all([
    labelled(
      top.map((row) => ({ key: row.key, amount: row.sum })),
      findPublisherLabels,
      (id) => `/publishers/${id}`,
    ),
    labelled(byAgent, findAgentLabels, (id) => `/agents/${id}`),
  ]);
  return {
    ...base('publishers', resolved, scope.city, now),
    tiles: {
      total: figure(total, totalBefore),
      newInWindow: figure(created, createdBefore),
      active: stateFigure(active),
      kyc: kycOf(kyc),
      suspended: stateFigure(suspended),
      closed: stateFigure(closed),
    },
    funnel,
    series: {
      newPublishers: seriesOf(resolved, newByDay, newByDayBefore),
      firstListingsPublished: seriesOf(resolved, firstListings, firstListingsBefore),
      firstBookings: seriesOf(resolved, firstBookings, firstBookingsBefore),
    },
    breakdowns: {
      byCity: listOf(
        byCity.map((row) => {
          const place = cityRowOf(row, (slug) => `/publishers?city=${encodeURIComponent(slug)}`);
          const zone = cost.byCity.get(place.key);
          return { ...place, count: row.count, listings: row.listings, gmv: money(row.gmv), cost: zone?.perOnboarding ?? null, onboardings: zone?.onboardings ?? 0 };
        }),
      ),
      byCategory: listOf(byCategory.map((row) => ({ key: row.key, label: titleCase(row.key), href: `/listings/directory?category=${row.key}`, publishers: row.publishers, listings: row.listings }))),
      bySubscriptionTier: listOf(countRows(byTier, () => null)),
      byAgent: listOf(agentRows),
    },
    cost: cost.block,
    top: { byEarnings: listOf(topRows) },
    money: { earningsPaid: moneyFigure(earnings, earningsBefore), payoutsReleased: moneyFigure(payouts, payoutsBefore) },
  };
}

async function advertisers(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<AdvertisersOverview> {
  const { window, previous } = resolved;
  const [
    total,
    totalBefore,
    created,
    createdBefore,
    active,
    activeBefore,
    kyc,
    byIndustry,
    funnel,
    newByDay,
    newByDayBefore,
    firstCampaigns,
    firstCampaignsBefore,
    spend,
    spendBefore,
    byCity,
    byPackageTier,
    byAgent,
    top,
    walletBalance,
    topUps,
    topUpsBefore,
  ] = await Promise.all([
    repository.advertisersAsAt(window.end, scope),
    repository.advertisersAsAt(previous.end, scope),
    repository.advertisersCreated(window, scope),
    repository.advertisersCreated(previous, scope),
    repository.advertisersWithLiveCampaign(window, scope),
    repository.advertisersWithLiveCampaign(previous, scope),
    repository.advertisersKycByState(scope),
    repository.advertisersByIndustry(scope),
    advertiserFunnel(),
    repository.advertisersCreatedByDay(window, scope),
    repository.advertisersCreatedByDay(previous, scope),
    repository.advertisersFirstCampaignByDay(window, scope),
    repository.advertisersFirstCampaignByDay(previous, scope),
    repository.advertiserSpendByDay(window, scope),
    repository.advertiserSpendByDay(previous, scope),
    repository.advertisersByCity(window, scope),
    repository.activePackageSalesByTier(scope),
    repository.advertisersByAgent(scope),
    repository.topAdvertisersBySpend(window, scope, TOP_LIMIT),
    repository.advertiserWalletBalance(scope),
    repository.advertiserTopUps(window, scope),
    repository.advertiserTopUps(previous, scope),
  ]);
  // CP-2: the agent money behind the window's advertiser onboardings.
  const cost = await costOf(window, scope, 'ADVERTISER');
  const [topRows, agentRows] = await Promise.all([
    labelled(
      top.map((row) => ({ key: row.key, amount: row.sum })),
      findAdvertiserLabels,
      (id) => `/advertisers/${id}`,
    ),
    labelled(byAgent, findAgentLabels, (id) => `/agents/${id}`),
  ]);
  const industries = listOf(countRows(byIndustry, (key) => `/advertisers?industry=${encodeURIComponent(key)}`, (key) => key));
  return {
    ...base('advertisers', resolved, scope.city, now),
    tiles: {
      total: figure(total, totalBefore),
      newInWindow: figure(created, createdBefore),
      active: figure(active, activeBefore),
      kyc: kycOf(kyc),
      byIndustry: industries,
    },
    funnel,
    series: {
      newAdvertisers: seriesOf(resolved, newByDay, newByDayBefore),
      firstCampaigns: seriesOf(resolved, firstCampaigns, firstCampaignsBefore),
      spend: moneySeriesOf(resolved, spend, spendBefore),
    },
    breakdowns: {
      byCity: listOf(
        byCity.map((row) => {
          const place = cityRowOf(row, (slug) => `/advertisers?city=${encodeURIComponent(slug)}`);
          const zone = cost.byCity.get(place.key);
          return { ...place, count: row.count, spend: money(row.spend), cost: zone?.perOnboarding ?? null, onboardings: zone?.onboardings ?? 0 };
        }),
      ),
      byIndustry: industries,
      byPackageTier: listOf(countRows(byPackageTier, () => null)),
      byAgent: listOf(agentRows),
    },
    cost: cost.block,
    top: { bySpend: listOf(topRows) },
    money: { walletBalanceHeld: stateMoney(walletBalance), topUps: moneyFigure(topUps, topUpsBefore) },
  };
}

async function agents(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<AgentsOverview> {
  const { window, previous } = resolved;
  const [
    total,
    totalBefore,
    created,
    createdBefore,
    active,
    activeBefore,
    byRole,
    byTier,
    kyc,
    suspended,
    onboardings,
    onboardingsBefore,
    visits,
    visitsBefore,
    jobs,
    jobsBefore,
    byCity,
    top,
    incentives,
    incentivesBefore,
    leaderboard,
  ] = await Promise.all([
    repository.agentsAsAt(window.end, scope),
    repository.agentsAsAt(previous.end, scope),
    repository.agentsCreated(window, scope),
    repository.agentsCreated(previous, scope),
    repository.agentsActive(window, scope),
    repository.agentsActive(previous, scope),
    repository.agentsByRole(scope),
    repository.agentsByTier(scope),
    repository.agentsKycByState(scope),
    repository.agentsSuspended(scope),
    repository.onboardingsByDay(window, scope),
    repository.onboardingsByDay(previous, scope),
    repository.visitsCompletedByDay(window, scope),
    repository.visitsCompletedByDay(previous, scope),
    repository.jobsCompletedByDay(window, scope),
    repository.jobsCompletedByDay(previous, scope),
    repository.agentsByCity(scope),
    repository.topAgentsByCommission(window, scope, TOP_LIMIT),
    repository.incentivesPaid(window, scope),
    repository.incentivesPaid(previous, scope),
    scope.city ? getLeaderboardForCity(scope.city.trim(), 'MONTH', now) : Promise.resolve(null),
  ]);
  /* CP-2: the blended figure — both sides over one denominator. It is NOT
     the two side figures added up: an agent holding both roles is counted on
     both sides, and their salary genuinely buys both. */
  const cost = await costOf(window, scope, 'ALL');
  const topRows = await labelled(
    top.map((row) => ({ key: row.key, amount: row.sum })),
    findAgentLabels,
    (id) => `/agents/${id}`,
  );
  const tiers = listOf(countRows(byTier, (key) => `/agents?tier=${key}`));
  return {
    ...base('agents', resolved, scope.city, now),
    tiles: {
      total: figure(total, totalBefore),
      newInWindow: figure(created, createdBefore),
      active: figure(active, activeBefore),
      byRole,
      byTier: tiers,
      kyc: kycOf(kyc),
      suspended: stateFigure(suspended),
    },
    series: {
      onboardingsDone: seriesOf(resolved, onboardings, onboardingsBefore),
      visitsCompleted: seriesOf(resolved, visits, visitsBefore),
      jobsCompleted: seriesOf(resolved, jobs, jobsBefore),
    },
    cost: cost.block,
    breakdowns: {
      byCity: listOf(
        cityRows(byCity, (slug) => `/agents?city=${encodeURIComponent(slug)}`).map((row) => {
          const zone = cost.byCity.get(row.key);
          return { ...row, cost: zone?.perOnboarding ?? null, onboardings: zone?.onboardings ?? 0 };
        }),
      ),
      byTier: tiers,
    },
    top: { byCommission: listOf(topRows), leaderboard },
    money: { incentivesPaid: moneyFigure(incentives, incentivesBefore) },
  };
}

async function printPartners(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<PrintPartnersOverview> {
  const { window, previous } = resolved;
  const [
    total,
    totalBefore,
    created,
    createdBefore,
    active,
    accepting,
    kyc,
    byCity,
    requests,
    requestsBefore,
    quotes,
    quotesBefore,
    jobs,
    jobsBefore,
    byCapability,
    top,
    turnaround,
    turnaroundBefore,
    awards,
    awardsBefore,
  ] = await Promise.all([
    repository.printPartnersAsAt(window.end, scope),
    repository.printPartnersAsAt(previous.end, scope),
    repository.printPartnersCreated(window, scope),
    repository.printPartnersCreated(previous, scope),
    repository.printPartnersActive(scope),
    repository.printPartnersAcceptingQuotes(scope),
    repository.printPartnersKycByState(scope),
    repository.printPartnersByCity(scope),
    repository.quoteRequestsByDay(window, scope),
    repository.quoteRequestsByDay(previous, scope),
    repository.quotesReceivedByDay(window, scope),
    repository.quotesReceivedByDay(previous, scope),
    repository.printJobsCompletedByDay(window, scope),
    repository.printJobsCompletedByDay(previous, scope),
    repository.printPartnersByCapability(scope),
    repository.topPrintPartners(window, scope, TOP_LIMIT),
    repository.printTurnaroundDays(window, scope),
    repository.printTurnaroundDays(previous, scope),
    repository.quoteAwards(window, scope),
    repository.quoteAwards(previous, scope),
  ]);
  const topRows = await labelled(
    top.map((row) => ({ key: row.key, jobs: row.jobs, earnings: money(row.earnings) })),
    findPrintPartnerLabels,
    (id) => `/print-partners/${id}`,
  );
  const cities = listOf(cityRows(byCity, (slug) => `/print-partners?city=${encodeURIComponent(slug)}`));
  return {
    ...base('print-partners', resolved, scope.city, now),
    tiles: {
      total: figure(total, totalBefore),
      newInWindow: figure(created, createdBefore),
      active: stateFigure(active),
      acceptingQuoteRequests: stateFigure(accepting),
      kyc: kycOf(kyc),
      byCity: cities,
    },
    series: {
      quoteRequestsSent: seriesOf(resolved, requests, requestsBefore),
      quotesReceived: seriesOf(resolved, quotes, quotesBefore),
      jobsCompleted: seriesOf(resolved, jobs, jobsBefore),
    },
    breakdowns: { byCity: cities, byCapability: listOf(countRows(byCapability, () => null, (key) => key)) },
    top: { byJobs: listOf(topRows) },
    averageTurnaroundDays: {
      value: turnaround,
      previous: turnaroundBefore,
      delta: turnaround !== null && turnaroundBefore !== null ? Math.round((turnaround - turnaroundBefore) * 100) / 100 : null,
    },
    awardsWon: {
      quotes: figure(awards.quotes, awardsBefore.quotes),
      awarded: figure(awards.awarded, awardsBefore.awarded),
      sharePct: pct(awards.awarded, awards.quotes),
    },
  };
}

async function employees(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<EmployeesOverviewSection> {
  const { window, previous } = resolved;
  const [overview, joined, joinedBefore, byDepartment, byWorkMode, byEmploymentType, byRegion, kyc, tenure, holidays, holidaysBefore, workload] =
    await Promise.all([
      employeesOverview(),
      repository.employeesJoined(window),
      repository.employeesJoined(previous),
      repository.employeesByDepartment(),
      repository.employeesByWorkMode(),
      repository.employeesByEmploymentType(),
      repository.employeesByRegion(),
      repository.employeesKycByState(),
      repository.employeesTenure(now),
      repository.holidaysInWindow(window),
      repository.holidaysInWindow(previous),
      workloadReport({ from: resolved.from, to: resolved.to, granularity: 'month' }, now),
    ]);
  return {
    ...base('employees', resolved, scope.city, now),
    overview,
    tiles: { joined: figure(joined, joinedBefore), kyc: kycOf(kyc), tenure, holidays: figure(holidays, holidaysBefore) },
    breakdowns: {
      byDepartment: listOf(byDepartment.map((row) => ({ key: row.key, label: row.label, href: `/hr/departments/${row.key}`, headcount: row.count, openRoles: row.openRoles }))),
      byWorkMode: listOf(countRows(byWorkMode, (key) => `/employees?workMode=${key}`)),
      byEmploymentType: listOf(countRows(byEmploymentType, (key) => `/employees?employmentType=${key}`)),
      byRegion: listOf(countRows(byRegion, (key) => `/employees?region=${encodeURIComponent(key)}`, (key) => key)),
    },
    workload,
  };
}

const ROLE_LABELS: Record<string, string> = {
  PUBLISHER: 'Publisher',
  ADVERTISER: 'Advertiser',
  AGENT_PUBLISHER: 'Publisher agent',
  AGENT_ADVERTISER: 'Advertiser agent',
  PARTNER: 'Print partner',
  ADMIN: 'Admin',
};

async function users(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<UsersOverview> {
  const { window, previous } = resolved;
  const [
    total,
    totalBefore,
    created,
    createdBefore,
    byRole,
    withoutRole,
    active,
    activeBefore,
    signUps,
    signUpsBefore,
    signIns,
    signInsBefore,
    twoFactor,
    closed,
    closedInWindow,
    closedInWindowBefore,
    erasures,
    contacts,
    byLanguage,
    byCity,
  ] = await Promise.all([
    repository.usersAsAt(window.end, scope),
    repository.usersAsAt(previous.end, scope),
    repository.usersCreated(window, scope),
    repository.usersCreated(previous, scope),
    repository.usersByRole(scope),
    repository.usersWithoutRole(scope),
    repository.usersActive(window, scope),
    repository.usersActive(previous, scope),
    repository.usersCreatedByDay(window, scope),
    repository.usersCreatedByDay(previous, scope),
    repository.usersSignInsByDay(window, scope),
    repository.usersSignInsByDay(previous, scope),
    repository.adminsTwoFactor(),
    repository.usersClosed(scope),
    repository.usersClosedInWindow(window, scope),
    repository.usersClosedInWindow(previous, scope),
    repository.erasureRequestsOpen(),
    repository.contactsVerified(scope),
    repository.usersByLanguage(scope),
    repository.usersByPartyCity(scope),
  ]);
  const roleCount = (role: string) => byRole.find((row) => row.key === role)?.count ?? 0;
  return {
    ...base('users', resolved, scope.city, now),
    tiles: {
      total: figure(total, totalBefore),
      newInWindow: figure(created, createdBefore),
      active: figure(active, activeBefore),
      byRole: {
        publisher: roleCount('PUBLISHER'),
        advertiser: roleCount('ADVERTISER'),
        agent: roleCount('AGENT_PUBLISHER') + roleCount('AGENT_ADVERTISER'),
        printPartner: roleCount('PARTNER'),
        admin: roleCount('ADMIN'),
        none: withoutRole,
      },
      twoFactor: { ...twoFactor, sharePct: pct(twoFactor.enrolled, twoFactor.admins) },
      closed: stateFigure(closed),
      closedInWindow: figure(closedInWindow, closedInWindowBefore),
      erasureRequestsOpen: stateFigure(erasures),
      contactsVerified: { ...contacts, sharePct: pct(contacts.verified, contacts.total) },
    },
    series: { signUps: seriesOf(resolved, signUps, signUpsBefore), signIns: seriesOf(resolved, signIns, signInsBefore) },
    breakdowns: {
      byRole: listOf(countRows(byRole, (key) => `/users?role=${key}`, (key) => ROLE_LABELS[key] ?? titleCase(key))),
      byLanguage: listOf(countRows(byLanguage, () => null, (key) => key)),
      byCity: listOf(cityRows(byCity, (slug) => `/users?city=${encodeURIComponent(slug)}`)),
    },
  };
}

/* ── The read ────────────────────────────────────────────────────────── */

/* ── LH9: leads ──────────────────────────────────────────────────────── */

const STAGE_LABEL: Record<string, string> = {
  SOURCED: 'Sourced',
  SCORED: 'Scored',
  CLAIMED: 'Claimed',
  CONTACTED: 'Contacted',
  ENGAGED: 'Engaged',
  VISIT_BOOKED: 'Visit booked',
  PROPOSED: 'Proposed',
  CONVERTED: 'Converted',
  ONBOARDING: 'Onboarding',
  ACTIVATED: 'Activated',
  RETAINED: 'Retained',
  LOST: 'Lost',
};

const CHANNEL_LABEL: Record<string, string> = {
  SMS: 'SMS',
  EMAIL: 'Email',
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  MESSENGER: 'Messenger',
  GOOGLE_BUSINESS: 'Google Business',
  CALL: 'Call',
  LINKEDIN: 'LinkedIn',
  IN_PERSON: 'In person',
  LINK: 'Invite link',
  OTHER: 'Other',
};

const perActivation = (incentives: Money, topUps: Money, activations: number): Money | null =>
  activations > 0 ? money(new Decimal(incentives).plus(topUps).dividedBy(activations).toFixed(2)) : null;

const timeOrNull = (read: LeadTimeToConvert, field: 'meanDays' | 'medianDays'): number | null => (read.converted > 0 ? read[field] : null);

async function leads(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<LeadsOverview> {
  const { window, previous } = resolved;
  const city = scope.city?.trim();
  const [
    open,
    created,
    createdBefore,
    createdByDay,
    createdByDayBefore,
    contacted,
    contactedBefore,
    converted,
    convertedBefore,
    convertedByDay,
    convertedByDayBefore,
    activated,
    activatedBefore,
    activatedByDay,
    activatedByDayBefore,
    lost,
    lostBefore,
    byTemperature,
    byCity,
    time,
    timeBefore,
    incentives,
    incentivesBefore,
    topUps,
    topUpsBefore,
    recycled,
    recycledBefore,
    afterRecycle,
    afterRecycleBefore,
    funnel,
  ] = await Promise.all([
    repository.leadsOpen(scope),
    repository.leadsCreated(window, scope),
    repository.leadsCreated(previous, scope),
    repository.leadsCreatedByDay(window, scope),
    repository.leadsCreatedByDay(previous, scope),
    repository.leadsContacted(window, scope),
    repository.leadsContacted(previous, scope),
    repository.leadsConverted(window, scope),
    repository.leadsConverted(previous, scope),
    repository.leadsConvertedByDay(window, scope),
    repository.leadsConvertedByDay(previous, scope),
    repository.leadsActivated(window, scope),
    repository.leadsActivated(previous, scope),
    repository.leadsActivatedByDay(window, scope),
    repository.leadsActivatedByDay(previous, scope),
    repository.leadsLost(window, scope),
    repository.leadsLost(previous, scope),
    repository.leadsByTemperature(scope),
    repository.leadsByCity(window, scope),
    repository.leadsTimeToConvert(window, scope),
    repository.leadsTimeToConvert(previous, scope),
    repository.leadIncentivesRecorded(window, scope),
    repository.leadIncentivesRecorded(previous, scope),
    repository.leadTopUpsRecorded(window, scope),
    repository.leadTopUpsRecorded(previous, scope),
    repository.leadsRecycled(window, scope),
    repository.leadsRecycled(previous, scope),
    repository.leadsConvertedAfterRecycle(window, scope),
    repository.leadsConvertedAfterRecycle(previous, scope),
    // The funnel over the window's cohort — `to` is inclusive on the funnel's side, so the window's last instant.
    leadFunnel({ ...(city ? { city } : {}), from: window.start, to: new Date(window.end.getTime() - 1) }),
  ]);

  const conversionRows = (rows: readonly { key: string; label?: string; total: number; converted: number; activated: number }[], href: (key: string) => string | null, label: (key: string) => string = titleCase): ConversionRow[] =>
    rows.map((row) => ({ key: row.key, label: row.label ?? label(row.key), href: href(row.key), leads: row.total, converted: row.converted, activated: row.activated, ratePct: pct(row.converted, row.total) }));
  const agentRows = await labelled(
    funnel.byAgent.map((row) => ({ key: row.key, leads: row.total, converted: row.converted, activated: row.activated, ratePct: pct(row.converted, row.total) })),
    findAgentLabels,
    (id) => `/agents/${id}`,
  );
  const byStage = new Map(funnel.byStage.map((row) => [row.stage, row]));
  const stages: StageRow[] = LEAD_STAGES.map((stage) => {
    const row = byStage.get(stage);
    return { key: stage, label: STAGE_LABEL[stage] ?? titleCase(stage), count: row?.count ?? 0, value: row?.value ? money(row.value) : null, avgDaysInStage: row?.avgDaysInStage ?? null };
  });
  const pipelineValue = money(stages.reduce((acc, row) => acc.plus(row.value ?? 0), new Decimal(0)));

  return {
    ...base('leads', resolved, scope.city, now),
    tiles: {
      open: stateFigure(open),
      newInWindow: figure(created, createdBefore),
      contacted: figure(contacted, contactedBefore),
      converted: figure(converted, convertedBefore),
      activated: figure(activated, activatedBefore),
      lost: figure(lost, lostBefore),
      byTemperature: listOf(countRows(byTemperature, (key) => `/leads/list?temperature=${key}`)),
    },
    funnel: { byStage: stages, totals: funnel.totals, lossMix: funnel.lossMix },
    series: {
      newLeads: seriesOf(resolved, createdByDay, createdByDayBefore),
      conversions: seriesOf(resolved, convertedByDay, convertedByDayBefore),
      activations: seriesOf(resolved, activatedByDay, activatedByDayBefore),
    },
    breakdowns: {
      bySource: listOf(conversionRows(funnel.bySource, (key) => (key === 'none' ? null : `/leads/sources?key=${encodeURIComponent(key)}`), (key) => key)),
      byAgent: listOf(agentRows),
      byCity: listOf(byCity.map((row) => ({ ...cityRowOf(row, (slug) => `/leads?city=${encodeURIComponent(slug)}`), count: row.count, converted: row.converted, ratePct: pct(row.converted, row.count) }))),
      byCategory: listOf(conversionRows(funnel.byCategory, (key) => `/leads/list?category=${encodeURIComponent(key)}`, (key) => key)),
      byChannel: listOf(funnel.byChannel.map((row) => ({ key: row.channel, label: CHANNEL_LABEL[row.channel] ?? titleCase(row.channel), href: null, firstContact: row.firstContact, engaged: row.engaged, converted: row.converted }))),
    },
    conversion: {
      timeToConvert: {
        meanDays: timeOrNull(time, 'meanDays'),
        medianDays: timeOrNull(time, 'medianDays'),
        previousMeanDays: timeOrNull(timeBefore, 'meanDays'),
        previousMedianDays: timeOrNull(timeBefore, 'medianDays'),
      },
      costPerActivation: {
        value: perActivation(incentives, topUps, activated),
        previous: perActivation(incentivesBefore, topUpsBefore, activatedBefore),
        incentives: money(incentives),
        topUps: money(topUps),
        activations: activated,
      },
      pipelineValue,
    },
    recycle: { recycled: figure(recycled, recycledBefore), convertedAfterRecycle: figure(afterRecycle, afterRecycleBefore), yieldPct: pct(afterRecycle, recycled) },
    money: { incentives: moneyFigure(incentives, incentivesBefore), topUps: moneyFigure(topUps, topUpsBefore) },
  };
}

/* ── Listings (2 Oct 2026) ───────────────────────────────────────────── */

/** The renewals tab's horizon — `GET /supply/rights-queue?horizonDays=60`, as the console asks it. */
export const LISTING_RENEWALS_HORIZON_DAYS = 60;
/** The verification tab's horizon — the widest risk window, as `GET /supply/verification-queue` reads it. Read when asked, so the constant stays supply's. */
export const listingVerificationHorizonDays = (): number => Math.max(...Object.values(RISK_WINDOW_DAYS));

/** The lifecycle in the order a listing walks it, with the console's words. */
const LISTING_STATUS_LABEL: Record<string, string> = {
  UNCLAIMED: 'Unclaimed',
  DRAFT: 'Draft',
  AWAITING_AGREEMENT: 'Awaiting agreement',
  AWAITING_DOCUMENTS: 'Awaiting documents',
  PENDING_REVIEW: 'Pending review',
  AWAITING_SITE_VERIFICATION: 'Awaiting site check',
  ACTIVE: 'Live',
  SUSPENDED: 'Suspended',
  REJECTED: 'Rejected',
  INACTIVE: 'Inactive',
};
const LISTING_STATUS_ORDER = Object.keys(LISTING_STATUS_LABEL);

async function listings(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<ListingsOverview> {
  const { window, previous } = resolved;
  const verificationHorizonDays = listingVerificationHorizonDays();
  const [
    total,
    totalBefore,
    created,
    createdBefore,
    byStatus,
    suspended,
    newByDay,
    newByDayBefore,
    publishedByDay,
    publishedByDayBefore,
    bookings,
    bookingsBefore,
    gmv,
    gmvBefore,
    byCity,
    byCategory,
    byPublisher,
    renewals,
    claimsOpen,
    verification,
  ] = await Promise.all([
    repository.listingsAsAt(window.end, scope),
    repository.listingsAsAt(previous.end, scope),
    repository.listingsCreated(window, scope),
    repository.listingsCreated(previous, scope),
    repository.listingsByStatus(scope),
    repository.listingsSuspended(scope),
    repository.listingsCreatedByDay(window, scope),
    repository.listingsCreatedByDay(previous, scope),
    repository.listingsPublishedByDay(window, scope),
    repository.listingsPublishedByDay(previous, scope),
    repository.listingBookings(window, scope),
    repository.listingBookings(previous, scope),
    repository.listingGmv(window, scope),
    repository.listingGmv(previous, scope),
    repository.listingsByCity(window, scope),
    repository.listingsByCategory(window, scope),
    repository.topPublishersByListings(scope, TOP_LIMIT),
    repository.listingRenewalsDue(now, LISTING_RENEWALS_HORIZON_DAYS, scope),
    repository.listingClaimsOpen(scope),
    repository.listingVerificationsDue(now, verificationHorizonDays, scope),
  ]);
  const status = new Map(byStatus.map((row) => [row.key, row.count]));
  const newListings = seriesOf(resolved, newByDay, newByDayBefore);
  const published = seriesOf(resolved, publishedByDay, publishedByDayBefore);
  const publisherRows = await labelled(byPublisher, findPublisherLabels, (id) => `/publishers/${id}`);
  const statusRows = [...byStatus].sort((a, b) => LISTING_STATUS_ORDER.indexOf(a.key) - LISTING_STATUS_ORDER.indexOf(b.key));
  return {
    ...base('listings', resolved, scope.city, now),
    tiles: {
      total: figure(total, totalBefore),
      live: stateFigure(status.get('ACTIVE') ?? 0),
      awaitingReview: stateFigure(status.get('PENDING_REVIEW') ?? 0),
      suspended: stateFigure(suspended),
      newInWindow: figure(created, createdBefore),
      published: published.total,
      bookings: figure(bookings, bookingsBefore),
    },
    series: { newListings, published },
    work: {
      renewals: { ...renewals, horizonDays: LISTING_RENEWALS_HORIZON_DAYS },
      claimsOpen,
      verification: { ...verification, horizonDays: verificationHorizonDays },
    },
    breakdowns: {
      byStatus: listOf(
        countRows(
          statusRows,
          (key) => `/listings/directory?status=${key}`,
          (key) => LISTING_STATUS_LABEL[key] ?? titleCase(key),
        ),
      ),
      byCity: listOf(byCity.map((row) => ({ ...cityRowOf(row, (slug) => `/listings?city=${encodeURIComponent(slug)}`), count: row.count, live: row.live, gmv: money(row.gmv) }))),
      byCategory: listOf(byCategory.map((row) => ({ key: row.key, label: titleCase(row.key), href: `/listings/directory?category=${row.key}`, count: row.count, live: row.live, gmv: money(row.gmv) }))),
      byPublisher: listOf(publisherRows),
    },
    money: { gmv: moneyFigure(gmv, gmvBefore) },
  };
}

/* ── Campaigns (2 Oct 2026) ──────────────────────────────────────────── */

/** The work lists' horizon — "launching / ending in the next 7 days". */
export const CAMPAIGN_WORK_HORIZON_DAYS = 7;

const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_PAYMENT: 'Awaiting payment',
  SCHEDULED: 'Scheduled',
  LIVE: 'Live',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
const CAMPAIGN_STATUS_ORDER = Object.keys(CAMPAIGN_STATUS_LABEL);
const CAMPAIGN_GOAL_LABEL: Record<string, string> = {
  BRAND_AWARENESS: 'Brand awareness',
  DIGITAL_LIFT: 'Digital lift',
  LOCAL_FOOTFALL: 'Local footfall',
};
export const WAITING_REASON_LABEL: Record<WaitingReason, string> = {
  RESERVATION_FEE: 'Reservation fee',
  PAYMENT: 'Payment',
  DESIGN_QUOTE: 'Design quote',
  KYC: 'KYC',
  ARTWORK: 'Artwork',
  PUBLISHER: 'Publisher',
  AGENT: 'Agent',
};

async function campaigns(resolved: ResolvedWindow, scope: Scope, now: Date): Promise<CampaignsOverview> {
  const { window, previous } = resolved;
  // The work lists read flight days, which are stored as UTC midnights: today in India, as that midnight.
  const today = todayIst(now);
  const horizonEnd = shiftDay(today, CAMPAIGN_WORK_HORIZON_DAYS - 1);
  const horizon: Window = { start: new Date(`${today}T00:00:00.000Z`), end: new Date(`${shiftDay(today, CAMPAIGN_WORK_HORIZON_DAYS)}T00:00:00.000Z`) };
  const [
    byStatus,
    paid,
    paidBefore,
    completed,
    completedBefore,
    cancelled,
    cancelledBefore,
    bookedValue,
    bookedValueBefore,
    valueByDay,
    valueByDayBefore,
    engagement,
    engagementBefore,
    scansByDay,
    scansByDayBefore,
    byCity,
    byGoal,
    byAdvertiser,
    launchingSoon,
    endingSoon,
    queue,
  ] = await Promise.all([
    repository.campaignsByStatus(scope),
    repository.campaignsPaid(window, scope),
    repository.campaignsPaid(previous, scope),
    repository.campaignsCompleted(window, scope),
    repository.campaignsCompleted(previous, scope),
    repository.campaignsCancelled(window, scope),
    repository.campaignsCancelled(previous, scope),
    repository.campaignBookedValue(window, scope),
    repository.campaignBookedValue(previous, scope),
    repository.campaignBookedValueByDay(window, scope),
    repository.campaignBookedValueByDay(previous, scope),
    repository.campaignEngagement(window, scope),
    repository.campaignEngagement(previous, scope),
    repository.campaignScansByDay(window, scope),
    repository.campaignScansByDay(previous, scope),
    repository.campaignsByCity(window, scope),
    repository.campaignsByGoal(scope),
    repository.topAdvertisersByBookedValue(window, scope, TOP_LIMIT),
    repository.campaignsLaunchingIn(horizon, scope),
    repository.campaignsEndingIn(horizon, scope),
    // The launch queue is the campaigns module's: the same gates, the same population.
    launchQueueSummary({ city: scope.city, cityId: scope.cityId }),
  ]);
  const status = new Map(byStatus.map((row) => [row.key, row.count]));
  const advertiserRows = await labelled(
    byAdvertiser.map((row) => ({ key: row.key, amount: row.sum, count: row.count })),
    findAdvertiserLabels,
    (id) => `/advertisers/${id}`,
  );
  const statusRows = [...byStatus].sort((a, b) => CAMPAIGN_STATUS_ORDER.indexOf(a.key) - CAMPAIGN_STATUS_ORDER.indexOf(b.key));
  return {
    ...base('campaigns', resolved, scope.city, now),
    tiles: {
      live: stateFigure(status.get('LIVE') ?? 0),
      scheduled: stateFigure(status.get('SCHEDULED') ?? 0),
      awaitingPayment: stateFigure(status.get('PENDING_PAYMENT') ?? 0),
      waitingToLaunch: stateFigure(queue.total),
      paid: figure(paid, paidBefore),
      completed: figure(completed, completedBefore),
      cancelled: figure(cancelled, cancelledBefore),
      scans: figure(engagement.scans, engagementBefore.scans),
      landingViews: figure(engagement.views, engagementBefore.views),
      ctaClicks: figure(engagement.ctaClicks, engagementBefore.ctaClicks),
      enquiries: figure(engagement.enquiries, engagementBefore.enquiries),
    },
    series: {
      bookedValue: moneySeriesOf(resolved, valueByDay, valueByDayBefore),
      scans: seriesOf(resolved, scansByDay, scansByDayBefore),
    },
    work: {
      launchingSoon: {
        count: launchingSoon,
        horizonDays: CAMPAIGN_WORK_HORIZON_DAYS,
        href: `/campaigns/directory?status=SCHEDULED&from=${today}&to=${horizonEnd}`,
      },
      endingSoon: { count: endingSoon, horizonDays: CAMPAIGN_WORK_HORIZON_DAYS, href: '/campaigns/directory?status=LIVE&sort=ENDING_SOON' },
      waitingToLaunch: {
        total: queue.total,
        href: '/campaigns/launch-queue',
        byReason: listOf(
          WAITING_REASONS.map((reason) => ({
            key: reason,
            label: WAITING_REASON_LABEL[reason],
            href: `/campaigns/launch-queue?reason=${reason}`,
            count: queue.byReason[reason] ?? 0,
          })),
        ),
      },
    },
    breakdowns: {
      byStatus: listOf(
        countRows(
          statusRows,
          (key) => `/campaigns/directory?status=${key}`,
          (key) => CAMPAIGN_STATUS_LABEL[key] ?? titleCase(key),
        ),
      ),
      byCity: listOf(
        byCity.map((row) => ({ ...cityRowOf(row, (slug) => `/campaigns?city=${encodeURIComponent(slug)}`), count: row.count, live: row.live, bookedValue: money(row.bookedValue) })),
      ),
      byGoal: listOf(
        byGoal.map((row) => ({ key: row.key, label: CAMPAIGN_GOAL_LABEL[row.key] ?? titleCase(row.key), href: `/campaigns/directory?goal=${row.key}`, count: row.count, live: row.live })),
      ),
      byAdvertiser: listOf(advertiserRows),
    },
    money: { bookedValue: moneyFigure(bookedValue, bookedValueBefore) },
  };
}

function load(section: Section, resolved: ResolvedWindow, scope: Scope, now: Date): Promise<SectionOverview> {
  switch (section) {
    case 'campaigns':
      return campaigns(resolved, scope, now);
    case 'listings':
      return listings(resolved, scope, now);
    case 'leads':
      return leads(resolved, scope, now);
    case 'publishers':
      return publishers(resolved, scope, now);
    case 'advertisers':
      return advertisers(resolved, scope, now);
    case 'agents':
      return agents(resolved, scope, now);
    case 'print-partners':
      return printPartners(resolved, scope, now);
    case 'employees':
      return employees(resolved, scope, now);
    case 'users':
      return users(resolved, scope, now);
  }
}

/**
 * GET /section-overviews/:section — cached a minute per section, window and
 * city. Lot X-B: `?city=` is a slug (or a name, for the console's older
 * links), resolved once to its key; every figure then narrows by the key
 * with the spelling as the fallback for the rows whose key is null.
 */
export async function sectionOverview(section: Section, query: OverviewQuery, now = new Date()): Promise<SectionOverview> {
  const resolved = resolveWindow(query, now);
  const city = query.city?.trim() || undefined;
  return readThrough(sectionOverviewCacheKey(section, resolved.from, resolved.to, city), SECTION_OVERVIEW_CACHE_SECONDS, async () =>
    load(section, resolved, { city, cityId: city ? ((await cityKeyFor(city))?.cityId ?? null) : undefined }, now),
  );
}
