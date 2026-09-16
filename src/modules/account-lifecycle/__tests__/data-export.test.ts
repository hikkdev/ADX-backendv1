import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataExportRepository } from '../data-export/data-export.repository';

/**
 * The data export — G6 (Q104).
 *
 * What is pinned: one open request at a time (409 while PENDING or READY and
 * unexpired, naming the open one); the build writes the JSON and a README
 * into a zip, stores it PRIVATE and owned by the person, marks READY for
 * seven days and tells them by `notify('DATA_EXPORT_READY')` with the deep
 * link; a failed build marks FAILED and does not throw; the sweep purges the
 * file behind an expired export and marks the row; nothing in the zip is an
 * image URL, a hash or a secret.
 */

const { repo, uploads, notifications, audit } = vi.hoisted(() => ({
  repo: {
    create: vi.fn(),
    findById: vi.fn(),
    findLatest: vi.fn(),
    findOpen: vi.fn(),
    findPending: vi.fn(),
    markReady: vi.fn(),
    markFailed: vi.fn(),
    findExpired: vi.fn(),
    markExpired: vi.fn(),
    deleteFinishedBefore: vi.fn(),
    assemble: vi.fn(),
  } satisfies Record<keyof DataExportRepository, ReturnType<typeof vi.fn>>,
  uploads: { storeGeneratedFile: vi.fn(), purgeStoredFile: vi.fn() },
  notifications: { notify: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../data-export/prisma-data-export.repository', () => ({ prismaDataExportRepository: repo }));
vi.mock('../../uploads', () => uploads);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { readZip } from '../../../shared/zip';
import { latestDataExportHandler, requestDataExportHandler } from '../data-export/data-export.controller';
import {
  buildDataExport,
  DATA_EXPORT_TTL_DAYS,
  deepLinkFor,
  latestDataExport,
  processPendingDataExports,
  purgeExpiredDataExports,
  requestDataExport,
} from '../data-export/data-export.service';
import { asyncHandler } from '../../../shared/http';
import { authenticate } from '../../../shared/auth';

const NOW = new Date('2026-09-14T06:00:00Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'dxr-1',
  userId: 'usr-1',
  status: 'PENDING',
  fileId: null,
  error: null,
  requestedAt: NOW,
  readyAt: null,
  expiresAt: null,
  ...over,
});

const assembled = () => ({
  profile: { id: 'usr-1', name: 'Asha Rao', mobile: '+919845012210', email: 'asha@x.co', createdAt: '2026-01-01T00:00:00.000Z' },
  roles: ['PUBLISHER'],
  parties: { publisher: { id: 'pub-1', name: 'Asha Rao', kycStatus: 'VERIFIED' }, advertiser: null, agent: null },
  kyc: { publisher: { status: 'VERIFIED', panNumber: 'ABCDE1234F', method: 'MANUAL' }, advertiser: null, agent: null, user: null, documentDecisions: [] },
  listings: [{ id: 'lst-1', title: 'Gym wall' }],
  orders: [],
  campaigns: [],
  wallets: [{ wallet: { id: 'w-1', balance: '1200.00' }, entries: [{ id: 'e-1', amount: '1200.00', type: 'CREDIT' }] }],
  withdrawals: [],
  invoices: [],
  notifications: [],
  sessions: [{ id: 's-1', userAgent: 'ADX/1.4 Android', ipAddress: '10.0.0.1' }],
  activity: [],
  preferences: { notifications: [], account: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.create.mockImplementation(async (userId: string, now: Date) => row({ userId, requestedAt: now }));
  repo.markReady.mockImplementation(async (id: string, patch: Record<string, unknown>) => row({ id, status: 'READY', ...patch }));
  repo.markFailed.mockImplementation(async (id: string, error: string) => row({ id, status: 'FAILED', error }));
  repo.markExpired.mockImplementation(async (id: string) => row({ id, status: 'EXPIRED' }));
  repo.deleteFinishedBefore.mockResolvedValue(0);
  uploads.storeGeneratedFile.mockResolvedValue({ id: 'file-1', url: '/api/v1/files/file-1' });
  uploads.purgeStoredFile.mockResolvedValue(true);
  notifications.notify.mockResolvedValue({ notificationId: 'n-1', templateKey: 'data-export-ready', deliveries: [] });
});

describe('requestDataExport', () => {
  it('opens a PENDING request and audits it', async () => {
    repo.findOpen.mockResolvedValue(null);
    const view = await requestDataExport('usr-1', undefined, NOW);
    expect(view).toMatchObject({ id: 'dxr-1', status: 'PENDING', fileId: null, deepLink: null });
    expect(repo.create).toHaveBeenCalledWith('usr-1', NOW);
    expect(audit.logActivity).toHaveBeenCalledWith('usr-1', 'DATA_EXPORT_REQUESTED', expect.objectContaining({ targetType: 'DataExportRequest', targetId: 'dxr-1' }));
  });

  it('is a 409 while one is PENDING, and while the last is READY and not expired', async () => {
    repo.findOpen.mockResolvedValueOnce(row());
    await expect(requestDataExport('usr-1', undefined, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', details: { code: 'DATA_EXPORT_OPEN', request: { id: 'dxr-1', status: 'PENDING' } } });

    repo.findOpen.mockResolvedValueOnce(row({ status: 'READY', fileId: 'file-1', expiresAt: new Date(NOW.getTime() + 86_400_000) }));
    await expect(requestDataExport('usr-1', undefined, NOW)).rejects.toMatchObject({ statusCode: 409, details: { request: { status: 'READY', fileId: 'file-1' } } });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('asks the repository for the open one against now — an expired READY row is the repository’s to exclude', async () => {
    repo.findOpen.mockResolvedValue(null);
    await requestDataExport('usr-1', undefined, NOW);
    expect(repo.findOpen).toHaveBeenCalledWith('usr-1', NOW);
  });
});

describe('latestDataExport', () => {
  it('answers the latest row as a view, and null with none', async () => {
    repo.findLatest.mockResolvedValueOnce(null);
    expect(await latestDataExport('usr-1')).toBeNull();
    repo.findLatest.mockResolvedValueOnce(row({ status: 'READY', fileId: 'file-1', readyAt: NOW, expiresAt: NOW }));
    expect(await latestDataExport('usr-1')).toMatchObject({ status: 'READY', fileId: 'file-1', deepLink: deepLinkFor('dxr-1') });
    // A FAILED row carries its reason and no file; an EXPIRED one neither.
    repo.findLatest.mockResolvedValueOnce(row({ status: 'FAILED', error: 'boom' }));
    expect(await latestDataExport('usr-1')).toMatchObject({ status: 'FAILED', error: 'boom', fileId: null });
    repo.findLatest.mockResolvedValueOnce(row({ status: 'EXPIRED', fileId: 'file-1' }));
    expect(await latestDataExport('usr-1')).toMatchObject({ status: 'EXPIRED', fileId: null, deepLink: null });
  });
});

describe('buildDataExport', () => {
  it('zips the JSON and a README, stores it private and owned by the person, marks READY for seven days and tells them', async () => {
    repo.findById.mockResolvedValue(row());
    repo.assemble.mockResolvedValue(assembled());

    const after = await buildDataExport('dxr-1', NOW);

    expect(after.status).toBe('READY');
    const [ownerId, stored] = uploads.storeGeneratedFile.mock.calls[0]!;
    expect(ownerId).toBe('usr-1');
    expect(stored).toMatchObject({ filename: 'adx-data-export.zip', mimeType: 'application/zip', purpose: 'DATA_EXPORT', ownerUserId: 'usr-1' });
    const entries = readZip(stored.content as Buffer);
    expect(entries.map((e) => e.name)).toEqual(['adx-data-export.json', 'README.txt']);
    const json = JSON.parse(entries[0]!.data.toString('utf8'));
    expect(json).toMatchObject({ requestId: 'dxr-1', profile: { name: 'Asha Rao' }, roles: ['PUBLISHER'], listings: [{ id: 'lst-1' }] });
    expect(json.wallets[0].entries[0].amount).toBe('1200.00');
    const readme = entries[1]!.data.toString('utf8');
    expect(readme).toContain('adx-data-export.json');
    expect(readme).toContain('Identity document images');

    const expiresAt = new Date(NOW.getTime() + DATA_EXPORT_TTL_DAYS * 86_400_000);
    expect(repo.markReady).toHaveBeenCalledWith('dxr-1', { fileId: 'file-1', readyAt: NOW, expiresAt });
    expect(notifications.notify).toHaveBeenCalledWith(
      'DATA_EXPORT_READY',
      'usr-1',
      { name: 'Asha Rao', url: 'adx://account/data-export/dxr-1', expiresAt: '21 Sep 2026' },
      expect.objectContaining({ type: 'SYSTEM', inApp: expect.objectContaining({ type: 'SYSTEM', relatedId: 'dxr-1' }) }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith('usr-1', 'DATA_EXPORT_READY', expect.objectContaining({ targetType: 'DataExportRequest', targetId: 'dxr-1' }));
  });

  it('marks FAILED with the reason when the build throws, and does not rethrow', async () => {
    repo.findById.mockResolvedValue(row());
    repo.assemble.mockResolvedValue(assembled());
    uploads.storeGeneratedFile.mockRejectedValue(new Error('R2 is down'));

    const after = await buildDataExport('dxr-1', NOW);

    expect(after).toMatchObject({ status: 'FAILED', error: 'R2 is down' });
    expect(repo.markReady).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('fails a request whose account is gone, and leaves a non-PENDING row alone', async () => {
    repo.findById.mockResolvedValueOnce(row());
    repo.assemble.mockResolvedValueOnce(null);
    expect(await buildDataExport('dxr-1', NOW)).toMatchObject({ status: 'FAILED' });

    repo.findById.mockResolvedValueOnce(row({ status: 'READY', fileId: 'file-1' }));
    expect(await buildDataExport('dxr-1', NOW)).toMatchObject({ status: 'READY' });
    expect(uploads.storeGeneratedFile).not.toHaveBeenCalled();
  });

  it('still answers READY when the notice cannot be sent', async () => {
    repo.findById.mockResolvedValue(row());
    repo.assemble.mockResolvedValue(assembled());
    notifications.notify.mockRejectedValue(new Error('no template'));
    expect(await buildDataExport('dxr-1', NOW)).toMatchObject({ status: 'READY' });
  });
});

describe('processPendingDataExports', () => {
  it('builds every pending request oldest first and tallies the outcomes', async () => {
    repo.findPending.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
    repo.findById.mockImplementation(async (id: string) => row({ id }));
    repo.assemble.mockResolvedValueOnce(assembled()).mockRejectedValueOnce(new Error('db hiccup'));
    const tally = await processPendingDataExports(20, NOW);
    expect(repo.findPending).toHaveBeenCalledWith(20);
    expect(tally).toEqual({ picked: 2, ready: 1, failed: 1 });
  });
});

describe('purgeExpiredDataExports', () => {
  it('removes the file behind every expired export, marks the row and deletes old finished rows', async () => {
    repo.findExpired.mockResolvedValue([row({ id: 'old-1', status: 'READY', fileId: 'file-9', expiresAt: new Date('2026-09-01T00:00:00Z') })]);
    repo.deleteFinishedBefore.mockResolvedValue(3);
    const result = await purgeExpiredDataExports(NOW);
    expect(uploads.purgeStoredFile).toHaveBeenCalledWith('file-9');
    expect(repo.markExpired).toHaveBeenCalledWith('old-1');
    expect(repo.deleteFinishedBefore).toHaveBeenCalledWith(new Date(NOW.getTime() - 90 * 86_400_000));
    expect(result).toEqual({ expired: 1, deleted: 3 });
  });

  it('marks the row even when the object cannot be removed', async () => {
    repo.findExpired.mockResolvedValue([row({ id: 'old-2', status: 'READY', fileId: 'file-8' })]);
    uploads.purgeStoredFile.mockRejectedValue(new Error('bucket gone'));
    await purgeExpiredDataExports(NOW);
    expect(repo.markExpired).toHaveBeenCalledWith('old-2');
  });
});

/* ── over HTTP ───────────────────────────────────────────────────── */

function app() {
  const instance = express();
  instance.use(express.json());
  const router = Router();
  router.post('/me/data-export', authenticate, asyncHandler(requestDataExportHandler));
  router.get('/me/data-export', authenticate, asyncHandler(latestDataExportHandler));
  const api = Router();
  api.use('/users', router);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

describe('/users/me/data-export', () => {
  const me = tokenFor(['ADVERTISER'], 'usr-1');

  it('POST answers 201 with the request, then 409 naming the open one', async () => {
    repo.findOpen.mockResolvedValueOnce(null);
    const created = await request(app()).post('/api/v1/users/me/data-export').set('Authorization', `Bearer ${me}`).send({});
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: 'dxr-1', status: 'PENDING' });

    repo.findOpen.mockResolvedValueOnce(row());
    const again = await request(app()).post('/api/v1/users/me/data-export').set('Authorization', `Bearer ${me}`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.details.request.id).toBe('dxr-1');
  });

  it('GET answers the latest request for the caller only', async () => {
    repo.findLatest.mockResolvedValue(row({ status: 'READY', fileId: 'file-1' }));
    const res = await request(app()).get('/api/v1/users/me/data-export').set('Authorization', `Bearer ${me}`);
    expect(res.status).toBe(200);
    expect(repo.findLatest).toHaveBeenCalledWith('usr-1');
    expect(res.body.data).toMatchObject({ status: 'READY', fileId: 'file-1', deepLink: 'adx://account/data-export/dxr-1' });
  });

  it('refuses without a token', async () => {
    expect((await request(app()).get('/api/v1/users/me/data-export')).status).toBe(401);
  });
});
