import type { CostSide } from '../agents';
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

/* ── CP-2: what an onboarding cost ───────────────────────────────────── */

/**
 * Which side of the market a cost read is about.
 *
 * `PUBLISHER` and `ADVERTISER` narrow to the agents holding that role, which
 * is the whole point of the figure: the owner wants the two costs apart
 * because the work is different — a field agent walking a market and a sales
 * agent sitting in an office are not the same money per account. `ALL` is
 * the blended read on the agents overview.
 *
 * An agent holding BOTH roles counts on both sides, so the two side figures
 * never add up to the blended one. That is deliberate and the only honest
 * choice: their salary genuinely buys both, and splitting it by guesswork
 * would make a made-up number out of a real one.
 */
export type { CostSide };

/** CP-2: accounts onboarded in a window, split by whether an agent did it. */
export type OnboardingProvenance = { byAgent: number; selfServe: number; byCity: CityCount[] };

/**
 * What an onboarding cost, as far as THIS module reads it: how many there
 * were and who brought them. The money is the agents module's own — a salary
 * is a row and this port is aggregates only, so `agents` exports the cost it
 * owns the way `supply` exports its funnel.
 */
export interface CostOverviewRepository {
  /**
   * Accounts that finished onboarding in the window — a publisher by
   * `onboardingCompletedAt`, an advertiser by `activatedAt` — split by
   * whether an agent was recorded as having done it. `byCity` is the
   * agent-led half only, because the self-serve half costs no agent money.
   */
  onboardingsByProvenance(window: Window, scope: Scope, side: CostSide): Promise<OnboardingProvenance>;
}

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

/** LH9: a city group of leads with how many of them converted. */
export type LeadCityRow = CityGroup & { count: number; converted: number };
/** LH9: the converted rows in the window and how long they took, in days — zeros when none converted (the service prints null). */
export type LeadTimeToConvert = { converted: number; meanDays: number; medianDays: number };

/**
 * LH9 (the Lead Hunt): the Leads overview's aggregates. The funnel by
 * stage, the conversion by source / agent / city / category / channel and
 * the mean time to convert are `leads.funnel`'s own answer over the window's
 * cohort, carried through that export; what is read here is what the
 * funnel does not say — the day series, the previous-window figures, the
 * median, the hunt's money and the recycle yield.
 */
export interface LeadsOverviewRepository {
  /** Open leads now — neither converted nor lost. A state. */
  leadsOpen(scope: Scope): Promise<number>;
  leadsCreated(window: Window, scope: Scope): Promise<number>;
  leadsCreatedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** First contacts logged in the window (`firstContactedAt`, stamped once). */
  leadsContacted(window: Window, scope: Scope): Promise<number>;
  leadsConverted(window: Window, scope: Scope): Promise<number>;
  leadsConvertedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** The catch — `activatedAt` in the window. */
  leadsActivated(window: Window, scope: Scope): Promise<number>;
  leadsActivatedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Lost in the window — stage LOST reached inside it. */
  leadsLost(window: Window, scope: Scope): Promise<number>;
  /** Open leads by temperature now. A state. */
  leadsByTemperature(scope: Scope): Promise<GroupCount[]>;
  /** Leads created in the window by city key, with how many of them converted. */
  leadsByCity(window: Window, scope: Scope): Promise<LeadCityRow[]>;
  /** Days from creation to conversion over the rows converted in the window: the mean and the median. */
  leadsTimeToConvert(window: Window, scope: Scope): Promise<LeadTimeToConvert>;
  /** LEAD_CONVERTED / ACTIVATED / RETAINED recorded in the window (any status but REJECTED), the priority rows aside; scoped by the agent's city. */
  leadIncentivesRecorded(window: Window, scope: Scope): Promise<Money>;
  /** The priority-zone top-ups recorded in the window (LH5 keys them `priority:<zone>:<lead>`); scoped by the agent's city. */
  leadTopUpsRecorded(window: Window, scope: Scope): Promise<Money>;
  /** Leads that came back to the cold pool in the window (`recycledAt`). */
  leadsRecycled(window: Window, scope: Scope): Promise<number>;
  /** Of the leads recycled in the window, how many have converted since — the recycle yield's numerator. */
  leadsConvertedAfterRecycle(window: Window, scope: Scope): Promise<number>;
}

/** The Listings overview's city row: listings in the city, the live ones, and the accrual gross on them over the window. */
export type ListingCityRow = CityGroup & { count: number; live: number; gmv: Money };
/** A listing category: its listings, the live ones, and their accrual gross over the window. */
export type ListingCategoryRow = { key: string; count: number; live: number; gmv: Money };
/** A publisher's listings, and the live ones — the top by listings. */
export type ListingPublisherRow = { key: string; count: number; live: number };
/** A queue's size now, and how much of it has already run out. */
export type DueCount = { due: number; lapsed: number };

/**
 * The Listings overview's aggregates (2 Oct 2026). A listing's city is its
 * own (`Listing.cityId`, the spelling as the fallback); a booking is a spot
 * on a campaign paid in the window, neither cancelled — the same count the
 * admin overview's breakdown reads by listing — and the GMV is the accrual
 * gross over the window's days, the column the publishers overview calls
 * GMV. The three queues are the console tabs' own reads, counted: the
 * renewals queue's sixty days, the verification queue's widest risk window,
 * the claims still pending.
 */
