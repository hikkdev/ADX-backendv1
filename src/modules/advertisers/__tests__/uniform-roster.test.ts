import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform: `GET /advertisers` takes
 * the cuts every party desk sends — the KYC state, the type and the city
 * beside the door — and each row carries its campaigns counted, the KYC
 * state the queue prints, and the page's total.
 */

const { repository, pricing } = vi.hoisted(() => ({
  repository: {
    listAdvertisers: vi.fn(),
    findKycSummaries: vi.fn(async () => new Map()),
    userLabels: vi.fn(async () => new Map()),
  },
  pricing: {
    cityKeyFor: vi.fn(async (name: string) => (name.toLowerCase() === 'pune' ? { cityId: 'city_pune', slug: 'pune' } : null)),
    withCityKey: vi.fn(),
  },
}));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../wallets', () => ({ move: vi.fn(), findWallet: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../payouts', () => ({ findPayoutMethod: vi.fn(), recordIncentiveOnce: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../agreements', () => ({ acceptInsertionOrder: vi.fn(), isCurrentAcceptance: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) }));

import { listAdvertisersHandler } from '../advertisers.controller';
import { advertiserRosterQuerySchema } from '../advertisers.schema';

const res = () => {
  const out = { body: undefined as unknown };
  return Object.assign(out, { json: vi.fn((body: unknown) => (out.body = body)) });
};

const advertiser = { id: 'adv_1', userId: null, name: 'Swiggy', kycStatus: 'PENDING', campaignCount: 2, onboardedVia: null, onboardedById: null, onboardedByRole: null, onboardedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  repository.listAdvertisers.mockResolvedValue({ rows: [advertiser], nextCursor: null, total: 1 });
});

describe('GET /advertisers — the cuts every party desk takes', () => {
  it('parses the KYC state, the type and the city case-insensitively', () => {
    expect(advertiserRosterQuerySchema.parse({ kycState: 'needs_info', type: 'agency', city: ' Pune ' })).toEqual({ kycState: 'NEEDS_INFO', type: 'AGENCY', city: 'Pune' });
    expect(advertiserRosterQuerySchema.safeParse({ kycState: 'LOST' }).success).toBe(false);
    expect(advertiserRosterQuerySchema.safeParse({ type: 'BUSINESS' }).success).toBe(false);
  });

  it('hands every cut to the repository beside the page, with the city resolved to its key', async () => {
    await listAdvertisersHandler(
      { query: { q: ' swiggy ', limit: '200', kycState: 'verified', type: 'commercial', city: 'Pune', onboardedVia: 'self' } } as never,
      res() as never,
    );
    expect(pricing.cityKeyFor).toHaveBeenCalledWith('Pune');
    expect(repository.listAdvertisers).toHaveBeenCalledWith({
      q: 'swiggy',
      limit: 200,
      cursor: undefined,
      onboardedVia: 'SELF',
      kycState: 'VERIFIED',
      type: 'COMMERCIAL',
      city: 'Pune',
      cityId: 'city_pune',
    });
  });

  it('refuses a KYC state the vocabulary does not have', async () => {
    await expect(listAdvertisersHandler({ query: { kycState: 'lost' } } as never, res() as never)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers the rows with their campaigns counted, their KYC state and the total', async () => {
    const response = res();
    await listAdvertisersHandler({ query: {} } as never, response as never);
    const body = response.body as { data: { rows: { campaignCount: number; kyc: { state: string } }[]; total: number } };
    expect(body.data.total).toBe(1);
    expect(body.data.rows[0]).toMatchObject({ campaignCount: 2, kyc: { state: 'AWAITING_DOCUMENTS' } });
  });
});
