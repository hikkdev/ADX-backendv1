import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../shared/money';
import { REPORT_KINDS, buildCatalogue, describeCatalogue, filterSchemaFor } from '../catalogue';
import type { ReportData } from '../reports.repository';
import { renderCsv, renderPdf } from '../render';

/**
 * Lot G (Q129): the twelve kinds are a contract — each names its filters
 * and columns, and its query answers rows keyed by exactly those columns,
 * with money as two-place strings. Pinned against a fixture data source so
 * the shaping is tested without a database.
 */
const D = (v: string) => new Decimal(v);
const AT = new Date('2026-09-10T05:00:00Z');

const data: ReportData = {
  onboardingBoard: async () => [{ actorId: 'usr_ops', actorName: 'Asha Rao', actorRole: 'Ops manager', via: { SELF: 0, AGENT: 0, QR: 0, DESK: 3, IMPORT: 0 }, publishers: 3, advertisers: 0, onboarded: 3, completed: 2, liveWithin7d: 1, verified: 1, firstBooking: 0 }],
  bookings: async () => [
    { kind: 'CAMPAIGN', reference: 'ADX-CMP-1', name: 'Diwali', advertiserDisplayId: 'ADX-ADV-1', advertiserName: 'Acme', agentDisplayId: null, paidAt: AT, subtotal: D('1000'), gst: D('180'), total: D('1180'), status: 'LIVE' },
    { kind: 'PACKAGE', reference: 'ADX-PKG-1', name: 'Starter', advertiserDisplayId: null, advertiserName: 'Beta', agentDisplayId: 'ADX-AGT-9', paidAt: AT, subtotal: D('500'), gst: null, total: D('590'), status: 'ACTIVE' },
  ],
  publisherEarnings: async () => [{ publisherId: 'p1', displayId: 'ADX-PUB-1', name: 'Mall', city: 'Pune', gross: D('100'), commission: D('20'), taxWithheld: D('2'), net: D('78'), accrualDays: 3 }],
  publisherPayouts: async () => [{ publisherId: 'p1', paidCount: 2, paidTotal: D('150.5') }],
  advertiserSpend: async () => [{ advertiserId: 'a1', displayId: null, name: 'Acme', industry: 'Retail', campaignsPaid: 1, campaignTotal: D('1180'), packagesPaid: 0, packageTotal: D('0') }],
  advertiserRefunds: async () => [{ advertiserId: 'a1', gatewayRefunds: D('80'), walletRefunds: D('0') }],
  agentCommissions: async () => [{ agentDisplayId: 'ADX-AGT-9', agentName: 'Ravi', event: 'CAMPAIGN_ASSIST', tier: 'SILVER', amount: D('300'), taxWithheld: D('15'), netAmount: D('285'), status: 'CREDITED', createdAt: AT, verifiedAt: AT }],
  onboardingFunnel: async () => [
    { party: 'PUBLISHER', created: 10, kycSubmitted: 8, kycVerified: 6, kycRejected: 1, activated: 5 },
    { party: 'AGENT', created: 2, kycSubmitted: 0, kycVerified: 0, kycRejected: 0, activated: null },
  ],
  listings: async () => [{ displayId: 'ADX-LST-1', title: 'Hoarding', category: 'OUTDOOR', city: 'Pune', publisherName: 'Mall', status: 'ACTIVE', ratePerDay: D('250'), slotsTotal: 2, createdAt: AT, publishedAt: null }],
  kycAgeing: async () => [{ type: 'PUBLISHER', partyId: 'p1', partyLabel: 'ADX-PUB-1', method: 'MANUAL', submittedAt: new Date('2026-09-08T05:00:00Z'), assigned: true, escalatedAt: null }],
  supportTickets: async () => [
    { displayId: 'ADX-TKT-1', kind: 'SUPPORT', priority: 'HIGH', status: 'OPEN', team: null, createdAt: AT, firstResponseDueAt: new Date('2026-09-10T09:00:00Z'), firstRespondedAt: null, resolutionDueAt: new Date('2026-09-20T05:00:00Z'), resolvedAt: null },
  ],
  disputes: async () => [{ displayId: 'ADX-DSP-1', status: 'RESOLVED', reason: 'DAMAGE', raisedAs: 'ADVERTISER', againstParty: 'PUBLISHER', createdAt: AT, resolvedAt: AT, outcome: 'CREDIT', creditedAmount: D('40') }],
  fraudCases: async () => [{ displayId: 'ADX-FRD-1', status: 'OPEN', kind: 'DUPLICATE_LISTING', subjectType: 'PUBLISHER', createdAt: new Date('2026-09-09T05:00:00Z'), decidedAt: null, decision: null, score: D('0.75') }],
  deliveryCounts: async () => [{ templateKey: 'payout-paid', channel: 'EMAIL', status: 'SENT', count: 12 }],
  campaignMetrics: async () => [{ reference: 'ADX-CMP-1', name: 'Diwali', advertiserName: 'Acme', status: 'LIVE', days: 5, spotsLive: 3, spend: D('900'), scans: 40, clicks: 10, redemptions: 2, reachFromSpots: 5000 }],
  platformSummary: async () => ({
    bookings: 2, gmv: D('1770'), platformRevenue: D('300'), publisherEarnings: D('78'), payoutsPaid: D('150.5'), newPublishers: 10, newAdvertisers: 3, newAgents: 2,
    listingsPublished: 4, activeCampaigns: 1, kycPending: 1, ticketsOpened: 1, disputesOpened: 1, fraudCasesOpened: 1, deliveriesSent: 12,
  }),
};

const catalogue = buildCatalogue(data);
const window = { start: new Date('2026-09-09T18:30:00Z'), end: new Date('2026-09-10T18:30:00Z'), from: '2026-09-10', to: '2026-09-10', label: '2026-09-10' };

