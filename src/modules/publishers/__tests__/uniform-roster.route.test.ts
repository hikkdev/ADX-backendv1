import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform (the owner: "Why this table
 * columns look different than advertisers?"). `GET /publishers?page=` takes
 * the cuts every party desk sends — the KYC state, the type and the city
 * beside the door — and each row carries the KYC state the queue prints and
 * its spots counted, so the console's roster reads the same columns off
 * every party.
 */

const { repository, pricing } = vi.hoisted(() => ({
  repository: {
    findRosterPage: vi.fn(),
    userLabels: vi.fn(async () => new Map([['usr_asha', 'Asha Rao']])),
  },
  pricing: {
    cityKeyFor: vi.fn(async (name: string) => (name.toLowerCase() === 'bengaluru' ? { cityId: 'city_blr', slug: 'bengaluru' } : null)),
    withCityKey: vi.fn(),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn(), agentExists: vi.fn() }));
vi.mock('../../kyc', () => ({
  kycUserLabels: vi.fn(async () => new Map()),
  listDocumentReviews: vi.fn(async () => []),
  listDocumentReviewsWithReviewer: vi.fn(async () => []),
  livenessStateFor: vi.fn(async () => null),
  kycCaseExtras: vi.fn(),
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
import { publisherRosterQuerySchema } from '../publishers.schema';

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

const row = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  displayId: 'PUB-1209-2601',
  name: 'Suraj Kumar Prints',
  mobile: '9507842149',
  email: 'suraj@example.com',
  city: 'Bengaluru',
  type: 'BUSINESS',
  kycStatus: 'PENDING',
  kyc: { id: 'pkyc_1', status: 'PENDING', submittedAt: new Date('2026-09-20T10:00:00Z'), requestedAt: null, requestedChannel: null, method: 'MANUAL' },
  listingCount: 4,
  user: null,
  agent: null,
  onboardedVia: 'DESK',
  onboardedById: 'usr_asha',
  onboardedByRole: 'Ops manager',
  onboardedAt: new Date('2026-09-12T09:00:00Z'),
  createdAt: new Date('2026-09-12T09:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findRosterPage.mockResolvedValue({ items: [row()], total: 1, counts: { PENDING: 1 } });
});

describe('the roster cuts every party desk takes', () => {
  it('parses the KYC state, the type and the city case-insensitively beside the door', () => {
    expect(publisherRosterQuerySchema.parse({ kycState: 'pending', type: 'business', city: ' Bengaluru ', onboardedVia: 'desk' })).toMatchObject({
      kycState: 'PENDING',
      type: 'BUSINESS',
      city: 'Bengaluru',
      onboardedVia: 'DESK',
    });
    expect(publisherRosterQuerySchema.safeParse({ kycState: 'LOST' }).success).toBe(false);
    expect(publisherRosterQuerySchema.safeParse({ type: 'COMPANY' }).success).toBe(false);
  });

  it('hands every cut to the repository, with the city resolved to its key', async () => {
    const res = await request(app())
      .get('/api/v1/publishers?page=1&pageSize=100&q=98765%2043210&kycState=pending&type=business&city=Bengaluru&onboardedVia=desk')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(pricing.cityKeyFor).toHaveBeenCalledWith('Bengaluru');
    expect(repository.findRosterPage).toHaveBeenCalledWith({
      q: '98765 43210',
      page: 1,
      pageSize: 100,
      kycState: 'PENDING',
      type: 'BUSINESS',
      city: 'Bengaluru',
      cityId: 'city_blr',
      onboardedVia: 'DESK',
    });
  });

  it('keeps the spelling alone for a town the catalogue lacks (cityId null)', async () => {
    await request(app()).get('/api/v1/publishers?page=1&city=Nowhere').set('Authorization', `Bearer ${admin}`);
    expect(repository.findRosterPage).toHaveBeenCalledWith(expect.objectContaining({ city: 'Nowhere', cityId: null }));
  });

  it('refuses a KYC state or a type the vocabulary does not have', async () => {
    expect((await request(app()).get('/api/v1/publishers?page=1&kycState=lost').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await request(app()).get('/api/v1/publishers?page=1&type=company').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
  });

  it('answers each row with its KYC state, its spots counted and who onboarded it', async () => {
    const res = await request(app()).get('/api/v1/publishers?page=1').set('Authorization', `Bearer ${admin}`);
    const [item] = res.body.data.items;
    expect(item.kyc).toMatchObject({ state: 'PENDING', kycId: 'pkyc_1', method: 'MANUAL' });
    expect(item.listingCount).toBe(4);
    expect(item.onboarding).toMatchObject({ via: 'DESK', viaLabel: 'Desk', byName: 'Asha Rao', byRole: 'Ops manager' });
  });

  it('reads a party with no record as awaiting documents, and a verified mirror with none as verified', async () => {
    repository.findRosterPage.mockResolvedValue({
      items: [row({ id: 'pub_a', kyc: null, kycStatus: 'PENDING' }), row({ id: 'pub_b', kyc: null, kycStatus: 'VERIFIED' })],
      total: 2,
      counts: {},
    });
    const res = await request(app()).get('/api/v1/publishers?page=1').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.items.map((item: { kyc: { state: string } }) => item.kyc.state)).toEqual(['AWAITING_DOCUMENTS', 'VERIFIED']);
  });
});
