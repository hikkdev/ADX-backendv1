import type { KycQueueState } from '../../shared/kyc-state';
import type { Money } from '../../shared/money';

/**
 * The aggregates behind the six section overviews — package O-B.
 *
 * Every method resolves to a number, a decimal string, or grouped counts —
 * never a row. This module reads across the tables the party modules own,
 * the way `admin-overview` does, and the port keeps that honest: nothing
 * returned here can be written back, and nothing here can grow into a second
 * read model of any party. Add a figure by adding an aggregate; if a figure
 * needs a row, the module that owns the row exports it instead (the funnels,
 * the leaderboard, the employees' overview and workload, the label lookups).
 *
 * `Window` is `[start, end)` in UTC instants on Indian day boundaries;
 * `Scope.city` narrows to the party's own city — Lot X-B: by the key
 * (`cityId`) when the facet resolved to one, the spelling (case-insensitive)
 * catching the rows whose key is null — the README says which column each
 * section reads.
 */

export type Window = { start: Date; end: Date };
export type Scope = { city?: string | undefined; cityId?: string | null | undefined };

/** A count per Indian day, `day` as `YYYY-MM-DD`. Days with nothing are absent; the service fills the zeros. */
export type DayCount = { day: string; count: number };
/** A sum per Indian day, money as a decimal string. */
export type DaySum = { day: string; sum: Money };
/** A count per group — a tier, a role, a party id. */
export type GroupCount = { key: string; count: number };
/** A sum per group, money as a decimal string. */
export type GroupSum = { key: string; sum: Money };
/** The six queue states of `shared/kyc-state`, each a count of parties. */
export type KycStateCountMap = Record<KycQueueState, number>;

/**
 * Lot X-B: a city group — by key, labelled from the `City` row; the rows
 * whose key is null come back as ONE group with `cityId` null and the raw
 * strings they were typed under in `typed` (the service draws it as
 * "Other (typed)").
 */
export type CityGroup = { cityId: string | null; slug: string | null; name: string | null; typed: string[] };
export type CityCount = CityGroup & { count: number };

export type PublisherCityRow = CityGroup & { count: number; listings: number; gmv: Money };
export type PublisherCategoryRow = { key: string; publishers: number; listings: number };
export type AdvertiserCityRow = CityGroup & { count: number; spend: Money };
export type PrintPartnerJobsRow = { key: string; jobs: number; earnings: Money };
export type DepartmentRow = { key: string; label: string; count: number; openRoles: number };

export interface PublishersOverviewRepository {
  /** Publishers created before `at` — the population as at an instant, so a window and the one before it compare. */
  publishersAsAt(at: Date, scope: Scope): Promise<number>;
  publishersCreated(window: Window, scope: Scope): Promise<number>;
  publishersCreatedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Publishers with at least one ACTIVE listing now. */
  publishersWithLiveListing(scope: Scope): Promise<number>;
  publishersKycByState(scope: Scope): Promise<KycStateCountMap>;
  publishersSuspended(scope: Scope): Promise<number>;
  /** Publishers whose login is closed (`User.closedAt`). */
  publishersClosed(scope: Scope): Promise<number>;
  /** Publishers whose FIRST listing went live on the day — `_min(publishedAt)` per publisher, kept when it falls in the window. */
  publishersFirstListingByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Publishers whose FIRST delivered booking day fell on the day — `_min(forDate)` per publisher over EarningAccrual. */
  publishersFirstBookingByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Per publisher city: publishers, their ACTIVE listings, and their accrual gross in the window. */
  publishersByCity(window: Window, scope: Scope): Promise<PublisherCityRow[]>;
  /** Per listing category: publishers with a listing in it, and the ACTIVE listings in it. */
  publishersByCategory(scope: Scope): Promise<PublisherCategoryRow[]>;
  /** Subscriptions running at `now` (started, not ended), per tier. */
  runningSubscriptionsByTier(now: Date, scope: Scope): Promise<GroupCount[]>;
  /** Publishers per onboarding agent (`Publisher.agentId`), unattributed left out. */
  publishersByAgent(scope: Scope): Promise<GroupCount[]>;
  /** EarningAccrual.net per publisher for the window's days, largest first. */
  topPublishersByEarnings(window: Window, scope: Scope, limit: number): Promise<GroupSum[]>;
  /** EarningAccrual.net for the window's days. */
  publisherEarningsNet(window: Window, scope: Scope): Promise<Money>;
  /** WithdrawalRequest.netAmount PAID by `paidAt` from publisher wallets. */
  publisherPayoutsReleased(window: Window, scope: Scope): Promise<Money>;
}

