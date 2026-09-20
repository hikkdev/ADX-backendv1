import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportData, ReportsRepository } from '../reports.repository';

/**
 * Reports — Lot G (Q129/Q143), through the routes and the job's tick.
 *
 * Pinned: ADMIN-only; the catalogue; a run renders a CSV or a PDF into a
 * PRIVATE file and answers the run, audited REPORT_RUN; an undeclared
 * filter is a 400; the file opens for an admin or a signed link, 410 past
 * thirty days; schedules are created with the next 06:00 IST, patched and
 * deleted with audit rows; the tick mails every recipient a signed link
 * (the admins when none are named), skips a failed run, and always moves
 * `nextRunAt` on.
 */
const { repository, data, uploads, notifications, users, audit } = vi.hoisted(() => ({
  repository: {
    createRun: vi.fn(),
    updateRun: vi.fn(),
    findRun: vi.fn(),
    listRuns: vi.fn(),
    createSchedule: vi.fn(),
    findSchedule: vi.fn(),
    listSchedules: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    findDueSchedules: vi.fn(),
    adminEmails: vi.fn(),
    recordMailed: vi.fn(),
    findRunsStartedSince: vi.fn(),
    enabledScheduleRecipients: vi.fn(),
  } satisfies Record<keyof ReportsRepository, ReturnType<typeof vi.fn>>,
  data: {
    onboardingBoard: vi.fn(),
    bookings: vi.fn(),
    publisherEarnings: vi.fn(),
    publisherPayouts: vi.fn(),
    advertiserSpend: vi.fn(),
    advertiserRefunds: vi.fn(),
    agentCommissions: vi.fn(),
    onboardingFunnel: vi.fn(),
    listings: vi.fn(),
    kycAgeing: vi.fn(),
    supportTickets: vi.fn(),
    disputes: vi.fn(),
    fraudCases: vi.fn(),
    deliveryCounts: vi.fn(),
    campaignMetrics: vi.fn(),
    platformSummary: vi.fn(),
  } satisfies Record<keyof ReportData, ReturnType<typeof vi.fn>>,
  uploads: { storeGeneratedFile: vi.fn(), openStoredFile: vi.fn() },
  notifications: { notify: vi.fn() },
  users: { systemUserId: vi.fn(), listAdminUserIds: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-reports.repository', () => ({ prismaReportsRepository: repository, prismaReportData: data }));
vi.mock('../../uploads', () => uploads);
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { runFileToken } from '../links';
import { reportsRouter } from '../reports.routes';
import { runDueSchedules } from '../reports.service';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/reports', reportsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const NOW = new Date('2026-09-14T03:00:00Z');
let admin = '';
let publisher = '';

let runs: Record<string, Record<string, unknown>>;
let schedules: Record<string, Record<string, unknown>>;
let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  admin = tokenFor(['ADMIN'], 'adm-1');
  publisher = tokenFor(['PUBLISHER'], 'pub-1');
  runs = {};
  schedules = {};
  seq = 0;

  repository.createRun.mockImplementation(async (input: Record<string, unknown>) => {
    const id = `run-${++seq}`;
    runs[id] = { id, status: 'RUNNING', fileId: null, rowCount: null, error: null, startedAt: new Date(), finishedAt: null, expiresAt: null, ...input };
    return runs[id];
  });
  repository.updateRun.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
    runs[id] = { ...runs[id], ...patch };
    return runs[id];
  });
  repository.findRun.mockImplementation(async (id: string) => runs[id] ?? null);
  repository.recordMailed.mockImplementation(async (id: string, mailed: { to: number; at: Date }) => {
    const filters = (runs[id]!['filters'] as Record<string, unknown> | null) ?? {};
    runs[id] = { ...runs[id], filters: { ...filters, $mailed: { to: mailed.to, at: mailed.at.toISOString() } } };
    return runs[id];
  });
  repository.createSchedule.mockImplementation(async (input: Record<string, unknown>) => {
    const id = `sch-${++seq}`;
    schedules[id] = { id, lastRunAt: null, createdAt: new Date(), updatedAt: new Date(), ...input };
    return schedules[id];
  });
  repository.findSchedule.mockImplementation(async (id: string) => schedules[id] ?? null);
  repository.updateSchedule.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
    schedules[id] = { ...schedules[id], ...patch };
    return schedules[id];
  });
  repository.deleteSchedule.mockImplementation(async (id: string) => {
    delete schedules[id];
  });
  repository.adminEmails.mockResolvedValue(['ops@adx.local', 'ceo@adx.local']);
  repository.findRunsStartedSince.mockResolvedValue([]);
  repository.enabledScheduleRecipients.mockResolvedValue([]);
  uploads.storeGeneratedFile.mockImplementation(async (_userId: string, input: { filename: string; content: Buffer }) => ({ id: `file-${input.filename}`, filename: input.filename }));
  users.systemUserId.mockResolvedValue('sys-1');
  users.listAdminUserIds.mockResolvedValue(['adm-1']);
  notifications.notify.mockResolvedValue({ notificationId: null, templateKey: 'report-ready', deliveries: [{ channel: 'EMAIL', deliveryId: 'd-1' }] });
  data.bookings.mockResolvedValue([
    { kind: 'CAMPAIGN', reference: 'ADX-CMP-1', name: 'Diwali', advertiserDisplayId: null, advertiserName: 'Acme', agentDisplayId: null, paidAt: NOW, subtotal: null, gst: null, total: null, status: 'LIVE' },
  ]);
  data.platformSummary.mockResolvedValue({
    bookings: 0, gmv: 0, platformRevenue: 0, publisherEarnings: 0, payoutsPaid: 0, newPublishers: 0, newAdvertisers: 0, newAgents: 0,
    listingsPublished: 0, activeCampaigns: 0, kycPending: 0, ticketsOpened: 0, disputesOpened: 0, fraudCasesOpened: 0, deliveriesSent: 0,
  });
});