export interface ListingsOverviewRepository {
  /** Listings created before `at` — every status, unclaimed ones too. */
  listingsAsAt(at: Date, scope: Scope): Promise<number>;
  listingsCreated(window: Window, scope: Scope): Promise<number>;
  listingsCreatedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Listings by `publishedAt` — the day ADX let them onto the marketplace. */
  listingsPublishedByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  /** Listings per lifecycle status now. A state. */
  listingsByStatus(scope: Scope): Promise<GroupCount[]>;
  /** Listings with any suspension section in force, or at status SUSPENDED. A state. */
  listingsSuspended(scope: Scope): Promise<number>;
  /** CampaignSpot rows on campaigns paid in the window, neither the spot nor the campaign cancelled. */
  listingBookings(window: Window, scope: Scope): Promise<number>;
  /** EarningAccrual.gross for the window's days. */
  listingGmv(window: Window, scope: Scope): Promise<Money>;
  listingsByCity(window: Window, scope: Scope): Promise<ListingCityRow[]>;
  listingsByCategory(window: Window, scope: Scope): Promise<ListingCategoryRow[]>;
  /** Publishers by how many listings they hold, largest first; unclaimed listings left out. */
  topPublishersByListings(scope: Scope, limit: number): Promise<ListingPublisherRow[]>;
  /** Leases, licences and permits running out within `horizonDays` of `now` (`due`), and those already past (`lapsed`). */
  listingRenewalsDue(now: Date, horizonDays: number, scope: Scope): Promise<DueCount>;
  /** Listing claims still PENDING. */
  listingClaimsOpen(scope: Scope): Promise<number>;
  /** Live or suspended listings whose verification runs out within `horizonDays` (`due`), and those already lapsed. */
  listingVerificationsDue(now: Date, horizonDays: number, scope: Scope): Promise<DueCount>;
}

/** The Campaigns overview's city row: campaigns aimed at the city (every status), the live ones, and the value paid in the window. */
export type CampaignCityRow = CityGroup & { count: number; live: number; bookedValue: Money };
/** A campaign goal: campaigns with it (every status) and the live ones. */
export type CampaignGoalRow = { key: string; count: number; live: number };
/** An advertiser's campaigns paid in the window: their value and how many. */
export type CampaignAdvertiserValueRow = { key: string; sum: Money; count: number };
/** Engagement recorded in a window: QR scans, landing-page views, CTA presses, enquiries (form submissions). */
export type CampaignEngagement = { scans: number; views: number; ctaClicks: number; enquiries: number };

/**
 * The Campaigns overview's aggregates (the Campaigns lot, 2 Oct 2026). A
 * campaign's city is the market it targets — `targetMarketCityId`, the typed
 * `targetMarket` as the fallback (Lot X-B). **Booked value** is the `total`
 * of the campaigns PAID in the window (`paidAt`), cancelled ones left out —
 * the column the advertisers overview's spend reads. Engagement is the
 * `TrackingEvent` rows ADX recorded in the window, through the campaign's
 * codes. The launch queue is not counted here: `campaigns.launchQueueSummary`
 * owns the gates and is carried through.
 */
export interface CampaignsOverviewRepository {
  /** Campaigns per status now. A state. */
  campaignsByStatus(scope: Scope): Promise<GroupCount[]>;
  /** `completedAt` in the window. */
  campaignsCompleted(window: Window, scope: Scope): Promise<number>;
  /** `cancelledAt` in the window. */
  campaignsCancelled(window: Window, scope: Scope): Promise<number>;
  /** Campaigns paid in the window, cancelled ones left out. */
  campaignsPaid(window: Window, scope: Scope): Promise<number>;
  campaignBookedValue(window: Window, scope: Scope): Promise<Money>;
  campaignBookedValueByDay(window: Window, scope: Scope): Promise<DaySum[]>;
  campaignEngagement(window: Window, scope: Scope): Promise<CampaignEngagement>;
  campaignScansByDay(window: Window, scope: Scope): Promise<DayCount[]>;
  campaignsByCity(window: Window, scope: Scope): Promise<CampaignCityRow[]>;
  campaignsByGoal(scope: Scope): Promise<CampaignGoalRow[]>;
  /** Advertisers by the value of their campaigns paid in the window, largest first. */
  topAdvertisersByBookedValue(window: Window, scope: Scope, limit: number): Promise<CampaignAdvertiserValueRow[]>;
  /** SCHEDULED campaigns whose flight overlaps `range` (UTC days) — due to go live in it, or overdue and still waiting. */
  campaignsLaunchingIn(range: Window, scope: Scope): Promise<number>;
  /** LIVE campaigns whose flight ends inside `range` (UTC days). */
  campaignsEndingIn(range: Window, scope: Scope): Promise<number>;
}

export type SectionOverviewsRepository = CostOverviewRepository &
  CampaignsOverviewRepository &
  ListingsOverviewRepository &
  PublishersOverviewRepository &
  AdvertisersOverviewRepository &
  AgentsOverviewRepository &
  PrintPartnersOverviewRepository &
  EmployeesOverviewRepository &
  UsersOverviewRepository &
  LeadsOverviewRepository;