export interface AdvertisersOverviewRepository {
  advertisersAsAt(at: Date, scope: Scope): Promise<number>;
  advertisersCreated(window: Window, scope: Scope): Promise<number>;
  advertisersCreatedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Advertisers with a campaign that ran on any day of the window (LIVE, PAUSED or COMPLETED, flight overlapping it). */
  advertisersWithLiveCampaign(window: Window, scope: Scope): Promise<number>;
  advertisersKycByState(scope: Scope): Promise<KycStateCountMap>;
  advertisersByIndustry(scope: Scope): Promise<GroupCount[]>;
  /** Advertisers whose FIRST paid campaign was paid on the day — `_min(paidAt)` per advertiser. */
  advertisersFirstCampaignByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Campaign.total plus PackageSale.total by the day they were paid, neither CANCELLED. */
  advertiserSpendByDay(window: Window, scope: Scope): Promise<DaySum[]>;
  /** Per advertiser city: advertisers and what they paid in the window. */
  advertisersByCity(window: Window, scope: Scope): Promise<AdvertiserCityRow[]>;
  /** PackageSale ACTIVE per tier. */
  activePackageSalesByTier(scope: Scope): Promise<GroupCount[]>;
  advertisersByAgent(scope: Scope): Promise<GroupCount[]>;
  /** What each advertiser paid in the window (campaigns + package sales), largest first. */
  topAdvertisersBySpend(window: Window, scope: Scope, limit: number): Promise<GroupSum[]>;
  /** Wallet.balance summed over advertiser wallets. */
  advertiserWalletBalance(scope: Scope): Promise<Money>;
  /** WalletTopUp.amount by `receivedAt` into advertiser wallets. */
  advertiserTopUps(window: Window, scope: Scope): Promise<Money>;
}

export interface AgentsOverviewRepository {
  agentsAsAt(at: Date, scope: Scope): Promise<number>;
  agentsCreated(window: Window, scope: Scope): Promise<number>;
  /** Agents with an order touched in the window or a visit scheduled or completed in it. */
  agentsActive(window: Window, scope: Scope): Promise<number>;
  /** Agents by the two agent roles on their login; one agent may hold both. */
  agentsByRole(scope: Scope): Promise<{ publisherAgents: number; advertiserAgents: number }>;
  agentsByTier(scope: Scope): Promise<GroupCount[]>;
  agentsKycByState(scope: Scope): Promise<KycStateCountMap>;
  agentsSuspended(scope: Scope): Promise<number>;
  /** Publishers and advertisers activated on the day with an agent on them. */
  onboardingsByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** FieldVisit COMPLETED by `completedAt`. */
  visitsCompletedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Order COMPLETED by `adminApprovedAt`, with an agent on it. */
  jobsCompletedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  agentsByCity(scope: Scope): Promise<CityCount[]>;
  /** AgentIncentive.netAmount CREDITED by `verifiedAt`, per agent, largest first. */
  topAgentsByCommission(window: Window, scope: Scope, limit: number): Promise<GroupSum[]>;
  /** AgentIncentive.netAmount CREDITED by `verifiedAt`. */
  incentivesPaid(window: Window, scope: Scope): Promise<Money>;
}