afterEach(() => vi.useRealTimers());

describe('access', () => {
  it('is ADMIN-only everywhere but the signed file link', async () => {
    await request(app()).get('/api/v1/reports/catalogue').expect(401);
    await request(app()).get('/api/v1/reports/catalogue').set('Authorization', `Bearer ${publisher}`).expect(403);
    await request(app()).post('/api/v1/reports/run').set('Authorization', `Bearer ${publisher}`).send({ kind: 'bookings-gmv' }).expect(403);
    await request(app()).get('/api/v1/reports/schedules').set('Authorization', `Bearer ${publisher}`).expect(403);
    await request(app()).get('/api/v1/reports/runs/run-1/file').expect(401);
    await request(app()).get('/api/v1/reports/runs/run-1/file').set('Authorization', `Bearer ${publisher}`).expect(403);
  });
});

describe('GET /reports/catalogue', () => {
  it('answers the thirteen kinds with filters and columns', async () => {
    const res = await request(app()).get('/api/v1/reports/catalogue').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(res.body.data).toHaveLength(13);
    expect(res.body.data[0]).toMatchObject({ kind: 'bookings-gmv', filters: expect.arrayContaining([{ key: 'kind', label: 'Kind', type: 'enum', values: ['CAMPAIGN', 'PACKAGE'] }]) });
    expect(res.body.data[0].query).toBeUndefined();
    // G11-2: the filter fields' labels keyed by field, so a row's `kind=CAMPAIGN` can print as `Kind: CAMPAIGN`.
    expect(res.body.data[0].filterLabels).toEqual({ advertiserId: 'Advertiser', agentId: 'Agent', kind: 'Kind' });
    expect(res.body.data.find((k: { kind: string }) => k.kind === 'platform-summary').filterLabels).toEqual({});
  });
});

