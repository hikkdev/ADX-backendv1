import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';
import type { BookingRecord, BookingReportRepository } from '../publisher-report/booking-report.repository';

/**
 * The publisher's booking report and spot insights — G6 (Q110).
 *
 * What is pinned: the listing's publisher opens both; an AGENT_PUBLISHER
 * opens them only under a live grant on that publisher (attribution alone
 * is 403); anybody else is 403 and an unknown order 404. The report is a
 * PDF with the spot, the campaign, the flight, the milestones with times,
 * the photos (thumbnails from the evidence; a photo that cannot be read is
 * a caption, not a failure), the earnings line and the ledger status; it is
 * stored PRIVATE owned by the publisher and audited. The insights read is
 * 403 FEATURE_OFF unless `publisher-spot-insights` is on for the publisher,
 * and then `{ scans, estimatedReach, interactions }` scoped to the spot.
 */

const { repo, agents, grants, flags, uploads, audit, photos } = vi.hoisted(() => ({
  repo: { findBooking: vi.fn(), countInteractions: vi.fn() } satisfies Record<keyof BookingReportRepository, ReturnType<typeof vi.fn>>,
  agents: { findAgentProfile: vi.fn(), dispatchAskFor: vi.fn(async () => ({})), isBelowRequiredGrade: vi.fn(async () => false), agentMeetsGrade: vi.fn(async () => true), getRoutingSettings: vi.fn(async () => ({ bands: { INDIVIDUAL: 'G1', SMALL_AGENCY: 'G2', LARGE_AGENCY: 'G3' }, leadBands: { STANDARD: 'G1', KEY: 'G3', ENTERPRISE: 'G4' }, enforce: true })) },
  grants: { liveGrantFor: vi.fn() },
  flags: { isFeatureEnabled: vi.fn() },
  uploads: { storeGeneratedFile: vi.fn(), openStoredFile: vi.fn(), fileIdFromUrl: vi.fn(() => null) },
  audit: { logActivity: vi.fn() },
  photos: { photoBytes: vi.fn() },
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../publisher-report/prisma-booking-report.repository', () => ({ prismaBookingReportRepository: repo }));
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);
vi.mock('../../feature-flags', () => ({ ...flags, ...passThroughFeatureGates() }));
vi.mock('../../uploads', () => uploads);
vi.mock('../publisher-report/photo-bytes', () => photos);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { publisherBookingRouter } from '../publisher-report/booking-report.routes';
import { bookingReportPdf, daysElapsed, earningsOf, milestonesOf, photosOf, spotInsights } from '../publisher-report/booking-report.service';
import { formatINR, renderBookingReportPdf } from '../publisher-report/booking-report.pdf';

const NOW = new Date('2026-09-14T09:00:00Z');
const d = (iso: string) => new Date(iso);

/** A one-pixel PNG, so the renderer has something real to draw. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const accrual = (forDate: string, over: Record<string, unknown> = {}) => ({
  forDate: d(forDate),
  gross: new Decimal('1000.00'),
  commission: new Decimal('200.00'),
  taxWithheld: new Decimal('0.00'),
  net: new Decimal('800.00'),
  clearsAt: d('2026-09-10T00:00:00Z'),
  walletEntryId: 'we-1',
  ...over,
});

const record = (over: Partial<BookingRecord> = {}): BookingRecord => ({
  order: {
    id: 'ord-1',
    status: 'COMPLETED',
    campaignName: 'Monsoon sale',
    startDate: d('2026-09-01T00:00:00Z'),
    endDate: d('2026-09-10T00:00:00Z'),
    installBy: 'ADX',
    publisherAcceptedAt: d('2026-08-28T10:00:00Z'),
    slotTime: d('2026-08-31T09:00:00Z'),
    adminApprovedAt: d('2026-08-31T15:00:00Z'),
    cancelledAt: null,
    createdAt: d('2026-08-27T08:00:00Z'),
    selfInstallCollectPhotoUrl: null,
    selfInstallConditionPhotoUrls: [],
    selfInstallInstallPhotoUrl: null,
  },
  listing: { id: 'lst-1', displayId: 'ADX-LST-24018', title: 'Gym wall, Indiranagar', address: '12 100ft Rd', city: 'Bengaluru', estimatedDailyFootfall: 500 },
  publisher: { id: 'pub-1', userId: 'usr-pub', agentId: 'agt-1', name: 'Asha Rao', displayId: 'PUB-1909-2601' },
  agentName: 'Ravi',
  spot: {
    id: 'spot-1',
    ratePerDay: new Decimal('1000.00'),
    days: 10,
    quantity: 1,
    startDate: d('2026-09-01T00:00:00Z'),
    endDate: d('2026-09-10T00:00:00Z'),
    campaign: { id: 'cmp-1', reference: 'ADX-CMP-2026-482913', name: 'Monsoon sale', startDate: d('2026-09-01T00:00:00Z'), endDate: d('2026-09-10T00:00:00Z'), status: 'COMPLETED' },
    codes: [
      { id: 'code-1', scans: 40, clicks: 12 },
      { id: 'code-2', scans: 5, clicks: 1 },
    ],
    accruals: Array.from({ length: 10 }, (_, i) => accrual(`2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`, i >= 8 ? { walletEntryId: null, clearsAt: d('2026-09-20T00:00:00Z') } : {})),
  },
  photos: [
    { id: 'ph-1', kind: 'CONDITION', label: null, url: 'https://cdn.example/condition.jpg', capturedAt: d('2026-08-31T09:10:00Z') },
    { id: 'ph-2', kind: 'INSTALLATION', label: null, url: 'https://cdn.example/installed.jpg', capturedAt: d('2026-08-31T10:00:00Z') },
  ],
  milestones: [
    { id: 'ms-1', order: 1, title: 'Collect prints', status: 'COMPLETED', startedAt: d('2026-08-30T08:00:00Z'), completedAt: d('2026-08-30T09:00:00Z'), scheduledStart: null, dueDate: null, photos: [{ id: 'ev-1', label: 'Prints', url: 'https://cdn.example/prints.jpg', createdAt: d('2026-08-30T09:00:00Z') }] },
    { id: 'ms-2', order: 2, title: 'Install', status: 'COMPLETED', startedAt: d('2026-08-31T09:00:00Z'), completedAt: d('2026-08-31T10:05:00Z'), scheduledStart: null, dueDate: null, photos: [] },
  ],
  verification: { verifiedAt: d('2026-08-31T10:10:00Z'), qrScanned: true, checklistPassed: true },
  checkIn: { checkedInAt: d('2026-08-31T09:02:00Z'), distanceM: 18.4 },
  ...over,
});

const publisher = { userId: 'usr-pub', roles: ['PUBLISHER'] as const };
const agent = { userId: 'usr-agent', roles: ['AGENT_PUBLISHER'] as const };
const stranger = { userId: 'usr-other', roles: ['PUBLISHER'] as const };

beforeEach(() => {
  vi.clearAllMocks();
  repo.findBooking.mockResolvedValue(record());
  repo.countInteractions.mockResolvedValue(7);
  agents.findAgentProfile.mockResolvedValue(null);
  grants.liveGrantFor.mockResolvedValue(null);
  flags.isFeatureEnabled.mockResolvedValue(true);
  uploads.storeGeneratedFile.mockResolvedValue({ id: 'file-1', url: '/api/v1/files/file-1' });
  photos.photoBytes.mockResolvedValue({ kind: 'png', data: PNG });
});

/* ── who may read ────────────────────────────────────────────────── */

describe('who may open a booking', () => {
  it('the listing’s publisher may', async () => {
    await expect(spotInsights('ord-1', publisher, NOW)).resolves.toBeDefined();
  });

  it('an agent under a live grant on the publisher may; attribution alone may not', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt-1' });
    await expect(spotInsights('ord-1', agent, NOW)).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    grants.liveGrantFor.mockImplementation(async (_agentId: string, _subject: unknown, scope: string) => (scope === 'LISTINGS' ? { id: 'grant-1' } : null));
    await expect(spotInsights('ord-1', agent, NOW)).resolves.toBeDefined();
    expect(grants.liveGrantFor).toHaveBeenCalledWith('agt-1', { publisherId: 'pub-1' }, 'PROFILE');
    expect(grants.liveGrantFor).toHaveBeenCalledWith('agt-1', { publisherId: 'pub-1' }, 'LISTINGS');
  });

  it('anybody else is 403, an unknown order 404, a booking with no publisher 403', async () => {
    await expect(spotInsights('ord-1', stranger, NOW)).rejects.toMatchObject({ statusCode: 403 });
    repo.findBooking.mockResolvedValueOnce(null);
    await expect(spotInsights('nope', publisher, NOW)).rejects.toMatchObject({ statusCode: 404 });
    repo.findBooking.mockResolvedValueOnce(record({ publisher: null }));
    await expect(spotInsights('ord-1', publisher, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});

/* ── the report ──────────────────────────────────────────────────── */

describe('earningsOf', () => {
  it('sums the accruals and says how far the flight and the ledger have come', () => {
    const earnings = earningsOf(record(), NOW);
    expect(earnings).toMatchObject({
      daysAccrued: 10,
      daysTotal: 10,
      gross: '10000.00',
      commission: '2000.00',
      taxWithheld: '0.00',
      net: '8000.00',
      cleared: '6400.00',
      held: '1600.00',
      status: 'ACCRUED',
      ledger: 'PARTLY_POSTED',
    });
  });

  it('is NOT_ACCRUED / NOT_POSTED with nothing on the books, ACCRUING mid-flight, POSTED once every day is on the ledger', () => {
    expect(earningsOf(record({ spot: { ...record().spot!, accruals: [] } }), NOW)).toMatchObject({ status: 'NOT_ACCRUED', ledger: 'NOT_POSTED', net: '0.00' });
    expect(earningsOf(record({ spot: { ...record().spot!, accruals: [accrual('2026-09-01T00:00:00Z')] } }), NOW)).toMatchObject({ status: 'ACCRUING', ledger: 'POSTED', daysAccrued: 1 });
    expect(earningsOf(record({ spot: null }), NOW)).toMatchObject({ status: 'NOT_ACCRUED', daysTotal: null });
  });
});

describe('milestonesOf and photosOf', () => {
  it('lists the booking’s own steps with their times, then the plan’s milestones', () => {
    const steps = milestonesOf(record());
    expect(steps.map((s) => s.title)).toEqual([
      'Booking placed',
      'Accepted by publisher',
      'Installation slot',
      'Agent checked in on site',
      'Site verified',
      'Approved by ADX',
      'Collect prints',
      'Install',
    ]);
    expect(steps.find((s) => s.title === 'Agent checked in on site')).toMatchObject({ at: d('2026-08-31T09:02:00Z'), note: '18 m from the spot' });
    expect(steps.find((s) => s.title === 'Install')).toMatchObject({ at: d('2026-08-31T10:05:00Z'), status: 'COMPLETED' });
  });

  it('gathers the agent’s photos, the self-install photos and the milestone evidence once each, capped', () => {
    const list = photosOf(record({ order: { ...record().order, selfInstallInstallPhotoUrl: 'https://cdn.example/installed.jpg' } }));
    expect(list.map((p) => p.label)).toEqual(['Site before installation', 'Installed', 'Prints']);
    const many = record({ photos: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, kind: 'CONDITION', label: null, url: `https://cdn.example/${i}.jpg`, capturedAt: NOW })) });
    expect(photosOf(many)).toHaveLength(12);
  });
});

describe('bookingReportPdf', () => {
  it('renders a PDF with the spot, campaign, flight, milestones, photos and earnings; stores it for the publisher; audits', async () => {
    const result = await bookingReportPdf('ord-1', publisher, undefined, NOW);

    expect(result.filename).toBe('booking-report-ord-1.pdf');
    expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.fileId).toBe('file-1');
    expect(photos.photoBytes).toHaveBeenCalledTimes(3);

    const [ownerId, stored] = uploads.storeGeneratedFile.mock.calls[0]!;
    expect(ownerId).toBe('usr-pub');
    expect(stored).toMatchObject({ filename: 'booking-report-ord-1.pdf', mimeType: 'application/pdf', purpose: 'BOOKING_REPORT', ownerUserId: 'usr-pub' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr-pub', 'BOOKING_REPORT_GENERATED', expect.objectContaining({ targetType: 'Order', targetId: 'ord-1', module: 'orders', metadata: expect.objectContaining({ via: 'OWNER', fileId: 'file-1', net: '8000.00' }) }));
  });

  it('still serves the PDF when the store refuses, and draws a caption for a photo it cannot read', async () => {
    uploads.storeGeneratedFile.mockRejectedValue(new Error('R2 down'));
    photos.photoBytes.mockResolvedValue(null);
    const result = await bookingReportPdf('ord-1', publisher, undefined, NOW);
    expect(result.fileId).toBeNull();
    expect(result.buffer.length).toBeGreaterThan(1000);
  });

  it('records the grant an agent acted under', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt-1' });
    grants.liveGrantFor.mockResolvedValue({ id: 'grant-7' });
    await bookingReportPdf('ord-1', agent, undefined, NOW);
    expect(audit.logActivity).toHaveBeenCalledWith('usr-agent', 'BOOKING_REPORT_GENERATED', expect.objectContaining({ metadata: expect.objectContaining({ via: 'GRANT', grantId: 'grant-7' }) }));
    // The stored file belongs to the publisher, not the agent who asked.
    expect(uploads.storeGeneratedFile.mock.calls[0]![1]).toMatchObject({ ownerUserId: 'usr-pub' });
  });
});

describe('the paper', () => {
  it('formats rupees with Indian grouping', () => {
    expect(formatINR('1234567.5')).toBe('12,34,567.50');
    expect(formatINR(0)).toBe('0.00');
  });

  it('renders with no spot, no photos and no milestones without throwing', async () => {
    const buffer = await renderBookingReportPdf({
      generatedAt: NOW,
      orderId: 'ord-9',
      publisher: { name: 'P', displayId: null },
      spot: { title: 'S', displayId: null, address: 'A', city: null },
      campaign: null,
      flight: { start: null, end: null, days: null, quantity: 1 },
      order: { status: 'PENDING_PUBLISHER', installBy: null, agentName: null },
      milestones: [],
      photos: [],
      earnings: { daysAccrued: 0, daysTotal: null, gross: '0.00', commission: '0.00', taxWithheld: '0.00', net: '0.00', cleared: '0.00', held: '0.00', status: 'NOT_ACCRUED', ledger: 'NOT_POSTED' },
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

/* ── insights ────────────────────────────────────────────────────── */

describe('spotInsights', () => {
  it('is 403 FEATURE_OFF unless the flag is on for the publisher', async () => {
    flags.isFeatureEnabled.mockResolvedValue(false);
    await expect(spotInsights('ord-1', publisher, NOW)).rejects.toMatchObject({ statusCode: 403, code: 'FEATURE_OFF' });
    expect(flags.isFeatureEnabled).toHaveBeenCalledWith('publisher-spot-insights', 'pub-1');
    expect(repo.countInteractions).not.toHaveBeenCalled();
  });

  it('answers scans, estimated reach and interactions scoped to the spot', async () => {
    const insights = await spotInsights('ord-1', publisher, NOW);
    // 45 scans over the two codes; 500 footfall × 10 days × 1 face; the events on those codes that are not scans.
    expect(insights).toEqual({ scans: 45, estimatedReach: 5000, interactions: 7 });
    expect(repo.countInteractions).toHaveBeenCalledWith(['code-1', 'code-2']);
  });

  it('is honest with no footfall and no codes', async () => {
    repo.findBooking.mockResolvedValue(record({ listing: { ...record().listing, estimatedDailyFootfall: null }, spot: { ...record().spot!, codes: [] } }));
    repo.countInteractions.mockResolvedValue(0);
    expect(await spotInsights('ord-1', publisher, NOW)).toEqual({ scans: 0, estimatedReach: null, interactions: 0 });
  });

  it('counts the days run so far, never beyond the end', () => {
    expect(daysElapsed(d('2026-09-01T00:00:00Z'), d('2026-09-10T00:00:00Z'), NOW)).toBe(10);
    expect(daysElapsed(d('2026-09-12T00:00:00Z'), d('2026-09-20T00:00:00Z'), NOW)).toBe(3);
    expect(daysElapsed(d('2026-09-20T00:00:00Z'), null, NOW)).toBe(0);
    expect(daysElapsed(null, null, NOW)).toBe(0);
  });
});

/* ── over HTTP ───────────────────────────────────────────────────── */

function app() {
  const instance = express();
  const api = Router();
  api.use('/publishers/me/bookings', publisherBookingRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

describe('/publishers/me/bookings/:orderId', () => {
  it('streams the PDF inline to the publisher and names the stored file', async () => {
    const res = await request(app()).get('/api/v1/publishers/me/bookings/ord-1/report.pdf').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'usr-pub')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="booking-report-ord-1.pdf"');
    expect(res.headers['x-adx-file-id']).toBe('file-1');
  });

  it('answers the insights, and FEATURE_OFF when the flag is off', async () => {
    const on = await request(app()).get('/api/v1/publishers/me/bookings/ord-1/insights').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'usr-pub')}`);
    expect(on.status).toBe(200);
    expect(on.body.data).toEqual({ scans: 45, estimatedReach: 5000, interactions: 7 });

    flags.isFeatureEnabled.mockResolvedValue(false);
    const off = await request(app()).get('/api/v1/publishers/me/bookings/ord-1/insights').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'usr-pub')}`);
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('FEATURE_OFF');
  });

  it('keeps an advertiser out at the door and a stranger out at the booking', async () => {
    const advertiser = await request(app()).get('/api/v1/publishers/me/bookings/ord-1/insights').set('Authorization', `Bearer ${tokenFor(['ADVERTISER'], 'usr-adv')}`);
    expect(advertiser.status).toBe(403);
    const other = await request(app()).get('/api/v1/publishers/me/bookings/ord-1/report.pdf').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'usr-other')}`);
    expect(other.status).toBe(403);
    expect(uploads.storeGeneratedFile).not.toHaveBeenCalled();
  });
});