export interface PrintPartnersOverviewRepository {
  printPartnersAsAt(at: Date, scope: Scope): Promise<number>;
  printPartnersCreated(window: Window, scope: Scope): Promise<number>;
  printPartnersActive(scope: Scope): Promise<number>;
  printPartnersAcceptingQuotes(scope: Scope): Promise<number>;
  printPartnersKycByState(scope: Scope): Promise<KycStateCountMap>;
  printPartnersByCity(scope: Scope): Promise<CityCount[]>;
  /** PrintQuoteRequest by `createdAt`; the city is the request's own. */
  quoteRequestsByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** PrintQuote by `submittedAt`; the city is the quoting partner's. */
  quotesReceivedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** PrintJob by `collectedAt` — a job is complete when the prints were collected. */
  printJobsCompletedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Partners per capability string (a partner with three capabilities counts in three groups). */
  printPartnersByCapability(scope: Scope): Promise<GroupCount[]>;
  /** Per partner: jobs collected in the window and the actual cost approved on them. */
  topPrintPartners(window: Window, scope: Scope, limit: number): Promise<PrintPartnerJobsRow[]>;
  /** Mean of `collectedAt - requestedAt` in days over jobs collected in the window; null with none. */
  printTurnaroundDays(window: Window, scope: Scope): Promise<number | null>;
  /** Quotes submitted in the window, and how many of them were ACCEPTED. */
  quoteAwards(window: Window, scope: Scope): Promise<{ quotes: number; awarded: number }>;
}

export interface EmployeesOverviewRepository {
  /** Employee rows created in the window — the join date the platform records. */
  employeesJoined(window: Window): Promise<number>;
  /** Active departments with their active headcount and open roles. */
  employeesByDepartment(): Promise<DepartmentRow[]>;
  employeesByWorkMode(): Promise<GroupCount[]>;
  employeesByEmploymentType(): Promise<GroupCount[]>;
  employeesByRegion(): Promise<GroupCount[]>;
  employeesKycByState(): Promise<KycStateCountMap>;
  /** Active employees by time since their row was created: under a year, one to three, three and more. */
  employeesTenure(now: Date): Promise<{ under1y: number; from1to3y: number; over3y: number }>;
  holidaysInWindow(window: Window): Promise<number>;
}

export interface UsersOverviewRepository {
  usersAsAt(at: Date, scope: Scope): Promise<number>;
  usersCreated(window: Window, scope: Scope): Promise<number>;
  usersCreatedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** UserRole rows per role — a login with two roles counts in both. */
  usersByRole(scope: Scope): Promise<GroupCount[]>;
  usersWithoutRole(scope: Scope): Promise<number>;
  /** Logins whose `lastLoginAt` falls in the window. */
  usersActive(window: Window, scope: Scope): Promise<number>;
  /** Logins by the day of their `lastLoginAt` — the most recent sign-in only, the column being what it is. */
  usersSignInsByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** ADMIN logins, and how many have a confirmed authenticator. */
  adminsTwoFactor(): Promise<{ admins: number; enrolled: number }>;
  usersClosed(scope: Scope): Promise<number>;
  usersClosedInWindow(window: Window, scope: Scope): Promise<number>;
  /** ErasureRequest PENDING or APPROVED — not yet DONE or REFUSED. */
  erasureRequestsOpen(): Promise<number>;
  /** UserContact rows, and how many carry `verifiedAt`. */
  contactsVerified(scope: Scope): Promise<{ verified: number; total: number }>;
  usersByLanguage(scope: Scope): Promise<GroupCount[]>;
  /** Logins by the city their party profile gives — publisher, advertiser and agent profiles summed. */
  usersByPartyCity(scope: Scope): Promise<CityCount[]>;
}

export type SectionOverviewsRepository = PublishersOverviewRepository &
  AdvertisersOverviewRepository &
  AgentsOverviewRepository &
  PrintPartnersOverviewRepository &
  EmployeesOverviewRepository &
  UsersOverviewRepository;
