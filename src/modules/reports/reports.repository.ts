import type { Prisma, ReportCadence, ReportFormat, ReportRun, ReportRunStatus, ReportSchedule } from '../../shared/database';
import type { OnboardingSource } from '../../shared/database';
import type { Decimal } from '../../shared/money';
import type { ListQuery } from '../../shared/pagination';

/**
 * Persistence seams for reports — Lot G (Q129/Q143).
 *
 * Two interfaces. `ReportsRepository` is this module's own tables — the
 * runs and the schedules — plus the one read outside them a schedule with
 * no recipients needs (the admins' addresses). `ReportData` is what the
 * catalogue's twelve queries read: a read-only walk across the other
 * modules' tables, the way `admin-overview` reads the ledger, because a
 * report is a join across domains and no module owns the join. Nothing in
 * here writes another module's row.
 */

export type Window = { start: Date; end: Date };

export const REPORT_RUN_STATUSES = ['RUNNING', 'READY', 'FAILED'] as const;
export const REPORT_SORTS = ['newest', 'oldest'] as const;
/** Schedules have no status column; the chip row is enabled / disabled. */
export const SCHEDULE_STATUSES = ['ENABLED', 'DISABLED'] as const;

export interface NewReportRun {
  kind: string;
  format: ReportFormat;
  filters: Prisma.InputJsonValue | null;
  scheduleId: string | null;
  requestedById: string | null;
}

export interface ReportRunPatch {
  status?: ReportRunStatus;
  fileId?: string | null;
  rowCount?: number | null;
  error?: string | null;
  finishedAt?: Date | null;
  expiresAt?: Date | null;
}

export interface RunFilter {
  q?: string | undefined;
  status?: readonly ReportRunStatus[] | undefined;
  kind?: string | undefined;
  scheduleId?: string | undefined;
}

export interface NewReportSchedule {
  kind: string;
  name: string;
  cadence: ReportCadence;
  format: ReportFormat;
  recipients: string[];
  filters: Prisma.InputJsonValue | null;
  enabled: boolean;
  createdById: string;
  nextRunAt: Date;
}

export interface ReportSchedulePatch {
  name?: string;
  cadence?: ReportCadence;
  format?: ReportFormat;
  recipients?: string[];
  filters?: Prisma.InputJsonValue | null;
  enabled?: boolean;
  lastRunAt?: Date | null;
  nextRunAt?: Date | null;
}

export interface ScheduleFilter {
  q?: string | undefined;
  status?: readonly (typeof SCHEDULE_STATUSES)[number][] | undefined;
  kind?: string | undefined;
}

export interface ReportsRepository {
  createRun(data: NewReportRun): Promise<ReportRun>;
  updateRun(id: string, patch: ReportRunPatch): Promise<ReportRun>;
  findRun(id: string): Promise<ReportRun | null>;
  listRuns(filter: RunFilter, page: ListQuery): Promise<{ items: ReportRun[]; total: number; counts: Record<string, number> }>;

  createSchedule(data: NewReportSchedule): Promise<ReportSchedule>;
  findSchedule(id: string): Promise<ReportSchedule | null>;
  listSchedules(filter: ScheduleFilter, page: ListQuery): Promise<{ items: ReportSchedule[]; total: number; counts: Record<string, number> }>;
  updateSchedule(id: string, patch: ReportSchedulePatch): Promise<ReportSchedule>;
  deleteSchedule(id: string): Promise<void>;
  /** Enabled schedules whose `nextRunAt` is at or before `now`. */
  findDueSchedules(now: Date): Promise<ReportSchedule[]>;

  /** Every live ADMIN account's email — the default recipients of a schedule with none. */
  adminEmails(): Promise<string[]>;
  /**
   * G11-2: the schedule mailed this run — to how many, and when. Until
   * `ReportRun` has `mailedTo` / `mailedAt` columns (schema need), the
   * record is kept under the reserved `$mailed` key of the run's `filters`
   * JSON; `runView` in the service splits it back out, so the wire never
   * shows it as a filter.
   */
  recordMailed(id: string, mailed: { to: number; at: Date }): Promise<ReportRun>;
  /** G13-B: every run started at or after `since` — a week's worth, for the list's summary. */
  findRunsStartedSince(since: Date): Promise<ReportRun[]>;
  /** G13-B: the recipient set of every enabled schedule; an empty set means the admins. */
  enabledScheduleRecipients(): Promise<string[][]>;
}

/** G11-2: the reserved key `recordMailed` writes into `ReportRun.filters` — never a filter a kind declares. */
export const MAILED_KEY = '$mailed';

/* ── What the twelve reports read ────────────────────────────────── */

export interface BookingRow {
  kind: 'CAMPAIGN' | 'PACKAGE';
  reference: string;
  name: string;
  advertiserDisplayId: string | null;
  advertiserName: string;
  agentDisplayId: string | null;
  paidAt: Date | null;
  subtotal: Decimal | null;
  gst: Decimal | null;
  total: Decimal | null;
  status: string;
}

export interface PublisherEarningsRow {
  publisherId: string;
  displayId: string | null;
  name: string;
  city: string | null;
  gross: Decimal;
  commission: Decimal;
  taxWithheld: Decimal;
  net: Decimal;
  accrualDays: number;
}

export interface PublisherPayoutRow {
  publisherId: string;
  paidCount: number;
  paidTotal: Decimal;
}

export interface AdvertiserSpendRow {
  advertiserId: string;
  displayId: string | null;
  name: string;
  industry: string | null;
  campaignsPaid: number;
  campaignTotal: Decimal;
  packagesPaid: number;
  packageTotal: Decimal;
}

