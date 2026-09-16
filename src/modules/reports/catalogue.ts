import { z } from 'zod';
import { money } from '../../shared/money';
import type { Decimal } from '../../shared/money';
import type { ReportData, Window } from './reports.repository';

/**
 * The catalogue — Lot G (Q129/Q143): twelve reports, defined in code.
 *
 * A report is a kind, a name, what it is for, the filters it takes, the
 * columns it prints and a query that answers rows for a window. The
 * catalogue is data the console reads (`GET /reports/catalogue`) and the
 * contract a run or a schedule is validated against — a filter a kind does
 * not declare is refused, never silently ignored. The queries read through
 * `ReportData`, so the twelve stay testable without a database and the
 * ORM stays behind the repository.
 *
 * Money is printed as a two-place string (`money`), dates as ISO instants;
 * the CSV is meant to be loaded into a spreadsheet, the PDF to be read.
 */

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
}

export type FilterDef =
  | { key: string; label: string; type: 'string' }
  | { key: string; label: string; type: 'id' }
  | { key: string; label: string; type: 'enum'; values: readonly [string, ...string[]] };

export interface ReportKind {
  kind: string;
  name: string;
  description: string;
  filters: readonly FilterDef[];
  columns: readonly ReportColumn[];
  /** Rows for the window; the filters have already passed `filterSchema`. */
  query(filters: Record<string, string | undefined>, window: Window): Promise<ReportRow[]>;
}

/** The zod schema a kind's filters are parsed with: every declared filter optional, nothing else allowed. */
export function filterSchemaFor(kind: Pick<ReportKind, 'filters'>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const def of kind.filters) {
    shape[def.key] =
      def.type === 'enum' ? z.enum(def.values).optional() : def.type === 'id' ? z.string().trim().min(1).max(64).optional() : z.string().trim().min(1).max(120).optional();
  }
  return z.strictObject(shape);
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);
const amount = (value: Decimal | null | undefined): string | null => (value === null || value === undefined ? null : money(value));
const hoursBetween = (from: Date, to: Date): number => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 3_600_000));
const breached = (dueAt: Date | null, doneAt: Date | null, asOf: Date): 'YES' | 'NO' | '' => {
  if (!dueAt) return '';
  return (doneAt ?? asOf).getTime() > dueAt.getTime() ? 'YES' : 'NO';
};
const pct = (part: number, whole: number): string | null => (whole === 0 ? null : `${((100 * part) / whole).toFixed(1)}%`);

const R = (key: string, label: string): ReportColumn => ({ key, label, align: 'right' });
const L = (key: string, label: string): ReportColumn => ({ key, label });