describe('the catalogue', () => {
  it('lists the thirteen kinds, in order, each with a name, a description and columns', () => {
    expect(catalogue.map((k) => k.kind)).toEqual([...REPORT_KINDS]);
    expect(new Set(catalogue.map((k) => k.kind)).size).toBe(13);
    for (const kind of catalogue) {
      expect(kind.name.length).toBeGreaterThan(3);
      expect(kind.description.length).toBeGreaterThan(10);
      expect(kind.columns.length).toBeGreaterThan(0);
      expect(new Set(kind.columns.map((c) => c.key)).size).toBe(kind.columns.length);
    }
  });

  it('describes itself without the query function', () => {
    const described = describeCatalogue(catalogue);
    expect(described[0]).toEqual({ kind: 'bookings-gmv', name: 'Bookings and GMV', description: expect.any(String), filters: expect.any(Array), filterLabels: { advertiserId: 'Advertiser', agentId: 'Agent', kind: 'Kind' }, columns: expect.any(Array) });
    expect('query' in described[0]!).toBe(false);
  });

  it('refuses a filter a kind does not declare, and an enum value it does not list', () => {
    const bookings = catalogue.find((k) => k.kind === 'bookings-gmv')!;
    expect(filterSchemaFor(bookings).safeParse({ kind: 'CAMPAIGN' }).success).toBe(true);
    expect(filterSchemaFor(bookings).safeParse({ kind: 'INVOICE' }).success).toBe(false);
    expect(filterSchemaFor(bookings).safeParse({ city: 'Pune' }).success).toBe(false);
    const summary = catalogue.find((k) => k.kind === 'platform-summary')!;
    expect(filterSchemaFor(summary).safeParse({}).success).toBe(true);
    expect(filterSchemaFor(summary).safeParse({ anything: 'x' }).success).toBe(false);
  });

  it('every query answers rows keyed by exactly its columns', async () => {
    for (const kind of catalogue) {
      const rows = await kind.query({}, window);
      expect(rows.length, kind.kind).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort(), kind.kind).toEqual(kind.columns.map((c) => c.key).sort());
      }
    }
  });

  it('prints money as two-place strings and joins the two-source reports', async () => {
    const earnings = await catalogue.find((k) => k.kind === 'publisher-earnings-payouts')!.query({}, window);
    expect(earnings[0]).toMatchObject({ publisher: 'Mall (ADX-PUB-1)', gross: '100.00', net: '78.00', payoutsPaid: '150.50', payoutCount: 2 });

    const spend = await catalogue.find((k) => k.kind === 'advertiser-spend-refunds')!.query({}, window);
    expect(spend[0]).toMatchObject({ advertiser: 'Acme', campaignTotal: '1180.00', gatewayRefunds: '80.00', walletRefunds: '0.00' });

    const bookings = await catalogue.find((k) => k.kind === 'bookings-gmv')!.query({}, window);
    expect(bookings[0]).toMatchObject({ advertiser: 'Acme (ADX-ADV-1)', gst: '180.00', total: '1180.00', paidAt: AT.toISOString() });
    expect(bookings[1]).toMatchObject({ advertiser: 'Beta', gst: null, agent: 'ADX-AGT-9' });
  });

  it('ages KYC to the window end and marks SLA breaches against it', async () => {
    const ageing = await catalogue.find((k) => k.kind === 'kyc-ageing')!.query({}, window);
    expect(ageing[0]).toMatchObject({ party: 'ADX-PUB-1', ageHours: 61, assigned: 'YES' });
    const sla = await catalogue.find((k) => k.kind === 'support-sla')!.query({}, window);
    expect(sla[0]).toMatchObject({ firstResponseBreached: 'YES', resolutionBreached: 'NO' });
    const funnel = await catalogue.find((k) => k.kind === 'onboarding-funnel')!.query({}, window);
    expect(funnel[0]).toMatchObject({ verifiedPct: '75.0%' });
    expect(funnel[1]).toMatchObject({ verifiedPct: null, activated: null });
  });

  it('merges disputes and fraud cases oldest first and honours the type filter', async () => {
    const kind = catalogue.find((k) => k.kind === 'disputes-fraud')!;
    const both = await kind.query({}, window);
    expect(both.map((r) => r['type'])).toEqual(['FRAUD', 'DISPUTE']);
    expect(both[0]).toMatchObject({ amount: '0.750' });
    expect(both[1]).toMatchObject({ amount: '40.00', parties: 'ADVERTISER vs PUBLISHER' });
    expect((await kind.query({ type: 'DISPUTE' }, window)).map((r) => r['type'])).toEqual(['DISPUTE']);
  });
});

describe('rendering', () => {
  it('CSV is the labels then the rows, CRLF, quoted where it has to be', () => {
    const columns = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B, or not' }];
    const out = renderCsv(columns, [{ a: 'x', b: 1 }, { a: null, b: 'y "q"' }]);
    expect(out.mimeType).toContain('text/csv');
    expect(out.buffer.toString('utf8')).toBe('A,"B, or not"\r\nx,1\r\n,"y ""q"""\r\n');
  });

  it('PDF renders a document with the title and paginates a long table', async () => {
    const columns = [{ key: 'n', label: 'N', align: 'right' as const }, { key: 't', label: 'Text' }];
    const rows = Array.from({ length: 120 }, (_, i) => ({ n: i, t: `row ${i}` }));
    const out = await renderPdf({ title: 'Bookings and GMV', windowLabel: '2026-09-10', generatedAt: AT, columns, rows });
    expect(out.mimeType).toBe('application/pdf');
    expect(out.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    // 120 rows at 14pt do not fit one landscape page: more than one /Page object.
    const pages = out.buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});