export interface AdvertiserRefundRow {
  advertiserId: string;
  gatewayRefunds: Decimal;
  walletRefunds: Decimal;
}

export interface AgentCommissionRow {
  agentDisplayId: string | null;
  agentName: string | null;
  event: string;
  tier: string;
  amount: Decimal;
  taxWithheld: Decimal;
  netAmount: Decimal;
  status: string;
  createdAt: Date;
  verifiedAt: Date | null;
}

export interface FunnelRow {
  party: 'PUBLISHER' | 'ADVERTISER' | 'AGENT';
  created: number;
  kycSubmitted: number;
  kycVerified: number;
  kycRejected: number;
  activated: number | null;
}

export interface ListingRow {
  displayId: string | null;
  title: string;
  category: string;
  city: string | null;
  publisherName: string | null;
  status: string;
  ratePerDay: Decimal | null;
  slotsTotal: number;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface KycAgeingRow {
  type: 'PUBLISHER' | 'ADVERTISER' | 'AGENT' | 'USER';
  partyId: string;
  partyLabel: string | null;
  method: string | null;
  submittedAt: Date;
  assigned: boolean;
  escalatedAt: Date | null;
}

export interface SupportTicketRow {
  displayId: string | null;
  kind: string;
  priority: string;
  status: string;
  team: string | null;
  createdAt: Date;
  firstResponseDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolutionDueAt: Date | null;
  resolvedAt: Date | null;
}

export interface DisputeRow {
  displayId: string;
  status: string;
  reason: string;
  raisedAs: string;
  againstParty: string;
  createdAt: Date;
  resolvedAt: Date | null;
  outcome: string | null;
  creditedAmount: Decimal | null;
}

export interface FraudCaseRow {
  displayId: string | null;
  status: string;
  kind: string;
  subjectType: string;
  createdAt: Date;
  decidedAt: Date | null;
  decision: string | null;
  score: Decimal | null;
}

export interface DeliveryCountRow {
  templateKey: string | null;
  channel: string;
  status: string;
  count: number;
}

export interface CampaignMetricRow {
  reference: string;
  name: string;
  advertiserName: string;
  status: string;
  days: number;
  spotsLive: number;
  spend: Decimal;
  scans: number;
  clicks: number;
  redemptions: number;
  reachFromSpots: number;
}

export interface PlatformSummary {
  bookings: number;
  gmv: Decimal;
  platformRevenue: Decimal;
  publisherEarnings: Decimal;
  payoutsPaid: Decimal;
  newPublishers: number;
  newAdvertisers: number;
  newAgents: number;
  listingsPublished: number;
  activeCampaigns: number;
  kycPending: number;
  ticketsOpened: number;
  disputesOpened: number;
  fraudCasesOpened: number;
  deliveriesSent: number;
}

/** QR-14: one row of the team onboarding board — a person (or "organic"), what they onboarded in the window and how far it got. */
export interface OnboardingBoardRow {
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  /** How many came through each door under this person. */
  via: Record<OnboardingSource, number>;
  publishers: number;
  advertisers: number;
  onboarded: number;
  /** Publishers whose onboarding reached COMPLETE; advertisers with an activated account. */
  completed: number;
  /** Publishers with a listing live within seven days of onboarding. */
  liveWithin7d: number;
  /** KYC verified. */
  verified: number;
  /** Publishers with a first booking; advertisers with a first paid campaign or package. */
  firstBooking: number;
}

export interface ReportData {
  /** QR-14: the team onboarding board for the window. */
  onboardingBoard(window: Window, f: { via?: OnboardingSource; role?: string }): Promise<OnboardingBoardRow[]>;
  bookings(window: Window, f: { advertiserId?: string; agentId?: string; kind?: 'CAMPAIGN' | 'PACKAGE' }): Promise<BookingRow[]>;
  publisherEarnings(window: Window, f: { publisherId?: string; city?: string }): Promise<PublisherEarningsRow[]>;
  publisherPayouts(window: Window, publisherIds: readonly string[] | null): Promise<PublisherPayoutRow[]>;
  advertiserSpend(window: Window, f: { advertiserId?: string; industry?: string }): Promise<AdvertiserSpendRow[]>;
  advertiserRefunds(window: Window, advertiserIds: readonly string[] | null): Promise<AdvertiserRefundRow[]>;
  agentCommissions(window: Window, f: { agentId?: string; status?: string; event?: string }): Promise<AgentCommissionRow[]>;
  onboardingFunnel(window: Window, f: { city?: string }): Promise<FunnelRow[]>;
  listings(window: Window, f: { status?: string; city?: string; category?: string }): Promise<ListingRow[]>;
  kycAgeing(asOf: Date, f: { type?: KycAgeingRow['type'] }): Promise<KycAgeingRow[]>;
  supportTickets(window: Window, f: { priority?: string; status?: string; team?: string }): Promise<SupportTicketRow[]>;
  disputes(window: Window, f: { status?: string }): Promise<DisputeRow[]>;
  fraudCases(window: Window, f: { status?: string }): Promise<FraudCaseRow[]>;
  deliveryCounts(window: Window, f: { channel?: string; templateKey?: string }): Promise<DeliveryCountRow[]>;
  campaignMetrics(window: Window, f: { advertiserId?: string; campaignId?: string }): Promise<CampaignMetricRow[]>;
  platformSummary(window: Window): Promise<PlatformSummary>;
}