/** The twelve, bound to a data source. */
export function buildCatalogue(data: ReportData): ReportKind[] {
  return [
    {
      kind: 'bookings-gmv',
      name: 'Bookings and GMV',
      description: 'Every campaign and package paid in the window, with its subtotal, GST and total.',
      filters: [
        { key: 'advertiserId', label: 'Advertiser', type: 'id' },
        { key: 'agentId', label: 'Agent', type: 'id' },
        { key: 'kind', label: 'Kind', type: 'enum', values: ['CAMPAIGN', 'PACKAGE'] },
      ],
      columns: [
        L('kind', 'Kind'),
        L('reference', 'Reference'),
        L('name', 'Name'),
        L('advertiser', 'Advertiser'),
        L('agent', 'Agent'),
        L('paidAt', 'Paid at'),
        R('subtotal', 'Subtotal'),
        R('gst', 'GST'),
        R('total', 'Total'),
        L('status', 'Status'),
      ],
      async query(f, window) {
        const rows = await data.bookings(window, { advertiserId: f['advertiserId'], agentId: f['agentId'], kind: f['kind'] as 'CAMPAIGN' | 'PACKAGE' | undefined });
        return rows.map((row) => ({
          kind: row.kind,
          reference: row.reference,
          name: row.name,
          advertiser: row.advertiserDisplayId ? `${row.advertiserName} (${row.advertiserDisplayId})` : row.advertiserName,
          agent: row.agentDisplayId,
          paidAt: iso(row.paidAt),
          subtotal: amount(row.subtotal),
          gst: amount(row.gst),
          total: amount(row.total),
          status: row.status,
        }));
      },
    },
    {
      kind: 'publisher-earnings-payouts',
      name: 'Publisher earnings and payouts',
      description: 'Per publisher: what accrued in the window (gross, commission, TDS, net) and what was paid out.',
      filters: [
        { key: 'publisherId', label: 'Publisher', type: 'id' },
        { key: 'city', label: 'City', type: 'string' },
      ],
      columns: [
        L('publisher', 'Publisher'),
        L('city', 'City'),
        R('accrualDays', 'Accrual days'),
        R('gross', 'Gross'),
        R('commission', 'Commission'),
        R('taxWithheld', 'TDS'),
        R('net', 'Net'),
        R('payoutsPaid', 'Payouts paid'),
        R('payoutCount', 'Payout count'),
      ],
      async query(f, window) {
        const earnings = await data.publisherEarnings(window, { publisherId: f['publisherId'], city: f['city'] });
        const payouts = await data.publisherPayouts(window, earnings.length ? earnings.map((row) => row.publisherId) : f['publisherId'] ? [f['publisherId']] : null);
        const paidBy = new Map(payouts.map((row) => [row.publisherId, row]));
        return earnings.map((row) => ({
          publisher: row.displayId ? `${row.name} (${row.displayId})` : row.name,
          city: row.city,
          accrualDays: row.accrualDays,
          gross: money(row.gross),
          commission: money(row.commission),
          taxWithheld: money(row.taxWithheld),
          net: money(row.net),
          payoutsPaid: money(paidBy.get(row.publisherId)?.paidTotal ?? 0),
          payoutCount: paidBy.get(row.publisherId)?.paidCount ?? 0,
        }));
      },
    },
    {
      kind: 'advertiser-spend-refunds',
      name: 'Advertiser spend and refunds',
      description: 'Per advertiser: campaigns and packages paid in the window, and refunds processed to the gateway or from the wallet.',
      filters: [
        { key: 'advertiserId', label: 'Advertiser', type: 'id' },
        { key: 'industry', label: 'Industry', type: 'string' },
      ],
      columns: [
        L('advertiser', 'Advertiser'),
        L('industry', 'Industry'),
        R('campaignsPaid', 'Campaigns'),
        R('campaignTotal', 'Campaign spend'),
        R('packagesPaid', 'Packages'),
        R('packageTotal', 'Package spend'),
        R('gatewayRefunds', 'Gateway refunds'),
        R('walletRefunds', 'Wallet refunds'),
      ],
      async query(f, window) {
        const spend = await data.advertiserSpend(window, { advertiserId: f['advertiserId'], industry: f['industry'] });
        const refunds = await data.advertiserRefunds(window, spend.length ? spend.map((row) => row.advertiserId) : f['advertiserId'] ? [f['advertiserId']] : null);
        const refundBy = new Map(refunds.map((row) => [row.advertiserId, row]));
        return spend.map((row) => ({
          advertiser: row.displayId ? `${row.name} (${row.displayId})` : row.name,
          industry: row.industry,
          campaignsPaid: row.campaignsPaid,
          campaignTotal: money(row.campaignTotal),
          packagesPaid: row.packagesPaid,
          packageTotal: money(row.packageTotal),
          gatewayRefunds: money(refundBy.get(row.advertiserId)?.gatewayRefunds ?? 0),
          walletRefunds: money(refundBy.get(row.advertiserId)?.walletRefunds ?? 0),
        }));
      },
    },
    {
      kind: 'agent-commissions',
      name: 'Agent commissions',
      description: 'Every agent incentive recorded in the window, with its tier, TDS and verification state.',
      filters: [
        { key: 'agentId', label: 'Agent', type: 'id' },
        { key: 'status', label: 'Status', type: 'enum', values: ['PENDING_VERIFICATION', 'CREDITED', 'REJECTED'] },
        { key: 'event', label: 'Event', type: 'enum', values: ['PUBLISHER_ONBOARDED', 'SITE_VISIT', 'CAMPAIGN_ASSIST', 'MILESTONE_BONUS', 'TIER_BONUS', 'PACKAGE_SOLD', 'INSTALLATION', 'ADVERTISER_ONBOARDED'] },
      ],
      columns: [
        L('agent', 'Agent'),
        L('event', 'Event'),
        L('tier', 'Tier'),
        R('amount', 'Amount'),
        R('taxWithheld', 'TDS'),
        R('netAmount', 'Net'),
        L('status', 'Status'),
        L('createdAt', 'Recorded at'),
        L('verifiedAt', 'Verified at'),
      ],
      async query(f, window) {
        const rows = await data.agentCommissions(window, { agentId: f['agentId'], status: f['status'], event: f['event'] });
        return rows.map((row) => ({
          agent: row.agentDisplayId ? `${row.agentName ?? ''} (${row.agentDisplayId})`.trim() : row.agentName,
          event: row.event,
          tier: row.tier,
          amount: money(row.amount),
          taxWithheld: money(row.taxWithheld),
          netAmount: money(row.netAmount),
          status: row.status,
          createdAt: iso(row.createdAt),
          verifiedAt: iso(row.verifiedAt),
        }));
      },
    },
    {
      kind: 'onboarding-funnel',
      name: 'Onboarding funnel',
      description: 'Per party type: accounts created, KYC submitted, verified, rejected and activated in the window.',
      filters: [{ key: 'city', label: 'City', type: 'string' }],
      columns: [
        L('party', 'Party'),
        R('created', 'Created'),
        R('kycSubmitted', 'KYC submitted'),
        R('kycVerified', 'KYC verified'),
        R('kycRejected', 'KYC rejected'),
        R('activated', 'Activated'),
        R('verifiedPct', 'Verified of submitted'),
      ],
      async query(f, window) {
        const rows = await data.onboardingFunnel(window, { city: f['city'] });
        return rows.map((row) => ({
          party: row.party,
          created: row.created,
          kycSubmitted: row.kycSubmitted,
          kycVerified: row.kycVerified,
          kycRejected: row.kycRejected,
          activated: row.activated,
          verifiedPct: pct(row.kycVerified, row.kycSubmitted),
        }));
      },
    },
    {
      kind: 'supply-listings',
      name: 'Supply — listings',
      description: 'Every listing created in the window, with its category, city, publisher, rate, slots and status.',
      filters: [
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['UNCLAIMED', 'DRAFT', 'AWAITING_AGREEMENT', 'AWAITING_DOCUMENTS', 'PENDING_REVIEW', 'AWAITING_SITE_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'INACTIVE'],
        },
        { key: 'city', label: 'City', type: 'string' },
        { key: 'category', label: 'Category', type: 'enum', values: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] },
      ],
      columns: [
        L('displayId', 'Listing'),
        L('title', 'Title'),
        L('category', 'Category'),
        L('city', 'City'),
        L('publisher', 'Publisher'),
        L('status', 'Status'),
        R('ratePerDay', 'Rate / day'),
        R('slotsTotal', 'Slots'),
        L('createdAt', 'Created at'),
        L('publishedAt', 'Published at'),
      ],
      async query(f, window) {
        const rows = await data.listings(window, { status: f['status'], city: f['city'], category: f['category'] });
        return rows.map((row) => ({
          displayId: row.displayId,
          title: row.title,
          category: row.category,
          city: row.city,
          publisher: row.publisherName,
          status: row.status,
          ratePerDay: amount(row.ratePerDay),
          slotsTotal: row.slotsTotal,
          createdAt: iso(row.createdAt),
          publishedAt: iso(row.publishedAt),
        }));
      },
    },
    {
      kind: 'kyc-ageing',
      name: 'KYC ageing',
      description: 'Every KYC record still pending at the end of the window, oldest first, with its age in hours.',
      filters: [{ key: 'type', label: 'Party type', type: 'enum', values: ['PUBLISHER', 'ADVERTISER', 'AGENT', 'USER'] }],
      columns: [
        L('type', 'Type'),
        L('party', 'Party'),
        L('method', 'Method'),
        L('submittedAt', 'Submitted at'),
        R('ageHours', 'Age (h)'),
        L('assigned', 'Assigned'),
        L('escalatedAt', 'Escalated at'),
      ],
      async query(f, window) {
        const rows = await data.kycAgeing(window.end, { type: f['type'] as 'PUBLISHER' | 'ADVERTISER' | 'AGENT' | 'USER' | undefined });
        return rows.map((row) => ({
          type: row.type,
          party: row.partyLabel ?? row.partyId,
          method: row.method,
          submittedAt: iso(row.submittedAt),
          ageHours: hoursBetween(row.submittedAt, window.end),
          assigned: row.assigned ? 'YES' : 'NO',
          escalatedAt: iso(row.escalatedAt),
        }));
      },
    },
    {
      kind: 'support-sla',
      name: 'Support SLA',
      description: 'Every ticket opened in the window against its first-response and resolution deadlines.',
      filters: [
        { key: 'priority', label: 'Priority', type: 'enum', values: ['URGENT', 'HIGH', 'NORMAL', 'LOW'] },
        { key: 'status', label: 'Status', type: 'enum', values: ['OPEN', 'WAITING', 'CLOSED'] },
        { key: 'team', label: 'Team', type: 'string' },
      ],
      columns: [
        L('displayId', 'Ticket'),
        L('kind', 'Kind'),
        L('priority', 'Priority'),
        L('status', 'Status'),
        L('team', 'Team'),
        L('createdAt', 'Opened at'),
        L('firstRespondedAt', 'First response'),
        L('firstResponseBreached', 'First response breached'),
        L('resolvedAt', 'Closed at'),
        L('resolutionBreached', 'Resolution breached'),
      ],
      async query(f, window) {
        const rows = await data.supportTickets(window, { priority: f['priority'], status: f['status'], team: f['team'] });
        return rows.map((row) => ({
          displayId: row.displayId,
          kind: row.kind,
          priority: row.priority,
          status: row.status,
          team: row.team,
          createdAt: iso(row.createdAt),
          firstRespondedAt: iso(row.firstRespondedAt),
          firstResponseBreached: breached(row.firstResponseDueAt, row.firstRespondedAt, window.end),
          resolvedAt: iso(row.resolvedAt),
          resolutionBreached: breached(row.resolutionDueAt, row.resolvedAt, window.end),
        }));
      },
    },
    {
      kind: 'disputes-fraud',
      name: 'Disputes and fraud cases',
      description: 'Every dispute raised and every fraud case opened in the window, with its outcome so far.',
      filters: [
        { key: 'type', label: 'Type', type: 'enum', values: ['DISPUTE', 'FRAUD'] },
        /** The union of the two status vocabularies; a value the other side does not know matches none of its rows. */
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'REJECTED', 'INVESTIGATING', 'CONFIRMED', 'DISMISSED'],
        },
      ],
      columns: [
        L('type', 'Type'),
        L('displayId', 'Reference'),
        L('status', 'Status'),
        L('reason', 'Reason / kind'),
        L('parties', 'Parties'),
        L('createdAt', 'Opened at'),
        L('closedAt', 'Decided at'),
        L('outcome', 'Outcome'),
        R('amount', 'Credited / score'),
      ],
      async query(f, window) {
        const DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'REJECTED'];
        const FRAUD_STATUSES = ['OPEN', 'INVESTIGATING', 'ESCALATED', 'CONFIRMED', 'DISMISSED'];
        const status = f['status'];
        const [disputes, fraud] = await Promise.all([
          f['type'] === 'FRAUD' || (status && !DISPUTE_STATUSES.includes(status)) ? Promise.resolve([]) : data.disputes(window, { status }),
          f['type'] === 'DISPUTE' || (status && !FRAUD_STATUSES.includes(status)) ? Promise.resolve([]) : data.fraudCases(window, { status }),
        ]);
        const rows: (ReportRow & { at: number })[] = [
          ...disputes.map((row) => ({
            at: row.createdAt.getTime(),
            type: 'DISPUTE',
            displayId: row.displayId,
            status: row.status,
            reason: row.reason,
            parties: `${row.raisedAs} vs ${row.againstParty}`,
            createdAt: iso(row.createdAt),
            closedAt: iso(row.resolvedAt),
            outcome: row.outcome,
            amount: amount(row.creditedAmount),
          })),
          ...fraud.map((row) => ({
            at: row.createdAt.getTime(),
            type: 'FRAUD',
            displayId: row.displayId,
            status: row.status,
            reason: row.kind,
            parties: row.subjectType,
            createdAt: iso(row.createdAt),
            closedAt: iso(row.decidedAt),
            outcome: row.decision,
            amount: row.score === null ? null : row.score.toFixed(3),
          })),
        ];
        return rows.sort((a, b) => a.at - b.at).map(({ at: _at, ...row }) => row);
      },
    },
    {
      kind: 'comms-deliveries',
      name: 'Comms deliveries',
      description: 'Outbound deliveries queued in the window, counted per template, channel and outcome.',
      filters: [
        { key: 'channel', label: 'Channel', type: 'enum', values: ['EMAIL', 'SMS', 'PUSH', 'IN_APP'] },
        { key: 'templateKey', label: 'Template', type: 'string' },
      ],
      columns: [L('templateKey', 'Template'), L('channel', 'Channel'), L('status', 'Outcome'), R('count', 'Count')],
      async query(f, window) {
        const rows = await data.deliveryCounts(window, { channel: f['channel'], templateKey: f['templateKey'] });
        return rows.map((row) => ({ templateKey: row.templateKey, channel: row.channel, status: row.status, count: row.count }));
      },
    },
    {
      kind: 'campaign-performance',
      name: 'Campaign performance',
      description: 'Per campaign with metrics in the window: spots live, spend, scans, clicks, redemptions and reach.',
      filters: [
        { key: 'advertiserId', label: 'Advertiser', type: 'id' },
        { key: 'campaignId', label: 'Campaign', type: 'id' },
      ],
      columns: [
        L('reference', 'Campaign'),
        L('name', 'Name'),
        L('advertiser', 'Advertiser'),
        L('status', 'Status'),
        R('days', 'Days'),
        R('spotsLive', 'Spots live (max)'),
        R('spend', 'Spend'),
        R('scans', 'Scans'),
        R('clicks', 'Clicks'),
        R('redemptions', 'Redemptions'),
        R('reachFromSpots', 'Reach'),
      ],
      async query(f, window) {
        const rows = await data.campaignMetrics(window, { advertiserId: f['advertiserId'], campaignId: f['campaignId'] });
        return rows.map((row) => ({
          reference: row.reference,
          name: row.name,
          advertiser: row.advertiserName,
          status: row.status,
          days: row.days,
          spotsLive: row.spotsLive,
          spend: money(row.spend),
          scans: row.scans,
          clicks: row.clicks,
          redemptions: row.redemptions,
          reachFromSpots: row.reachFromSpots,
        }));
      },
    },
    {
      kind: 'platform-summary',
      name: 'Platform summary',
      description: 'One line per headline number for the window: bookings, GMV, revenue, earnings, payouts, growth, queues.',
      filters: [],
      columns: [L('metric', 'Metric'), R('value', 'Value')],
      async query(_f, window) {
        const s = await data.platformSummary(window);
        const rows: ReportRow[] = [
          { metric: 'Bookings paid', value: s.bookings },
          { metric: 'GMV (INR)', value: money(s.gmv) },
          { metric: 'Platform revenue (INR)', value: money(s.platformRevenue) },
          { metric: 'Publisher earnings, net (INR)', value: money(s.publisherEarnings) },
          { metric: 'Payouts paid (INR)', value: money(s.payoutsPaid) },
          { metric: 'New publishers', value: s.newPublishers },
          { metric: 'New advertisers', value: s.newAdvertisers },
          { metric: 'New agents', value: s.newAgents },
          { metric: 'Listings published', value: s.listingsPublished },
          { metric: 'Campaigns active in window', value: s.activeCampaigns },
          { metric: 'KYC pending now', value: s.kycPending },
          { metric: 'Support tickets opened', value: s.ticketsOpened },
          { metric: 'Disputes raised', value: s.disputesOpened },
          { metric: 'Fraud cases opened', value: s.fraudCasesOpened },
          { metric: 'Deliveries sent', value: s.deliveriesSent },
        ];
        return rows;
      },
    },
  ];
}

export const REPORT_KINDS = [
  'bookings-gmv',
  'publisher-earnings-payouts',
  'advertiser-spend-refunds',
  'agent-commissions',
  'onboarding-funnel',
  'supply-listings',
  'kyc-ageing',
  'support-sla',
  'disputes-fraud',
  'comms-deliveries',
  'campaign-performance',
  'platform-summary',
] as const;

export type ReportKindName = (typeof REPORT_KINDS)[number];

/**
 * The catalogue as the console sees it — no query function on the wire.
 * G11-2: `filterLabels` is the filters' labels keyed by field, so a run or
 * schedule row's stored `{ kind: 'CAMPAIGN' }` can print as `Kind: CAMPAIGN`
 * without the console indexing the filter list itself.
 */
export function describeCatalogue(catalogue: readonly ReportKind[]) {
  return catalogue.map(({ kind, name, description, filters, columns }) => ({
    kind,
    name,
    description,
    filters,
    filterLabels: Object.fromEntries(filters.map((def) => [def.key, def.label])) as Record<string, string>,
    columns,
  }));
}