describe('POST /reports/run', () => {
  it('renders a CSV into a private REPORT file, answers the run and audits it', async () => {
    const res = await request(app())
      .post('/api/v1/reports/run')
      .set('Authorization', `Bearer ${admin}`)
      .send({ kind: 'bookings-gmv', format: 'CSV', filters: { kind: 'CAMPAIGN' }, window: { preset: 'yesterday' } })
      .expect(201);

    expect(data.bookings).toHaveBeenCalledWith(
      expect.objectContaining({ start: new Date('2026-09-12T18:30:00.000Z'), end: new Date('2026-09-13T18:30:00.000Z') }),
      { advertiserId: undefined, agentId: undefined, kind: 'CAMPAIGN' },
    );
    expect(uploads.storeGeneratedFile).toHaveBeenCalledWith('adm-1', expect.objectContaining({ purpose: 'REPORT', mimeType: 'text/csv; charset=utf-8', filename: 'bookings-gmv-2026-09-13-to-2026-09-13.csv' }));
    const csv = (uploads.storeGeneratedFile.mock.calls[0]![1] as { content: Buffer }).content.toString('utf8');
    expect(csv.split('\r\n')[0]).toBe('Kind,Reference,Name,Advertiser,Agent,Paid at,Subtotal,GST,Total,Status');
    expect(csv).toContain('CAMPAIGN,ADX-CMP-1,Diwali,Acme,,2026-09-14T03:00:00.000Z,,,,LIVE');

    expect(res.body.data).toMatchObject({ id: 'run-1', status: 'READY', kind: 'bookings-gmv', format: 'CSV', rowCount: 1, fileId: 'file-bookings-gmv-2026-09-13-to-2026-09-13.csv', requestedById: 'adm-1', filters: { kind: 'CAMPAIGN' } });
    expect(new Date(res.body.data.expiresAt).toISOString()).toBe('2026-10-14T03:00:00.000Z');
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'REPORT_RUN', expect.objectContaining({ targetType: 'ReportRun', targetId: 'run-1', module: 'reports', metadata: expect.objectContaining({ kind: 'bookings-gmv', status: 'READY', rowCount: 1 }) }));
  });

  it('renders a PDF when asked', async () => {
    const res = await request(app()).post('/api/v1/reports/run').set('Authorization', `Bearer ${admin}`).send({ kind: 'platform-summary', format: 'PDF', window: { from: '2026-09-01', to: '2026-09-13' } }).expect(201);
    const stored = uploads.storeGeneratedFile.mock.calls[0]![1] as { content: Buffer; mimeType: string; filename: string };
    expect(stored.mimeType).toBe('application/pdf');
    expect(stored.filename).toBe('platform-summary-2026-09-01-to-2026-09-13.pdf');
    expect(stored.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.body.data).toMatchObject({ format: 'PDF', rowCount: 15 });
  });

  it('refuses a filter the kind does not declare, and a window over a year', async () => {
    const bad = await request(app()).post('/api/v1/reports/run').set('Authorization', `Bearer ${admin}`).send({ kind: 'platform-summary', filters: { city: 'Pune' } }).expect(400);
    expect(bad.body.error.code ?? bad.body.code).toBe('VALIDATION_ERROR');
    expect(repository.createRun).not.toHaveBeenCalled();
    await request(app()).post('/api/v1/reports/run').set('Authorization', `Bearer ${admin}`).send({ kind: 'platform-summary', window: { from: '2025-01-01', to: '2026-09-13' } }).expect(400);
    await request(app()).post('/api/v1/reports/run').set('Authorization', `Bearer ${admin}`).send({ kind: 'not-a-report' }).expect(400);
  });

  it('marks the run FAILED with the reason when the query throws, and says so', async () => {
    data.bookings.mockRejectedValue(new Error('relation does not exist'));
    const res = await request(app()).post('/api/v1/reports/run').set('Authorization', `Bearer ${admin}`).send({ kind: 'bookings-gmv' }).expect(500);
    expect(runs['run-1']).toMatchObject({ status: 'FAILED', error: 'relation does not exist' });
    expect(res.body.details ?? res.body.error?.details).toMatchObject({ runId: 'run-1' });
    expect(uploads.storeGeneratedFile).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'REPORT_RUN', expect.objectContaining({ metadata: expect.objectContaining({ status: 'FAILED' }) }));
  });
});

