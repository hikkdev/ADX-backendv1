import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1 — the names and totals the console's publisher desks print by id.
 *
 * What is pinned: `GET /publishers` (ADMIN) takes `?q=` beside `?category=`
 * and, when `?page=` is given, answers the list contract with the KYC-status
 * chips; the bare array stays when it is not. The KYC queue's rows carry the
 * assignee by name beside the id, through the label port `kyc` holds, and
 * the case read's per-document decisions carry who decided each tile.
 */

const { repository, kyc, agents } = vi.hoisted(() => ({
  repository: {
    findAllForAdmin: vi.fn(),
    findRosterPage: vi.fn(),
    findForAgent: vi.fn(),
    findKycQueue: vi.fn(),
    countKycQueue: vi.fn(async () => 0),
    findKycDetail: vi.fn(),
  },
  kyc: {
    listDocumentReviews: vi.fn(async () => []),
    listDocumentReviewsWithReviewer: vi.fn(async () => []),
    livenessStateFor: vi.fn(async () => null),
    kycUserLabels: vi.fn(async (ids: readonly (string | null | undefined)[]) => {
      const map = new Map<string, { id: string; name: string | null }>();
      for (const id of ids) if (id) map.set(id, { id, name: id === 'usr_priya' ? 'Priya' : null });
      return map;
    }),
    kycCaseExtras: vi.fn(async () => ({ ageHours: 3, slaBreached: false, slaHours: 48, reviewedBy: null, assignedTo: null, recordedBy: null })),
  },
  agents: { requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn(), agentExists: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../kyc', () => ({
  ...kyc,
  flaggedDocuments: vi.fn(),
  clearDocumentReviews: vi.fn(),
  flagDocuments: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
  resolveManifestVersion: vi.fn(),
  assignCaseSchema: {},
  bulkAssignSchema: {},
  documentDecisionSchema: {},
  reuploadRequestSchema: {},
}));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn() }));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { publisherRouter } from '../publishers.routes';
import { publisherBareQuerySchema, publisherRosterQuerySchema } from '../publishers.schema';
import { getKycCase, listKycQueue } from '../publishers.service';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/publishers', publisherRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  displayId: 'PUB-1209-2601',
  name: 'Suraj Kumar Prints',
  mobile: '+919845012210',
  city: 'Bengaluru',
  kycStatus: 'VERIFIED',
  kyc: null,
  listings: [],
  user: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAllForAdmin.mockResolvedValue([publisher()]);
  repository.findRosterPage.mockResolvedValue({
    items: [publisher()],
    total: 18,
    counts: { PENDING: 4, VERIFIED: 12, REJECTED: 1, NEEDS_INFO: 1 },
  });
  repository.findKycQueue.mockResolvedValue([]);
  repository.findKycDetail.mockResolvedValue(null);
});

describe('GET /publishers — the roster', () => {
  it('parses q, category and the page pair', () => {
    expect(publisherRosterQuerySchema.parse({ q: ' suraj ', category: 'KYC' })).toEqual({ q: 'suraj', category: 'KYC', page: 1, pageSize: 20 });
    expect(publisherRosterQuerySchema.parse({ page: '3', pageSize: '500' }).pageSize).toBe(100);
    expect(publisherRosterQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('keeps the bare array when no page is asked for, and hands q through', async () => {
    const res = await request(app()).get('/api/v1/publishers?q=suraj&category=KYC').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toMatchObject({ id: 'pub_1' });
    expect(repository.findAllForAdmin).toHaveBeenCalledWith('KYC', 'suraj');
    expect(repository.findRosterPage).not.toHaveBeenCalled();
  });

  it('answers the list contract with the KYC chips when ?page= is given', async () => {
    const res = await request(app()).get('/api/v1/publishers?page=2&pageSize=10&q=ben').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.findRosterPage).toHaveBeenCalledWith({ q: 'ben', page: 2, pageSize: 10 });
    expect(res.body.data).toEqual({
      items: [expect.objectContaining({ id: 'pub_1' })],
      total: 18,
      page: 2,
      pageSize: 10,
      counts: { PENDING: 4, VERIFIED: 12, REJECTED: 1, NEEDS_INFO: 1 },
    });
    expect(repository.findAllForAdmin).not.toHaveBeenCalled();
  });

  it('refuses a malformed page', async () => {
    const res = await request(app()).get('/api/v1/publishers?page=zero').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
  });

  /* E12-B: the bare path is the old handler's, and the old handler ignored
     what it did not read — an empty search box, a pageSize nobody asked
     for. The console's list URL sends both; they are not a 400 here. */
  it('E12-B: the bare path ignores an empty q and a non-numeric pageSize the way the old handler did', async () => {
    const res = await request(app()).get('/api/v1/publishers?q=&pageSize=abc&category=KYC').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(repository.findAllForAdmin).toHaveBeenCalledWith('KYC', undefined);
    expect(repository.findRosterPage).not.toHaveBeenCalled();

    const empty = await request(app()).get('/api/v1/publishers?q=&category=').set('Authorization', `Bearer ${admin}`);
    expect(empty.status).toBe(200);
    expect(repository.findAllForAdmin).toHaveBeenLastCalledWith(undefined, undefined);

    expect(publisherBareQuerySchema.parse({ q: '', pageSize: 'abc', page: '', category: '' })).toEqual({});
    expect(publisherBareQuerySchema.parse({ q: ' suraj ' })).toEqual({ q: 'suraj' });
  });

  it('E12-B: the list-contract path keeps its validation — an empty q and a non-numeric pageSize are still a 400 there', async () => {
    const q = await request(app()).get('/api/v1/publishers?page=1&q=').set('Authorization', `Bearer ${admin}`);
    expect(q.status).toBe(400);
    const size = await request(app()).get('/api/v1/publishers?page=1&pageSize=abc').set('Authorization', `Bearer ${admin}`);
    expect(size.status).toBe(400);
    expect(repository.findRosterPage).not.toHaveBeenCalled();
    expect(repository.findAllForAdmin).not.toHaveBeenCalled();
  });
});

describe('GET /publishers/kyc-queue — the assignee by name', () => {
  it('carries assignedTo { id, name } | null beside assignedToId on every row', async () => {
    repository.findKycQueue.mockResolvedValue([
      publisher({ id: 'pub_1', kyc: { status: 'PENDING', submittedAt: new Date(), assignedToId: 'usr_priya' }, agent: null }),
      publisher({ id: 'pub_2', kyc: { status: 'PENDING', submittedAt: new Date(), assignedToId: null }, agent: null }),
      publisher({ id: 'pub_3', kyc: { status: 'PENDING', submittedAt: new Date(), assignedToId: 'usr_gone' }, agent: null }),
    ]);
    const { items } = await listKycQueue({});
    // G11-1: the escalation's two people ride the same lookup (undefined here — the rows carry no escalation columns);
    // Lot N: so do who requested and who recorded.
    expect(kyc.kycUserLabels).toHaveBeenCalledWith([
      'usr_priya', undefined, undefined, undefined, undefined,
      null, undefined, undefined, undefined, undefined,
      'usr_gone', undefined, undefined, undefined, undefined,
    ]);
    expect(items.map((row) => [row.id, row.assignedTo])).toEqual([
      ['pub_1', { id: 'usr_priya', name: 'Priya' }],
      ['pub_2', null],
      ['pub_3', { id: 'usr_gone', name: null }],
    ]);
    expect(items[0]).toMatchObject({ kyc: expect.objectContaining({ assignedToId: 'usr_priya' }) });
  });
});

describe('GET /publishers/kyc-queue/:publisherId — who decided each tile', () => {
  it('reads the document decisions with the reviewer named', async () => {
    repository.findKycDetail.mockResolvedValue(publisher({ kyc: { id: 'kyc_1', status: 'PENDING', submittedAt: new Date() }, userId: null, agent: null }));
    kyc.listDocumentReviewsWithReviewer.mockResolvedValue([
      { field: 'selfieUrl', decision: 'APPROVED', note: null, reviewedById: 'usr_priya', reviewedBy: { id: 'usr_priya', name: 'Priya' } },
    ] as never);
    const view = await getKycCase('pub_1');
    expect(kyc.listDocumentReviewsWithReviewer).toHaveBeenCalledWith('PUBLISHER', 'kyc_1');
    expect(view.documentReviews).toEqual([
      expect.objectContaining({ field: 'selfieUrl', reviewedById: 'usr_priya', reviewedBy: { id: 'usr_priya', name: 'Priya' } }),
    ]);
  });
});