describe('GET /reports/runs and /runs/:id/file', () => {
  const ready = (over: Record<string, unknown> = {}) => ({
    id: 'run-9',
    kind: 'bookings-gmv',
    format: 'CSV',
    status: 'READY',
    fileId: 'file-9',
    rowCount: 3,
    error: null,
    startedAt: NOW,
    finishedAt: NOW,
    expiresAt: new Date('2026-10-14T03:00:00Z'),
    scheduleId: null,
    requestedById: 'adm-1',
    filters: null,
    ...over,
  });

  it('lists runs on the list contract', async () => {
    repository.listRuns.mockResolvedValue({ items: [ready()], total: 1, counts: { RUNNING: 0, READY: 1, FAILED: 0 } });
    const res = await request(app()).get('/api/v1/reports/runs?status=READY&kind=bookings-gmv&page=2&pageSize=5').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(repository.listRuns).toHaveBeenCalledWith({ q: undefined, status: ['READY'], kind: 'bookings-gmv', scheduleId: undefined }, expect.objectContaining({ page: 2, pageSize: 5, sort: 'newest' }));
    expect(res.body.data).toMatchObject({ total: 1, page: 2, pageSize: 5, counts: { READY: 1 } });
    expect(res.body.data.items[0].id).toBe('run-9');
    // G11-2: a run by hand was mailed to nobody.
    expect(res.body.data.items[0]).toMatchObject({ mailedTo: null, mailedAt: null });
  });

  it('G13-B: the list carries a summary — READY runs this Indian week, the ones mailed this week, and the distinct recipients across the enabled schedules', async () => {
    repository.listRuns.mockResolvedValue({ items: [], total: 0, counts: { RUNNING: 0, READY: 0, FAILED: 0 } });
    // NOW is Monday 14 Sep 08:30 IST; the week opened at Monday 00:00 IST = Sunday 18:30Z.
    repository.findRunsStartedSince.mockResolvedValue([
      ready({ id: 'r1', filters: { $mailed: { to: 2, at: '2026-09-14T00:35:00.000Z' } } }),
      ready({ id: 'r2', filters: { $mailed: { to: 1, at: '2026-09-13T00:35:00.000Z' } } }), // mailed last week (a run re-listed by startedAt) — not this week
      ready({ id: 'r3', status: 'FAILED', filters: null }),
      ready({ id: 'r4', filters: null }),
    ]);
    repository.enabledScheduleRecipients.mockResolvedValue([['a@x.io', 'B@x.io'], ['b@x.io'], []]);
    const res = await request(app()).get('/api/v1/reports/runs').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(repository.findRunsStartedSince).toHaveBeenCalledWith(new Date('2026-09-13T18:30:00.000Z'));
    // The empty recipient set is every admin with an email.
    expect(res.body.data.summary).toEqual({ readyThisWeek: 3, mailedThisWeek: 1, uniqueRecipients: 4 });
  });

  it('G11-2: a run the schedule mailed carries mailedTo and mailedAt, and its filters stay the filters', async () => {
    const mailed = ready({ id: 'run-8', scheduleId: 'sch-1', filters: { kind: 'CAMPAIGN', $mailed: { to: 2, at: '2026-09-14T03:00:00.000Z' } } });
    repository.listRuns.mockResolvedValue({ items: [mailed, ready()], total: 2, counts: { RUNNING: 0, READY: 2, FAILED: 0 } });
    const res = await request(app()).get('/api/v1/reports/runs').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(res.body.data.items[0]).toMatchObject({ id: 'run-8', filters: { kind: 'CAMPAIGN' }, mailedTo: 2, mailedAt: '2026-09-14T03:00:00.000Z' });
    expect(res.body.data.items[0].filters.$mailed).toBeUndefined();
    expect(res.body.data.items[1]).toMatchObject({ id: 'run-9', mailedTo: null, mailedAt: null });

    runs['run-8'] = mailed;
    const one = await request(app()).get('/api/v1/reports/runs/run-8').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(one.body.data).toMatchObject({ id: 'run-8', filters: { kind: 'CAMPAIGN' }, mailedTo: 2, mailedAt: '2026-09-14T03:00:00.000Z' });
  });

  it('streams the stored file to an admin, as an attachment', async () => {
    runs['run-9'] = ready();
    const tmp = path.join(os.tmpdir(), `adx-report-${Date.now()}.csv`);
    fs.writeFileSync(tmp, 'A,B\r\n1,2\r\n');
    uploads.openStoredFile.mockResolvedValue({ kind: 'stream', path: tmp, mimeType: 'text/csv', filename: 'bookings.csv' });
    try {
      const res = await request(app()).get('/api/v1/reports/runs/run-9/file').set('Authorization', `Bearer ${admin}`).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe('attachment; filename="bookings.csv"');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.text).toBe('A,B\r\n1,2\r\n');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('opens for a signed link with no token, and refuses a link for another run or one that has expired', async () => {
    runs['run-9'] = ready();
    runs['run-8'] = ready({ id: 'run-8' });
    uploads.openStoredFile.mockResolvedValue({ kind: 'redirect', url: 'https://r2.example/private/reports/x.csv?sig=1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('A,B\r\n', { status: 200 }));
    try {
      const token = runFileToken('run-9', new Date('2026-10-14T03:00:00Z'));
      const res = await request(app()).get(`/api/v1/reports/runs/run-9/file?t=${encodeURIComponent(token)}`).expect(200);
      expect(res.text).toBe('A,B\r\n');
      expect(fetchSpy).toHaveBeenCalledWith('https://r2.example/private/reports/x.csv?sig=1');

      await request(app()).get(`/api/v1/reports/runs/run-8/file?t=${encodeURIComponent(token)}`).expect(401);
      const stale = runFileToken('run-9', new Date('2026-09-14T02:00:00Z'));
      await request(app()).get(`/api/v1/reports/runs/run-9/file?t=${encodeURIComponent(stale)}`).expect(401);
      await request(app()).get('/api/v1/reports/runs/run-9/file?t=garbage').expect(401);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers 410 past thirty days, 409 while rendering, 404 when failed or unknown', async () => {
    runs['run-9'] = ready({ expiresAt: new Date('2026-09-14T02:59:00Z') });
    await request(app()).get('/api/v1/reports/runs/run-9/file').set('Authorization', `Bearer ${admin}`).expect(410);
    runs['run-9'] = ready({ status: 'RUNNING', fileId: null });
    await request(app()).get('/api/v1/reports/runs/run-9/file').set('Authorization', `Bearer ${admin}`).expect(409);
    runs['run-9'] = ready({ status: 'FAILED', fileId: null });
    await request(app()).get('/api/v1/reports/runs/run-9/file').set('Authorization', `Bearer ${admin}`).expect(404);
    await request(app()).get('/api/v1/reports/runs/nope/file').set('Authorization', `Bearer ${admin}`).expect(404);
  });
});

describe('schedules', () => {
  it('creates a schedule with the next 06:00 IST, validated against the kind, audited', async () => {
    const res = await request(app())
      .post('/api/v1/reports/schedules')
      .set('Authorization', `Bearer ${admin}`)
      .send({ kind: 'support-sla', name: 'Morning SLA', cadence: 'DAILY', format: 'PDF', recipients: ['Ops@ADX.local'], filters: { priority: 'URGENT' } })
      .expect(201);
    expect(res.body.data).toMatchObject({ id: 'sch-1', kind: 'support-sla', name: 'Morning SLA', cadence: 'DAILY', format: 'PDF', recipients: ['ops@adx.local'], filters: { priority: 'URGENT' }, enabled: true, createdById: 'adm-1' });
    // 03:00 UTC on the 14th is past 06:00 IST: tomorrow.
    expect(new Date(res.body.data.nextRunAt).toISOString()).toBe('2026-09-15T00:30:00.000Z');
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'REPORT_SCHEDULE_CREATED', expect.objectContaining({ targetType: 'ReportSchedule', targetId: 'sch-1', diff: expect.objectContaining({ cadence: { before: null, after: 'DAILY' } }) }));

    await request(app()).post('/api/v1/reports/schedules').set('Authorization', `Bearer ${admin}`).send({ kind: 'support-sla', name: 'Bad', cadence: 'DAILY', filters: { city: 'Pune' } }).expect(400);
    await request(app()).post('/api/v1/reports/schedules').set('Authorization', `Bearer ${admin}`).send({ kind: 'support-sla', name: 'Bad', cadence: 'HOURLY' }).expect(400);
    await request(app()).post('/api/v1/reports/schedules').set('Authorization', `Bearer ${admin}`).send({ kind: 'support-sla', name: 'Bad', cadence: 'DAILY', recipients: ['not-an-email'] }).expect(400);
  });

  it('G13-B: a schedule may carry a fixed window in its filters — validated as a custom window, kept beside the declared filters, cleared with null', async () => {
    const res = await request(app())
      .post('/api/v1/reports/schedules')
      .set('Authorization', `Bearer ${admin}`)
      .send({ kind: 'bookings-gmv', name: 'Q3 bookings', cadence: 'WEEKLY', filters: { kind: 'CAMPAIGN', window: { from: '2026-07-01', to: '2026-09-30' } } })
      .expect(201);
    expect(res.body.data.filters).toEqual({ kind: 'CAMPAIGN', window: { from: '2026-07-01', to: '2026-09-30' } });

    await request(app())
      .post('/api/v1/reports/schedules')
      .set('Authorization', `Bearer ${admin}`)
      .send({ kind: 'bookings-gmv', name: 'Backwards', cadence: 'WEEKLY', filters: { window: { from: '2026-09-30', to: '2026-07-01' } } })
      .expect(400);
    await request(app())
      .post('/api/v1/reports/schedules')
      .set('Authorization', `Bearer ${admin}`)
      .send({ kind: 'bookings-gmv', name: 'Too wide', cadence: 'WEEKLY', filters: { window: { from: '2024-01-01', to: '2026-09-30' } } })
      .expect(400);

    const patched = await request(app()).patch('/api/v1/reports/schedules/sch-1').set('Authorization', `Bearer ${admin}`).send({ filters: { kind: 'PACKAGE' } }).expect(200);
    expect(patched.body.data.filters).toEqual({ kind: 'PACKAGE' });
  });

  it('lists, patches (recomputing the next fire on a cadence change) and deletes, each audited', async () => {
    schedules['sch-1'] = { id: 'sch-1', kind: 'support-sla', name: 'Morning SLA', cadence: 'DAILY', format: 'CSV', recipients: [], filters: null, enabled: true, createdById: 'adm-1', lastRunAt: null, nextRunAt: new Date('2026-09-15T00:30:00Z') };
    repository.listSchedules.mockResolvedValue({ items: [schedules['sch-1']], total: 1, counts: { ENABLED: 1, DISABLED: 0 } });

    const list = await request(app()).get('/api/v1/reports/schedules?status=ENABLED').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(list.body.data).toMatchObject({ total: 1, counts: { ENABLED: 1, DISABLED: 0 } });

    const patched = await request(app()).patch('/api/v1/reports/schedules/sch-1').set('Authorization', `Bearer ${admin}`).send({ cadence: 'WEEKLY', enabled: false }).expect(200);
    expect(patched.body.data).toMatchObject({ cadence: 'WEEKLY', enabled: false });
    expect(new Date(patched.body.data.nextRunAt).toISOString()).toBe('2026-09-21T00:30:00.000Z');
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'REPORT_SCHEDULE_UPDATED', expect.objectContaining({ targetId: 'sch-1', diff: expect.objectContaining({ cadence: { before: 'DAILY', after: 'WEEKLY' }, enabled: { before: true, after: false } }) }));

    await request(app()).patch('/api/v1/reports/schedules/sch-1').set('Authorization', `Bearer ${admin}`).send({}).expect(400);
    await request(app()).patch('/api/v1/reports/schedules/nope').set('Authorization', `Bearer ${admin}`).send({ name: 'Renamed' }).expect(404);

    await request(app()).delete('/api/v1/reports/schedules/sch-1').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(schedules['sch-1']).toBeUndefined();
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'REPORT_SCHEDULE_DELETED', expect.objectContaining({ targetId: 'sch-1' }));
  });
});

describe('runDueSchedules', () => {
  const due = (over: Record<string, unknown> = {}) => ({
    id: 'sch-1',
    kind: 'bookings-gmv',
    name: 'Daily bookings',
    cadence: 'DAILY',
    format: 'CSV',
    recipients: ['a@x.io', 'b@x.io'],
    filters: { kind: 'CAMPAIGN' },
    enabled: true,
    createdById: 'adm-1',
    lastRunAt: null,
    nextRunAt: new Date('2026-09-14T00:30:00Z'),
    ...over,
  });

  it('renders yesterday, stores under the system account, mails every recipient a signed link, moves nextRunAt on', async () => {
    schedules['sch-1'] = due();
    repository.findDueSchedules.mockResolvedValue([schedules['sch-1']]);
    const outcomes = await runDueSchedules(NOW);

    expect(outcomes).toEqual([{ scheduleId: 'sch-1', runId: 'run-1', status: 'READY', recipients: 2 }]);
    expect(uploads.storeGeneratedFile).toHaveBeenCalledWith('sys-1', expect.objectContaining({ purpose: 'REPORT' }));
    expect(runs['run-1']).toMatchObject({ scheduleId: 'sch-1', requestedById: null, status: 'READY', rowCount: 1 });
    expect(notifications.notify).toHaveBeenCalledTimes(2);
    expect(notifications.notify).toHaveBeenCalledWith(
      'REPORT_READY',
      null,
      expect.objectContaining({ reportName: 'Daily bookings', window: '2026-09-13', rowCount: 1, format: 'CSV', expiresAt: '2026-10-14', url: expect.stringMatching(/\/api\/v1\/reports\/runs\/run-1\/file\?t=/) }),
      { recipient: { email: 'a@x.io' }, type: 'SYSTEM' },
    );
    const url = new URL((notifications.notify.mock.calls[0]![2] as { url: string }).url);
    expect(url.searchParams.get('t')).toBe(runFileToken('run-1', new Date('2026-10-14T03:00:00Z')));
    expect(schedules['sch-1']).toMatchObject({ lastRunAt: NOW, nextRunAt: new Date('2026-09-15T00:30:00Z') });
    expect(audit.logActivity).toHaveBeenCalledWith('sys-1', 'REPORT_SCHEDULE_RUN', expect.objectContaining({ targetType: 'ReportSchedule', targetId: 'sch-1', metadata: expect.objectContaining({ runId: 'run-1', mailed: 2 }) }));
    // G11-2: the mailing is recorded on the run — how many, and when.
    expect(repository.recordMailed).toHaveBeenCalledWith('run-1', { to: 2, at: NOW });
    expect(runs['run-1']).toMatchObject({ filters: { kind: 'CAMPAIGN', $mailed: { to: 2, at: NOW.toISOString() } } });
  });

  it('G13-B: a schedule with a fixed window renders that range instead of the cadence\'s own', async () => {
    schedules['sch-1'] = due({ filters: { kind: 'CAMPAIGN', window: { from: '2026-07-01', to: '2026-09-30' } } });
    repository.findDueSchedules.mockResolvedValue([schedules['sch-1']]);
    await runDueSchedules(NOW);
    expect(runs['run-1']).toMatchObject({ status: 'READY', filters: expect.objectContaining({ kind: 'CAMPAIGN' }) });
    expect(data.bookings).toHaveBeenCalledWith(expect.objectContaining({ start: new Date('2026-06-30T18:30:00.000Z'), end: new Date('2026-09-30T18:30:00.000Z') }), expect.anything());
    expect(notifications.notify).toHaveBeenCalledWith('REPORT_READY', null, expect.objectContaining({ window: '2026-07-01 → 2026-09-30' }), expect.anything());
    // The fixed window is not a filter the kind declares, so it never reaches the run's filters.
    expect((runs['run-1']!['filters'] as Record<string, unknown>)['window']).toBeUndefined();
  });

  it('mails the admins when the schedule names nobody', async () => {
    schedules['sch-1'] = due({ recipients: [] });
    repository.findDueSchedules.mockResolvedValue([schedules['sch-1']]);
    await runDueSchedules(NOW);
    expect(notifications.notify.mock.calls.map((call) => (call[3] as { recipient: { email: string } }).recipient.email)).toEqual(['ops@adx.local', 'ceo@adx.local']);
  });

  it('mails nobody for a failed run but still moves the schedule on', async () => {
    data.bookings.mockRejectedValue(new Error('boom'));
    schedules['sch-1'] = due();
    repository.findDueSchedules.mockResolvedValue([schedules['sch-1']]);
    const outcomes = await runDueSchedules(NOW);
    expect(outcomes[0]).toMatchObject({ status: 'FAILED', recipients: 0 });
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(repository.recordMailed).not.toHaveBeenCalled();
    expect(schedules['sch-1']).toMatchObject({ nextRunAt: new Date('2026-09-15T00:30:00Z') });
  });

  it('does nothing when nothing is due', async () => {
    repository.findDueSchedules.mockResolvedValue([]);
    expect(await runDueSchedules(NOW)).toEqual([]);
    expect(users.systemUserId).not.toHaveBeenCalled();
  });
});
